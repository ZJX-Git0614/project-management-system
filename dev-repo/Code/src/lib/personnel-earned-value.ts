import type { EarnedValueSummary } from "@/lib/earned-value";
import {
  type ProjectEarnedValueAnalysis,
  type ProjectEarnedValueWorklog,
  type TaskActualCostMode,
} from "@/lib/project-earned-value-analysis";

export const UNATTRIBUTED_PERSONNEL_ID = "__UNATTRIBUTED__";

const nonNegative = (value: number | null | undefined) => (
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
);

const safeRatio = (numerator: number, denominator: number) => (
  Math.abs(denominator) < 1e-9 ? null : numerator / denominator
);

export interface PersonnelEarnedValueMember {
  id: string;
  personName: string;
  roleName: string;
}

export interface PersonnelBudgetLaborAllocation {
  budgetItemId: string;
  projectMemberId: string;
  plannedHours: number;
  plannedHourlyCost: number;
}

export interface PersonnelTaskLaborAssignment {
  taskId: string;
  projectMemberId: string;
  plannedWorkHours: number;
}

interface PersonnelEarnedValueAccumulator {
  projectMemberId: string | null;
  personName: string;
  roleName: string;
  isUnattributed: boolean;
  taskIds: Set<string>;
  worklogCount: number;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  plannedWorkHours: number;
  earnedWorkHours: number;
  actualWorkHours: number;
  legacyActualCost: number;
  manualAdjustmentCost: number;
}

export interface PersonnelEarnedValueRow {
  projectMemberId: string | null;
  personName: string;
  roleName: string;
  isUnattributed: boolean;
  taskCount: number;
  worklogCount: number;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  spi: number | null;
  cpi: number | null;
  plannedWorkHours: number;
  earnedWorkHours: number;
  actualWorkHours: number;
  workVarianceHours: number;
  legacyActualCost: number;
  manualAdjustmentCost: number;
}

export interface PersonnelEarnedValueResult {
  statusDate: string;
  summary: EarnedValueSummary;
  rows: PersonnelEarnedValueRow[];
  attribution: {
    attributedBac: number;
    unattributedBac: number;
    attributedActualCost: number;
    unattributedActualCost: number;
    legacyActualCost: number;
    manualAdjustmentCost: number;
  };
}

const makeAccumulator = ({
  projectMemberId,
  personName,
  roleName,
  isUnattributed,
}: Pick<PersonnelEarnedValueAccumulator, "projectMemberId" | "personName" | "roleName" | "isUnattributed">): PersonnelEarnedValueAccumulator => ({
  projectMemberId,
  personName,
  roleName,
  isUnattributed,
  taskIds: new Set<string>(),
  worklogCount: 0,
  bac: 0,
  pv: 0,
  ev: 0,
  ac: 0,
  plannedWorkHours: 0,
  earnedWorkHours: 0,
  actualWorkHours: 0,
  legacyActualCost: 0,
  manualAdjustmentCost: 0,
});

const normalizedRecipients = (candidates: Array<{ projectMemberId: string; weight: number }>) => {
  const unique = new Map<string, number>();
  candidates.forEach((candidate) => {
    unique.set(candidate.projectMemberId, (unique.get(candidate.projectMemberId) ?? 0) + nonNegative(candidate.weight));
  });
  const values = [...unique.entries()].map(([projectMemberId, weight]) => ({ projectMemberId, weight }));
  if (values.length === 0) return [];
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return values.map((item) => ({ ...item, ratio: 1 / values.length }));
  return values.map((item) => ({ ...item, ratio: item.weight / total }));
};

const resolvePlanRecipients = ({
  taskId,
  budgetItemId,
  ownerMemberId,
  assignmentsByTaskId,
  budgetAllocationsByItemId,
  knownMemberIds,
}: {
  taskId: string;
  budgetItemId?: string | null;
  ownerMemberId?: string | null;
  assignmentsByTaskId: Map<string, PersonnelTaskLaborAssignment[]>;
  budgetAllocationsByItemId: Map<string, PersonnelBudgetLaborAllocation[]>;
  knownMemberIds: Set<string>;
}) => {
  const taskAssignments = (assignmentsByTaskId.get(taskId) ?? [])
    .filter((assignment) => knownMemberIds.has(assignment.projectMemberId));
  if (taskAssignments.length > 0) {
    return normalizedRecipients(taskAssignments.map((assignment) => ({
      projectMemberId: assignment.projectMemberId,
      weight: assignment.plannedWorkHours,
    })));
  }
  const budgetAllocations = budgetItemId
    ? (budgetAllocationsByItemId.get(budgetItemId) ?? []).filter((allocation) => knownMemberIds.has(allocation.projectMemberId))
    : [];
  if (budgetAllocations.length > 0) {
    return normalizedRecipients(budgetAllocations.map((allocation) => ({
      projectMemberId: allocation.projectMemberId,
      weight: nonNegative(allocation.plannedHours) * nonNegative(allocation.plannedHourlyCost)
        || nonNegative(allocation.plannedHours),
    })));
  }
  if (ownerMemberId && knownMemberIds.has(ownerMemberId)) {
    return [{ projectMemberId: ownerMemberId, weight: 1, ratio: 1 }];
  }
  return [];
};

export const buildPersonnelEarnedValue = ({
  analysis,
  members,
  budgetLaborAllocations,
  taskLaborAssignments,
  worklogs,
}: {
  analysis: ProjectEarnedValueAnalysis;
  members: PersonnelEarnedValueMember[];
  budgetLaborAllocations: PersonnelBudgetLaborAllocation[];
  taskLaborAssignments: PersonnelTaskLaborAssignment[];
  worklogs: ProjectEarnedValueWorklog[];
}): PersonnelEarnedValueResult => {
  const memberById = new Map(members.map((member) => [member.id, member] as const));
  const knownMemberIds = new Set(memberById.keys());
  const accumulators = new Map<string, PersonnelEarnedValueAccumulator>();
  members.forEach((member) => {
    accumulators.set(member.id, makeAccumulator({
      projectMemberId: member.id,
      personName: member.personName,
      roleName: member.roleName,
      isUnattributed: false,
    }));
  });
  const unattributed = () => {
    let accumulator = accumulators.get(UNATTRIBUTED_PERSONNEL_ID);
    if (!accumulator) {
      accumulator = makeAccumulator({
        projectMemberId: null,
        personName: "待归集",
        roleName: "历史成本 / 未分配",
        isUnattributed: true,
      });
      accumulators.set(UNATTRIBUTED_PERSONNEL_ID, accumulator);
    }
    return accumulator;
  };
  const accumulatorFor = (projectMemberId: string | null) => (
    projectMemberId ? accumulators.get(projectMemberId) ?? unattributed() : unattributed()
  );
  const assignmentsByTaskId = new Map<string, PersonnelTaskLaborAssignment[]>();
  taskLaborAssignments.forEach((assignment) => {
    assignmentsByTaskId.set(assignment.taskId, [
      ...(assignmentsByTaskId.get(assignment.taskId) ?? []),
      assignment,
    ]);
  });
  const budgetAllocationsByItemId = new Map<string, PersonnelBudgetLaborAllocation[]>();
  budgetLaborAllocations.forEach((allocation) => {
    budgetAllocationsByItemId.set(allocation.budgetItemId, [
      ...(budgetAllocationsByItemId.get(allocation.budgetItemId) ?? []),
      allocation,
    ]);
  });
  const worklogsByTaskId = new Map<string, ProjectEarnedValueWorklog[]>();
  worklogs.forEach((worklog) => {
    worklogsByTaskId.set(worklog.taskId, [...(worklogsByTaskId.get(worklog.taskId) ?? []), worklog]);
  });
  const taskById = new Map(analysis.analysisTasks.map((task) => [task.id, task] as const));

  analysis.rows.forEach((row) => {
    if (row.includeInTotals === false) return;
    const task = taskById.get(row.id);
    const recipients = resolvePlanRecipients({
      taskId: row.id,
      budgetItemId: row.budgetItemId,
      ownerMemberId: task?.ownerMemberId,
      assignmentsByTaskId,
      budgetAllocationsByItemId,
      knownMemberIds,
    });
    if (recipients.length === 0) {
      const accumulator = unattributed();
      accumulator.taskIds.add(row.id);
      accumulator.bac += nonNegative(row.budgetAtCompletion);
      accumulator.pv += nonNegative(row.pv);
      accumulator.ev += nonNegative(row.ev);
      accumulator.plannedWorkHours += nonNegative(row.plannedWorkHours);
      accumulator.earnedWorkHours += nonNegative(row.earnedWorkHours);
    } else {
      recipients.forEach((recipient) => {
        const accumulator = accumulatorFor(recipient.projectMemberId);
        accumulator.taskIds.add(row.id);
        accumulator.bac += nonNegative(row.budgetAtCompletion) * recipient.ratio;
        accumulator.pv += nonNegative(row.pv) * recipient.ratio;
        accumulator.ev += nonNegative(row.ev) * recipient.ratio;
        accumulator.plannedWorkHours += nonNegative(row.plannedWorkHours) * recipient.ratio;
        accumulator.earnedWorkHours += nonNegative(row.earnedWorkHours) * recipient.ratio;
      });
    }

    const actualCost = analysis.actualCostsByTaskId.get(row.id);
    if (!actualCost) return;
    const mode: TaskActualCostMode = actualCost.mode;
    if (mode === "AUTO_LABOR" || mode === "AUTO_PLUS_ADJUSTMENT") {
      (worklogsByTaskId.get(row.id) ?? []).forEach((worklog) => {
        const accumulator = accumulatorFor(knownMemberIds.has(worklog.projectMemberId) ? worklog.projectMemberId : null);
        accumulator.worklogCount += 1;
        accumulator.ac += nonNegative(worklog.actualCostSnapshot);
        accumulator.actualWorkHours += nonNegative(worklog.actualHours);
      });
      if (actualCost.manualAdjustmentCost > 0) {
        const accumulator = unattributed();
        accumulator.ac += actualCost.manualAdjustmentCost;
        accumulator.manualAdjustmentCost += actualCost.manualAdjustmentCost;
      }
      return;
    }
    const accumulator = unattributed();
    accumulator.ac += actualCost.actualCost;
    accumulator.actualWorkHours += actualCost.actualWorkHours;
    accumulator.legacyActualCost += actualCost.legacyActualCost;
  });

  const rows = [...accumulators.values()]
    .filter((row) => !row.isUnattributed || row.bac > 0 || row.ac > 0 || row.actualWorkHours > 0)
    .map<PersonnelEarnedValueRow>((row) => ({
      projectMemberId: row.projectMemberId,
      personName: row.personName,
      roleName: row.roleName,
      isUnattributed: row.isUnattributed,
      taskCount: row.taskIds.size,
      worklogCount: row.worklogCount,
      bac: row.bac,
      pv: row.pv,
      ev: row.ev,
      ac: row.ac,
      sv: row.ev - row.pv,
      cv: row.ev - row.ac,
      spi: safeRatio(row.ev, row.pv),
      cpi: safeRatio(row.ev, row.ac),
      plannedWorkHours: row.plannedWorkHours,
      earnedWorkHours: row.earnedWorkHours,
      actualWorkHours: row.actualWorkHours,
      workVarianceHours: row.earnedWorkHours - row.plannedWorkHours,
      legacyActualCost: row.legacyActualCost,
      manualAdjustmentCost: row.manualAdjustmentCost,
    }))
    .sort((left, right) => {
      if (left.isUnattributed !== right.isUnattributed) return left.isUnattributed ? 1 : -1;
      return left.personName.localeCompare(right.personName, "zh-CN");
    });
  const unattributedRow = rows.find((row) => row.isUnattributed);

  return {
    statusDate: analysis.statusDate,
    summary: analysis.summary,
    rows,
    attribution: {
      attributedBac: rows.filter((row) => !row.isUnattributed).reduce((sum, row) => sum + row.bac, 0),
      unattributedBac: unattributedRow?.bac ?? 0,
      attributedActualCost: rows.filter((row) => !row.isUnattributed).reduce((sum, row) => sum + row.ac, 0),
      unattributedActualCost: unattributedRow?.ac ?? 0,
      legacyActualCost: rows.reduce((sum, row) => sum + row.legacyActualCost, 0),
      manualAdjustmentCost: rows.reduce((sum, row) => sum + row.manualAdjustmentCost, 0),
    },
  };
};
