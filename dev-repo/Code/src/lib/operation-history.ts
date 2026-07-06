/**
 * 操作历史实体类型与动作类型中文映射
 */

const ENTITY_TYPE_LABELS: Record<string, string> = {
  MONTHLY_ITEM: "本月事项（历史）",
  WEEKLY_ITEM: "本周事项",
  Project: "项目",
  ProjectMember: "项目组成员",
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  CREATE: "新增",
  UPDATE: "修改",
  DELETE: "删除",
  STATUS_CHANGED: "状态变更",
};

export function formatEntityType(type: string): string {
  return ENTITY_TYPE_LABELS[type] ?? type;
}

export function formatActionType(type: string): string {
  return ACTION_TYPE_LABELS[type] ?? type;
}
