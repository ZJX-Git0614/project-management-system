import { AppRole, BudgetCategoryKind, ItemHealth, ItemPriority, ItemRiskStatus, ItemStatus, ProjectStatus, TodoStatus, TodoType } from "@/domain/enums";

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project extends BaseEntity {
  name: string;
  code: string;
  clientName: string;
  amountWan: number;
  deviceCount: number;
  repairCycleDays: number;
  startDate: string;
  expectedEndDate: string;
  status: ProjectStatus;
}

export interface ProjectGanttTask extends BaseEntity {
  projectId: string;
  parentId?: string | null;
  taskCode: string;
  taskCategory: string;
  taskName: string;
  startDate: string;
  durationDays: number;
  predecessorTask: string;
  sortOrder: number;
  project?: Pick<Project, "id" | "name" | "code" | "status">;
}

export interface ProjectBudgetCategory extends BaseEntity {
  projectId: string;
  name: string;
  kind: BudgetCategoryKind;
  description: string;
  sortOrder: number;
  project?: Pick<Project, "id" | "name" | "code" | "status">;
}

export interface ProjectBudgetItem extends BaseEntity {
  projectId: string;
  categoryId: string;
  sortOrder: number;
  // 通用
  title: string;
  // 人力型
  groupName: string;
  person: string;
  personMonths: number;
  monthlyCostPerPerson: number;
  // 采购型
  unitPrice: number;
  sampleQuantity: number;
  productionQuantity: number;
  // 其他型
  amount: number;
  // 费率型（RATE）
  minRate: number;
  maxRate: number;
  defaultRate: number;
  currentRate: number;
  // 备注
  remark: string;
  category?: ProjectBudgetCategory;
  project?: Pick<Project, "id" | "name" | "code" | "status">;
}

export interface ProjectBudgetSetting extends BaseEntity {
  projectId: string;
  contractAmount: number;
  profitTargetRate: number;
  note: string;
  project?: Pick<Project, "id" | "name" | "code" | "status">;
}

export interface RoleConfig extends BaseEntity {
  roleName: string;
  allowMultiple: boolean;
  systemPreset: boolean;
  persons: string[];
}

export interface UserAccount extends BaseEntity {
  username: string;
  displayName: string;
  enabled: boolean;
  assignedRoleNames: string[];
  passwordHash: string;
  passwordResetRequired: boolean;
  passwordUpdatedAt?: string;
}

export interface SystemPerson extends BaseEntity {
  personName: string;
}

export interface ProjectMember extends BaseEntity {
  projectId: string;
  roleName: string;
  personName: string;
}

export interface WeeklyItem extends BaseEntity {
  projectId: string;
  matterCode: string;
  title: string;
  taskName: string;
  description: string;
  dueDate: string;
  status: ItemStatus;
  owner: string;
  priority: ItemPriority;
  plannedStartDate: string;
  actualStartDate: string;
  plannedEndDate: string;
  actualEndDate: string;
  progress: number;
  health: ItemHealth;
  issueAndAction: string;
  dependency: string;
  risk: string;
  riskStatus: ItemRiskStatus;
  remark: string;
}

export interface TodoItem extends BaseEntity {
  projectId: string;
  title: string;
  detail: string;
  targetRole: AppRole;
  targetPersonName?: string;
  type: TodoType;
  status: TodoStatus;
}

export interface OperationHistory extends BaseEntity {
  projectId: string;
  entityType:
    | "MONTHLY_ITEM" // 历史兼容：本月事项模块已退役，不再产生新记录
    | "WEEKLY_ITEM"
    | "PROJECT"
    | "PROJECT_MEMBER"
    | "PROJECT_GANTT_TASK"
    | "PROJECT_BUDGET_ITEM";
  entityId: string;
  actionType: "CREATE" | "UPDATE" | "DELETE" | "STATUS_CHANGED";
  operator: string;
  detail: string;
}

export interface PermissionTreeStateMap {
  [roleName: string]: string[];
}
export type PermissionTreeState = PermissionTreeStateMap;
