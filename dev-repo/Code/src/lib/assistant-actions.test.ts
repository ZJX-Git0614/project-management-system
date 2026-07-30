import { describe, expect, it } from "vitest";

import {
  isScheduleConversionRequest,
  isScheduleMergeRequest,
  parseGanttDepthPruneIntent,
  parseGanttTaskCreateIntent,
  parseGanttTaskDeleteIntent,
  parseGanttTaskTextUpdateIntent,
  parseHierarchyIntent,
  parseRiskCreationName,
  parseRiskDeleteIntent,
  parseRiskStatusUpdateIntent,
  parseTodoCompletionTarget,
  parseTodoDeleteTarget,
  parseWeeklyItemCreateIntent,
  parseWeeklyItemDeleteIntent,
  parseWeeklyItemUpdateIntent,
} from "@/lib/assistant-actions";

describe("assistant action intent parsing", () => {
  it("extracts the target from a todo completion command", () => {
    expect(parseTodoCompletionTarget("请把待办“完成项目验收资料”标记为已完成"))
      .toBe("完成项目验收资料");
    expect(parseTodoCompletionTarget("查看项目待办"))
      .toBeNull();
  });

  it("parses matter status and progress without changing unrelated fields", () => {
    expect(parseWeeklyItemUpdateIntent("将 Matter007 更新为进行中，当前进度 35%"))
      .toEqual({ matterCode: "Matter007", status: "IN_PROGRESS", progress: 35 });
    expect(parseWeeklyItemUpdateIntent("将 Matter007 完成度设置为 35%"))
      .toEqual({ matterCode: "Matter007", status: undefined, progress: 35 });
    expect(parseWeeklyItemUpdateIntent("查看 Matter007"))
      .toBeNull();
  });

  it("parses risk status updates by stable risk code", () => {
    expect(parseRiskStatusUpdateIntent("把 Risk003 状态改为已关闭"))
      .toEqual({ riskCode: "Risk003", status: "已关闭" });
  });

  it("creates a risk name only from an explicit creation command", () => {
    expect(parseRiskCreationName("登记风险：供应商交付延期"))
      .toBe("供应商交付延期");
    expect(parseRiskCreationName("从计划分析冲突创建风险"))
      .toBeNull();
    expect(parseRiskCreationName("有哪些风险"))
      .toBeNull();
  });

  it("parses safe, fully specified Gantt creation and deletion commands", () => {
    expect(parseGanttTaskCreateIntent("新增任务：接口联调；任务类别：软件开发；计划开始：2026-08-01；工期：2.5"))
      .toEqual({ taskName: "接口联调", taskCategory: "软件开发", startDate: "2026-08-01", durationDays: 2.5, parentTaskCode: undefined });
    expect(parseGanttTaskCreateIntent("新增任务：接口联调；任务类别：软件开发"))
      .toBeNull();
    expect(parseGanttTaskDeleteIntent("删除 Task3.2 和 Task4"))
      .toEqual({ taskCodes: ["Task3.2", "Task4"] });
    expect(parseGanttDepthPruneIntent("删除所有第 5 层及更深的甘特任务"))
      .toEqual({ minimumDepth: 5 });
  });

  it("parses supported task editing and hierarchy commands without inventing fields", () => {
    expect(parseGanttTaskTextUpdateIntent("将 Task2.1 任务描述改为完成联调记录"))
      .toEqual({
        taskCode: "Task2.1",
        taskName: undefined,
        taskDescription: "完成联调记录",
        remark: undefined,
      });
    expect(parseGanttTaskTextUpdateIntent("将 Task2.1 负责人改为张三")).toBeNull();
    expect(parseHierarchyIntent("将 Task2.1 下移一个层级"))
      .toEqual({ taskCodes: ["Task2.1"], direction: "INDENT" });
    expect(parseHierarchyIntent("把 Task2.1 上移一个层级"))
      .toEqual({ taskCodes: ["Task2.1"], direction: "OUTDENT" });
  });

  it("requires stable codes for destructive business commands", () => {
    expect(parseWeeklyItemCreateIntent("新增事项：提交验收资料；负责人：张三"))
      .toEqual({ title: "提交验收资料", owner: "张三", description: undefined });
    expect(parseWeeklyItemDeleteIntent("删除 Matter007"))
      .toEqual({ matterCode: "Matter007" });
    expect(parseRiskDeleteIntent("删除 Risk003"))
      .toEqual({ riskCode: "Risk003" });
    expect(parseTodoDeleteTarget("删除待办：整理验收资料"))
      .toBe("整理验收资料");
  });

  it("recognizes an explicit request to merge schedule attachments", () => {
    expect(isScheduleMergeRequest("把这两个进度计划文件合并成系统可导入的 Excel")).toBe(true);
    expect(isScheduleMergeRequest("把两个格式不一的进度计划文件合二为一，制作成可导入系统的进度计划")).toBe(true);
    expect(isScheduleMergeRequest("帮我分析这两个计划有什么差异")).toBe(false);
  });

  it("recognizes a single schedule file conversion request without confusing it with merge", () => {
    const message = "我给你一个mpp文件，你能帮我按照系统的甘特任务格式输出文件吗";
    expect(isScheduleConversionRequest(message)).toBe(true);
    expect(isScheduleMergeRequest(message)).toBe(false);
    expect(isScheduleConversionRequest("把这两个进度计划合并成系统可导入 Excel")).toBe(false);
  });
});
