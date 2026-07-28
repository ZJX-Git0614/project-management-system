import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { GanttTimeline } from "@/components/gantt-timeline";
import type { ProjectGanttTask } from "@/domain/models";

const task = (index: number): ProjectGanttTask => ({
  id: `task-${index}`,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  projectId: "project-1",
  parentId: null,
  taskCode: `Task${String(index).padStart(3, "0")}`,
  taskCategory: "测试",
  taskName: `性能任务 ${index}`,
  startDate: "2026-07-28",
  finishDate: "2026-07-28",
  durationDays: 1,
  actualStartDate: "",
  actualEndDate: "",
  estimatedWorkHours: 8,
  actualWorkHours: 0,
  progress: 0,
  predecessorTask: "",
  predecessorTaskIds: [],
  sortOrder: index,
});

describe("GanttTimeline performance", () => {
  it("renders only viewport rows and loads predecessor choices on demand", async () => {
    const tasks = Array.from({ length: 460 }, (_, index) => task(index + 1));
    render(<GanttTimeline tasks={tasks} canEdit />);

    const renderedRows = screen.getAllByLabelText("拖拽排序");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(80);
    expect(screen.queryByText("Task460 · 性能任务 460")).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "紧前任务" })[0]);
    expect(await screen.findByText("Task460 · 性能任务 460")).toBeInTheDocument();
  });
});
