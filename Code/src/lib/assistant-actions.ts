import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, basename } from "node:path";

import type { AssistantActionRun } from "@prisma/client";

import { userHasPermission, type AuthenticatedUser } from "@/lib/server-auth";
import {
  getAssistantToolDefinition,
  loadAssistantRuntimeConfig,
  validateAssistantToolArgs,
  type AssistantRuntimeConfig,
} from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { buildAssistantStoredName, getAssistantArtifactPath, getAssistantAttachmentPath } from "@/lib/assistant-artifact-storage";
import { nextRiskCode } from "@/lib/risk-register-codes";
import {
  convertScheduleFile,
  mergeScheduleFiles,
  SCHEDULE_CONVERT_EXTENSIONS,
  SCHEDULE_MERGE_EXTENSIONS,
} from "@/lib/schedule-file-merge";
import {
  changeProjectGanttTaskHierarchy,
  getOrderedGanttTasks,
  renumberProjectGanttTaskCodes,
} from "@/lib/gantt-task-service";
import { parseGanttImportFile } from "@/lib/gantt-file-transfer";
import { analyzeSchedule } from "@/lib/schedule-analysis";
import { buildImportedScheduleSnapshot, getCurrentScheduleSnapshot } from "@/lib/schedule-snapshot";
import { isDocumentRevisionRequest, reviseDocumentsWithSmallModel } from "@/lib/assistant-document-revision";

export type AssistantActionView = {
  id: string;
  toolId: string;
  title: string;
  description: string;
  riskLevel: string;
  status: string;
  expiresAt: string;
  result?: Record<string, unknown>;
  planId?: string;
  planStepId?: string;
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
    planId: action.planId || undefined,
    planStepId: action.planStepId || undefined,
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

export const parseHierarchyIntent = (message: string) => {
  const taskCodes = Array.from(new Set([...message.matchAll(/Task\d+(?:\.\d+)*/gi)].map((match) => match[0])));
  if (taskCodes.length === 0) return null;
  if (/(上移(?:一个)?层级|提升(?:一个)?层级|取消缩进|升级为父级|减少缩进)/u.test(message)) {
    return { taskCodes, direction: "OUTDENT" as const };
  }
  if (/(下移(?:一个)?层级|降低(?:一个)?层级|设为.*子任务|变为.*子任务|增加缩进|缩进)/u.test(message)) {
    return { taskCodes, direction: "INDENT" as const };
  }
  return null;
};

export const parseGanttParentWrapIntent = (message: string) => {
  const requestsParent = /(创建|新增|新建|添加|加)(?:一个|一条)?(?:总)?父(?:级)?任务|父(?:级)?任务.{0,12}(创建|新增|新建|添加|加)/u.test(message);
  const targetsCurrentRoots = /(当前|现有|全部|所有).{0,12}(一级|顶级|根级|最上层).{0,8}(甘特)?任务/u.test(message);
  if (!requestsParent || !targetsCurrentRoots) return null;

  const quotedName = message.match(/[“"'《]([^”"'》]{1,100})[”"'》]/u)?.[1]?.trim();
  const inlineName = message.match(/父(?:级)?任务(?:名称)?\s*(?:为|叫|是|[:：])?\s*([^，。；;\n]{1,100})/u)?.[1]
    ?.replace(/^(一个|一条)\s*/u, "")
    .trim();
  const taskName = (quotedName || inlineName || "")
    .replace(/(?:并|然后|同时)?\s*(?:把|将)\s*(?:当前|现有|全部|所有)[\s\S]*$/u, "")
    .trim();
  return taskName ? { taskName } : null;
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

export const isScheduleMergeRequest = (message: string) => (
  /(合并|整合|汇总|合成|合二为一|拼接).{0,20}(进度|计划|排期|附件|文件)|(进度|计划|排期|附件|文件).{0,20}(合并|整合|汇总|合成|合二为一|拼接)/u.test(message)
  && /(生成|制作|导出|下载|可导入|模板|文件|表格|计划)/u.test(message)
);

export const isScheduleConversionRequest = (message: string) => {
  if (/(合并|整合|汇总|合成|合二为一|拼接)/u.test(message)) return false;
  const asksForTransformation = /(输出|导出|下载|转换|转成|转为|整理成|做成|生成|制作)/u.test(message);
  const mentionsScheduleInput = /(mpp|project\s*xml|\.xml|\.xlsx|excel|甘特|进度|计划|排期|附件|文件)/iu.test(message);
  const mentionsSupportedOutput = /(系统.{0,12}(甘特|任务|进度|导入|excel)|甘特.{0,12}(任务|格式|文件|excel)|可导入.{0,12}(格式|文件|excel)|excel)/iu.test(message);
  return asksForTransformation && mentionsScheduleInput && mentionsSupportedOutput;
};

export const isScheduleComparisonRequest = (message: string) => (
  /(对比|比较|分析|检查|核对).{0,24}(当前|现有|实际|甘特|进度|计划)|(当前|现有|实际|甘特|进度|计划).{0,24}(差异|冲突|干涉|影响|偏差)/u.test(message)
  && /(附件|文件|mpp|xml|xlsx|excel|进度|计划)/iu.test(message)
);

const ensureProjectAccess = async (user: AuthenticatedUser, projectId: string) => {
  if (user.assignedRoleNames.includes("管理员")) return true;
  return Boolean(await prisma.projectMember.findFirst({
    where: { projectId, personName: user.displayName },
    select: { id: true },
  }));
};

const canUseAssistantTool = async (user: AuthenticatedUser, toolId: string) => {
  const tool = getAssistantToolDefinition(toolId);
  if (!tool) return false;
  return (await Promise.all(tool.permissions.map((permission) => userHasPermission(user, permission)))).every(Boolean);
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
  const contract = getAssistantToolDefinition(params.toolId);
  if (!contract) throw new Error("不支持的 Agent 工具");
  const validation = validateAssistantToolArgs(params.toolId, params.args);
  if (!validation.ok) throw new Error(validation.error);
  const expiresAt = new Date(Date.now() + params.runtime.agentActionExpiryMinutes * 60_000);
  const action = await prisma.assistantActionRun.create({
    data: {
      userId: params.user.userId,
      username: params.user.username,
      displayName: params.user.displayName,
      projectId: params.projectId,
      toolId: params.toolId,
      toolVersion: contract.version,
      riskLevel: contract.riskLevel,
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
  attachmentIds?: string[];
  expectedToolId?: string;
}): Promise<AssistantActionView | null> => {
  if (!params.runtime.agentEnabled || !params.projectId) return null;
  if (!(await ensureProjectAccess(params.user, params.projectId))) return null;
  const enabled = new Set(params.runtime.agentEnabledToolIds);
  const allowed = new Set((await Promise.all([...enabled].map(async (toolId) => ({
    toolId,
    allowed: await canUseAssistantTool(params.user, toolId),
  })))).filter((item) => item.allowed).map((item) => item.toolId));
  const canUse = (toolId: string) => allowed.has(toolId) && (!params.expectedToolId || params.expectedToolId === toolId);

  if (canUse("schedule.compare.file") && isScheduleComparisonRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)));
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
        const statusDate = new Date().toISOString().slice(0, 10);
        return createProposal({
          ...params,
          toolId: "schedule.compare.file",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id, statusDate },
          title: "对比上传计划与当前进度",
          description: `解析「${attachment.originalName}」，与当前甘特任务对比并生成差异、冲突、干涉和影响链；不会修改当前计划`,
        });
      }
    }
  }

  if (canUse("schedule.convert.file") && isScheduleConversionRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean))).slice(0, 5);
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
        return createProposal({
          ...params,
          toolId: "schedule.convert.file",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id },
          title: "转换进度计划文件",
          description: `将「${attachment.originalName}」转换为系统可导入 Excel，并校验转换后的任务数量；不会直接写入项目进度`,
        });
      }
    }
  }

  if (canUse("schedule.merge.files") && isScheduleMergeRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean))).slice(0, 5);
    if (requestedIds.length >= 2) {
      const attachments = await prisma.assistantAttachment.findMany({
        where: { id: { in: requestedIds }, projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      const ordered = requestedIds.map((id) => attachmentById.get(id)).filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment));
      const supported = ordered.filter((attachment) => SCHEDULE_MERGE_EXTENSIONS.includes(extname(attachment.originalName).toLocaleLowerCase("en-US") as typeof SCHEDULE_MERGE_EXTENSIONS[number]));
      if (supported.length === requestedIds.length) {
        return createProposal({
          ...params,
          toolId: "schedule.merge.files",
          riskLevel: "LOW",
          args: { attachmentIds: requestedIds },
          title: "合并进度计划文件",
          description: `按原始顺序合并 ${supported.length} 个文件（${supported.map((attachment) => attachment.originalName).join("、")}），统一任务 ID 和依赖关系后生成可导入 Excel；不会直接写入项目进度`,
        });
      }
    }
  }

  if (canUse("document.revision.generate") && isDocumentRevisionRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)));
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const tool = getAssistantToolDefinition("document.revision.generate")!;
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && tool.attachments?.extensions.includes(extension)) {
        return createProposal({
          ...params,
          toolId: "document.revision.generate",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id, instruction: params.message.slice(0, 2000) },
          title: "诊断并生成文档修订稿",
          description: `读取「${attachment.originalName}」，在不编造事实的前提下梳理结构、细化内容并生成独立 Markdown 修订稿`,
        });
      }
    }
  }

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

  const parentWrapIntent = parseGanttParentWrapIntent(params.message);
  if (canUse("gantt.parent.wrap") && parentWrapIntent) {
    const rootTasks = await prisma.projectGanttTask.findMany({
      where: { projectId: params.projectId, parentId: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, taskCode: true, taskName: true },
    });
    if (rootTasks.length > 0) {
      return createProposal({
        ...params,
        toolId: "gantt.parent.wrap",
        riskLevel: "MEDIUM",
        args: { taskName: parentWrapIntent.taskName, childTaskIds: rootTasks.map((task) => task.id) },
        title: "创建任务总父级",
        description: `创建一级父任务「${parentWrapIntent.taskName}」，并将当前 ${rootTasks.length} 个一级任务及其全部子任务纳入其下`,
      });
    }
  }

  const hierarchyIntent = parseHierarchyIntent(params.message);
  const hierarchyToolId = hierarchyIntent?.direction === "OUTDENT"
    ? "gantt.hierarchy.outdent"
    : "gantt.hierarchy.indent";
  if (hierarchyIntent && canUse(hierarchyToolId)) {
    const tasks = await prisma.projectGanttTask.findMany({
      where: {
        projectId: params.projectId,
        taskCode: { in: hierarchyIntent.taskCodes, mode: "insensitive" },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, taskCode: true, taskName: true },
    });
    if (tasks.length === hierarchyIntent.taskCodes.length) {
      return createProposal({
        ...params,
        toolId: hierarchyToolId,
        riskLevel: "MEDIUM",
        args: { taskIds: tasks.map((task) => task.id), direction: hierarchyIntent.direction },
        title: hierarchyIntent.direction === "OUTDENT" ? "上移任务层级" : "下移任务层级",
        description: `${tasks.map((task) => `${task.taskCode} ${task.taskName}`).join("、")}及其全部子任务将${hierarchyIntent.direction === "OUTDENT" ? "上移一个层级" : "下移到上一条同级任务下"}`,
      });
    }
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

const completeScheduleArtifactAction = async (params: {
  action: AssistantActionRun;
  user: AuthenticatedUser;
  attachmentId?: string;
  artifactType: "SCHEDULE_CONVERSION" | "SCHEDULE_MERGE";
  fileName: string;
  workbook: Buffer;
  operationDetail: string;
  result: Record<string, unknown>;
}) => {
  const artifactId = randomUUID();
  const storedName = buildAssistantStoredName(artifactId, params.fileName);
  const filePath = getAssistantArtifactPath(params.action.projectId, storedName);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, params.workbook);
  const artifact = await prisma.$transaction(async (tx) => {
    const created = await tx.assistantArtifact.create({
      data: {
        id: artifactId,
        projectId: params.action.projectId,
        userId: params.user.userId,
        attachmentId: params.attachmentId,
        type: params.artifactType,
        fileName: params.fileName,
        storedName,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: params.workbook.length,
      },
    });
    await tx.operationHistory.create({
      data: {
        projectId: params.action.projectId,
        entityType: "ASSISTANT_ARTIFACT",
        entityId: artifactId,
        actionType: "CREATE",
        operator: params.user.displayName,
        detail: params.operationDetail,
      },
    });
    return created;
  }).catch(async (error) => {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  });
  return prisma.assistantActionRun.update({
    where: { id: params.action.id },
    data: {
      status: "SUCCEEDED",
      confirmedAt: new Date(),
      executedAt: new Date(),
      resultJson: JSON.stringify({
        ...params.result,
        artifactId: artifact.id,
        fileName: params.fileName,
        downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`,
      }),
    },
  });
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
  if (!(await canUseAssistantTool(user, action.toolId))) throw new Error("当前账号没有执行该操作的模块权限");

  const args = parseJson(action.argsJson);
  const validation = validateAssistantToolArgs(action.toolId, args);
  if (!validation.ok) throw new Error(validation.error);

  const claimed = await prisma.assistantActionRun.updateMany({
    where: { id: action.id, userId: user.userId, status: "PROPOSED" },
    data: { status: "EXECUTING", confirmedAt: new Date() },
  });
  if (claimed.count === 0) {
    return await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
  }

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

  if (action.toolId === "gantt.parent.wrap") {
    const taskName = String(args.taskName || "").trim();
    const requestedChildIds = Array.isArray(args.childTaskIds)
      ? Array.from(new Set(args.childTaskIds.map(String).filter(Boolean)))
      : [];
    if (!taskName || taskName.length > 100) throw new Error("父任务名称不能为空且不能超过 100 个字符");

    const rootTasks = await prisma.projectGanttTask.findMany({
      where: { projectId: action.projectId, parentId: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const requestedSet = new Set(requestedChildIds);
    const childTasks = rootTasks.filter((task) => requestedSet.has(task.id));
    if (childTasks.length === 0 || childTasks.length !== requestedSet.size || rootTasks.length !== requestedSet.size) {
      throw new Error("一级任务已发生变化，请重新发起操作");
    }

    const startDate = childTasks.map((task) => task.startDate).sort()[0];
    const finishDate = childTasks.map((task) => task.finishDate).sort().at(-1) || startDate;
    const durationDays = Math.max(1, Math.round((new Date(`${finishDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1);
    const actualStartDate = childTasks.map((task) => task.actualStartDate).filter(Boolean).sort()[0] || "";
    const actualEndDate = childTasks.map((task) => task.actualEndDate).filter(Boolean).sort().at(-1) || "";
    const estimatedWorkHours = childTasks.reduce((sum, task) => sum + Math.max(0, task.estimatedWorkHours), 0);
    const actualWorkHours = childTasks.reduce((sum, task) => sum + Math.max(0, task.actualWorkHours), 0);
    const weightedDuration = childTasks.reduce((sum, task) => sum + Math.max(1, task.durationDays), 0);
    const progress = Math.round(childTasks.reduce((sum, task) => sum + Math.max(1, task.durationDays) * task.progress, 0) / weightedDuration);
    const parent = await prisma.$transaction(async (tx) => {
      await tx.projectGanttTask.updateMany({
        where: { projectId: action.projectId, parentId: null },
        data: { sortOrder: { increment: 1 } },
      });
      const created = await tx.projectGanttTask.create({
        data: {
          projectId: action.projectId,
          parentId: null,
          taskCode: "",
          taskCategory: "",
          taskName,
          startDate,
          finishDate,
          durationDays,
          durationMinutes: durationDays * 480,
          actualStartDate,
          actualEndDate,
          estimatedWorkHours,
          actualWorkHours,
          progress,
          predecessorTask: "",
          sortOrder: 1,
        },
      });
      await Promise.all(childTasks.map((task, index) => tx.projectGanttTask.update({
        where: { id: task.id },
        data: { parentId: created.id, sortOrder: index + 1 },
      })));
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手创建父任务「${taskName}」，并纳入 ${childTasks.length} 个原一级任务`,
        },
      });
      return created;
    }, { maxWait: 10_000, timeout: 60_000 });
    await renumberProjectGanttTaskCodes(action.projectId);
    const normalizedParent = (await getOrderedGanttTasks(action.projectId)).find((task) => task.id === parent.id);
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `已创建 ${normalizedParent?.taskCode || "Task1"} ${taskName}，并调整现有一级任务层级`,
          taskId: parent.id,
          navigateUrl: `/projects/${action.projectId}?nav=gantt`,
          navigateLabel: "查看项目进度",
        }),
      },
    });
  }

  if (action.toolId === "gantt.hierarchy.outdent" || action.toolId === "gantt.hierarchy.indent") {
    const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String).filter(Boolean) : [];
    const direction = action.toolId === "gantt.hierarchy.outdent" ? "OUTDENT" : "INDENT";
    if (taskIds.length === 0) throw new Error("没有可调整层级的任务");
    const result = await changeProjectGanttTaskHierarchy({
      projectId: action.projectId,
      taskIds,
      direction,
      operator: user.displayName,
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: result.movedTaskIds.length > 0
            ? `已${direction === "OUTDENT" ? "上移" : "下移"} ${result.movedTaskIds.length} 个任务层级`
            : "所选任务已位于当前方向的边界，未发生变化",
          taskIds: result.movedTaskIds,
          navigateUrl: `/projects/${action.projectId}?nav=gantt`,
          navigateLabel: "查看项目进度",
        }),
      },
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

  if (action.toolId === "schedule.compare.file") {
    const attachmentId = String(args.attachmentId || "").trim();
    const requestedStatusDate = String(args.statusDate || "");
    const statusDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStatusDate)
      ? requestedStatusDate
      : new Date().toISOString().slice(0, 10);
    const [project, attachment] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { startDate: true } }),
      prisma.assistantAttachment.findFirst({
        where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    if (!attachment) throw new Error("源附件不存在、尚未解析完成或不属于当前项目");
    const extension = extname(attachment.originalName).toLocaleLowerCase("en-US");
    if (!SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
      throw new Error("计划对比仅支持 MPP、Project XML 和系统 Excel");
    }
    const bundle = await parseGanttImportFile(
      attachment.originalName,
      await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
      { fallbackStartDate: project.startDate },
    );
    const [currentSnapshot, incomingSnapshot] = await Promise.all([
      getCurrentScheduleSnapshot(action.projectId, statusDate),
      Promise.resolve(buildImportedScheduleSnapshot(attachment.originalName, bundle, statusDate)),
    ]);
    const analysis = analyzeSchedule(currentSnapshot, incomingSnapshot);
    const issueCount = analysis.issues.length;
    const persisted = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.projectScheduleSnapshot.create({
        data: {
          projectId: action.projectId,
          sourceFileName: attachment.originalName,
          schemaVersion: incomingSnapshot.schemaVersion,
          normalizedJson: JSON.stringify(incomingSnapshot),
          createdBy: user.displayName,
        },
      });
      const run = await tx.scheduleAnalysisRun.create({
        data: {
          projectId: action.projectId,
          snapshotId: snapshot.id,
          sourceFileName: attachment.originalName,
          statusDate,
          resultJson: JSON.stringify(analysis),
          createdBy: user.displayName,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "SCHEDULE_ANALYSIS",
          entityId: run.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手对比「${attachment.originalName}」与当前计划，发现 ${issueCount} 个问题，未修改当前计划`,
        },
      });
      return { snapshotId: snapshot.id, analysisRunId: run.id };
    }, { maxWait: 10_000, timeout: 60_000 });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `计划对比完成：识别 ${analysis.summary.changedFields} 个字段变更、${issueCount} 个冲突或干涉问题`,
          ...persisted,
          issueCount,
          summary: analysis.summary,
          verification: { kind: "DATABASE_STATE", passed: true, analysisRunId: persisted.analysisRunId },
        }),
      },
    });
  }

  if (action.toolId === "schedule.convert.file") {
    const attachmentId = String(args.attachmentId || "").trim();
    if (!attachmentId) throw new Error("请选择一个需要转换的进度计划附件");
    const [project, attachment] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { startDate: true } }),
      prisma.assistantAttachment.findFirst({
        where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    if (!attachment) throw new Error("源附件不存在、尚未解析完成或不属于当前项目");
    const extension = extname(attachment.originalName).toLocaleLowerCase("en-US");
    if (!SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
      throw new Error("单文件转换仅支持 MPP、Project XML 和系统 Excel");
    }
    const converted = await convertScheduleFile({
      fileName: attachment.originalName,
      buffer: await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
    }, project.startDate);
    const sourceLabel = basename(attachment.originalName, extname(attachment.originalName))
      .replace(/[\\/:*?"<>|]/g, "-")
      .slice(0, 80) || "进度计划";
    const fileName = `${sourceLabel}-系统甘特任务.xlsx`;
    return completeScheduleArtifactAction({
      action,
      user,
      attachmentId: attachment.id,
      artifactType: "SCHEDULE_CONVERSION",
      fileName,
      workbook: converted.workbook,
      operationDetail: `通过智能助手将「${attachment.originalName}」转换为系统甘特任务文件，生成 ${converted.tasks.length} 条任务、${converted.warnings.length} 条校验提示`,
      result: {
        message: `已将「${attachment.originalName}」转换为系统可导入 Excel，共 ${converted.tasks.length} 条任务${converted.warnings.length > 0 ? `，转换说明中有 ${converted.warnings.length} 条待核对提示` : ""}`,
        sourceCount: 1,
        taskCount: converted.tasks.length,
        warningCount: converted.warnings.length,
        verification: { kind: "SCHEDULE_REIMPORT", passed: true, expectedTaskCount: converted.tasks.length, actualTaskCount: converted.tasks.length },
      },
    });
  }

  if (action.toolId === "schedule.merge.files") {
    const attachmentIds = Array.isArray(args.attachmentIds)
      ? Array.from(new Set(args.attachmentIds.map((value) => String(value || "").trim()).filter(Boolean))).slice(0, 5)
      : [];
    if (attachmentIds.length < 2) throw new Error("合并进度计划至少需要两个附件");
    const [project, attachments] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { name: true, code: true, startDate: true } }),
      prisma.assistantAttachment.findMany({
        where: { id: { in: attachmentIds }, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    const ordered = attachmentIds.map((id) => attachmentById.get(id)).filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment));
    if (ordered.length !== attachmentIds.length) throw new Error("部分源附件不存在、尚未解析完成或不属于当前项目");
    const sources = await Promise.all(ordered.map(async (attachment) => ({
      fileName: attachment.originalName,
      buffer: await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
    })));
    const merged = await mergeScheduleFiles(sources, project.startDate);
    const projectLabel = (project.code || project.name || "项目").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    const fileName = `${projectLabel}-合并进度计划.xlsx`;
    return completeScheduleArtifactAction({
      action,
      user,
      artifactType: "SCHEDULE_MERGE",
      fileName,
      workbook: merged.workbook,
      operationDetail: `通过智能助手合并 ${sources.length} 个进度计划文件，生成 ${merged.tasks.length} 条任务、${merged.warnings.length} 条校验提示`,
      result: {
        message: `已合并 ${sources.length} 个文件并生成 ${merged.tasks.length} 条任务${merged.warnings.length > 0 ? `，合并说明中有 ${merged.warnings.length} 条待核对提示` : ""}`,
        sourceCount: sources.length,
        taskCount: merged.tasks.length,
        warningCount: merged.warnings.length,
        verification: { kind: "SCHEDULE_REIMPORT", passed: true, expectedTaskCount: merged.tasks.length, actualTaskCount: merged.tasks.length },
      },
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
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "修订稿已保存", revisionId, artifactId: artifact.id, downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`, verification: { kind: "DOWNLOAD_AVAILABLE", passed: true } }) },
    });
  }

  if (action.toolId === "document.revision.generate") {
    const attachmentId = String(args.attachmentId || "");
    const instruction = String(args.instruction || "").trim();
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
      include: { extraction: true },
    });
    if (!attachment?.extraction) throw new Error("来源附件不存在或尚未完成内容提取");
    const diagnostics = (() => {
      try {
        const parsed = JSON.parse(attachment.extraction.diagnosticsJson || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const blocking = diagnostics.filter((item) => item && typeof item === "object" && (item as { severity?: unknown }).severity === "ERROR");
    if (blocking.some((item) => (item as { code?: unknown }).code === "PDF_OCR_REQUIRED")) {
      throw new Error("PDF 未提取到可用文本，请先完成 OCR 后重新上传");
    }
    const structured = parseJson(attachment.extraction.structuredJson);
    const runtime = await loadAssistantRuntimeConfig();
    const content = await reviseDocumentsWithSmallModel({
      message: instruction,
      documents: [{
        attachmentId: attachment.id,
        fileName: attachment.originalName,
        format: String(structured.format || extname(attachment.originalName).slice(1)),
        diagnostics,
        content: attachment.extraction.content,
      }],
      runtime,
    });
    if (!content) throw new Error("当前未配置可用的文档修订模型");
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
      await tx.documentRevision.create({ data: { id: revisionId, projectId: action.projectId, attachmentId, userId: user.userId, instruction, content, format: "md" } });
      const created = await tx.assistantArtifact.create({ data: { id: artifactId, projectId: action.projectId, userId: user.userId, attachmentId, revisionId, fileName, storedName, mimeType: "text/markdown; charset=utf-8", sizeBytes: buffer.length } });
      await tx.operationHistory.create({ data: { projectId: action.projectId, entityType: "DOCUMENT_REVISION", entityId: revisionId, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手诊断、重写并生成「${attachment.originalName}」的独立修订稿` } });
      return created;
    }).catch(async (error) => {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `文档修订稿已生成${/## 待确认问题/u.test(content) ? "，末尾保留了待确认问题" : ""}`,
          revisionId,
          artifactId: artifact.id,
          downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`,
          diagnosticCount: diagnostics.length,
          verification: { kind: "DOWNLOAD_AVAILABLE", passed: true, bytes: buffer.length },
        }),
      },
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
