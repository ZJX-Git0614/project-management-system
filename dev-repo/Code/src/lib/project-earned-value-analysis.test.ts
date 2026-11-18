import { describe, expect, it } from "vitest";

import { buildProjectEarnedValueAnalysis } from "@/lib/project-earned-value-analysis";

const budgetItem = {
  id: "budget-1",
  title: "仿真人力",
  person: "孟洵",
  groupName: "仿真组",
  categoryName: "人力预算",
  kind: "MANPOWER",
  personMonths: 1,
  monthlyCostPerPerson: 17_400,
  unitPrice: 0,
  sampleQuantity: 0,
  productionQuantity: 0,
  amount: 0,
  currentRate: 0,
};

const task = {
  id: "task-1",
  taskCode: "WBS-001",
  taskName: "仿真分析",
  startDate: "2026-09-01",
  finishDate: "2026-09-10",
  durationDays: 10,
  progress: 50,
  estimatedWorkHours: 80,
  actualWorkHours: 8,
  budgetAtCompletion: 1_000,
  actualCost: 0,
  budgetItemId: "budget-1",
};

describe("project earned value analysis", () => {
  it("uses frozen personnel worklog costs for modern automatic tasks", () => {
    const result = buildProjectEarnedValueAnalysis({
      tasks: [{ ...task, actualCostMode: "AUTO_LABOR" }],
      budgetItems: [budgetItem],
      contractAmount: 0,
      statusDate: "2026-09-05",
      worklogs: [{ taskId: task.id, projectMemberId: "member-1", actualHours: 8, actualCostSnapshot: 800 }],
    });

    expect(result.rows[0]).toMatchObject({ actualCost: 800, actualWorkHours: 8, actualCostMode: "AUTO_LABOR" });
    expect(result.summary).toMatchObject({ pv: 500, ev: 500, ac: 800, cv: -300 });
  });

  it("keeps legacy manual and task-rate costs mutually exclusive from new worklogs", () => {
    const manual = buildProjectEarnedValueAnalysis({
      tasks: [{ ...task, actualCost: 900, actualCostMode: "LEGACY_MANUAL_TOTAL" }],
      budgetItems: [budgetItem],
      contractAmount: 0,
      statusDate: "2026-09-05",
      worklogs: [{ taskId: task.id, projectMemberId: "member-1", actualHours: 8, actualCostSnapshot: 800 }],
    });
    const taskRate = buildProjectEarnedValueAnalysis({
      tasks: [{ ...task, actualCostMode: "LEGACY_AUTO_TASK_RATE" }],
      budgetItems: [budgetItem],
      contractAmount: 0,
      statusDate: "2026-09-05",
      worklogs: [{ taskId: task.id, projectMemberId: "member-1", actualHours: 8, actualCostSnapshot: 800 }],
    });

    expect(manual.rows[0]).toMatchObject({ actualCost: 900, actualWorkHours: 8 });
    expect(taskRate.rows[0]).toMatchObject({ actualCost: 800, actualWorkHours: 8 });
  });
});
