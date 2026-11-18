import { describe, expect, it } from "vitest";

import { buildPersonnelEarnedValue, UNATTRIBUTED_PERSONNEL_ID } from "@/lib/personnel-earned-value";
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
  actualWorkHours: 0,
  budgetAtCompletion: 1_000,
  actualCost: 0,
  budgetItemId: "budget-1",
  ownerMemberId: "meng",
};

const members = [
  { id: "meng", personName: "孟洵", roleName: "仿真工程师" },
  { id: "li", personName: "李明", roleName: "结构工程师" },
];

describe("personnel earned value", () => {
  it("splits BAC/PV/EV by WBS labor hours and assigns AC to the actual worker", () => {
    const worklogs = [{ taskId: "task-1", projectMemberId: "meng", actualHours: 8, actualCostSnapshot: 800 }];
    const analysis = buildProjectEarnedValueAnalysis({
      tasks: [{ ...task, actualCostMode: "AUTO_LABOR" }],
      budgetItems: [budgetItem],
      contractAmount: 0,
      statusDate: "2026-09-05",
      worklogs,
    });
    const result = buildPersonnelEarnedValue({
      analysis,
      members,
      budgetLaborAllocations: [
        { budgetItemId: "budget-1", projectMemberId: "meng", plannedHours: 60, plannedHourlyCost: 100 },
        { budgetItemId: "budget-1", projectMemberId: "li", plannedHours: 20, plannedHourlyCost: 100 },
      ],
      taskLaborAssignments: [
        { taskId: "task-1", projectMemberId: "meng", plannedWorkHours: 60 },
        { taskId: "task-1", projectMemberId: "li", plannedWorkHours: 20 },
      ],
      worklogs,
    });

    expect(result.rows.find((row) => row.projectMemberId === "meng")).toMatchObject({
      bac: 750,
      pv: 375,
      ev: 375,
      ac: 800,
      cv: -425,
      actualWorkHours: 8,
    });
    expect(result.rows.find((row) => row.projectMemberId === "li")).toMatchObject({
      bac: 250,
      pv: 125,
      ev: 125,
      ac: 0,
      cv: 125,
    });
    expect(result.summary).toMatchObject({ bac: 1000, pv: 500, ev: 500, ac: 800 });
  });

  it("exposes legacy cost as an explicit unattributed row instead of assigning it silently", () => {
    const analysis = buildProjectEarnedValueAnalysis({
      tasks: [{ ...task, actualCost: 700, actualWorkHours: 7, actualCostMode: "LEGACY_MANUAL_TOTAL" }],
      budgetItems: [budgetItem],
      contractAmount: 0,
      statusDate: "2026-09-05",
    });
    const result = buildPersonnelEarnedValue({
      analysis,
      members,
      budgetLaborAllocations: [],
      taskLaborAssignments: [{ taskId: "task-1", projectMemberId: "meng", plannedWorkHours: 80 }],
      worklogs: [],
    });
    const unattributed = result.rows.find((row) => row.projectMemberId === null);

    expect(unattributed).toMatchObject({
      personName: "待归集",
      ac: 700,
      actualWorkHours: 7,
      legacyActualCost: 700,
    });
    expect(result.attribution.unattributedActualCost).toBe(700);
    expect(UNATTRIBUTED_PERSONNEL_ID).toBe("__UNATTRIBUTED__");
  });
});
