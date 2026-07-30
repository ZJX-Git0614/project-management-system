import { describe, expect, it } from "vitest";

import { calculateEarnedValue, getTaskPlannedProgress } from "@/lib/earned-value";

const task = {
  id: "task-1",
  taskCode: "Task001",
  taskName: "设计",
  startDate: "2026-07-01",
  finishDate: "2026-07-10",
  durationDays: 10,
  progress: 40,
  budgetAtCompletion: 1000,
  actualCost: 500,
};

describe("earned value", () => {
  it("calculates planned progress at the status date", () => {
    expect(getTaskPlannedProgress(task, "2026-06-30")).toBe(0);
    expect(getTaskPlannedProgress(task, "2026-07-05")).toBe(0.5);
    expect(getTaskPlannedProgress(task, "2026-07-10")).toBe(1);
  });

  it("calculates PV through TCPI using the attachment formulas", () => {
    const { summary } = calculateEarnedValue([task], "2026-07-05");

    expect(summary).toMatchObject({ pv: 500, ev: 400, ac: 500, sv: -100, cv: -100, bac: 1000 });
    expect(summary.spi).toBeCloseTo(0.8);
    expect(summary.cpi).toBeCloseTo(0.8);
    expect(summary.atypical).toMatchObject({ etc: 600, eac: 1100, vac: -100 });
    expect(summary.typical.etc).toBeCloseTo(750);
    expect(summary.typical.eac).toBeCloseTo(1250);
    expect(summary.tcpiBac).toBeCloseTo(1.2);
    expect(summary.typical.tcpiEac).toBeCloseTo(0.8);
  });

  it("returns null indices when a denominator is zero", () => {
    const { summary } = calculateEarnedValue([{ ...task, budgetAtCompletion: 0, actualCost: 0 }], "2026-07-05");
    expect(summary.spi).toBeNull();
    expect(summary.cpi).toBeNull();
    expect(summary.tcpiBac).toBeNull();
  });

  it("calculates work-hour performance and excludes summary tasks from totals", () => {
    const { rows, summary } = calculateEarnedValue([
      { ...task, id: "summary", includeInTotals: false, estimatedWorkHours: 80, actualWorkHours: 40 },
      { ...task, id: "leaf", estimatedWorkHours: 80, actualWorkHours: 48 },
    ], "2026-07-05");

    expect(rows[1]).toMatchObject({
      plannedWorkHours: 40,
      earnedWorkHours: 32,
      workVarianceHours: -8,
      actualWorkHours: 48,
    });
    expect(summary).toMatchObject({ pv: 500, ev: 400, ac: 500, bac: 1000 });
    expect(summary).toMatchObject({
      workBasisHours: 80,
      plannedWorkHours: 40,
      earnedWorkHours: 32,
      actualWorkHours: 48,
      plannedProgress: 0.5,
      actualProgress: 0.4,
      scheduleVarianceHours: -8,
      schedulePerformanceIndex: 0.8,
    });
  });

  it("uses planned duration as the work basis when estimated hours are not maintained", () => {
    const { rows, summary } = calculateEarnedValue([
      { ...task, estimatedWorkHours: 0, actualWorkHours: 12 },
    ], "2026-07-05");

    expect(rows[0]).toMatchObject({
      estimatedWorkHours: 0,
      workBasisHours: 75,
      plannedWorkHours: 37.5,
      earnedWorkHours: 30,
    });
    expect(summary.scheduleVarianceHours).toBe(-7.5);
    expect(summary.schedulePerformanceIndex).toBeCloseTo(0.8);
  });
});
