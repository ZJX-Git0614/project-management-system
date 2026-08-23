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
  ganttCalendarMode?: "CALENDAR_DAYS" | "WORKING_DAYS";
  ganttHardFinishDate?: string;
  ganttRevision?: number;
  ganttBaselineVersion?: number;
  ganttBaselineState?: "DRAFT" | "PUBLISHED" | "CHANGE_DRAFT" | string;
  ganttBaselinePublishedAt?: string | null;
  ganttBaselinePublishedBy?: string;
}

export interface ProjectGanttTask extends BaseEntity {
  projectId: string;
  parentId?: string | null;
  ownerMemberId?: string | null;
  ownerMemberIds?: string[];
  ownerMember?: Pick<ProjectMember, "id" | "accountId" | "personName" | "roleName"> | null;
  ownerMembers?: Array<Pick<ProjectMember, "id" | "accountId" | "personName" | "roleName"> & { roleNames?: string[] }>;
  ownerReadOnly?: boolean;
  taskCode: string;
  taskCategory: string;
  taskName: string;
  taskDescription: string;
  startDate: string;
  finishDate?: string;
  relativeStartOffsetDays?: number | null;
  relativeFinishOffsetDays?: number | null;
  earlyStartDate?: string;
  earlyFinishDate?: string;
  lateStartDate?: string;
  lateFinishDate?: string;
  totalFloatMinutes?: number | null;
  freeFloatMinutes?: number | null;
  scheduleStatus?: string;
  scheduleCalculatedAt?: string | null;
  durationDays: number;
  durationMinutes?: number;
  durationFormat?: number;
  actualStartDate: string;
  actualEndDate: string;
  estimatedWorkHours?: number;
  actualWorkHours?: number;
  progress: number;
  predecessorTask: string;
  remark: string;
  predecessorTaskIds?: string[];
  predecessorDependencies?: ProjectGanttDependency[];
  taskMode?: string;
  startSlot?: "AM" | "PM" | string;
  finishSlot?: "AM" | "PM" | string;
  actualStartSlot?: "AM" | "PM" | string;
  actualFinishSlot?: "AM" | "PM" | string;
  parentBoundaryMode?: "ROLLUP" | "TARGET" | "LOCKED" | string;
  schedulePriority?: number;
  userPriority?: "LOW" | "MEDIUM" | "HIGH" | string;
  effectivePriority?: "LOW" | "MEDIUM" | "HIGH" | "HIGHEST" | string;
  effortDriven?: boolean;
  parallelizable?: boolean;
  isMilestone?: boolean;
  externalUid?: string;
  wbsCode?: string;
  outlineNumber?: string;
  calendarUid?: string;
  constraintType?: number | null;
  constraintDate?: string;
  resourceNotBeforeDate?: string;
  baselineStartDate?: string;
  baselineFinishDate?: string;
  baselineCost?: number;
  budgetAtCompletion?: number;
  actualCost?: number;
  budgetItemId?: string | null;
  baselines?: unknown;
  sortOrder: number;
  project?: Pick<Project, "id" | "name" | "code" | "status">;
}

export interface ProjectGanttDependency extends BaseEntity {
  projectId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  type: number;
  lag: number;
  lagFormat: number;
  unsupportedReason?: string;
  predecessorTask?: Pick<ProjectGanttTask, "id" | "taskCode" | "taskName">;
}

export interface ProjectExecutionTaskLink {
  executionId: string;
  ganttTaskId: string;
  relationType: string;
  createdAt?: string;
  task?: Pick<
    ProjectGanttTask,
    "id" | "taskCode" | "taskName" | "taskCategory" | "parentId" | "startDate" | "finishDate" | "progress"
  >;
}

export interface ProjectExecution extends BaseEntity {
  projectId: string;
  name: string;
  type: string;
  ownerMemberId?: string | null;
  status: string;
  description: string;
  sortOrder: number;
  ownerMember?: Pick<ProjectMember, "id" | "personName" | "roleName"> | null;
  taskLinks: ProjectExecutionTaskLink[];
  planStart?: string;
  planFinish?: string;
  progress?: number;
}

export interface ProjectGanttDeletionPreview {
  rootTaskIds: string[];
  rootTasks: Array<Pick<ProjectGanttTask, "id" | "taskCode" | "taskName">>;
  taskIds: string[];
  deletedTaskCount: number;
  descendantTaskCount: number;
  dependencyCount: number;
  internalDependencyCount: number;
  externalDependencyCount: number;
  detachedWeeklyItemCount: number;
  detachedRiskCount: number;
  affectedRiskCount?: number;
  clearedPredecessorCount: number;
  ganttRevision: number;
}

export interface ProjectGanttDeletionBatch extends BaseEntity {
  projectId: string;
  operatorUserId: string;
  operatorName: string;
  status: "AVAILABLE" | "RESTORED" | "EXPIRED" | "PURGED";
  rootTaskIds: string[];
  summary: ProjectGanttDeletionPreview;
  revisionBeforeDelete: number;
  revisionAfterDelete: number;
  expiresAt: string;
  restoredAt?: string | null;
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
  linkedTasks?: Array<{ id: string; taskCode: string; taskName: string }>;
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
  accountId?: string | null;
  roleName: string;
  roleNames?: string[];
  personName: string;
  capacityHoursPerDay?: number;
  productivityRate?: number;
  maxConcurrentAssignments?: number;
}

export interface ProjectDocumentFile extends BaseEntity {
  projectId: string;
  directoryKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  storageProvider?: "LOCAL" | "CLOUD" | "BOTH";
  cloudPath?: string;
}

export interface WeeklyItem extends BaseEntity {
  projectId: string;
  matterCode: string;
  sortOrder: number;
  title: string;
  ganttTaskId?: string | null;
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
    | "PROJECT_BUDGET_ITEM"
    | "PROJECT_GANTT_IMPORT"
    | "PROJECT_EARNED_VALUE";
  entityId: string;
  actionType: "CREATE" | "UPDATE" | "DELETE" | "RESTORE" | "STATUS_CHANGED";
  operator: string;
  detail: string;
}

export interface PermissionTreeStateMap {
  [roleName: string]: string[];
}
export type PermissionTreeState = PermissionTreeStateMap;
