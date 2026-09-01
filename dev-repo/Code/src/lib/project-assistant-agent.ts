import { proposeAssistantAction, type AssistantActionView } from "@/lib/assistant-actions";
import {
  planProjectAssistantActionWithModel,
  planProjectAssistantWorkflowWithModel,
  shouldPlanProjectAssistantAction,
  shouldPlanProjectAssistantWorkflow,
} from "@/lib/project-assistant-model";
import type { AssistantMessageInput } from "@/lib/project-assistant";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import type { AssistantIntentContract } from "@/lib/assistant-intent-contract";
import type { AuthenticatedUser } from "@/lib/server-auth";
import {
  describeAssistantExportFilters,
  parseAssistantProjectExportIntent,
} from "@/lib/assistant-export";
import {
  formatAssistantExportDataObservation,
  observeAssistantProjectExportData,
  type AssistantExportDataObservation,
} from "@/lib/assistant-export-observation";
import {
  createAssistantWorkflowPlan,
  createAssistantWorkflowPlanFromSteps,
  resumeAssistantWorkflowPlan,
  type AssistantPlanView,
} from "@/lib/assistant-plans";
import { isContextualRiskRegistrationRequest } from "@/lib/assistant-risk-drafts";

export type AssistantAgentPlanningStep = {
  stage: "WORKFLOW_PLAN" | "MODEL_WORKFLOW_PLAN" | "DATA_OBSERVATION" | "DETERMINISTIC_MATCH" | "MODEL_PLAN" | "MODEL_REPLAN" | "PLAN_VALIDATION";
  outcome: "MATCHED" | "NO_MATCH" | "SKIPPED" | "REJECTED";
  toolId?: string;
  detail?: string;
};

export type AssistantAgentResolution = {
  action: AssistantActionView | null;
  plan?: AssistantPlanView;
  trace: {
    requested: boolean;
    outcome: "ACTION_READY" | "NO_ACTION" | "AGENT_DISABLED";
    toolId?: string;
    steps: AssistantAgentPlanningStep[];
    objective?: string;
    constraints?: string[];
    observation?: AssistantExportDataObservation;
    decisionSummary?: string;
    toolArgs?: Record<string, unknown>;
  };
};

export const resolveProjectAssistantAction = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  history?: AssistantMessageInput[];
  attachmentIds?: string[];
  intentContract?: AssistantIntentContract;
  allowModelPlanning?: boolean;
  signal?: AbortSignal;
}): Promise<AssistantAgentResolution> => {
  const requested = shouldPlanProjectAssistantAction(params.message, params.intentContract);
  if (!params.runtime.agentEnabled) {
    return { action: null, trace: { requested, outcome: "AGENT_DISABLED", steps: [] } };
  }

  const steps: AssistantAgentPlanningStep[] = [];
  const requestedExportIntent = parseAssistantProjectExportIntent(params.message);
  const workflow = await resumeAssistantWorkflowPlan(params) ?? await createAssistantWorkflowPlan(params);
  steps.push({
    stage: "WORKFLOW_PLAN",
    outcome: workflow ? "MATCHED" : "NO_MATCH",
    toolId: workflow?.action.toolId,
  });
  if (workflow) {
    return {
      action: workflow.action,
      plan: workflow.plan,
      trace: { requested: true, outcome: "ACTION_READY", toolId: workflow.action.toolId, steps },
    };
  }
  if (
    !requestedExportIntent
    && params.allowModelPlanning !== false
    && shouldPlanProjectAssistantWorkflow(params.message, params.intentContract)
    && !params.signal?.aborted
  ) {
    const modelWorkflow = await planProjectAssistantWorkflowWithModel({
      message: params.message,
      history: params.history ?? [],
      runtime: params.runtime,
      intentContract: params.intentContract,
      signal: params.signal,
    });
    const plannedWorkflow = modelWorkflow ? await createAssistantWorkflowPlanFromSteps({
      ...params,
      title: modelWorkflow.title,
      steps: modelWorkflow.steps,
    }) : null;
    steps.push({
      stage: "MODEL_WORKFLOW_PLAN",
      outcome: plannedWorkflow ? "MATCHED" : modelWorkflow ? "REJECTED" : "NO_MATCH",
      toolId: plannedWorkflow?.action.toolId,
    });
    if (plannedWorkflow) {
      return {
        action: plannedWorkflow.action,
        plan: plannedWorkflow.plan,
        trace: { requested: true, outcome: "ACTION_READY", toolId: plannedWorkflow.action.toolId, steps },
      };
    }
  }
  const contextualRiskRegistration = isContextualRiskRegistrationRequest(params.message);
  const preferStructuredModelPlan = requested
    && params.allowModelPlanning !== false
    && !params.signal?.aborted
    && (
      contextualRiskRegistration
      || (
        /(导出|下载)/u.test(params.message)
        && /(任务|甘特|进度|事项|风险|预算|成本)/u.test(params.message)
        && !/(差异|冲突|计划分析|影响链)/u.test(params.message)
      )
    );
  const structuredExportIntent = preferStructuredModelPlan ? requestedExportIntent : null;
  const exportObservation = structuredExportIntent && structuredExportIntent.exportType !== "scheduleAnalysis"
    ? await observeAssistantProjectExportData(params.projectId, structuredExportIntent)
    : undefined;
  const constraints = structuredExportIntent ? describeAssistantExportFilters(structuredExportIntent) : [];
  if (exportObservation) {
    steps.push({
      stage: "DATA_OBSERVATION",
      outcome: "MATCHED",
      toolId: "project.export",
      detail: `读取 ${exportObservation.totalRows} 条真实记录，按当前条件命中 ${exportObservation.matchedRows} 条`,
    });
  }
  const traceContext = {
    objective: (params.intentContract?.understanding || params.message).trim().slice(0, 500),
    ...((params.intentContract?.constraints.length || constraints.length) > 0
      ? { constraints: Array.from(new Set([...(params.intentContract?.constraints ?? []), ...constraints])) }
      : {}),
    ...(exportObservation ? { observation: exportObservation } : {}),
  };
  let modelPlanAttempted = false;
  if (preferStructuredModelPlan) {
    modelPlanAttempted = true;
    const plan = await planProjectAssistantActionWithModel({
      message: params.message,
      history: params.history ?? [],
      runtime: params.runtime,
      intentContract: params.intentContract,
      dataObservation: exportObservation ? formatAssistantExportDataObservation(exportObservation) : undefined,
      signal: params.signal,
    });
    steps.push({
      stage: "MODEL_PLAN",
      outcome: plan ? "MATCHED" : "NO_MATCH",
      toolId: plan?.toolId,
    });
    if (plan && !params.signal?.aborted) {
      const plannedAction = await proposeAssistantAction({
        ...params,
        message: params.message,
        expectedToolId: plan.toolId,
        plannedArgs: plan.args,
      });
      steps.push({
        stage: "PLAN_VALIDATION",
        outcome: plannedAction ? "MATCHED" : "REJECTED",
        toolId: plan.toolId,
      });
      if (plannedAction) {
        return {
          action: plannedAction,
          trace: {
            requested: true,
            outcome: "ACTION_READY",
            toolId: plannedAction.toolId,
            steps,
            ...traceContext,
            decisionSummary: plan.decisionSummary,
            toolArgs: plan.args,
          },
        };
      }
      if (exportObservation && !params.signal?.aborted) {
        const correctedPlan = await planProjectAssistantActionWithModel({
          message: params.message,
          history: params.history ?? [],
          runtime: params.runtime,
          intentContract: params.intentContract,
          dataObservation: formatAssistantExportDataObservation(exportObservation),
          validationFeedback: `上一计划未通过结构化参数校验。必须逐项保留：${constraints.join("、") || "用户原始筛选条件"}。`,
          signal: params.signal,
        });
        steps.push({
          stage: "MODEL_REPLAN",
          outcome: correctedPlan ? "MATCHED" : "NO_MATCH",
          toolId: correctedPlan?.toolId,
        });
        if (correctedPlan) {
          const correctedAction = await proposeAssistantAction({
            ...params,
            message: params.message,
            expectedToolId: correctedPlan.toolId,
            plannedArgs: correctedPlan.args,
          });
          steps.push({
            stage: "PLAN_VALIDATION",
            outcome: correctedAction ? "MATCHED" : "REJECTED",
            toolId: correctedPlan.toolId,
          });
          if (correctedAction) {
            return {
              action: correctedAction,
              trace: {
                requested: true,
                outcome: "ACTION_READY",
                toolId: correctedAction.toolId,
                steps,
                ...traceContext,
                decisionSummary: correctedPlan.decisionSummary,
                toolArgs: correctedPlan.args,
              },
            };
          }
        }
      }
    }
  }
  let action = await proposeAssistantAction(params);
  steps.push({
    stage: "DETERMINISTIC_MATCH",
    outcome: action ? "MATCHED" : "NO_MATCH",
    toolId: action?.toolId,
  });
  if (action) {
    return { action, trace: { requested: true, outcome: "ACTION_READY", toolId: action.toolId, steps, ...traceContext } };
  }

  if (!requested || params.allowModelPlanning === false || params.signal?.aborted || modelPlanAttempted) {
    if (modelPlanAttempted) {
      return { action: null, trace: { requested, outcome: "NO_ACTION", steps, ...traceContext } };
    }
    steps.push({ stage: "MODEL_PLAN", outcome: "SKIPPED" });
    return { action: null, trace: { requested, outcome: "NO_ACTION", steps, ...traceContext } };
  }

  const plan = await planProjectAssistantActionWithModel({
    message: params.message,
    history: params.history ?? [],
    runtime: params.runtime,
    intentContract: params.intentContract,
    dataObservation: exportObservation ? formatAssistantExportDataObservation(exportObservation) : undefined,
    signal: params.signal,
  });
  steps.push({
    stage: "MODEL_PLAN",
    outcome: plan ? "MATCHED" : "NO_MATCH",
    toolId: plan?.toolId,
  });
  if (!plan || params.signal?.aborted) {
    return { action: null, trace: { requested: true, outcome: "NO_ACTION", steps, ...traceContext } };
  }

  action = await proposeAssistantAction({
    ...params,
    message: plan.args ? params.message : plan.command,
    expectedToolId: plan.toolId,
    plannedArgs: plan.args,
  });
  steps.push({
    stage: "PLAN_VALIDATION",
    outcome: action ? "MATCHED" : "REJECTED",
    toolId: plan.toolId,
  });
  return {
    action,
    trace: {
      requested: true,
      outcome: action ? "ACTION_READY" : "NO_ACTION",
      toolId: action?.toolId,
      steps,
      ...traceContext,
      decisionSummary: plan.decisionSummary,
      toolArgs: plan.args,
    },
  };
};
