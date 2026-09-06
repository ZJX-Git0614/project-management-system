/**
 * 操作历史实体类型与动作类型中文映射
 */

const ENTITY_TYPE_LABELS: Record<string, string> = {
  MONTHLY_ITEM: "本月事项（历史）",
  WEEKLY_ITEM: "项目事项",
  Project: "项目",
  ProjectMember: "项目组成员",
  DELIVERY_ITEM: "交付物",
  DELIVERABLE: "交付物",
  DELIVERY_STATUS: "交付物状态",
  DELIVERY_BOM: "交付物 BOM/线缆清单",
  MATERIAL_REVISION: "材料版本",
  PROCUREMENT_ITEM: "采购条目",
  PROCUREMENT_STATUS: "采购状态",
  PROCUREMENT_STATUS_LOG: "采购状态日志",
  PROCUREMENT_BOM_SYNC: "采购 BOM 同步",
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  CREATE: "新增",
  UPDATE: "修改",
  DELETE: "删除",
  STATUS_CHANGED: "状态变更",
  PUBLISH: "发布",
  SYNC: "同步",
  RESTORE: "恢复",
};

export function formatEntityType(type: string): string {
  return ENTITY_TYPE_LABELS[type] ?? type;
}

export function formatActionType(type: string): string {
  return ACTION_TYPE_LABELS[type] ?? type;
}
