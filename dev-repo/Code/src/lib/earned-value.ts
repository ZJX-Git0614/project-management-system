import { addDaysInclusive, diffDays, diffDaysInclusive } from "@/lib/gantt";

export interface EarnedValueTaskInput {
  id: string;
  taskCode: string;
  taskName: string;
  parentId?: string | null;
  startDate: string;
  finishDate?: string;
  durationDays: number;
  progress: number;
  isMilestone?: boolean;
  baselineStartDate?: string;
  baselineFinishDate?: string;
  budgetAtCompletion?: number;
  actualCost?: number;
  estimatedWorkHours?: number;
  actualWorkHours?: number;
  budgetItemId?: string | null;
  budgetSource?: string;
  includeInTotals?: boolean;
}

export interface EarnedValueTaskResult extends EarnedValueTaskInput {
  plannedProgress: number;
  pv: number;
  ev: number;
  sv: number;
  cv: number;
  plannedWorkHours: number;
  earnedWorkHours: number;
  workVarianceHours: number;
}

export interface EarnedValueForecast {
  etc: number | null;
  eac: number | null;
  vac: number | null;
  tcpiEac: number | null;
}

export interface EarnedValueSummary {
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  spi: number | null;
  cpi: number | null;
  bac: number;
  typical: EarnedValueForecast;
  atypical: EarnedValueForecast;
  tcpiBac: number | null;
}

const finiteNonNegative = (value: number | undefined) => (
  Number.isFinite(value) ? Math.max(0, value ?? 0) : 0
);

const safeRatio = (numerator: number, denominator: number) => (
  Math.abs(denominator) < 1e-9 ? null : numerator / denominator
);

export const getTaskPlannedProgress = (task: EarnedValueTaskInput, statusDate: string) => {
  const startDate = task.baselineStartDate || task.startDate;
  const finishDate = task.baselineFinishDate || task.finishDate || addDaysInclusive(task.startDate, task.durationDays);
  if (!startDate || !finishDate || statusDate < startDate) return 0;
  if (statusDate >= finishDate) return 1;
  if (task.isMilestone) return 0;

  const totalDays = diffDaysInclusive(startDate, finishDate);
  const elapsedDays = Math.max(0, diffDays(startDate, statusDate) + 1);
  return Math.min(1, elapsedDays / totalDays);
};

const buildForecast = (bac: number, ev: number, ac: number, etc: number | null): EarnedValueForecast => {
  const eac = etc === null ? null : ac + etc;
  return {
    etc,
    eac,
    vac: eac === null ? null : bac - eac,
    tcpiEac: eac === null ? null : safeRatio(bac - ev, eac - ac),
  };
};

export const calculateEarnedValue = (tasks: EarnedValueTaskInput[], statusDate: string) => {
  const rows: EarnedValueTaskResult[] = tasks.map((task) => {
    const bac = finiteNonNegative(task.budgetAtCompletion);
    const ac = finiteNonNegative(task.actualCost);
    const plannedProgress = getTaskPlannedProgress(task, statusDate);
    const ev = bac * Math.min(100, Math.max(0, task.progress)) / 100;
    const pv = bac * plannedProgress;
    const estimatedWorkHours = finiteNonNegative(task.estimatedWorkHours);
    const actualWorkHours = finiteNonNegative(task.actualWorkHours);
    const plannedWorkHours = estimatedWorkHours * plannedProgress;
    const earnedWorkHours = estimatedWorkHours * Math.min(100, Math.max(0, task.progress)) / 100;
    return {
      ...task,
      budgetAtCompletion: bac,
      actualCost: ac,
      estimatedWorkHours,
      actualWorkHours,
      plannedProgress,
      pv,
      ev,
      sv: ev - pv,
      cv: ev - ac,
      plannedWorkHours,
      earnedWorkHours,
      workVarianceHours: earnedWorkHours - plannedWorkHours,
    };
  });

  const totals = rows.filter((row) => row.includeInTotals !== false).reduce((sum, row) => ({
    pv: sum.pv + row.pv,
    ev: sum.ev + row.ev,
    ac: sum.ac + finiteNonNegative(row.actualCost),
    bac: sum.bac + finiteNonNegative(row.budgetAtCompletion),
  }), { pv: 0, ev: 0, ac: 0, bac: 0 });
  const spi = safeRatio(totals.ev, totals.pv);
  const cpi = safeRatio(totals.ev, totals.ac);
  const atypicalEtc = totals.bac - totals.ev;
  const typicalEtc = cpi === null || Math.abs(cpi) < 1e-9 ? null : (totals.bac - totals.ev) / cpi;

  const summary: EarnedValueSummary = {
    ...totals,
    sv: totals.ev - totals.pv,
    cv: totals.ev - totals.ac,
    spi,
    cpi,
    bac: totals.bac,
    typical: buildForecast(totals.bac, totals.ev, totals.ac, typicalEtc),
    atypical: buildForecast(totals.bac, totals.ev, totals.ac, atypicalEtc),
    tcpiBac: safeRatio(totals.bac - totals.ev, totals.bac - totals.ac),
  };

  return { statusDate, rows, summary };
};
