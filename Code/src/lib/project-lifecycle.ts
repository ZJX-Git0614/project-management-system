import { ProjectStatus } from "@/domain/enums";

const PROJECT_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.IN_PROGRESS, ProjectStatus.VOIDED],
  [ProjectStatus.IN_PROGRESS]: [ProjectStatus.COMPLETED, ProjectStatus.VOIDED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.IN_PROGRESS],
  [ProjectStatus.VOIDED]: [ProjectStatus.DRAFT, ProjectStatus.IN_PROGRESS],
};

export const canTransitionProjectStatus = (currentStatus: string, targetStatus: string) =>
  currentStatus !== targetStatus && (PROJECT_STATUS_TRANSITIONS[currentStatus] ?? []).includes(targetStatus);

export const assertProjectStatusTransition = (currentStatus: string, targetStatus: string) => {
  if (!canTransitionProjectStatus(currentStatus, targetStatus)) {
    throw new Error(`项目状态不允许从 ${currentStatus} 变更为 ${targetStatus}`);
  }
};

export const projectStatusActionPermission = (currentStatus: string, targetStatus: string, scope = "project-info") => {
  if (targetStatus === ProjectStatus.IN_PROGRESS) {
    return `${scope}:${currentStatus === ProjectStatus.DRAFT ? "start" : "restore"}`;
  }
  if (targetStatus === ProjectStatus.COMPLETED) return `${scope}:complete`;
  if (targetStatus === ProjectStatus.VOIDED) return `${scope}:void`;
  return `${scope}:edit`;
};
