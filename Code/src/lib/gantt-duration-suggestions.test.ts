import { describe, expect, it } from "vitest";

import {
  createGanttDurationSuggestions,
  type GanttDurationSuggestionTask,
} from "@/lib/gantt-duration-suggestions";

const task = (overrides: Partial<GanttDurationSuggestionTask> = {}): GanttDurationSuggestionTask => ({
  id: "task-1",
  projectId: "project-1",
  parentId: "parent",
  taskName: "任务一",
  ownerKeys: ["owner-a"],
  startDate: "",
  finishDate: "",
  durationDays: 0,
  sortOrder: 1,
  predecessorDependencies: [],
  ...overrides,
});

describe("createGanttDurationSuggestions", () => {
  it("按父任务窗口确定性生成 1、1、1、1、3 天建议", () => {
    const result = createGanttDurationSuggestions([
      task({ id: "parent", parentId: null, taskName: "父任务", ownerKeys: [], durationDays: 7 }),
      ...Array.from({ length: 5 }, (_, index) => task({
        id: `child-${index + 1}`,
        taskName: `子任务 ${index + 1}`,
        sortOrder: index + 1,
      })),
    ], "CALENDAR_DAYS");

    expect(result.issues).toEqual([]);
    expect(result.suggestions.map((item) => item.suggestedDurationDays)).toEqual([1, 1, 1, 1, 3]);
    expect(result.suggestions.every((item) => item.source === "SYSTEM_SUGGESTED")).toBe(true);
  });

  it("不同负责人各自使用完整父窗口，不把父工期除以人数", () => {
    const result = createGanttDurationSuggestions([
      task({ id: "parent", parentId: null, ownerKeys: [], durationDays: 7 }),
      task({ id: "a-1", ownerKeys: ["owner-a"], sortOrder: 1 }),
      task({ id: "a-2", ownerKeys: ["owner-a"], sortOrder: 2 }),
      task({ id: "b-1", ownerKeys: ["owner-b"], sortOrder: 3 }),
      task({ id: "b-2", ownerKeys: ["owner-b"], sortOrder: 4 }),
    ], "CALENDAR_DAYS");

    expect(result.suggestions.map((item) => item.suggestedDurationDays)).toEqual([1, 6, 1, 6]);
  });

  it("先扣除同负责人已确认正式工期，再分配剩余窗口", () => {
    const result = createGanttDurationSuggestions([
      task({ id: "parent", parentId: null, ownerKeys: [], durationDays: 7 }),
      task({ id: "formal", durationDays: 2, sortOrder: 1 }),
      task({ id: "missing-1", sortOrder: 2 }),
      task({ id: "missing-2", sortOrder: 3 }),
      task({ id: "missing-3", sortOrder: 4 }),
      task({ id: "missing-4", sortOrder: 5 }),
    ], "CALENDAR_DAYS");

    expect(result.suggestions.map((item) => item.suggestedDurationDays)).toEqual([1, 1, 1, 2]);
  });

  it("参与 FS 依赖的任务也可在父窗口内生成待确认建议值", () => {
    const result = createGanttDurationSuggestions([
      task({ id: "parent", parentId: null, ownerKeys: [], durationDays: 7 }),
      task({ id: "predecessor", sortOrder: 1 }),
      task({
        id: "successor",
        sortOrder: 2,
        predecessorDependencies: [{ predecessorTaskId: "predecessor", type: 1 }],
      }),
    ], "CALENDAR_DAYS");

    expect(result.issues).toEqual([]);
    expect(result.suggestions.map((item) => item.suggestedDurationDays)).toEqual([1, 6]);
    expect(result.suggestions.every((item) => item.reason.includes("FS 关系仅决定后续排期顺序"))).toBe(true);
  });

  it("父级汇总依赖展开到叶子后，仍可为没有显式依赖的子任务拆分父级工期", () => {
    const result = createGanttDurationSuggestions([
      task({
        id: "previous-summary",
        parentId: null,
        taskName: "前置汇总任务",
        ownerKeys: [],
        durationDays: 2,
      }),
      task({
        id: "parent",
        parentId: null,
        taskName: "父任务",
        ownerKeys: [],
        durationDays: 7,
        predecessorDependencies: [{ predecessorTaskId: "previous-summary", type: 1 }],
      }),
      ...Array.from({ length: 5 }, (_, index) => task({
        id: `child-${index + 1}`,
        taskName: `子任务 ${index + 1}`,
        sortOrder: index + 1,
      })),
    ], "CALENDAR_DAYS");

    expect(result.issues).toEqual([]);
    expect(result.suggestions.map((item) => item.suggestedDurationDays)).toEqual([1, 1, 1, 1, 3]);
  });

  it("父窗口不足时阻止产生无法兑现的建议", () => {
    const result = createGanttDurationSuggestions([
      task({ id: "parent", parentId: null, ownerKeys: [], durationDays: 0.5 }),
      task({ id: "child-1", sortOrder: 1 }),
      task({ id: "child-2", sortOrder: 2 }),
    ], "CALENDAR_DAYS");

    expect(result.suggestions).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "INSUFFICIENT_PARENT_WINDOW" }));
  });
});
