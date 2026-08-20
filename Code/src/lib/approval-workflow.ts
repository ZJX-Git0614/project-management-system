export const APPROVAL_BUSINESS_TYPES = {
  PROJECT_STATUS_CHANGE: "PROJECT_STATUS_CHANGE",
  WBS_BASELINE_PUBLISH: "WBS_BASELINE_PUBLISH",
  WBS_TASK_PROGRESS_SUBMISSION: "WBS_TASK_PROGRESS_SUBMISSION",
  BUDGET_CHANGE: "BUDGET_CHANGE",
  RISK_ACCEPTANCE: "RISK_ACCEPTANCE",
  DOCUMENT_RELEASE: "DOCUMENT_RELEASE",
} as const;

export type ApprovalBusinessType = (typeof APPROVAL_BUSINESS_TYPES)[keyof typeof APPROVAL_BUSINESS_TYPES];

export const APPROVAL_BUSINESS_TYPE_LABEL: Record<string, string> = {
  PROJECT_STATUS_CHANGE: "项目状态变更",
  WBS_BASELINE_PUBLISH: "WBS 基线发布",
  WBS_TASK_PROGRESS_SUBMISSION: "WBS 任务进度提交",
  BUDGET_CHANGE: "项目预算变更",
  RISK_ACCEPTANCE: "风险接受",
  DOCUMENT_RELEASE: "项目文档发布",
};

export const APPROVAL_INSTANCE_STATUS_LABEL: Record<string, string> = {
  PENDING: "审批中",
  APPROVED: "已通过",
  REJECTED: "已退回",
  RETURNED: "已退回修改",
  CANCELED: "已撤销",
  COMPLETION_FAILED: "业务执行失败",
};

export const APPROVAL_NODE_STATUS_LABEL: Record<string, string> = {
  WAITING: "待流转",
  PENDING: "待审批",
  APPROVED: "已通过",
  REJECTED: "已退回",
  RETURNED: "已退回修改",
  SKIPPED: "已跳过",
};

export const APPROVAL_NODE_TYPE_LABEL: Record<string, string> = {
  APPROVAL: "审批",
  CC: "抄送",
  CONDITION: "条件",
  AUTOMATIC: "自动处理",
};

export interface ApprovalNodeActionConfig {
  actionKey: string;
  actionType: "FORM" | "ATTACHMENT" | "BUSINESS_CHECK";
  actionName: string;
  required: boolean;
  config?: Record<string, unknown>;
}

export interface ApprovalWorkflowNodeInput {
  nodeKey: string;
  nodeOrder: number;
  nodeType: "APPROVAL" | "CC" | "CONDITION" | "AUTOMATIC";
  nodeName: string;
  assignmentType: "PROJECT_ROLE" | "ACCOUNT" | "REQUESTER";
  projectRoleName?: string;
  accountId?: string;
  approvalMode?: "ALL" | "ANY";
  requiredApprovals?: number;
  returnTargetNodeKey?: string;
  reminderAfterHours?: number;
  reminderIntervalHours?: number;
  conditionConfig?: Record<string, unknown>;
  actionsConfig?: ApprovalNodeActionConfig[];
}

export interface ApprovalWorkflowDraftInput {
  businessType: string;
  moduleKey: string;
  name: string;
  description?: string;
  enabled?: boolean;
  triggerPermissionKey?: string;
  completionHandlerKey?: string;
  config?: Record<string, unknown>;
  nodes: ApprovalWorkflowNodeInput[];
}

export interface ApprovalWorkflowValidationIssue {
  path: string;
  message: string;
}

const normalizeHours = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(720, Math.round(parsed))) : fallback;
};

export const normalizeApprovalWorkflowNodes = (value: unknown): ApprovalWorkflowNodeInput[] => {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const nodeType = ["APPROVAL", "CC", "CONDITION", "AUTOMATIC"].includes(String(item.nodeType))
      ? String(item.nodeType) as ApprovalWorkflowNodeInput["nodeType"]
      : "APPROVAL";
    const assignmentType = ["PROJECT_ROLE", "ACCOUNT", "REQUESTER"].includes(String(item.assignmentType))
      ? String(item.assignmentType) as ApprovalWorkflowNodeInput["assignmentType"]
      : "PROJECT_ROLE";
    const approvalMode = String(item.approvalMode) === "ANY" ? "ANY" : "ALL";
    const actions = Array.isArray(item.actionsConfig) ? item.actionsConfig : [];
    return {
      nodeKey: String(item.nodeKey || `node-${index + 1}`).trim(),
      nodeOrder: index + 1,
      nodeType,
      nodeName: String(item.nodeName || `审批节点 ${index + 1}`).trim(),
      assignmentType,
      projectRoleName: String(item.projectRoleName || "").trim(),
      accountId: String(item.accountId || "").trim(),
      approvalMode,
      requiredApprovals: Math.max(1, Math.round(Number(item.requiredApprovals) || 1)),
      returnTargetNodeKey: String(item.returnTargetNodeKey || "").trim(),
      reminderAfterHours: normalizeHours(item.reminderAfterHours, 24),
      reminderIntervalHours: normalizeHours(item.reminderIntervalHours, 24),
      conditionConfig: item.conditionConfig && typeof item.conditionConfig === "object"
        ? item.conditionConfig as Record<string, unknown>
        : {},
      actionsConfig: actions.map((action, actionIndex) => {
        const record = action && typeof action === "object" ? action as Record<string, unknown> : {};
        return {
          actionKey: String(record.actionKey || `action-${actionIndex + 1}`).trim(),
          actionType: ["ATTACHMENT", "BUSINESS_CHECK"].includes(String(record.actionType))
            ? String(record.actionType) as ApprovalNodeActionConfig["actionType"]
            : "FORM",
          actionName: String(record.actionName || `节点动作 ${actionIndex + 1}`).trim(),
          required: Boolean(record.required),
          config: record.config && typeof record.config === "object" ? record.config as Record<string, unknown> : {},
        };
      }),
    };
  });
};

export const validateApprovalWorkflowDraft = (input: ApprovalWorkflowDraftInput): ApprovalWorkflowValidationIssue[] => {
  const issues: ApprovalWorkflowValidationIssue[] = [];
  if (!input.businessType.trim()) issues.push({ path: "businessType", message: "业务类型不能为空" });
  if (!input.moduleKey.trim()) issues.push({ path: "moduleKey", message: "所属模块不能为空" });
  if (!input.name.trim()) issues.push({ path: "name", message: "流程名称不能为空" });
  if (input.nodes.length === 0) issues.push({ path: "nodes", message: "至少配置一个审批节点" });

  const keys = new Set<string>();
  input.nodes.forEach((node, index) => {
    const path = `nodes.${index}`;
    if (node.nodeType !== "APPROVAL") {
      issues.push({ path: `${path}.nodeType`, message: "当前版本仅支持审批节点" });
    }
    if (!node.nodeKey) issues.push({ path: `${path}.nodeKey`, message: "节点标识不能为空" });
    if (keys.has(node.nodeKey)) issues.push({ path: `${path}.nodeKey`, message: "节点标识不能重复" });
    keys.add(node.nodeKey);
    if (!node.nodeName) issues.push({ path: `${path}.nodeName`, message: "节点名称不能为空" });
    if (node.nodeType === "APPROVAL") {
      if (node.assignmentType === "PROJECT_ROLE" && !node.projectRoleName) {
        issues.push({ path: `${path}.projectRoleName`, message: "按项目角色审批时必须选择角色" });
      }
      if (node.assignmentType === "ACCOUNT" && !node.accountId) {
        issues.push({ path: `${path}.accountId`, message: "按账号审批时必须选择账号" });
      }
    }
  });

  if (!input.nodes.some((node) => node.nodeType === "APPROVAL")) {
    issues.push({ path: "nodes", message: "流程至少需要一个可执行审批节点" });
  }
  return issues;
};

export const requiredApprovalCount = (mode: "ALL" | "ANY" | undefined, approverCount: number) => (
  mode === "ANY" ? 1 : Math.max(1, approverCount)
);

export const APPROVAL_EFFECT_AUTOMATIC_RETRY_LIMIT = 5;

export const approvalEffectFailurePolicy = (completedAttemptCount: number) => {
  const attempts = Math.max(1, Math.trunc(completedAttemptCount));
  const requiresManualRetry = attempts >= APPROVAL_EFFECT_AUTOMATIC_RETRY_LIMIT;
  return {
    status: requiresManualRetry ? "MANUAL_REVIEW" : "FAILED",
    nextDelayMinutes: requiresManualRetry ? null : Math.min(60, 2 ** Math.min(attempts, 5)),
    requiresManualRetry,
  } as const;
};

export const DEFAULT_APPROVAL_WORKFLOWS: ApprovalWorkflowDraftInput[] = [
  {
    businessType: APPROVAL_BUSINESS_TYPES.PROJECT_STATUS_CHANGE,
    moduleKey: "project-info",
    name: "项目状态变更审批",
    description: "启动、完成、作废或恢复项目时，由项目经理审批后生效。",
    triggerPermissionKey: "project-info:status-request",
    completionHandlerKey: "APPLY_PROJECT_STATUS_CHANGE",
    nodes: [
      {
        nodeKey: "project-manager-approval",
        nodeOrder: 1,
        nodeType: "APPROVAL",
        nodeName: "项目经理审批",
        assignmentType: "PROJECT_ROLE",
        projectRoleName: "项目经理",
        approvalMode: "ALL",
        requiredApprovals: 1,
        reminderAfterHours: 24,
        reminderIntervalHours: 24,
      },
    ],
  },
  {
    businessType: APPROVAL_BUSINESS_TYPES.WBS_BASELINE_PUBLISH,
    moduleKey: "project-wbs",
    name: "WBS 基线发布审批",
    description: "将当前计划日期、工时和成本固化为项目基线前进行审批。",
    triggerPermissionKey: "project-gantt:baseline-request",
    completionHandlerKey: "PUBLISH_WBS_BASELINE",
    nodes: [
      {
        nodeKey: "project-manager-approval",
        nodeOrder: 1,
        nodeType: "APPROVAL",
        nodeName: "项目经理审批",
        assignmentType: "PROJECT_ROLE",
        projectRoleName: "项目经理",
        approvalMode: "ALL",
        requiredApprovals: 1,
        reminderAfterHours: 24,
        reminderIntervalHours: 24,
      },
    ],
  },
];

const WBS_TASK_PROGRESS_SUBMISSION_WORKFLOW: ApprovalWorkflowDraftInput = {
  businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
  moduleKey: "project-wbs",
  name: "WBS 任务进度提交审批",
  description: "末级任务直接负责人提交本人任务执行事实后，经项目经理审批通过再写入 WBS。",
  triggerPermissionKey: "project-gantt:view",
  completionHandlerKey: "APPLY_WBS_TASK_PROGRESS_SUBMISSION",
  nodes: [
    {
      nodeKey: "project-manager-approval",
      nodeOrder: 1,
      nodeType: "APPROVAL",
      nodeName: "项目经理审批",
      assignmentType: "PROJECT_ROLE",
      projectRoleName: "项目经理",
      approvalMode: "ALL",
      requiredApprovals: 1,
      reminderAfterHours: 24,
      reminderIntervalHours: 24,
    },
  ],
};

export const CONFIGURABLE_APPROVAL_WORKFLOWS: ApprovalWorkflowDraftInput[] = [
  ...DEFAULT_APPROVAL_WORKFLOWS,
  WBS_TASK_PROGRESS_SUBMISSION_WORKFLOW,
];

export const approvalActiveKey = (params: { projectId: string; businessType: string; businessId: string }) =>
  `${params.projectId}:${params.businessType}:${params.businessId}`;

const canonicalApprovalPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => canonicalApprovalPayload(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalApprovalPayload(item)]),
  );
};

export const approvalPayloadsMatch = (left: unknown, right: unknown) => (
  JSON.stringify(canonicalApprovalPayload(left)) === JSON.stringify(canonicalApprovalPayload(right))
);

export const approvalBusinessIdForProjectStatus = (projectId: string) => `${projectId}:status`;
export const approvalBusinessIdForWbsBaseline = (projectId: string) => `${projectId}:wbs-baseline`;
export const approvalBusinessIdForWbsTaskProgressSubmission = (projectId: string, taskId: string) =>
  `${projectId}:wbs-task-progress:${taskId}`;
