export const ASSISTANT_ACCESS_MODES = ["REQUEST_APPROVAL", "AUTO_APPROVE", "FULL_ACCESS"] as const;

export type AssistantAccessMode = (typeof ASSISTANT_ACCESS_MODES)[number];

export const ASSISTANT_ACCESS_MODE_LABELS: Record<AssistantAccessMode, string> = {
  REQUEST_APPROVAL: "请求批准",
  AUTO_APPROVE: "替我审批",
  FULL_ACCESS: "完全访问",
};

export const normalizeAssistantAccessMode = (value: unknown): AssistantAccessMode => (
  ASSISTANT_ACCESS_MODES.includes(value as AssistantAccessMode)
    ? value as AssistantAccessMode
    : "REQUEST_APPROVAL"
);

export const shouldAutoExecuteAssistantAction = (
  mode: AssistantAccessMode,
  riskLevel: string,
) => {
  if (mode === "FULL_ACCESS") return true;
  if (mode === "AUTO_APPROVE") return riskLevel === "LOW" || riskLevel === "MEDIUM";
  return false;
};
