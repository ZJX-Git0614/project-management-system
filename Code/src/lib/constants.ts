import { AppRole, ItemHealth, ItemPriority, ItemRiskStatus, ItemStatus, ProjectStatus, TodoStatus, TodoType } from "@/domain/enums";

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  [ItemStatus.PENDING]: "未开始",
  [ItemStatus.IN_PROGRESS]: "进行中",
  [ItemStatus.DONE]: "已完成",
};

export const ITEM_PRIORITY_LABEL: Record<ItemPriority, string> = {
  [ItemPriority.LOW]: "低",
  [ItemPriority.NORMAL]: "普通",
  [ItemPriority.HIGH]: "高",
  [ItemPriority.URGENT]: "紧急",
};

export const ITEM_HEALTH_LABEL: Record<ItemHealth, string> = {
  [ItemHealth.HEALTHY]: "健康",
  [ItemHealth.AT_RISK]: "有风险",
  [ItemHealth.OFF_TRACK]: "偏离",
  [ItemHealth.UNKNOWN]: "未知",
};

export const ITEM_RISK_STATUS_LABEL: Record<ItemRiskStatus, string> = {
  [ItemRiskStatus.NONE]: "无",
  [ItemRiskStatus.OPEN]: "开放",
  [ItemRiskStatus.MITIGATED]: "已缓解",
  [ItemRiskStatus.CLOSED]: "已关闭",
};

export const ROLE_LABEL: Record<AppRole, string> = {
  [AppRole.PROJECT_MANAGER]: "项目经理",
  [AppRole.MEMBER]: "项目成员",
  [AppRole.ADMIN]: "超级管理员",
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  [ProjectStatus.DRAFT]: "草稿",
  [ProjectStatus.IN_PROGRESS]: "进行中",
  [ProjectStatus.COMPLETED]: "已完成",
  [ProjectStatus.VOIDED]: "已作废",
};

export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  [TodoStatus.OPEN]: "待处理",
  [TodoStatus.DONE]: "已完成",
  [TodoStatus.CANCELED]: "已取消",
};

export const TODO_TYPE_LABEL: Record<TodoType, string> = {
  [TodoType.WEEKLY_ITEM_OVERDUE]: "项目事项逾期",
  [TodoType.CUSTOM]: "自定义",
};
