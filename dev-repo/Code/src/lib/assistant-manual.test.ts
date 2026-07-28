import { describe, expect, it } from "vitest";

import { isAssistantManualQuestion, searchAssistantManual } from "@/lib/assistant-manual";

describe("assistant manual", () => {
  it("prefers the progress hierarchy instructions for operation questions", () => {
    const result = searchAssistantManual("怎么把一个任务变成上一个任务的子任务？");
    expect(result).toContain("层级下移");
    expect(result).toContain("上一条同级任务");
  });

  it("does not inject the manual into ordinary business queries", () => {
    expect(isAssistantManualQuestion("当前项目有几个风险")).toBe(false);
    expect(searchAssistantManual("当前项目有几个风险")).toBe("");
  });
});
