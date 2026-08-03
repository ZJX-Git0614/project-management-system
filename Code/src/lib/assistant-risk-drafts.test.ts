import { describe, expect, it } from "vitest";

import {
  extractAssistantRiskDrafts,
  isContextualRiskRegistrationRequest,
  normalizeAssistantRiskDrafts,
} from "@/lib/assistant-risk-drafts";

const analysis = `
## 当前项目潜在风险分析报告

| 序号 | 潜在风险 | 风险等级建议 | 主要依据 | 可能影响 | 建议应对措施 |
|---:|---|---|---|---|---|
| 1 | 项目整体进度严重滞后风险 | 高 | 461 项任务均已逾期 | 影响项目整体交付 | 立即组织进度复盘 |
| 2 | 计划基线与项目周期不一致风险 | 高 | 项目结束日期早于任务计划日期 | 影响延期责任判定 | 核查并更新计划基线 |
| 3 | 软件开发主线延期风险 | 高 | 软件主线进度为 0% | 影响系统联调 | 拆分可交付模块 |
| 4 | 前端、后端、自研仿真引擎并行延期风险 | 高 | 多个模块同时延期 | 压缩联调测试时间 | 按模块设置负责人 |
| 5 | 预算/成本消耗不可控风险 | 中 | 未提供实际成本 | 延期可能产生额外成本 | 建立预算实际预测对比 |

## 建议优先登记的风险

| 优先级 | 建议风险名称 | 建议等级 | 建议状态 |
|---:|---|---|---|
| 1 | 项目整体进度严重滞后风险 | 高 | 打开 |
| 2 | 计划基线与项目预计结束日期不一致风险 | 高 | 打开 |
| 3 | 软件开发关键路径延期风险 | 高 | 打开 |
| 4 | 多模块并行延期导致集成测试窗口压缩风险 | 中高 | 打开 |
| 5 | 项目延期引发成本超支风险 | 中 | 打开 |
`;

describe("assistant risk drafts", () => {
  it("recognizes a request that writes referenced analysis into the risk register", () => {
    expect(isContextualRiskRegistrationRequest("帮我把以上风险写入风险登记册")).toBe(true);
    expect(isContextualRiskRegistrationRequest("登记风险：供应商延期")).toBe(false);
    expect(isContextualRiskRegistrationRequest("分析一下当前风险")).toBe(false);
  });

  it("uses the recommended risk scope and enriches it from the detailed analysis", () => {
    const drafts = extractAssistantRiskDrafts([{ role: "assistant", content: analysis }]);

    expect(drafts).toHaveLength(5);
    expect(drafts.map((draft) => draft.riskName)).toEqual([
      "项目整体进度严重滞后风险",
      "计划基线与项目预计结束日期不一致风险",
      "软件开发关键路径延期风险",
      "多模块并行延期导致集成测试窗口压缩风险",
      "项目延期引发成本超支风险",
    ]);
    expect(drafts[0]).toMatchObject({
      level: "高",
      status: "识别中",
      category: "进度",
      response: "立即组织进度复盘",
    });
    expect(drafts[0].trigger).toContain("识别依据：461 项任务均已逾期");
    expect(drafts[0].trigger).toContain("可能影响：影响项目整体交付");
    expect(drafts[3].level).toBe("高");
  });

  it("normalizes model-provided risk drafts and removes duplicate names", () => {
    const drafts = normalizeAssistantRiskDrafts([
      { riskName: "供应商延期风险", level: "中高", status: "打开", trigger: "交期延迟" },
      { riskName: " 供应商延期风险 ", level: "低" },
      { title: "预算超支风险", level: "一般", status: "处理中" },
    ]);

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ level: "高", status: "识别中", trigger: "识别依据：交期延迟" });
    expect(drafts[1]).toMatchObject({ category: "成本", level: "中", status: "处理中" });
  });
});
