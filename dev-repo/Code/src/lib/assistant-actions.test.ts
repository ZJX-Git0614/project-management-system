import { describe, expect, it } from "vitest";

import {
  isScheduleMergeRequest,
  parseRiskCreationName,
  parseRiskStatusUpdateIntent,
  parseTodoCompletionTarget,
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

  it("recognizes an explicit request to merge schedule attachments", () => {
    expect(isScheduleMergeRequest("把这两个进度计划文件合并成系统可导入的 Excel")).toBe(true);
    expect(isScheduleMergeRequest("把两个格式不一的进度计划文件合二为一，制作成可导入系统的进度计划")).toBe(true);
    expect(isScheduleMergeRequest("帮我分析这两个计划有什么差异")).toBe(false);
  });
});
