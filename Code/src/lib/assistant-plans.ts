import type { AssistantActionRun, AssistantPlanRun, AssistantPlanStep } from "@prisma/client";

import { shouldAutoExecuteAssistantAction } from "@/lib/assistant-access";
import { executeAssistantActionWithRecovery } from "@/lib/assistant-action-execution";
import {
  isScheduleComparisonRequest,
  proposeAssistantAction,
  serializeAssistantAction,
  type AssistantActionView,
} from "@/lib/assistant-actions";
import {
  getAssistantToolDefinition,
  loadAssistantRuntimeConfig,
  type AssistantRuntimeConfig,
} from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { userHasPermission, type AuthenticatedUser } from "@/lib/server-auth";

export type AssistantWorkflowStepSeed = {
  toolId: string;
  title: string;
  command: string;
  args?: Record<string, unknown>;
  dependsOn: number[];
};

export type AssistantPlanStepView = {
  id: string;
  stepIndex: number;
  toolId: string;
  title: string;
  status: string;
  riskLevel: string;
  attemptCount: number;
  maxAttempts: number;
  errorCode?: string;
  errorMessage?: string;
  verification?: Record<string, unknown>;
};

export type AssistantPlanView = {
  id: string;
  title: string;
  goal: string;
  status: string;
  currentStepIndex: number;
  expiresAt: string;
  errorCode?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
  steps: AssistantPlanStepView[];
};

export type AssistantPlanActionView = AssistantActionView & { plan?: AssistantPlanView };

const parseObject = (value: string) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const serializeStep = (step: AssistantPlanStep): AssistantPlanStepView => ({
  id: step.id,
  stepIndex: step.stepIndex,
  toolId: step.toolId,
  title: step.title,
  status: step.status,
  riskLevel: step.riskLevel,
  attemptCount: step.attemptCount,
  maxAttempts: step.maxAttempts,
  errorCode: step.errorCode || undefined,
  errorMessage: step.errorMessage || undefined,
  verification: step.verificationJson && step.verificationJson !== "{}" ? parseObject(step.verificationJson) : undefined,
});

export const serializeAssistantPlan = (
  plan: AssistantPlanRun & { steps: AssistantPlanStep[] },
): AssistantPlanView => ({
  id: plan.id,
  title: plan.title,
  goal: plan.goal,
  status: plan.status,
  currentStepIndex: plan.currentStepIndex,
  expiresAt: plan.expiresAt.toISOString(),
  errorCode: plan.errorCode || undefined,
  errorMessage: plan.errorMessage || undefined,
  result: plan.resultJson && plan.resultJson !== "{}" ? parseObject(plan.resultJson) : undefined,
  steps: [...plan.steps].sort((left, right) => left.stepIndex - right.stepIndex).map(serializeStep),
});

const loadPlanView = async (planId: string) => serializeAssistantPlan(await prisma.assistantPlanRun.findUniqueOrThrow({
  where: { id: planId },
  include: { steps: true },
}));

const attachPlan = async (action: AssistantActionView, planId?: string | null): Promise<AssistantPlanActionView> => (
  planId ? { ...action, plan: await loadPlanView(planId) } : action
);

export const buildScheduleWorkflowSteps = (message: string): AssistantWorkflowStepSeed[] | null => {
  if (!isScheduleComparisonRequest(message)) return null;
  const wantsExport = /(导出|下载|报告)/u.test(message);
  const wantsRisk = /风险/u.test(message) && /(转为|创建|登记|生成)/u.test(message);
  const wantsTodo = /(待办|整改)/u.test(message) && /(转为|创建|生成)/u.test(message);
  if (!wantsExport && !wantsRisk && !wantsTodo) return null;
  const steps: AssistantWorkflowStepSeed[] = [{
    toolId: "schedule.compare.file",
    title: "解析并对比上传计划",
    command: message,
    dependsOn: [],
  }];
  if (wantsExport) steps.push({
    toolId: "schedule.analysis.export",
    title: "导出差异与冲突报告",
    command: "导出最新计划差异、冲突和影响链报告",
    dependsOn: [0],
  });
  if (wantsRisk) steps.push({
    toolId: "risk.create.from-analysis",
    title: "将最严重冲突转为风险",
    command: "将最新计划分析中最严重的冲突创建为风险",
    dependsOn: [0],
  });
  if (wantsTodo) steps.push({
    toolId: "todo.create.batch",
    title: "生成计划整改待办",
    command: "将最新计划分析中的冲突处理建议生成整改待办",
    dependsOn: [0],
  });
  return steps.slice(0, 6);
};

const materializePlanStep = async (params: {
  planId: string;
  stepIndex: number;
  user: AuthenticatedUser;
  projectId: string;
  runtime: AssistantRuntimeConfig;
}): Promise<AssistantPlanActionView | null> => {
  const [plan, step] = await Promise.all([
    prisma.assistantPlanRun.findUniqueOrThrow({ where: { id: params.planId } }),
    prisma.assistantPlanStep.findUniqueOrThrow({ where: { planId_stepIndex: { planId: params.planId, stepIndex: params.stepIndex } } }),
  ]);
  const input = parseObject(plan.inputJson);
  const stepInput = parseObject(step.inputJson);
  const attachmentIds = Array.isArray(input.attachmentIds) ? input.attachmentIds.map(String) : [];
  const action = await proposeAssistantAction({
    message: step.command,
    projectId: params.projectId,
    user: params.user,
    runtime: params.runtime,
    attachmentIds: step.stepIndex === 0 ? attachmentIds : [],
    expectedToolId: step.toolId,
    plannedArgs: stepInput.args && typeof stepInput.args === "object" && !Array.isArray(stepInput.args)
      ? stepInput.args as Record<string, unknown>
      : undefined,
  });
  if (!action) {
    await prisma.$transaction([
      prisma.assistantPlanStep.update({
        where: { id: step.id },
        data: { status: "BLOCKED", errorCode: "INPUT_REQUIRED", errorMessage: "当前数据不足以生成该步骤的安全操作预览" },
      }),
      prisma.assistantPlanRun.update({
        where: { id: plan.id },
        data: { status: "WAITING_INPUT", currentStepIndex: step.stepIndex, errorCode: "INPUT_REQUIRED", errorMessage: "请补充步骤所需输入后续跑" },
      }),
    ]);
    return null;
  }
  await prisma.$transaction([
    prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { planId: plan.id, planStepId: step.id },
    }),
    prisma.assistantPlanStep.update({
      where: { id: step.id },
      data: { status: "PROPOSED", inputJson: JSON.stringify({ command: step.command, args: stepInput.args }), errorCode: "", errorMessage: "" },
    }),
    prisma.assistantPlanRun.update({
      where: { id: plan.id },
      data: { status: "AWAITING_APPROVAL", currentStepIndex: step.stepIndex, errorCode: "", errorMessage: "" },
    }),
  ]);
  return attachPlan(action, plan.id);
};

export const createAssistantWorkflowPlanFromSteps = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  attachmentIds?: string[];
  title: string;
  steps: AssistantWorkflowStepSeed[];
}): Promise<{ plan: AssistantPlanView; action: AssistantPlanActionView } | null> => {
  if (!params.runtime.agentEnabled || !params.projectId) return null;
  const seeds = params.steps.slice(0, 6);
  if (seeds.length < 2) return null;
  const enabled = new Set(params.runtime.agentEnabledToolIds);
  if (seeds.some((step) => !enabled.has(step.toolId))) return null;
  const permissions = Array.from(new Set(seeds.flatMap((step) => getAssistantToolDefinition(step.toolId)?.permissions ?? [])));
  if (!(await Promise.all(permissions.map((permission) => userHasPermission(params.user, permission)))).every(Boolean)) return null;
  const expiresAt = new Date(Date.now() + params.runtime.agentActionExpiryMinutes * 60_000);
  const plan = await prisma.assistantPlanRun.create({
    data: {
      userId: params.user.userId,
      username: params.user.username,
      displayName: params.user.displayName,
      projectId: params.projectId,
      title: params.title.slice(0, 100),
      goal: params.message,
      status: "RUNNING",
      inputJson: JSON.stringify({ attachmentIds: params.attachmentIds }),
      expiresAt,
      steps: {
        create: seeds.map((step, stepIndex) => {
          const tool = getAssistantToolDefinition(step.toolId)!;
          return {
            stepIndex,
            toolId: step.toolId,
            title: step.title,
            command: step.command,
            inputJson: JSON.stringify({ command: step.command, args: step.args }),
            riskLevel: tool.riskLevel,
            dependsOnJson: JSON.stringify(step.dependsOn),
            maxAttempts: tool.retryPolicy.maxAttempts,
          };
        }),
      },
    },
    include: { steps: true },
  });
  const action = await materializePlanStep({ ...params, planId: plan.id, stepIndex: 0 });
  if (!action) return null;
  return { plan: await loadPlanView(plan.id), action };
};

export const createAssistantWorkflowPlan = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  attachmentIds?: string[];
}): Promise<{ plan: AssistantPlanView; action: AssistantPlanActionView } | null> => {
  const steps = buildScheduleWorkflowSteps(params.message);
  if (!steps || (params.attachmentIds ?? []).length !== 1) return null;
  return createAssistantWorkflowPlanFromSteps({ ...params, title: "计划差异分析与处置", steps });
};

export const resumeAssistantWorkflowPlan = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  attachmentIds?: string[];
}): Promise<{ plan: AssistantPlanView; action: AssistantPlanActionView } | null> => {
  const plan = await prisma.assistantPlanRun.findFirst({
    where: {
      userId: params.user.userId,
      projectId: params.projectId,
      status: "WAITING_INPUT",
      expiresAt: { gt: new Date() },
    },
    orderBy: { updatedAt: "desc" },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  if (!plan) return null;
  const step = plan.steps.find((item) => item.status === "BLOCKED" && item.stepIndex === plan.currentStepIndex);
  if (!step) return null;
  const existingInput = parseObject(plan.inputJson);
  const attachmentIds = (params.attachmentIds ?? []).length > 0
    ? params.attachmentIds
    : Array.isArray(existingInput.attachmentIds) ? existingInput.attachmentIds.map(String) : [];
  await prisma.$transaction([
    prisma.assistantPlanStep.update({
      where: { id: step.id },
      data: { status: "PENDING", command: params.message, errorCode: "", errorMessage: "" },
    }),
    prisma.assistantPlanRun.update({
      where: { id: plan.id },
      data: { status: "RUNNING", goal: `${plan.goal}\n补充：${params.message}`, inputJson: JSON.stringify({ ...existingInput, attachmentIds }), errorCode: "", errorMessage: "" },
    }),
  ]);
  const action = await materializePlanStep({ ...params, planId: plan.id, stepIndex: step.stepIndex });
  if (!action) return null;
  return { plan: await loadPlanView(plan.id), action };
};

const synchronizePlanStep = async (action: AssistantActionRun) => {
  if (!action.planId || !action.planStepId) return;
  const result = parseObject(action.resultJson);
  const verification = result.verification && typeof result.verification === "object"
    ? result.verification as Record<string, unknown>
    : { kind: getAssistantToolDefinition(action.toolId)?.verifier || "RESULT_PRESENT", passed: action.status === "SUCCEEDED" };
  await prisma.assistantPlanStep.update({
    where: { id: action.planStepId },
    data: {
      status: action.status,
      outputJson: action.resultJson,
      verificationJson: JSON.stringify(verification),
      attemptCount: { increment: 1 },
      errorCode: action.errorCode,
      errorMessage: action.errorMessage,
      startedAt: action.confirmedAt,
      completedAt: action.executedAt,
    },
  });
};

const completePlanIfDone = async (planId: string) => {
  const plan = await prisma.assistantPlanRun.findUniqueOrThrow({ where: { id: planId }, include: { steps: true } });
  if (!plan.steps.every((step) => step.status === "SUCCEEDED")) return false;
  const evidence = plan.steps.sort((left, right) => left.stepIndex - right.stepIndex).map((step) => ({
    stepIndex: step.stepIndex,
    toolId: step.toolId,
    verification: parseObject(step.verificationJson),
  }));
  await prisma.assistantPlanRun.update({
    where: { id: plan.id },
    data: {
      status: "SUCCEEDED",
      completedAt: new Date(),
      resultJson: JSON.stringify({ message: "领域 Agent 计划已完成", verification: { passed: true, steps: evidence } }),
      traceJson: JSON.stringify(evidence),
      errorCode: "",
      errorMessage: "",
    },
  });
  return true;
};

const nextRunnableStep = async (planId: string) => {
  const steps = await prisma.assistantPlanStep.findMany({ where: { planId }, orderBy: { stepIndex: "asc" } });
  const succeeded = new Set(steps.filter((step) => step.status === "SUCCEEDED").map((step) => step.stepIndex));
  return steps.find((step) => {
    if (step.status !== "PENDING") return false;
    const dependencies = JSON.parse(step.dependsOnJson || "[]") as number[];
    return dependencies.every((dependency) => succeeded.has(dependency));
  }) ?? null;
};

export const executeAssistantActionAndAdvancePlan = async (
  initialAction: AssistantActionRun,
  user: AuthenticatedUser,
): Promise<{ action: AssistantPlanActionView; nextAction?: AssistantPlanActionView; plan?: AssistantPlanView }> => {
  let action = initialAction;
  let lastCompleted = initialAction;
  while (true) {
    try {
      lastCompleted = await executeAssistantActionWithRecovery(action, user);
    } catch (error) {
      const failed = await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
      await synchronizePlanStep(failed);
      if (failed.planId) {
        const waitingForInput = failed.errorCode === "INPUT_REQUIRED";
        if (waitingForInput && failed.planStepId) {
          await prisma.assistantPlanStep.update({
            where: { id: failed.planStepId },
            data: { status: "BLOCKED", completedAt: null },
          });
        }
        await prisma.assistantPlanRun.update({
          where: { id: failed.planId },
          data: {
            status: waitingForInput ? "WAITING_INPUT" : "FAILED",
            errorCode: failed.errorCode || "BUSINESS_RULE",
            errorMessage: failed.errorMessage || (error instanceof Error ? error.message : "执行失败"),
          },
        });
      }
      throw error;
    }
    await synchronizePlanStep(lastCompleted);
    if (!lastCompleted.planId) {
      return { action: serializeAssistantAction(lastCompleted) };
    }
    if (lastCompleted.status !== "SUCCEEDED") {
      const status = lastCompleted.status === "CANCELLED" ? "CANCELLED" : "FAILED";
      await prisma.assistantPlanRun.update({
        where: { id: lastCompleted.planId },
        data: {
          status,
          completedAt: new Date(),
          errorCode: lastCompleted.errorCode || lastCompleted.status,
          errorMessage: lastCompleted.errorMessage || `步骤状态：${lastCompleted.status}`,
        },
      });
      const plan = await loadPlanView(lastCompleted.planId);
      return { action: { ...serializeAssistantAction(lastCompleted), plan }, plan };
    }
    if (await completePlanIfDone(lastCompleted.planId)) {
      const plan = await loadPlanView(lastCompleted.planId);
      return { action: { ...serializeAssistantAction(lastCompleted), plan }, plan };
    }
    const next = await nextRunnableStep(lastCompleted.planId);
    if (!next) {
      const plan = await loadPlanView(lastCompleted.planId);
      return { action: { ...serializeAssistantAction(lastCompleted), plan }, plan };
    }
    const runtime = await loadAssistantRuntimeConfig();
    const nextActionView = await materializePlanStep({
      planId: lastCompleted.planId,
      stepIndex: next.stepIndex,
      user,
      projectId: lastCompleted.projectId,
      runtime,
    });
    const plan = await loadPlanView(lastCompleted.planId);
    if (!nextActionView) return { action: { ...serializeAssistantAction(lastCompleted), plan }, plan };
    if (!shouldAutoExecuteAssistantAction(user.assistantAccessMode, nextActionView.riskLevel)) {
      return { action: { ...serializeAssistantAction(lastCompleted), plan }, nextAction: { ...nextActionView, plan }, plan };
    }
    action = await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: nextActionView.id } });
  }
};

export const cancelAssistantPlanAction = async (action: AssistantActionRun) => {
  if (!action.planId || !action.planStepId) return;
  await prisma.$transaction([
    prisma.assistantPlanStep.update({ where: { id: action.planStepId }, data: { status: "CANCELLED", completedAt: new Date() } }),
    prisma.assistantPlanRun.update({ where: { id: action.planId }, data: { status: "CANCELLED", completedAt: new Date() } }),
  ]);
};
