import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GanttTimeline } from "@/components/gantt-timeline";
import type { ProjectGanttTask } from "@/domain/models";

const task = (index: number, overrides: Partial<ProjectGanttTask> = {}): ProjectGanttTask => ({
  id: `task-${index}`,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
  projectId: "project-1",
  parentId: null,
  taskCode: `Task${String(index).padStart(3, "0")}`,
  taskCategory: "测试",
  taskName: `性能任务 ${index}`,
  taskDescription: "",
  startDate: "2026-07-28",
  finishDate: "2026-07-28",
  durationDays: 1,
  actualStartDate: "",
  actualEndDate: "",
  estimatedWorkHours: 8,
  actualWorkHours: 0,
  progress: 0,
  predecessorTask: "",
  remark: "",
  predecessorTaskIds: [],
  sortOrder: index,
  ...overrides,
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
  }, 15_000);

  it("selects multiple predecessors from a searchable hierarchy and applies them together", async () => {
    const onUpdateTask = vi.fn();
    const tasks = [
      task(1),
      task(2, { taskCategory: "研发", taskName: "父任务" }),
      task(3, { parentId: "task-2", taskCategory: "研发 / 接口", taskName: "子任务" }),
    ];
    render(<GanttTimeline tasks={tasks} canEdit onUpdateTask={onUpdateTask} />);

    await userEvent.click(screen.getAllByRole("button", { name: "紧前任务" })[0]);
    expect(screen.queryByText("Task003 · 子任务")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开 Task002 子任务" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 Task002" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 Task003" }));
    await userEvent.click(screen.getByRole("button", { name: "应用紧前任务" }));

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({ predecessorTaskIds: ["task-2", "task-3"] }),
    ));
  });

  it("hides optional columns from both the header and task rows", async () => {
    render(<GanttTimeline tasks={[task(1)]} canEdit />);
    expect(screen.getByRole("button", { name: "负责人" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "列设置" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "负责人" }));

    expect(screen.queryByRole("button", { name: "负责人" })).not.toBeInTheDocument();
  });

  it("opens a task context menu and requests deletion for that task subtree", async () => {
    const onDeleteSelected = vi.fn();
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
      ]}
      canCreate
      canDelete
      canEdit
      onDeleteSelected={onDeleteSelected}
    />);

    fireEvent.contextMenu(screen.getByText("Task001"));

    expect(screen.getByRole("menu", { name: "甘特任务右键菜单" })).toBeInTheDocument();
    expect(screen.getByText("含 1 个子任务")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: "删除任务（含子任务）" }));

    expect(onDeleteSelected).toHaveBeenCalledWith(["task-1"]);
  });

  it("shows unscheduled duration and work fields as placeholders, then accepts a half-day duration", async () => {
    const onUpdateTask = vi.fn();
    render(<GanttTimeline tasks={[task(1, {
      durationDays: 0,
      finishDate: "",
      estimatedWorkHours: 0,
      actualWorkHours: 0,
    })]} canEdit onUpdateTask={onUpdateTask} />);

    expect(screen.getByLabelText("工期天数")).toHaveValue("--");
    expect(screen.getByLabelText("预计工时")).toHaveValue("--");
    expect(screen.getByLabelText("实际工时")).toHaveValue("--");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("工期天数"));
    await user.type(screen.getByLabelText("工期天数"), "0.5");
    await user.tab();

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({ durationDays: 0.5, estimatedWorkHours: 3.75 }),
    ));
  });
});
