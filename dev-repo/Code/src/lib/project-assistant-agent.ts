import { proposeAssistantAction, type AssistantActionView } from "@/lib/assistant-actions";
import {
  planProjectAssistantActionWithModel,
  planProjectAssistantWorkflowWithModel,
  shouldPlanProjectAssistantAction,
  shouldPlanProjectAssistantWorkflow,
} from "@/lib/project-assistant-model";
import type { AssistantMessageInput } from "@/lib/project-assistant";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import type { AuthenticatedUser } from "@/lib/server-auth";
import {
  createAssistantWorkflowPlan,
  createAssistantWorkflowPlanFromSteps,
  resumeAssistantWorkflowPlan,
  type AssistantPlanView,
} from "@/lib/assistant-plans";

export type AssistantAgentPlanningStep = {
  stage: "WORKFLOW_PLAN" | "MODEL_WORKFLOW_PLAN" | "DETERMINISTIC_MATCH" | "MODEL_PLAN" | "PLAN_VALIDATION";
  outcome: "MATCHED" | "NO_MATCH" | "SKIPPED" | "REJECTED";
  toolId?: string;
};

export type AssistantAgentResolution = {
  action: AssistantActionView | null;
  plan?: AssistantPlanView;
  trace: {
    requested: boolean;
    outcome: "ACTION_READY" | "NO_ACTION" | "AGENT_DISABLED";
    toolId?: string;
    steps: AssistantAgentPlanningStep[];
  };
};

export const resolveProjectAssistantAction = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  history?: AssistantMessageInput[];
  attachmentIds?: string[];
  allowModelPlanning?: boolean;
  signal?: AbortSignal;
}): Promise<AssistantAgentResolution> => {
  const requested = shouldPlanProjectAssistantAction(params.message);
  if (!params.runtime.agentEnabled) {
    return { action: null, trace: { requested, outcome: "AGENT_DISABLED", steps: [] } };
  }

  const steps: AssistantAgentPlanningStep[] = [];
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
  if (params.allowModelPlanning !== false && shouldPlanProjectAssistantWorkflow(params.message) && !params.signal?.aborted) {
    const modelWorkflow = await planProjectAssistantWorkflowWithModel({
      message: params.message,
      history: params.history ?? [],
      runtime: params.runtime,
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
  let action = await proposeAssistantAction(params);
  steps.push({
    stage: "DETERMINISTIC_MATCH",
    outcome: action ? "MATCHED" : "NO_MATCH",
    toolId: action?.toolId,
  });
  if (action) {
    return { action, trace: { requested: true, outcome: "ACTION_READY", toolId: action.toolId, steps } };
  }

  if (!requested || params.allowModelPlanning === false || params.signal?.aborted) {
    steps.push({ stage: "MODEL_PLAN", outcome: "SKIPPED" });
    return { action: null, trace: { requested, outcome: "NO_ACTION", steps } };
  }

  const plan = await planProjectAssistantActionWithModel({
    message: params.message,
    history: params.history ?? [],
    runtime: params.runtime,
    signal: params.signal,
  });
  steps.push({
    stage: "MODEL_PLAN",
    outcome: plan ? "MATCHED" : "NO_MATCH",
    toolId: plan?.toolId,
  });
  if (!plan || params.signal?.aborted) {
    return { action: null, trace: { requested: true, outcome: "NO_ACTION", steps } };
  }

  action = await proposeAssistantAction({
    ...params,
    message: plan.command,
    expectedToolId: plan.toolId,
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
    },
  };
};
