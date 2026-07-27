import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, basename } from "node:path";

import type { AssistantActionRun } from "@prisma/client";

import type { AuthenticatedUser } from "@/lib/server-auth";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { buildAssistantStoredName, getAssistantArtifactPath } from "@/lib/assistant-artifact-storage";
import { nextRiskCode } from "@/lib/risk-register-codes";

export type AssistantActionView = {
  id: string;
  toolId: string;
  title: string;
  description: string;
  riskLevel: string;
  status: string;
  expiresAt: string;
  result?: Record<string, unknown>;
};

const parseJson = (value: string) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const serializeAssistantAction = (action: AssistantActionRun): AssistantActionView => {
  const preview = parseJson(action.previewJson);
  return {
    id: action.id,
    toolId: action.toolId,
    title: String(preview.title || action.toolId),
    description: String(preview.description || ""),
    riskLevel: action.riskLevel,
    status: action.status,
    expiresAt: action.expiresAt.toISOString(),
    result: action.resultJson && action.resultJson !== "{}" ? parseJson(action.resultJson) : undefined,
  };
};

const cleanTitle = (message: string) => message
  .replace(/^(请|帮我|麻烦)?\s*(创建|新增|新建)\s*(一个|一条)?\s*(项目)?\s*待办\s*[:：]?/u, "")
  .replace(/[“”"']/g, "")
  .trim();

const parseProgressIntent = (message: string) => {
  const code = message.match(/Task\d+(?:\.\d+)*/i)?.[0];
  const progress = message.match(/(?:进度|完成度)\s*(?:改为|更新为|设置为|到)?\s*(\d{1,3})\s*%?/u)?.[1];
  if (!code || progress === undefined) return null;
  const value = Number(progress);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? { taskCode: code, progress: value } : null;
};

const weeklyStatusByLabel: Record<string, string> = {
  "待开始": "PENDING",
  "未开始": "PENDING",
  "进行中": "IN_PROGRESS",
  "已完成": "DONE",
  "完成": "DONE",
  "已取消": "CANCELED",
  "取消": "CANCELED",
};

const weeklyStatusLabel: Record<string, string> = {
  PENDING: "待开始",
  IN_PROGRESS: "进行中",
  DONE: "已完成",
  CANCELED: "已取消",
};

export const parseWeeklyItemUpdateIntent = (message: string) => {
  const matterCode = message.match(/Matter\d+/i)?.[0];
  if (!matterCode) return null;
  const statusLabel = message.match(/(?:状态\s*(?:改为|更新为|设置为|设为)?|改为|更新为|设置为|设为)\s*(待开始|未开始|进行中|已完成|完成(?!度)|已取消|取消)/u)?.[1];
  const progressText = message.match(/(?:进度|完成度)\s*(?:改为|更新为|设置为|到)?\s*(\d{1,3})\s*%?/u)?.[1];
  const progress = progressText === undefined ? undefined : Number(progressText);
  if (!statusLabel && progress === undefined) return null;
  if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) return null;
  return {
    matterCode,
    status: statusLabel ? weeklyStatusByLabel[statusLabel] : undefined,
    progress,
  };
};

export const parseTodoCompletionTarget = (message: string) => {
  if (!/(完成|关闭|办结).*(待办)|待办.*(完成|关闭|办结)/u.test(message)) return null;
  const target = message
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*(完成|关闭|办结)\s*(?:项目)?待办\s*[:：]?/u, "")
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*(?:项目)?待办\s*/u, "")
    .replace(/\s*(?:标记为|设置为|改为|更新为)?\s*(?:已完成|完成|关闭|办结)\s*$/u, "")
    .replace(/[“”"'：:]/g, "")
    .trim();
  return target || null;
};

const riskStatuses = ["识别中", "跟踪中", "处理中", "已关闭"] as const;

export const parseRiskStatusUpdateIntent = (message: string) => {
  const riskCode = message.match(/Risk\d+/i)?.[0];
  const status = riskStatuses.find((candidate) => message.includes(candidate));
  return riskCode && status ? { riskCode, status } : null;
};

export const parseRiskCreationName = (message: string) => {
  if (!/(创建|新增|新建|登记).{0,8}风险|风险.{0,8}(创建|新增|新建|登记)/u.test(message)) return null;
  if (/(分析结论|计划分析|冲突).*(转为|创建|新增|登记).*风险/u.test(message)) return null;
  const name = message
    .replace(/^(请|帮我|麻烦)?\s*(?:创建|新增|新建|登记)\s*(?:一个|一条)?\s*(?:项目)?风险\s*[:：]?/u, "")
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*风险\s*/u, "")
    .replace(/\s*(?:创建|新增|新建|登记)\s*$/u, "")
    .replace(/[“”"']/g, "")
    .trim();
  return name && name.length <= 200 ? name : null;
};

type AssistantExportType = "scheduleAnalysis" | "gantt" | "weekly" | "risk" | "budget";

const parseExportType = (message: string): AssistantExportType | null => {
  if (!/(导出|下载)/u.test(message)) return null;
  if (/(差异|冲突|计划分析|影响链)/u.test(message)) return "scheduleAnalysis";
  if (/(任务|甘特|进度)/u.test(message)) return "gantt";
  if (/(事项|本周)/u.test(message)) return "weekly";
  if (/风险/u.test(message)) return "risk";
  if (/(预算|成本)/u.test(message)) return "budget";
  return null;
};

const ensureProjectAccess = async (user: AuthenticatedUser, projectId: string) => {
  if (user.assignedRoleNames.includes("管理员")) return true;
  return Boolean(await prisma.projectMember.findFirst({
    where: { projectId, personName: user.displayName },
    select: { id: true },
  }));
};

const createProposal = async (params: {
  user: AuthenticatedUser;
  projectId: string;
  toolId: string;
  riskLevel: string;
  args: Record<string, unknown>;
  title: string;
  description: string;
  runtime: AssistantRuntimeConfig;
}) => {
  const expiresAt = new Date(Date.now() + params.runtime.agentActionExpiryMinutes * 60_000);
  const action = await prisma.assistantActionRun.create({
    data: {
      userId: params.user.userId,
      username: params.user.username,
      displayName: params.user.displayName,
      projectId: params.projectId,
      toolId: params.toolId,
      toolVersion: 1,
      riskLevel: params.riskLevel,
      argsJson: JSON.stringify(params.args),
      previewJson: JSON.stringify({ title: params.title, description: params.description }),
      idempotencyKey: randomUUID(),
      expiresAt,
    },
  });
  return serializeAssistantAction(action);
};

export const proposeAssistantAction = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  expectedToolId?: string;
}): Promise<AssistantActionView | null> => {
  if (!params.runtime.agentEnabled || !params.projectId) return null;
  if (!(await ensureProjectAccess(params.user, params.projectId))) return null;
  const enabled = new Set(params.runtime.agentEnabledToolIds);
  const canUse = (toolId: string) => enabled.has(toolId) && (!params.expectedToolId || params.expectedToolId === toolId);

  if (canUse("document.revision.save") && /(保存|下载|生成).*(修订稿|修改稿|重写稿|文档)/u.test(params.message)) {
    const latestAssistantContent = [...(params.history ?? [])].reverse().find((item) => item.role === "assistant")?.content.trim() || "";
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { projectId: params.projectId, userId: params.user.userId, status: "READY" },
      orderBy: { createdAt: "desc" },
      select: { id: true, originalName: true },
    });
    if (attachment && latestAssistantContent) {
      return createProposal({
        ...params,
        toolId: "document.revision.save",
        riskLevel: "LOW",
        args: { attachmentId: attachment.id, content: latestAssistantContent, instruction: params.message },
        title: "保存文档修订稿",
        description: `将上一条助手回答保存为「${attachment.originalName}」的独立 Markdown 修订稿`,
      });
    }
  }

  if (canUse("schedule.analysis.export") && /(导出|下载).*(差异|冲突|计划分析|影响链)/u.test(params.message)) {
    const run = await prisma.scheduleAnalysisRun.findFirst({
      where: { projectId: params.projectId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      select: { id: true, sourceFileName: true },
    });
    if (run) {
      return createProposal({
        ...params,
        toolId: "schedule.analysis.export",
        riskLevel: "LOW",
        args: { analysisRunId: run.id },
        title: "导出计划分析",
        description: `导出「${run.sourceFileName || "最新计划"}」的差异、冲突和影响链报告`,
      });
    }
  }

  if (canUse("risk.create.from-analysis") && /(冲突|分析结论|问题).*(创建|新建|转为).*风险|风险.*(创建|新建|转为).*(冲突|分析)/u.test(params.message)) {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { projectId: params.projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    const result = run ? parseJson(run.resultJson) : {};
    const issue = Array.isArray(result.issues)
      ? result.issues.find((item) => item && typeof item === "object" && (item as { severity?: unknown }).severity === "ERROR") || result.issues[0]
      : null;
    if (run && issue && typeof issue === "object") {
      const value = issue as Record<string, unknown>;
      const taskCodes = Array.isArray(value.taskCodes) ? value.taskCodes.map(String) : [];
      return createProposal({
        ...params,
        toolId: "risk.create.from-analysis",
        riskLevel: "MEDIUM",
        args: { analysisRunId: run.id, issue: value },
        title: "从计划分析创建风险",
        description: `${taskCodes.join("、") || "计划"}：${String(value.message || "计划冲突")}`,
      });
    }
  }

  if (canUse("todo.create.batch") && /(建议|冲突|分析结论).*(创建|生成|转为).*待办|待办.*(创建|生成|转为).*(建议|冲突|分析)/u.test(params.message)) {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { projectId: params.projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    const result = run ? parseJson(run.resultJson) : {};
    const issues = Array.isArray(result.issues) ? result.issues.filter((item) => item && typeof item === "object").slice(0, 20) as Record<string, unknown>[] : [];
    if (run && issues.length > 0) {
      const items = issues.map((issue) => ({
        title: `处理${Array.isArray(issue.taskCodes) && issue.taskCodes.length > 0 ? ` ${issue.taskCodes.map(String).join("、")}` : "计划"}：${String(issue.message || "计划冲突")}`.slice(0, 200),
        detail: String(issue.suggestion || "请核对计划分析结论并制定处理方案"),
      }));
      return createProposal({
        ...params,
        toolId: "todo.create.batch",
        riskLevel: "MEDIUM",
        args: { analysisRunId: run.id, items },
        title: "创建计划整改待办",
        description: `从最新分析生成 ${items.length} 条本人整改待办`,
      });
    }
  }

  const todoCompletionTarget = parseTodoCompletionTarget(params.message);
  if (canUse("todo.complete") && todoCompletionTarget) {
    const matches = await prisma.todoItem.findMany({
      where: {
        projectId: params.projectId,
        status: "OPEN",
        title: { contains: todoCompletionTarget, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, title: true },
    });
    if (matches.length === 1) {
      return createProposal({
        ...params,
        toolId: "todo.complete",
        riskLevel: "MEDIUM",
        args: { todoId: matches[0].id },
        title: "完成项目待办",
        description: `将待办「${matches[0].title}」标记为已完成`,
      });
    }
  }

  if (canUse("todo.create") && /(创建|新增|新建).*(待办)|待办.*(创建|新增|新建)/u.test(params.message)) {
    const title = cleanTitle(params.message);
    if (!title || title.length > 200) return null;
    return createProposal({
      ...params,
      toolId: "todo.create",
      riskLevel: "MEDIUM",
      args: { title, targetPersonName: params.user.displayName },
      title: "创建项目待办",
      description: `为 ${params.user.displayName} 创建待办「${title}」`,
    });
  }

  const progressIntent = parseProgressIntent(params.message);
  if (canUse("gantt.progress.update") && progressIntent) {
    const task = await prisma.projectGanttTask.findFirst({
      where: { projectId: params.projectId, taskCode: { equals: progressIntent.taskCode, mode: "insensitive" } },
      select: { id: true, taskCode: true, taskName: true, progress: true },
    });
    if (!task) return null;
    return createProposal({
      ...params,
      toolId: "gantt.progress.update",
      riskLevel: "MEDIUM",
      args: { taskId: task.id, progress: progressIntent.progress },
      title: "更新任务进度",
      description: `${task.taskCode} ${task.taskName}：${task.progress}% → ${progressIntent.progress}%`,
    });
  }

  const weeklyIntent = parseWeeklyItemUpdateIntent(params.message);
  if (canUse("weekly.status.update") && weeklyIntent) {
    const item = await prisma.weeklyItem.findFirst({
      where: { projectId: params.projectId, matterCode: { equals: weeklyIntent.matterCode, mode: "insensitive" } },
      select: { id: true, matterCode: true, title: true, status: true, progress: true },
    });
    if (item) {
      const nextStatus = weeklyIntent.status ?? item.status;
      const nextProgress = weeklyIntent.progress ?? (nextStatus === "DONE" ? 100 : item.progress);
      return createProposal({
        ...params,
        toolId: "weekly.status.update",
        riskLevel: "MEDIUM",
        args: { weeklyItemId: item.id, status: nextStatus, progress: nextProgress },
        title: "更新项目事项",
        description: `${item.matterCode} ${item.title}：${weeklyStatusLabel[item.status] || item.status} / ${item.progress}% → ${weeklyStatusLabel[nextStatus] || nextStatus} / ${nextProgress}%`,
      });
    }
  }

  const riskStatusIntent = parseRiskStatusUpdateIntent(params.message);
  if (canUse("risk.status.update") && riskStatusIntent) {
    const risk = await prisma.riskRegisterItem.findFirst({
      where: { projectId: params.projectId, riskCode: { equals: riskStatusIntent.riskCode, mode: "insensitive" } },
      select: { id: true, riskCode: true, riskName: true, status: true },
    });
    if (risk) {
      return createProposal({
        ...params,
        toolId: "risk.status.update",
        riskLevel: "MEDIUM",
        args: { riskId: risk.id, status: riskStatusIntent.status },
        title: "更新风险状态",
        description: `${risk.riskCode} ${risk.riskName}：${risk.status} → ${riskStatusIntent.status}`,
      });
    }
  }

  const riskName = parseRiskCreationName(params.message);
  if (canUse("risk.create") && riskName) {
    return createProposal({
      ...params,
      toolId: "risk.create",
      riskLevel: "MEDIUM",
      args: { riskName },
      title: "登记项目风险",
      description: `创建风险「${riskName}」，其余字段保持系统默认并可在风险登记册继续完善`,
    });
  }

  const exportType = parseExportType(params.message);
  const projectExportType = exportType && exportType !== "scheduleAnalysis" ? exportType : null;
  if (canUse("project.export") && projectExportType) {
    const label = { gantt: "任务进度", weekly: "项目事项", risk: "风险登记册", budget: "项目预算" }[projectExportType];
    return createProposal({
      ...params,
      toolId: "project.export",
      riskLevel: "LOW",
      args: { exportType: projectExportType },
      title: `导出${label}`,
      description: `生成当前项目的${label} CSV 文件`,
    });
  }
  return null;
};

export const executeAssistantAction = async (action: AssistantActionRun, user: AuthenticatedUser) => {
  if (action.userId !== user.userId) throw new Error("无权执行该操作");
  if (action.status !== "PROPOSED") return action;
  if (action.expiresAt.getTime() < Date.now()) {
    await prisma.assistantActionRun.updateMany({
      where: { id: action.id, userId: user.userId, status: "PROPOSED" },
      data: { status: "EXPIRED" },
    });
    return await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
  }
  if (!(await ensureProjectAccess(user, action.projectId))) throw new Error("无权访问当前项目");

  const claimed = await prisma.assistantActionRun.updateMany({
    where: { id: action.id, userId: user.userId, status: "PROPOSED" },
    data: { status: "EXECUTING", confirmedAt: new Date() },
  });
  if (claimed.count === 0) {
    return await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
  }

  const args = parseJson(action.argsJson);

  if (action.toolId === "todo.create") {
    const title = String(args.title || "").trim();
    if (!title) throw new Error("待办标题不能为空");
    const todo = await prisma.$transaction(async (tx) => {
      const created = await tx.todoItem.create({
        data: {
          projectId: action.projectId,
          title,
          detail: "由佳佳创建",
          targetRole: "MEMBER",
          targetPersonName: String(args.targetPersonName || user.displayName),
          type: "ASSISTANT",
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "ASSISTANT_ACTION",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手创建待办「${title}」`,
        },
      });
      return created;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "待办已创建", todoId: todo.id, title: todo.title, navigateUrl: "/todos", navigateLabel: "查看待办中心" }) },
    });
  }

  if (action.toolId === "todo.complete") {
    const todoId = String(args.todoId || "");
    const current = await prisma.todoItem.findFirst({ where: { id: todoId, projectId: action.projectId, status: "OPEN" } });
    if (!current) throw new Error("待办不存在或已处理");
    const updated = await prisma.$transaction(async (tx) => {
      const todo = await tx.todoItem.update({ where: { id: todoId }, data: { status: "DONE" } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "TODO_ITEM",
          entityId: todo.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手完成待办「${todo.title}」`,
        },
      });
      return todo;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "待办已完成", todoId: updated.id, navigateUrl: "/todos", navigateLabel: "查看待办中心" }) },
    });
  }

  if (action.toolId === "gantt.progress.update") {
    const taskId = String(args.taskId || "");
    const progress = Number(args.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new Error("任务进度应为 0-100 的数字");
    }
    const current = await prisma.projectGanttTask.findFirst({ where: { id: taskId, projectId: action.projectId } });
    if (!current) throw new Error("任务不存在");
    const updated = await prisma.$transaction(async (tx) => {
      const task = await tx.projectGanttTask.update({ where: { id: taskId }, data: { progress } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: task.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手将 ${task.taskCode} ${task.taskName} 进度从 ${current.progress}% 更新为 ${progress}%`,
        },
      });
      return task;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "任务进度已更新", taskId: updated.id, progress: updated.progress, navigateUrl: `/projects/${action.projectId}?nav=gantt`, navigateLabel: "查看项目进度" }) },
    });
  }

  if (action.toolId === "weekly.status.update") {
    const weeklyItemId = String(args.weeklyItemId || "");
    const status = String(args.status || "");
    const progress = Number(args.progress);
    if (!Object.hasOwn(weeklyStatusLabel, status)) throw new Error("事项状态无效");
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error("事项进度应为 0-100 的数字");
    const current = await prisma.weeklyItem.findFirst({ where: { id: weeklyItemId, projectId: action.projectId } });
    if (!current) throw new Error("事项不存在");
    const updated = await prisma.$transaction(async (tx) => {
      const item = await tx.weeklyItem.update({ where: { id: weeklyItemId }, data: { status, progress } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "WEEKLY_ITEM",
          entityId: item.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手将 ${item.matterCode} ${item.title} 从 ${weeklyStatusLabel[current.status] || current.status} / ${current.progress}% 更新为 ${weeklyStatusLabel[status]} / ${progress}%`,
        },
      });
      return item;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "事项状态已更新", weeklyItemId: updated.id, navigateUrl: "/weekly-items", navigateLabel: "查看项目事项" }) },
    });
  }

  if (action.toolId === "project.export") {
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "导出文件已生成", downloadUrl: `/api/assistant/exports/${action.id}` }) },
    });
  }

  if (action.toolId === "schedule.analysis.export") {
    const analysisRunId = String(args.analysisRunId || "");
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { id: analysisRunId, projectId: action.projectId } });
    if (!run) throw new Error("计划分析记录不存在");
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "分析报告已生成", downloadUrl: `/api/assistant/exports/${action.id}` }) },
    });
  }

  if (action.toolId === "document.revision.save") {
    const attachmentId = String(args.attachmentId || "");
    const content = String(args.content || "").trim();
    const instruction = String(args.instruction || "").trim();
    if (!content) throw new Error("修订稿内容为空");
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { id: attachmentId, projectId: action.projectId, userId: user.userId },
    });
    if (!attachment) throw new Error("来源附件不存在");
    const revisionId = randomUUID();
    const artifactId = randomUUID();
    const originalBase = basename(attachment.originalName, extname(attachment.originalName)).slice(0, 120) || "文档";
    const fileName = `${originalBase}-修订稿.md`;
    const storedName = buildAssistantStoredName(artifactId, fileName);
    const filePath = getAssistantArtifactPath(action.projectId, storedName);
    const buffer = Buffer.from(content, "utf8");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    const artifact = await prisma.$transaction(async (tx) => {
      await tx.documentRevision.create({
        data: { id: revisionId, projectId: action.projectId, attachmentId, userId: user.userId, instruction, content, format: "md" },
      });
      const created = await tx.assistantArtifact.create({
        data: { id: artifactId, projectId: action.projectId, userId: user.userId, attachmentId, revisionId, fileName, storedName, mimeType: "text/markdown; charset=utf-8", sizeBytes: buffer.length },
      });
      await tx.operationHistory.create({
        data: { projectId: action.projectId, entityType: "DOCUMENT_REVISION", entityId: revisionId, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手保存「${attachment.originalName}」的独立修订稿` },
      });
      return created;
    }).catch(async (error) => {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "修订稿已保存", artifactId: artifact.id, downloadUrl: `/api/assistant/artifacts/${artifact.id}/download` }) },
    });
  }

  if (action.toolId === "risk.create.from-analysis") {
    const issue = args.issue && typeof args.issue === "object" ? args.issue as Record<string, unknown> : {};
    const taskIds = Array.isArray(issue.taskIds) ? issue.taskIds.map(String) : [];
    const linkedTask = taskIds.length > 0
      ? await prisma.projectGanttTask.findFirst({ where: { id: { in: taskIds }, projectId: action.projectId }, select: { id: true, taskCode: true, taskName: true } })
      : null;
    const existing = await prisma.riskRegisterItem.findMany({ where: { projectId: action.projectId }, select: { id: true, riskCode: true, sortOrder: true, createdAt: true } });
    const lastSortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const created = await prisma.$transaction(async (tx) => {
      const risk = await tx.riskRegisterItem.create({
        data: {
          projectId: action.projectId,
          sortOrder: lastSortOrder + 1,
          riskCode: nextRiskCode(existing),
          ganttTaskId: linkedTask?.id ?? null,
          riskName: String(issue.message || "计划分析冲突").slice(0, 200),
          linkedItemName: linkedTask ? `${linkedTask.taskCode} ${linkedTask.taskName}` : "",
          category: "进度",
          trigger: JSON.stringify(issue.facts ?? {}).slice(0, 500),
          probability: "中",
          impact: issue.severity === "ERROR" ? "高" : "中",
          level: issue.severity === "ERROR" ? "高" : "中",
          response: String(issue.suggestion || "核对计划并制定纠偏措施"),
          owner: user.displayName,
        },
      });
      await tx.operationHistory.create({ data: { projectId: action.projectId, entityType: "RISK_REGISTER_ITEM", entityId: risk.id, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手从计划分析创建风险「${risk.riskName}」` } });
      return risk;
    });
    return prisma.assistantActionRun.update({ where: { id: action.id }, data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险已创建", riskId: created.id, riskCode: created.riskCode }) } });
  }

  if (action.toolId === "risk.create") {
    const riskName = String(args.riskName || "").trim();
    if (!riskName || riskName.length > 200) throw new Error("风险名称不能为空且不能超过 200 个字");
    const existing = await prisma.riskRegisterItem.findMany({
      where: { projectId: action.projectId },
      select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
    });
    const lastSortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const created = await prisma.$transaction(async (tx) => {
      const risk = await tx.riskRegisterItem.create({
        data: {
          projectId: action.projectId,
          sortOrder: lastSortOrder + 1,
          riskCode: nextRiskCode(existing),
          riskName,
          owner: user.displayName,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "RISK_REGISTER_ITEM",
          entityId: risk.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手登记风险「${risk.riskName}」`,
        },
      });
      return risk;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险已登记", riskId: created.id, riskCode: created.riskCode, navigateUrl: "/risk-register", navigateLabel: "查看风险登记册" }) },
    });
  }

  if (action.toolId === "risk.status.update") {
    const riskId = String(args.riskId || "");
    const status = String(args.status || "");
    if (!riskStatuses.includes(status as (typeof riskStatuses)[number])) throw new Error("风险状态无效");
    const current = await prisma.riskRegisterItem.findFirst({ where: { id: riskId, projectId: action.projectId } });
    if (!current) throw new Error("风险不存在");
    const updated = await prisma.$transaction(async (tx) => {
      const risk = await tx.riskRegisterItem.update({ where: { id: riskId }, data: { status } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "RISK_REGISTER_ITEM",
          entityId: risk.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手将 ${risk.riskCode} ${risk.riskName} 状态从 ${current.status} 更新为 ${status}`,
        },
      });
      return risk;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险状态已更新", riskId: updated.id, navigateUrl: "/risk-register", navigateLabel: "查看风险登记册" }) },
    });
  }

  if (action.toolId === "todo.create.batch") {
    const items = Array.isArray(args.items) ? args.items.filter((item) => item && typeof item === "object").slice(0, 50) as Record<string, unknown>[] : [];
    if (items.length === 0) throw new Error("没有可创建的整改待办");
    const created = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const item of items) {
        const title = String(item.title || "处理计划分析问题").slice(0, 200);
        rows.push(await tx.todoItem.create({ data: { projectId: action.projectId, title, detail: String(item.detail || "由佳佳从计划分析生成"), targetRole: "MEMBER", targetPersonName: user.displayName, type: "ASSISTANT" } }));
      }
      await tx.operationHistory.create({ data: { projectId: action.projectId, entityType: "ASSISTANT_ACTION", entityId: action.id, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手从计划分析创建 ${rows.length} 条整改待办` } });
      return rows;
    });
    return prisma.assistantActionRun.update({ where: { id: action.id }, data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: `已创建 ${created.length} 条整改待办`, todoIds: created.map((item) => item.id) }) } });
  }

  throw new Error("不支持的 Agent 工具");
};
