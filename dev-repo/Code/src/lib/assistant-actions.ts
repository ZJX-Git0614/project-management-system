import { randomUUID } from "crypto";

import type { AssistantActionRun } from "@prisma/client";

import type { AuthenticatedUser } from "@/lib/server-auth";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";

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

const parseExportType = (message: string) => {
  if (!/(导出|下载)/u.test(message)) return null;
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
}): Promise<AssistantActionView | null> => {
  if (!params.runtime.agentEnabled || !params.projectId) return null;
  if (!(await ensureProjectAccess(params.user, params.projectId))) return null;
  const enabled = new Set(params.runtime.agentEnabledToolIds);

  if (enabled.has("todo.create") && /(创建|新增|新建).*(待办)|待办.*(创建|新增|新建)/u.test(params.message)) {
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
  if (enabled.has("gantt.progress.update") && progressIntent) {
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

  const exportType = parseExportType(params.message);
  if (enabled.has("project.export") && exportType) {
    const label = { gantt: "任务进度", weekly: "本周事项", risk: "风险登记册", budget: "项目预算" }[exportType];
    return createProposal({
      ...params,
      toolId: "project.export",
      riskLevel: "LOW",
      args: { exportType },
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
          detail: "由项目智能助手创建",
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
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "待办已创建", todoId: todo.id, title: todo.title }) },
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
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "任务进度已更新", taskId: updated.id, progress: updated.progress }) },
    });
  }

  if (action.toolId === "project.export") {
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "导出文件已生成", downloadUrl: `/api/assistant/exports/${action.id}` }) },
    });
  }

  throw new Error("不支持的 Agent 工具");
};
