import { describe, expect, it } from "vitest";

import { evaluateProjectExecutionHealth } from "@/lib/project-execution-health";
import { resolveProjectExecutionScope, type ProjectExecutionScopeTask } from "@/lib/project-execution";

const task = (id: string, overrides: Partial<ProjectExecutionScopeTask> = {}): ProjectExecutionScopeTask => ({
  id,
  parentId: null,
  taskCode: id,
  taskName: id,
  taskCategory: "TASK",
  startDate: "2026-09-01",
  finishDate: "2026-09-05",
  durationDays: 5,
  estimatedWorkHours: 40,
  progress: 0,
  scheduleStatus: "UNSCHEDULED",
  totalFloatMinutes: null,
  ...overrides,
});

describe("project execution scope and health", () => {
  it("expands a subtree while avoiding parent-child progress double counting", () => {
    const tasks = [
      task("parent", { estimatedWorkHours: 0, progress: 50 }),
      task("child-a", { parentId: "parent", estimatedWorkHours: 10, progress: 100 }),
      task("child-b", { parentId: "parent", estimatedWorkHours: 30, progress: 0 }),
    ];
    const scope = resolveProjectExecutionScope([{ ganttTaskId: "parent", relationType: "SUBTREE" }], tasks);
    expect(scope.resolvedTaskIds).toEqual(["parent", "child-a", "child-b"]);
    expect(scope.effectiveTaskIds).toEqual(["child-a", "child-b"]);
    expect(scope.weightedProgress).toBe(25);
  });

  it("keeps a direct parent out of effective tasks when a selected child exists", () => {
    const tasks = [task("parent"), task("child", { parentId: "parent", progress: 100 })];
    const scope = resolveProjectExecutionScope([
      { ganttTaskId: "parent", relationType: "DIRECT" },
      { ganttTaskId: "child", relationType: "DIRECT" },
    ], tasks);
    expect(scope.effectiveTaskIds).toEqual(["child"]);
    expect(scope.weightedProgress).toBe(100);
  });

  it("marks overdue incomplete tasks as off track", () => {
    const scope = resolveProjectExecutionScope([{ ganttTaskId: "late", relationType: "DIRECT" }], [
      task("late", { finishDate: "2026-09-01", progress: 60 }),
    ]);
    const health = evaluateProjectExecutionHealth({ scope, today: "2026-09-02" });
    expect(health.status).toBe("OFF_TRACK");
    expect(health.evidence.some((item) => item.code === "OVERDUE_TASK")).toBe(true);
  });

  it("keeps pure relative schedules unknown without a concrete date anchor", () => {
    const scope = resolveProjectExecutionScope([{ ganttTaskId: "relative", relationType: "DIRECT" }], [
      task("relative", { startDate: "T0+1", finishDate: "T0+5", progress: 0 }),
    ]);
    expect(evaluateProjectExecutionHealth({ scope, today: "2026-09-02" }).status).toBe("UNKNOWN");
  });

  it("marks open high risks as at risk", () => {
    const scope = resolveProjectExecutionScope([{ ganttTaskId: "task", relationType: "DIRECT" }], [task("task", { progress: 50 })]);
    expect(evaluateProjectExecutionHealth({ scope, openHighRiskCount: 1 }).status).toBe("AT_RISK");
  });
});
