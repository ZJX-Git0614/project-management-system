import { describe, expect, it } from "vitest";

import { buildAssistantSuggestions } from "@/lib/assistant-suggestions";
import type { ProjectAssistantContext } from "@/lib/project-assistant";

const context = {
  project: { id: "project-1" },
  progress: { total: 3 },
  weeklyItems: [{ id: "item-1" }],
  risks: [{ id: "risk-1" }],
  budget: { contractAmount: 100, categories: [] },
  documents: [],
} as unknown as ProjectAssistantContext;

describe("assistant suggestions", () => {
  it("adapts next-step suggestions to recent usage", () => {
    const suggestions = buildAssistantSuggestions({
      context,
      history: [
        { role: "user", content: "分析当前甘特进度" },
        { role: "assistant", content: "已完成分析" },
        { role: "user", content: "哪些任务延期了" },
      ],
    });
    expect(suggestions).toHaveLength(4);
    expect(suggestions[0]).toMatch(/任务|计划|关键路径/);
  });

  it("uses portfolio prompts without a current project", () => {
    expect(buildAssistantSuggestions({ context: null, history: [] }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/项目|待办/)]));
  });
});
