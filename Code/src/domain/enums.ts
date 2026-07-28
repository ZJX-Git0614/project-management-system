export enum AppRole {
  PROJECT_MANAGER = "PROJECT_MANAGER",
  MEMBER = "MEMBER",
  ADMIN = "ADMIN",
}

export enum ProjectStatus {
  DRAFT = "DRAFT",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  VOIDED = "VOIDED",
}

export enum ItemStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  DONE = "DONE",
  CANCELED = "CANCELED",
}

export enum ItemPriority {
  LOW = "LOW",
  NORMAL = "NORMAL",
  HIGH = "HIGH",
  URGENT = "URGENT",
}

export enum TodoStatus {
  OPEN = "OPEN",
  DONE = "DONE",
  CANCELED = "CANCELED",
}

export enum TodoType {
  WEEKLY_ITEM_OVERDUE = "WEEKLY_ITEM_OVERDUE",
  CUSTOM = "CUSTOM",
}

export enum ItemHealth {
  HEALTHY = "HEALTHY",       // 绿
  AT_RISK = "AT_RISK",       // 黄
  OFF_TRACK = "OFF_TRACK",   // 红
  UNKNOWN = "UNKNOWN",       // 灰
}

export enum ItemRiskStatus {
  NONE = "NONE",             // 无
  OPEN = "OPEN",             // 开放
  MITIGATED = "MITIGATED",   // 已缓解
  CLOSED = "CLOSED",         // 已关闭
}

export enum BudgetCategoryKind {
  MANPOWER = "MANPOWER",   // 人力型：组别+人员+人月+人均月成本 → 小计=人月×人均
  PURCHASE = "PURCHASE",   // 采购型：标题+单价+样机数+量产数 → 样机/量产/合并小计
  OTHER = "OTHER",         // 差旅型：事项+金额 → 小计=金额
  RATE = "RATE",           // 费率型：标题+建议上下限+当前使用 → 公摊/审价/风险等费率参数
}
