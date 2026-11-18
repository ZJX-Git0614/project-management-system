import {
  calculateEarnedValue,
  type EarnedValueSummary,
  type EarnedValueTaskInput,
  type EarnedValueTaskResult,
} from "@/lib/earned-value";
import {
  manpowerHourlyCost,
  projectBudgetItemPlannedCost,
  type BudgetCostItemLike,
} from "@/lib/project-budget-cost";

export const TASK_ACTUAL_COST_MODES = [
  "LEGACY_AUTO_TASK_RATE",
  "LEGACY_MANUAL_TOTAL",
  "AUTO_LABOR",
  "AUTO_PLUS_ADJUSTMENT",
] as const;

export type TaskActualCostMode = typeof TASK_ACTUAL_COST_MODES[number];

const taskActualCostModeSet = new Set<string>(TASK_ACTUAL_COST_MODES);

const nonNegative = (value: number | null | undefined) => (
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
);

export const normalizeTaskActualCostMode = (value: unknown): TaskActualCostMode => {
  const normalized = String(value ?? "").trim().toUpperCase();
  return taskActualCostModeSet.has(normalized)
    ? normalized as TaskActualCostMode
    : "AUTO_LABOR";
};

export interface ProjectEarnedValueTask extends EarnedValueTaskInput {
  actualCostMode?: string | null;
  ownerMemberId?: string | null;
}

export interface ProjectEarnedValueBudgetItem extends BudgetCostItemLike {
  id: string;
  title: string;
  person?: string;
  groupName?: string;
  categoryName: string;
}

export interface ProjectEarnedValueWorklog {
  taskId: string;
  projectMemberId: string;
  actualHours: number;
  actualCostSnapshot: number;
}

export interface NormalizedProjectBudgetItem {
  id: string;
  title: string;
  categoryName: string;
  kind: string;
  plannedCost: number;
  hourlyCost: number;
  plannedWorkHours: number;
}

export interface ResolvedTaskActualCost {
  mode: TaskActualCostMode;
  actualCost: number;
  actualWorkHours: number;
  laborActualCost: number;
  laborActualHours: number;
  legacyActualCost: number;
  manualAdjustmentCost: number;
}

export interface ProjectEarnedValueAnalysisTask extends ProjectEarnedValueTask {
  actualCostMode: TaskActualCostMode;
  budgetAtCompletion: number;
  actualCost: number;
  actualWorkHours: number;
  budgetSource: string;
  includeInTotals: boolean;
}

export interface ProjectEarnedValueRow extends EarnedValueTaskResult {
  actualCostMode: TaskActualCostMode;
  budgetSource: string;
}

export interface ProjectEarnedValueAnalysis {
  statusDate: string;
  rows: ProjectEarnedValueRow[];
  summary: EarnedValueSummary;
  analysisTasks: ProjectEarnedValueAnalysisTask[];
  normalizedBudgetItems: NormalizedProjectBudgetItem[];
  budgetSummary: {
    projectBudget: number;
    linkedBudgetItems: number;
    blendedHourlyCost: number;
  };
  actualCostsByTaskId: Map<string, ResolvedTaskActualCost>;
}

export const resolveTaskActualCost = ({
  task,
  worklogs,
  legacyActualCost,
}: {
  task: Pick<ProjectEarnedValueTask, "actualCost" | "actualWorkHours" | "actualCostMode">;
  worklogs: ProjectEarnedValueWorklog[];
  legacyActualCost: number;
}): ResolvedTaskActualCost => {
  const mode = normalizeTaskActualCostMode(task.actualCostMode);
  const laborActualHours = worklogs.reduce((sum, worklog) => sum + nonNegative(worklog.actualHours), 0);
  const laborActualCost = worklogs.reduce((sum, worklog) => sum + nonNegative(worklog.actualCostSnapshot), 0);
  const manualCost = nonNegative(task.actualCost);
  const legacyHours = nonNegative(task.actualWorkHours);
  const resolvedLegacyActualCost = nonNegative(legacyActualCost);

  if (mode === "LEGACY_MANUAL_TOTAL") {
    return {
      mode,
      actualCost: manualCost,
      actualWorkHours: legacyHours,
      laborActualCost,
      laborActualHours,
      legacyActualCost: manualCost,
      manualAdjustmentCost: 0,
    };
  }
  if (mode === "LEGACY_AUTO_TASK_RATE") {
    return {
      mode,
      actualCost: resolvedLegacyActualCost,
      actualWorkHours: legacyHours,
      laborActualCost,
      laborActualHours,
      legacyActualCost: resolvedLegacyActualCost,
      manualAdjustmentCost: 0,
    };
  }
  if (mode === "AUTO_PLUS_ADJUSTMENT") {
    return {
      mode,
      actualCost: laborActualCost + manualCost,
      actualWorkHours: laborActualHours,
      laborActualCost,
      laborActualHours,
      legacyActualCost: 0,
      manualAdjustmentCost: manualCost,
    };
  }
  return {
    mode,
    actualCost: laborActualCost,
    actualWorkHours: laborActualHours,
    laborActualCost,
    laborActualHours,
    legacyActualCost: 0,
    manualAdjustmentCost: 0,
  };
};

export const buildProjectEarnedValueAnalysis = ({
  tasks,
  budgetItems,
  contractAmount,
  statusDate,
  worklogs = [],
}: {
  tasks: ProjectEarnedValueTask[];
  budgetItems: ProjectEarnedValueBudgetItem[];
  contractAmount: number;
  statusDate: string;
  worklogs?: ProjectEarnedValueWorklog[];
}): ProjectEarnedValueAnalysis => {
  const normalizedBudgetItems = budgetItems.map((item) => ({
    id: item.id,
    title: item.title || item.person || item.groupName || item.categoryName,
    categoryName: item.categoryName,
    kind: item.kind,
    plannedCost: projectBudgetItemPlannedCost(item, contractAmount),
    hourlyCost: manpowerHourlyCost(item),
    plannedWorkHours: item.kind === "MANPOWER"
      ? nonNegative(item.personMonths) * 21.75 * 8
      : 0,
  }));
  const budgetById = new Map(normalizedBudgetItems.map((item) => [item.id, item] as const));
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((value): value is string => Boolean(value)));
  const leafTasks = tasks.filter((task) => !parentIds.has(task.id));
  const linkedTaskIdsByBudgetItem = new Map<string, string[]>();
  leafTasks.forEach((task) => {
    if (!task.budgetItemId || !budgetById.has(task.budgetItemId)) return;
    linkedTaskIdsByBudgetItem.set(task.budgetItemId, [
      ...(linkedTaskIdsByBudgetItem.get(task.budgetItemId) ?? []),
      task.id,
    ]);
  });
  const linkedBudgetIds = new Set(linkedTaskIdsByBudgetItem.keys());
  const unlinkedBudgetTotal = normalizedBudgetItems
    .filter((item) => !linkedBudgetIds.has(item.id))
    .reduce((sum, item) => sum + item.plannedCost, 0);
  const unlinkedTasks = leafTasks.filter((task) => !task.budgetItemId && nonNegative(task.budgetAtCompletion) === 0);
  const taskWeight = (task: ProjectEarnedValueTask) => (
    nonNegative(task.estimatedWorkHours) || Math.max(1, nonNegative(task.durationDays)) * 8
  );
  const unlinkedWeightTotal = unlinkedTasks.reduce((sum, task) => sum + taskWeight(task), 0);
  const manpowerItems = normalizedBudgetItems.filter((item) => item.kind === "MANPOWER" && item.hourlyCost > 0);
  const manpowerPlannedHours = manpowerItems.reduce((sum, item) => sum + item.plannedWorkHours, 0);
  const blendedHourlyCost = manpowerPlannedHours > 0
    ? manpowerItems.reduce((sum, item) => sum + item.plannedCost, 0) / manpowerPlannedHours
    : 0;
  const worklogsByTaskId = new Map<string, ProjectEarnedValueWorklog[]>();
  worklogs.forEach((worklog) => {
    worklogsByTaskId.set(worklog.taskId, [...(worklogsByTaskId.get(worklog.taskId) ?? []), worklog]);
  });
  const actualCostsByTaskId = new Map<string, ResolvedTaskActualCost>();

  const analysisTasks: ProjectEarnedValueAnalysisTask[] = tasks.map((task) => {
    const includeInTotals = !parentIds.has(task.id);
    const linkedBudget = task.budgetItemId ? budgetById.get(task.budgetItemId) : undefined;
    const linkedTasks = linkedBudget ? linkedTaskIdsByBudgetItem.get(linkedBudget.id) ?? [] : [];
    const linkedWeightTotal = linkedTasks.reduce((sum, taskId) => {
      const linkedTask = leafTasks.find((item) => item.id === taskId);
      return sum + (linkedTask ? taskWeight(linkedTask) : 0);
    }, 0);
    const allocatedBudget = linkedBudget && includeInTotals
      ? linkedBudget.plannedCost * taskWeight(task) / Math.max(linkedWeightTotal, taskWeight(task))
      : includeInTotals && unlinkedTasks.some((item) => item.id === task.id)
        ? unlinkedBudgetTotal * taskWeight(task) / Math.max(unlinkedWeightTotal, taskWeight(task))
        : 0;
    const budgetAtCompletion = nonNegative(task.budgetAtCompletion) || allocatedBudget;
    const legacyActualCost = linkedBudget?.kind === "MANPOWER" && linkedBudget.hourlyCost > 0
      ? nonNegative(task.actualWorkHours) * linkedBudget.hourlyCost
      : !linkedBudget && blendedHourlyCost > 0
        ? nonNegative(task.actualWorkHours) * blendedHourlyCost
        : 0;
    const actualCost = resolveTaskActualCost({
      task,
      worklogs: worklogsByTaskId.get(task.id) ?? [],
      legacyActualCost,
    });
    actualCostsByTaskId.set(task.id, actualCost);
    const budgetSource = nonNegative(task.budgetAtCompletion) > 0
      ? "任务手工设定"
      : linkedBudget
        ? `${linkedBudget.categoryName} / ${linkedBudget.title}`
        : allocatedBudget > 0
          ? "项目预算按预计工时分摊"
          : "未关联预算";
    return {
      ...task,
      actualCostMode: actualCost.mode,
      budgetAtCompletion,
      actualCost: actualCost.actualCost,
      actualWorkHours: actualCost.actualWorkHours,
      budgetSource,
      includeInTotals,
    };
  });
  const calculated = calculateEarnedValue(analysisTasks, statusDate);
  const analysisTaskById = new Map(analysisTasks.map((task) => [task.id, task] as const));
  const rows = calculated.rows.map((row) => {
    const task = analysisTaskById.get(row.id)!;
    return {
      ...row,
      actualCostMode: task.actualCostMode,
      budgetSource: task.budgetSource,
    };
  });

  return {
    statusDate,
    rows,
    summary: calculated.summary,
    analysisTasks,
    normalizedBudgetItems,
    budgetSummary: {
      projectBudget: normalizedBudgetItems.reduce((sum, item) => sum + item.plannedCost, 0),
      linkedBudgetItems: linkedBudgetIds.size,
      blendedHourlyCost,
    },
    actualCostsByTaskId,
  };
};
