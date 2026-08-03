import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";

import {
  buildAssistantBudgetWorkbook,
  buildAssistantRiskWorkbook,
  buildAssistantScheduleAnalysisWorkbook,
  buildAssistantWeeklyWorkbook,
  getAssistantBudgetWorkbookSheetNames,
  type AssistantBudgetExportItem,
} from "@/lib/assistant-project-export-workbook";

const budgetItem = (overrides: Partial<AssistantBudgetExportItem>): AssistantBudgetExportItem => ({
  id: "item",
  title: "预算项",
  groupName: "",
  person: "",
  personMonths: 0,
  monthlyCostPerPerson: 0,
  unitPrice: 0,
  sampleQuantity: 0,
  productionQuantity: 0,
  amount: 0,
  minRate: 0,
  maxRate: 0,
  currentRate: 0,
  remark: "",
  sortOrder: 1,
  ...overrides,
});

const sheetRows = (workbook: XLSX.WorkBook, name: string) => (
  XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: "" })
);

describe("assistant project export workbook", () => {
  it("separates budget dimensions into homogeneous detail sheets", () => {
    const categories = [
      {
        id: "category-1",
        name: "人力成本",
        kind: "MANPOWER",
        description: "研发人力",
        sortOrder: 1,
        items: [budgetItem({ id: "manpower", title: "前端开发", groupName: "研发组", person: "张三", personMonths: 2, monthlyCostPerPerson: 20_000 })],
      },
      {
        id: "category-2",
        name: "设备采购",
        kind: "PURCHASE",
        description: "设备",
        sortOrder: 2,
        items: [budgetItem({ id: "purchase", title: "测试终端", unitPrice: 100, sampleQuantity: 2, productionQuantity: 3 })],
      },
      {
        id: "category-3",
        name: "差旅成本",
        kind: "OTHER",
        description: "现场支持",
        sortOrder: 3,
        items: [budgetItem({ id: "travel", title: "现场调试", amount: 300 })],
      },
      {
        id: "category-4",
        name: "风险预留",
        kind: "RATE",
        description: "风险费用",
        sortOrder: 4,
        items: [budgetItem({ id: "rate", title: "风险费", minRate: 3, currentRate: 5, maxRate: 8 })],
      },
    ];
    const buffer = buildAssistantBudgetWorkbook({
      projectCode: "F26007",
      projectName: "网络状态控制设备",
      contractAmount: 1_000_000,
      profitTargetRate: 20,
      generatedAt: new Date("2026-08-02T12:00:00.000Z"),
      categories,
    });
    const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });

    expect(getAssistantBudgetWorkbookSheetNames(categories)).toEqual([
      "人力预算",
      "采购预算",
      "差旅预算",
      "费率预算",
      "预算汇总",
      "数据可视化",
    ]);
    expect(workbook.SheetNames).toEqual(getAssistantBudgetWorkbookSheetNames(categories));

    const manpowerHeaders = sheetRows(workbook, "人力预算")[3];
    const purchaseHeaders = sheetRows(workbook, "采购预算")[3];
    const travelHeaders = sheetRows(workbook, "差旅预算")[3];
    const rateRows = sheetRows(workbook, "费率预算");
    expect(manpowerHeaders).toEqual(expect.arrayContaining(["人员", "人月", "月成本/人"]));
    expect(manpowerHeaders).not.toContain("单价");
    expect(purchaseHeaders).toEqual(expect.arrayContaining(["单价", "样机数量", "量产数量", "采购数量合计"]));
    expect(purchaseHeaders).not.toContain("人员");
    expect(travelHeaders).toEqual(["序号", "预算分类", "预算项", "条目金额", "分类说明", "备注"]);
    expect(rateRows[3]).toEqual(expect.arrayContaining(["建议下限(%)", "当前费率(%)", "建议上限(%)"]));
    expect(rateRows[4]).toEqual(expect.arrayContaining([0.03, 0.05, 0.08, 50_000]));
    expect(sheetRows(workbook, "预算汇总").flat()).toEqual(expect.arrayContaining(["预算合计", 90_800]));
    expect(workbook.Sheets["人力预算"].A1.s?.fgColor?.rgb).toBe("1F4E78");
  });

  it("keeps schedule conflicts and field changes in separate sheets", () => {
    const workbook = XLSX.read(buildAssistantScheduleAnalysisWorkbook({
      projectCode: "F26007",
      projectName: "网络状态控制设备",
      generatedAt: new Date("2026-08-02T12:00:00.000Z"),
      issues: [{ ruleId: "OVERDUE", severity: "HIGH", taskCodes: ["Task1"], message: "任务逾期", facts: { progress: 20 }, expected: { progress: 100 }, impactTaskIds: ["Task2"], suggestion: "调整计划" }],
      changes: [{ taskCode: "Task2", taskName: "联调", field: "计划完成", before: "2026-08-01", after: "2026-08-05" }],
    }), { type: "buffer" });

    expect(workbook.SheetNames).toEqual(["分析汇总", "冲突与风险", "字段变化"]);
    expect(sheetRows(workbook, "冲突与风险")[3]).toContain("规则ID");
    expect(sheetRows(workbook, "冲突与风险")[3]).not.toContain("原值");
    expect(sheetRows(workbook, "字段变化")[3]).toEqual(["序号", "任务ID", "任务名称", "字段", "原值", "新值"]);
  });

  it("exports matters and risks as formatted workbooks with stable schemas", () => {
    const identity = { projectCode: "F26007", projectName: "网络状态控制设备", generatedAt: new Date("2026-08-02T12:00:00.000Z") };
    const weekly = XLSX.read(buildAssistantWeeklyWorkbook({
      ...identity,
      rows: [{ matterCode: "Matter001", title: "接口联调", description: "完成联调", taskName: "Task1", owner: "张三", priority: "紧急", status: "进行中", plannedStartDate: "2026-08-01", plannedEndDate: "2026-08-02", actualStartDate: "", actualEndDate: "", progress: 50, health: "健康", issueAndAction: "", dependency: "", risk: "", riskStatus: "无", remark: "" }],
    }), { type: "buffer" });
    const risk = XLSX.read(buildAssistantRiskWorkbook({
      ...identity,
      rows: [{ riskCode: "Risk001", riskName: "交付延期", linkedItemName: "Matter001", category: "进度", trigger: "联调延期", probability: "中", impact: "高", level: "高", response: "提前协调", owner: "张三", status: "跟踪中", targetDate: "2026-08-10" }],
    }), { type: "buffer" });

    expect(weekly.SheetNames).toEqual(["项目事项"]);
    expect(sheetRows(weekly, "项目事项")[3]).toEqual(expect.arrayContaining(["事项ID", "详细事件内容", "当前问题/措施", "依赖条件"]));
    expect(risk.SheetNames).toEqual(["风险登记册"]);
    expect(sheetRows(risk, "风险登记册")[3]).toEqual(expect.arrayContaining(["风险ID", "关联事项", "触发条件", "应对措施"]));
  });
});
