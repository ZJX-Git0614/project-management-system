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
      "predecessor",
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
    expect(screen.getByText("已选 1 项，共处理 2 行")).toBeInTheDocument();

    fireEvent.click(document.body);
    expect(screen.queryByRole("menu", { name: "甘特任务右键菜单" })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("Task001"));
    expect(screen.getByRole("menu", { name: "甘特任务右键菜单" })).toBeInTheDocument();
    fireEvent.contextMenu(document.body);
    expect(screen.queryByRole("menu", { name: "甘特任务右键菜单" })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("Task001"));

    await userEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    expect(onDeleteSelected).toHaveBeenCalledWith(["task-1", "task-2"]);
  });

  it("selects rows from the sequence column and locks descendants selected by a parent", async () => {
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
        task(3, { taskName: "同级任务" }),
      ]}
      canEdit
    />);

    await userEvent.click(screen.getByRole("button", { name: "选择第 1 行" }));

    expect(screen.getByRole("button", { name: "选择第 1 行" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "选择第 2 行" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "选择第 2 行" })).toHaveAttribute("title", "由父任务联动选择");

    await userEvent.click(screen.getByRole("button", { name: "选择第 2 行" }));
    expect(screen.getByRole("button", { name: "选择第 2 行" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "选择全部任务" }));
    expect(screen.getByRole("button", { name: "取消选择全部任务" })).toBeInTheDocument();
  });

  it("draws the Excel-style outline only through explicitly selected rows", async () => {
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
        task(3, { taskName: "同级任务" }),
      ]}
      canEdit
    />);

    await userEvent.click(screen.getByRole("button", { name: "选择第 1 行" }));

    const firstOutline = document.querySelector('[data-gantt-task-id="task-1"] [data-gantt-selection-outline="true"]');
    const secondOutline = document.querySelector('[data-gantt-task-id="task-2"] [data-gantt-selection-outline="true"]');
    expect(firstOutline).toHaveClass("border-t-2");
    expect(firstOutline).toHaveClass("border-b-2");
    expect(secondOutline).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "选择第 3 行" }), { shiftKey: true });
    const rangeFirstOutline = document.querySelector('[data-gantt-task-id="task-1"] [data-gantt-selection-outline="true"]');
    const rangeSecondOutline = document.querySelector('[data-gantt-task-id="task-2"] [data-gantt-selection-outline="true"]');
    const rangeThirdOutline = document.querySelector('[data-gantt-task-id="task-3"] [data-gantt-selection-outline="true"]');
    expect(rangeFirstOutline).toHaveClass("border-t-2");
    expect(rangeFirstOutline).not.toHaveClass("border-b-2");
    expect(rangeSecondOutline).not.toHaveClass("border-t-2", "border-b-2");
    expect(rangeThirdOutline).not.toHaveClass("border-t-2");
    expect(rangeThirdOutline).toHaveClass("border-b-2");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "选择第 1 行" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "选择第 3 行" }));
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("button", { name: "选择第 3 行" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps sequence cells visually flat like the other table columns", () => {
    render(<GanttTimeline tasks={[task(1)]} canEdit />);

    expect(screen.getByRole("button", { name: "选择全部任务" })).toHaveClass("!rounded-none", "!border-0", "!bg-transparent");
    expect(screen.getByRole("button", { name: "选择第 1 行" })).toHaveClass("!rounded-none", "!border-0", "!bg-transparent");
  });

  it("inserts a chosen number of sibling tasks from the Excel-style submenu", async () => {
    const onInsertTasks = vi.fn().mockResolvedValue({ createdTaskIds: ["created-1", "created-2", "created-3"] });
    render(<GanttTimeline
      projectId="project-1"
      tasks={[task(1)]}
      canCreate
      canEdit
      onInsertTasks={onInsertTasks}
    />);

    fireEvent.contextMenu(screen.getByText("Task001"));
    await userEvent.hover(screen.getByRole("menuitem", { name: "插入" }));
    const countInput = screen.getByRole("spinbutton", { name: "在下方插入个同级任务数量" });
    await userEvent.clear(countInput);
    await userEvent.type(countInput, "3");
    await userEvent.click(screen.getByRole("menuitem", { name: /在下方插入.*个同级任务/ }));

    await waitFor(() => expect(onInsertTasks).toHaveBeenCalledWith("task-1", "SIBLING_AFTER", 3));
  });

  it("resets the insert quantity to one whenever the insert menu is reopened", async () => {
    render(<GanttTimeline
      projectId="project-1"
      tasks={[task(1)]}
      canCreate
      canEdit
      onInsertTasks={vi.fn()}
    />);

    fireEvent.contextMenu(screen.getByText("Task001"));
    await userEvent.hover(screen.getByRole("menuitem", { name: "插入" }));
    const countInput = screen.getByRole("spinbutton", { name: "在下方插入个同级任务数量" });
    await userEvent.clear(countInput);
    await userEvent.type(countInput, "7");
    expect(countInput).toHaveValue(7);

    fireEvent.pointerDown(document.body);
    fireEvent.contextMenu(screen.getByText("Task001"));
    await userEvent.hover(screen.getByRole("menuitem", { name: "插入" }));
    expect(screen.getByRole("spinbutton", { name: "在下方插入个同级任务数量" })).toHaveValue(1);
  });

  it("copies only explicitly selected tasks and asks for a paste position", async () => {
    const onPasteTasks = vi.fn().mockResolvedValue({ taskIds: ["copied-1"] });
    render(<GanttTimeline
      projectId="project-1"
      tasks={[
        task(1, { taskName: "父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
        task(3, { taskName: "目标任务" }),
      ]}
      canEdit
      onPasteTasks={onPasteTasks}
    />);

    await userEvent.click(screen.getByRole("button", { name: "选择第 1 行" }));
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    await userEvent.click(screen.getByRole("button", { name: "选择第 3 行" }));
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    expect(screen.getByRole("menu", { name: "粘贴位置" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "粘贴到行下方" }));
    await waitFor(() => expect(onPasteTasks).toHaveBeenCalledWith("COPY", ["task-1"], "task-3", "AFTER"));
  });

  it("blocks moving a cut branch beside itself without calling the server", async () => {
    const onPasteTasks = vi.fn();
    const onActionError = vi.fn();
    render(<GanttTimeline
      projectId="project-1"
      tasks={[
        task(1, { taskName: "父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
        task(3, { taskName: "其他任务" }),
      ]}
      canEdit
      onActionError={onActionError}
      onPasteTasks={onPasteTasks}
    />);

    await userEvent.click(screen.getByRole("button", { name: "选择第 1 行" }));
    fireEvent.keyDown(window, { key: "x", ctrlKey: true });
    fireEvent.contextMenu(screen.getByText("Task001.001"));
    await userEvent.hover(screen.getByRole("menuitem", { name: "粘贴" }));

    expect(screen.getByRole("menuitem", { name: "粘贴到行上方" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "粘贴到行下方" })).toBeDisabled();
    expect(screen.getByText("请选择被剪切分支以外的目标行")).toBeInTheDocument();
    expect(onPasteTasks).not.toHaveBeenCalled();
    expect(onActionError).not.toHaveBeenCalled();
  });

  it("uses the native horizontal scrollbar and keeps the divider control fixed", async () => {
    render(<GanttTimeline tasks={[task(1)]} canEdit />);

    expect(screen.queryByRole("slider", { name: "甘特图横向滚动" })).not.toBeInTheDocument();
    expect(screen.queryByText("横向滚动")).not.toBeInTheDocument();
    expect(screen.getByTestId("gantt-task-grid-header")).not.toHaveClass("left-0");
    expect(screen.getByTestId("gantt-task-grid-body")).not.toHaveClass("sticky");

    const viewport = screen.getByTestId("gantt-scroll-viewport");
    const surface = viewport.parentElement as HTMLDivElement;
    Object.defineProperty(surface, "clientWidth", { configurable: true, value: 1400 });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 500,
      left: 100,
      right: 1300,
      top: 100,
      width: 1200,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      bottom: 620,
      height: 540,
      left: 80,
      right: 1480,
      top: 80,
      width: 1400,
      x: 80,
      y: 80,
      toJSON: () => ({}),
    });

    viewport.scrollLeft = 0;
    fireEvent.scroll(viewport);
    const divider = screen.getByRole("button", { name: "折叠列" });
    await waitFor(() => expect(divider.style.left).not.toBe(""));
    const initialLeft = divider.style.left;

    viewport.scrollLeft = 640;
    fireEvent.scroll(viewport);

    expect(divider.style.left).toBe(initialLeft);
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
      "durationDays",
    ));
  });
});
