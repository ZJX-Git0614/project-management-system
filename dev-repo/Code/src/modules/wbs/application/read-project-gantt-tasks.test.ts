import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrderedGanttTasks: vi.fn(),
  materializeProjectGanttRelativeSchedule: vi.fn(),
  serializeGanttTaskList: vi.fn(),
}));

vi.mock("@/lib/gantt-task-service", () => mocks);

describe("readProjectGanttTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrderedGanttTasks.mockResolvedValue([
      { id: "task-1", relativeStartOffsetDays: 0, relativeFinishOffsetDays: 2 },
    ]);
    mocks.serializeGanttTaskList.mockImplementation((tasks) => tasks.map((task: { id: string }) => ({ id: task.id })));
  });

  it("materializes relative schedules before returning the WBS read model", async () => {
    const { readProjectGanttTasks } = await import("./read-project-gantt-tasks");

    const result = await readProjectGanttTasks({ projectId: "project-1", projectStartDate: "2026-09-01" });

    expect(mocks.materializeProjectGanttRelativeSchedule).toHaveBeenCalledWith("project-1", "2026-09-01");
    expect(mocks.getOrderedGanttTasks).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ id: "task-1" }]);
  });

  it("does not materialize an already absolute schedule", async () => {
    mocks.getOrderedGanttTasks.mockResolvedValue([{ id: "task-1", relativeStartOffsetDays: null, relativeFinishOffsetDays: null }]);
    const { readProjectGanttTasks } = await import("./read-project-gantt-tasks");

    await readProjectGanttTasks({ projectId: "project-1", projectStartDate: "2026-09-01" });

    expect(mocks.materializeProjectGanttRelativeSchedule).not.toHaveBeenCalled();
    expect(mocks.getOrderedGanttTasks).toHaveBeenCalledOnce();
  });
});
