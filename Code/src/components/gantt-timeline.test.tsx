import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { buildGanttCriticalPaths, GanttTimeline } from "@/components/gantt-timeline";
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
  it("renders relative offsets on the abstract timeline", () => {
    render(<GanttTimeline tasks={[
      task(1, { taskName: "抽象阶段", startDate: "", finishDate: "", durationDays: 3, relativeStartOffsetDays: 0, relativeFinishOffsetDays: 2 }),
      task(2, { taskName: "后续阶段", startDate: "", finishDate: "", durationDays: 2, relativeStartOffsetDays: 5, relativeFinishOffsetDays: 6, predecessorTaskIds: ["task-1"] }),
    ]} canEdit />);

    expect(screen.getAllByText("T0").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/T0\+5/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("计划开始")[0]).toHaveTextContent("T0");
    expect(screen.getAllByTitle(/抽象阶段:/).length).toBeGreaterThan(0);
  });

  it("uses one calendar coordinate system after project T0 is concrete", () => {
    render(<GanttTimeline
      projectStartDate="2026-07-28"
      tasks={[
        task(1, {
          taskName: "已落地阶段",
          relativeStartOffsetDays: 0,
          relativeFinishOffsetDays: 0,
        }),
      ]}
      canEdit
    />);

    expect(screen.queryByText(/^T0(?:\+\d+)?$/)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("计划开始")[0]).not.toHaveTextContent("T0");
  });

  it("fills timeline rows with the same hierarchy palette used by task rows", () => {
    const { container } = render(<GanttTimeline
      projectStartDate="2026-07-28"
      tasks={[
        task(1, { taskName: "父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
      ]}
      canEdit
    />);

    const backgrounds = [...container.querySelectorAll<HTMLElement>("[data-gantt-timeline-row-background]")];
    expect(backgrounds).toHaveLength(2);
    expect(backgrounds[0].style.backgroundColor).not.toBe("");
    expect(backgrounds[0].style.backgroundColor).not.toBe(backgrounds[1].style.backgroundColor);
  });

  it("keeps task and owner labels visible for short gantt bars", () => {
    const ownerName = "赵佳鑫（项目经理兼总体负责人）";
    render(<GanttTimeline tasks={[
      task(1, {
        taskName: "跨阶段总体任务",
        startDate: "2026-07-01",
        finishDate: "2026-07-01",
        durationDays: 1,
        ownerMembers: [{
          id: "member-1",
          accountId: "account-1",
          personName: ownerName,
          roleName: "项目经理",
          roleNames: ["项目经理"],
        }],
      }),
    ]} canEdit />);

    const label = screen.getByText(`跨阶段总体任务 · ${ownerName}`);
    expect(label).toHaveClass("absolute", "whitespace-nowrap");
    expect(label).not.toHaveClass("truncate");
    expect(label).toHaveAttribute("data-gantt-bar-label-side", "right");
    expect(Number.parseFloat(label.getAttribute("style")?.match(/width:\s*([\d.]+)px/)?.[1] ?? "0")).toBeGreaterThan(220);
  });

  it("keeps a long gantt label in the reserved lane after the gantt bar", () => {
    const longTaskName = "跨越整个计划周期的总体任务，需要完整展示任务名称以及全部负责人姓名并避免在甘特图边界处被截断";
    const { container } = render(<GanttTimeline tasks={[
      task(1, {
        taskName: longTaskName,
        startDate: "2026-01-01",
        finishDate: "2028-09-26",
        durationDays: 1000,
      }),
    ]} canEdit />);

    const label = screen.getByText(longTaskName);
    expect(label).toHaveAttribute("data-gantt-bar-label-side", "right");
    expect(container.querySelector("[data-gantt-bar-label-side='overlay']")).not.toBeInTheDocument();
  });

  it("renders an unscheduled WBS instead of treating it as an empty project", () => {
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "未排期父任务", startDate: "", finishDate: "", durationDays: 0 }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "未排期子任务", startDate: "", finishDate: "", durationDays: 0 }),
      ]}
      canEdit
    />);

    expect(screen.getByText("尚未录入排期")).toBeInTheDocument();
    expect(screen.getByDisplayValue("未排期父任务")).toBeInTheDocument();
    expect(screen.getByDisplayValue("未排期子任务")).toBeInTheDocument();
    expect(screen.queryByText("暂无甘特任务")).not.toBeInTheDocument();
  });

  it("renders task categories as read-only values and defaults blank descriptions to 无", () => {
    render(<GanttTimeline tasks={[task(1)]} canEdit />);

    expect(screen.getByLabelText("任务类别：测试")).toHaveTextContent("测试");
    expect(screen.queryByPlaceholderText("任务类别")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "任务描述" })).toHaveValue("无");
  });

  it("warns parent tasks about unassigned descendant leaves and lists them in a tooltip", async () => {
    render(<GanttTimeline
      tasks={[
        task(1, { ownerMemberId: "member-1", taskName: "父任务" }),
        task(2, {
          parentId: "task-1",
          ownerMemberId: "member-1",
          taskCode: "Task001.001",
          taskName: "已分配任务",
        }),
        task(3, {
          parentId: "task-1",
          ownerMemberId: null,
          taskCode: "Task001.002",
          taskName: "待分配任务",
        }),
      ]}
      canEdit
    />);

    const warning = screen.getByRole("button", { name: "父任务存在 1 个未分配负责人任务" });
    expect(warning).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /已分配任务存在/ })).not.toBeInTheDocument();
    const parentNameInput = screen.getByDisplayValue("父任务");
    expect(parentNameInput).not.toHaveClass("pr-[76px]");
    expect(warning.closest("[data-gantt-column-key='taskCode']")).toBeInTheDocument();
    expect(warning).toHaveClass("!border-0", "!bg-transparent");
    expect(within(parentNameInput.parentElement!).queryByText("【关键路径】")).not.toBeInTheDocument();

    await userEvent.hover(warning);

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("以下任务未安排负责人")).toBeInTheDocument();
    expect(within(tooltip).getByText("Task001.002 · 待分配任务")).toBeInTheDocument();
  });

  it("renders only viewport rows and loads predecessor choices on demand", async () => {
    const tasks = Array.from({ length: 460 }, (_, index) => task(index + 1));
    render(<GanttTimeline tasks={tasks} canEdit />);

    const renderedRows = screen.getAllByLabelText("拖拽排序");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(80);
    expect(screen.queryByText("Task460 · 性能任务 460")).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "紧前任务" })[0]);
    await userEvent.type(screen.getByRole("textbox", { name: "紧前任务搜索" }), "性能任务 460");
    expect(await screen.findByTitle("Task460 · 性能任务 460")).toBeInTheDocument();
  }, 30_000);

  it("selects a task subtree from a searchable hierarchy and applies it together", async () => {
    const onUpdateTask = vi.fn();
    const tasks = [
      task(1),
      task(2, { taskCategory: "研发", taskName: "父任务" }),
      task(3, { parentId: "task-2", taskCategory: "研发 / 接口", taskName: "子任务" }),
    ];
    render(<GanttTimeline tasks={tasks} canEdit onUpdateTask={onUpdateTask} />);

    await userEvent.click(screen.getAllByRole("button", { name: "紧前任务" })[0]);
    expect(screen.queryByText("Task003 · 子任务")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开 Task002" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 Task002" }));
    expect(screen.getByRole("checkbox", { name: "选择 Task003" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "应用紧前任务" }));

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({ predecessorTaskIds: ["task-2", "task-3"] }),
      "predecessor",
    ));
  });

  it("edits a leaf task owner as a searchable single selection", async () => {
    const onUpdateTask = vi.fn();
    render(<GanttTimeline
      tasks={[task(1)]}
      projectMembers={[
        { id: "member-1", projectId: "project-1", accountId: "account-1", personName: "张三", roleName: "开发", roleNames: ["开发", "评审"], createdAt: "", updatedAt: "" },
        { id: "member-2", projectId: "project-1", accountId: "account-2", personName: "李四", roleName: "测试", roleNames: ["测试"], createdAt: "", updatedAt: "" },
      ]}
      canEdit
      onUpdateTask={onUpdateTask}
    />);

    await userEvent.click(screen.getByRole("button", { name: "负责人" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择 李四" }));

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({ ownerMemberId: "member-2", ownerMemberIds: ["member-2"] }),
      "owner",
    ));
  });

  it("keeps a parent owner selector disabled even before its children have owners", () => {
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "未分配父任务" }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "未分配子任务" }),
      ]}
      projectMembers={[
        { id: "member-1", projectId: "project-1", accountId: "account-1", personName: "张三", roleName: "开发", roleNames: ["开发"], createdAt: "", updatedAt: "" },
      ]}
      canEdit
    />);

    const parentRow = document.querySelector<HTMLElement>("[data-gantt-task-id='task-1']");
    const childRow = document.querySelector<HTMLElement>("[data-gantt-task-id='task-2']");
    expect(parentRow).not.toBeNull();
    expect(childRow).not.toBeNull();
    expect(within(parentRow!).getByRole("button", { name: "负责人" })).toBeDisabled();
    expect(within(childRow!).getByRole("button", { name: "负责人" })).toBeEnabled();
  });

  it("keeps task settings limited to priority and parent boundaries", async () => {
    render(<GanttTimeline
      tasks={[
        task(1, {
          taskName: "父任务",
          ownerMemberIds: [],
          ownerMembers: [
            { id: "member-1", accountId: "account-1", personName: "张三", roleName: "开发", roleNames: ["开发"] },
            { id: "member-2", accountId: "account-2", personName: "李四", roleName: "测试", roleNames: ["测试"] },
          ],
          ownerReadOnly: true,
        }),
        task(2, { parentId: "task-1", taskCode: "Task001.001", taskName: "子任务" }),
      ]}
      canEdit
    />);

    fireEvent.contextMenu(screen.getByText("Task001"));
    await userEvent.hover(screen.getByRole("menuitem", { name: "任务设置" }));

    const submenu = screen.getByRole("menu", { name: "任务设置" });
    expect(within(submenu).getByText("任务优先级")).toBeInTheDocument();
    expect(within(submenu).getByText("父任务边界")).toBeInTheDocument();
    expect(within(submenu).queryByText("任务排期方式")).not.toBeInTheDocument();
    expect(within(submenu).queryByText("自动排期")).not.toBeInTheDocument();
    expect(within(submenu).queryByText("工期固定 · 正排")).not.toBeInTheDocument();
    expect(within(submenu).queryByText("工期固定 · 倒排")).not.toBeInTheDocument();
    expect(within(submenu).queryByText("日期固定")).not.toBeInTheDocument();
  });

  it("filters to every critical path while retaining the required ancestors", async () => {
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "关键父任务", totalFloatMinutes: 450 }),
        task(2, {
          parentId: "task-1",
          taskCode: "Task001.001",
          taskName: "关键子任务",
          totalFloatMinutes: 0,
          scheduleStatus: "CRITICAL",
        }),
        task(3, { taskName: "普通任务", durationDays: 0.5, totalFloatMinutes: 450, scheduleStatus: "NORMAL" }),
      ]}
      canEdit
    />);

    const criticalButton = screen.getByRole("button", { name: "关键路径 1 条" });
    await userEvent.click(criticalButton);

    expect(screen.getByDisplayValue("关键父任务")).toBeInTheDocument();
    expect(screen.getByDisplayValue("关键子任务")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("普通任务")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "显示全部 1 条" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a summary dependency connected through its critical leaf tasks", () => {
    render(<GanttTimeline
      tasks={[
        task(1, { taskName: "前置阶段", totalFloatMinutes: 0 }),
        task(2, {
          parentId: "task-1",
          taskCode: "Task001.001",
          taskName: "关键前置任务",
          totalFloatMinutes: 0,
          scheduleStatus: "CRITICAL",
        }),
        task(3, {
          parentId: "task-1",
          taskCode: "Task001.002",
          taskName: "非关键前置任务",
          totalFloatMinutes: 450,
          scheduleStatus: "NORMAL",
        }),
        task(4, {
          taskName: "后续任务",
          startDate: "2026-07-29",
          finishDate: "2026-07-29",
          predecessorTaskIds: ["task-1"],
          totalFloatMinutes: 0,
          scheduleStatus: "CRITICAL",
        }),
      ]}
      canEdit
    />);

    expect(screen.getByRole("button", { name: "关键路径 2 条" })).toBeInTheDocument();
  });

  it("renders critical, FS, and resource-chain connectors with readable distinct tones", () => {
    render(<GanttTimeline
      tasks={[
        task(1, { finishDate: "2026-07-30", durationDays: 3, totalFloatMinutes: 0, scheduleStatus: "CRITICAL" }),
        task(2, {
          startDate: "2026-07-29",
          finishDate: "2026-07-29",
          durationDays: 3,
          predecessorTaskIds: ["task-1"],
          totalFloatMinutes: 0,
          scheduleStatus: "CRITICAL",
        }),
        task(3, {
          startDate: "2026-07-30",
          finishDate: "2026-07-30",
          durationDays: 0.5,
          totalFloatMinutes: 450,
          scheduleStatus: "NORMAL",
        }),
        task(4, {
          startDate: "2026-07-31",
          finishDate: "2026-07-31",
          durationDays: 0.5,
          predecessorTaskIds: ["task-3"],
          totalFloatMinutes: 450,
          scheduleStatus: "NORMAL",
        }),
      ]}
      resourceCriticalChainLinks={[{
        predecessorTaskId: "task-2",
        successorTaskId: "task-3",
        ownerKey: "account:user-1",
      }]}
    />);

    const criticalFs = document.querySelector('[data-gantt-link-tone="critical"]');
    const regularFs = document.querySelector('[data-gantt-link-tone="dependency"]');
    const resourceChain = document.querySelector('[data-gantt-link-tone="resource"]');
    expect(criticalFs).toHaveAttribute("stroke", "#ef4444");
    expect(regularFs).toHaveAttribute("stroke", "#94a3b8");
    expect(resourceChain).toHaveAttribute("stroke", "#38bdf8");
    expect(criticalFs).not.toHaveAttribute("stroke-dasharray");
    expect(regularFs).toHaveAttribute("stroke-dasharray", "4 4");
    expect(resourceChain).toHaveAttribute("stroke-dasharray", "5 3");
  });

  it("keeps the full resource-constrained critical chain in path order", () => {
    const rows = [
      { id: "1.4.3", isCritical: true },
      { id: "1.2.1", isCritical: true },
      { id: "1.4.1", isCritical: true },
      { id: "1.4.2", isCritical: true },
    ] as unknown as Parameters<typeof buildGanttCriticalPaths>[0];
    const paths = buildGanttCriticalPaths(rows, [
      { predecessorId: "1.4.3", successorId: "1.2.1", predecessorName: "", successorName: "" },
      { predecessorId: "1.2.1", successorId: "1.4.1", predecessorName: "", successorName: "" },
      { predecessorId: "1.4.1", successorId: "1.4.2", predecessorName: "", successorName: "" },
    ]);

    expect(paths).toEqual([{ taskIds: ["1.4.3", "1.2.1", "1.4.1", "1.4.2"] }]);
  });

  it("fits the timeline zoom to the visible project duration and viewport", async () => {
    render(<GanttTimeline
      tasks={[
        task(1, {
          startDate: "2026-07-01",
          finishDate: "2026-08-29",
          durationDays: 60,
        }),
      ]}
      canEdit
    />);

    const viewport = screen.getByTestId("gantt-scroll-viewport");
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 1_000 });
    fireEvent.scroll(viewport);

    await waitFor(() => expect(screen.getByText("15天")).toBeInTheDocument());
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

  it("keeps a portaled context submenu available after the pointer leaves its trigger", async () => {
    render(<GanttTimeline
      projectId="project-1"
      tasks={[task(1)]}
      canCreate
      canEdit
      onInsertTasks={vi.fn()}
    />);

    fireEvent.contextMenu(screen.getByText("Task001"));
    const insertItem = screen.getByRole("menuitem", { name: "插入" });
    await userEvent.hover(insertItem);
    const countInput = screen.getByRole("spinbutton", { name: "在下方插入个同级任务数量" });
    const submenu = screen.getByRole("menu", { name: "插入任务" });

    expect(submenu).toHaveClass("gantt-context-submenu-portal");
    expect(submenu.closest(".gantt-context-menu")).toBeNull();
    fireEvent.pointerDown(countInput);

    expect(screen.getByRole("menu", { name: "插入任务" })).toBeInTheDocument();
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

  it("ghosts the existing duration on focus and replaces it without manual deletion", async () => {
    const onUpdateTask = vi.fn();
    render(<GanttTimeline tasks={[task(1, { durationDays: 2.5 })]} canEdit onUpdateTask={onUpdateTask} />);

    const durationInput = screen.getByLabelText("工期天数");
    expect(durationInput).toHaveValue("2.5");

    const user = userEvent.setup();
    await user.click(durationInput);
    expect(durationInput).toHaveValue("");
    expect(durationInput).toHaveAttribute("placeholder", "2.5");
    await user.type(durationInput, "3.5");
    await user.tab();

    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({ durationDays: 3.5, estimatedWorkHours: 26.25 }),
      "durationDays",
    ));
  });

  it("keeps an existing duration when focus leaves without input and clears it after Delete", async () => {
    const onUpdateTask = vi.fn();
    render(<GanttTimeline tasks={[task(1, { durationDays: 2 })]} canEdit onUpdateTask={onUpdateTask} />);

    const user = userEvent.setup();
    const durationInput = screen.getByLabelText("工期天数");
    await user.click(durationInput);
    await user.tab();
    expect(onUpdateTask).not.toHaveBeenCalled();
    expect(durationInput).toHaveValue("2");

    await user.click(durationInput);
    await user.keyboard("{Delete}");
    await user.tab();
    await waitFor(() => expect(onUpdateTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "task-1" }),
      expect.objectContaining({ durationDays: 0, estimatedWorkHours: 0 }),
      "durationDays",
    ));
  });

  it("shows all CPM columns by default", () => {
    render(<GanttTimeline calendarMode="CALENDAR_DAYS" tasks={[
      task(1, {
        taskName: "项目总任务",
        startDate: "2026-07-01",
        finishDate: "2026-07-03",
        durationDays: 3,
      }),
      task(2, {
        parentId: "task-1",
        taskCode: "Task001.001",
        startDate: "2026-07-01",
        finishDate: "2026-07-01",
        totalFloatMinutes: 450,
        freeFloatMinutes: 225,
        earlyStartDate: "2026-07-01",
        earlyFinishDate: "2026-07-01",
        lateStartDate: "2026-07-02",
        lateFinishDate: "2026-07-02",
        scheduleStatus: "NEAR_CRITICAL",
      }),
    ]} />);

    expect(screen.getByText("总浮动")).toBeInTheDocument();
    expect(screen.getByText("1天")).toBeInTheDocument();
    expect(screen.getByText("自由浮动")).toBeInTheDocument();
    expect(screen.getAllByText("0 天")).toHaveLength(4);
    expect(screen.getByText("最早开始")).toBeInTheDocument();
    expect(screen.getByText("最迟完成")).toBeInTheDocument();
    expect(screen.getByText("排程状态")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浮动" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not draw or report float beyond the root task finish boundary", () => {
    const { container } = render(<GanttTimeline
      calendarMode="CALENDAR_DAYS"
      projectStartDate="2026-08-17"
      tasks={[
        task(1, {
          taskCode: "Task1",
          taskName: "项目总任务",
          startDate: "2026-08-17",
          finishDate: "2026-09-01",
          durationDays: 16,
        }),
        task(2, {
          parentId: "task-1",
          taskCode: "Task1.1",
          taskName: "截止日任务",
          startDate: "2026-08-31",
          finishDate: "2026-09-01",
          durationDays: 2,
          totalFloatMinutes: 7 * 450,
          freeFloatMinutes: 7 * 450,
          lateStartDate: "2026-09-09",
          lateFinishDate: "2026-09-10",
        }),
        task(3, {
          taskCode: "Task2",
          taskName: "另一条较晚结束的根任务",
          startDate: "2026-08-17",
          finishDate: "2026-09-10",
          durationDays: 25,
        }),
      ]}
    />);

    expect(container.querySelector('[data-gantt-float-line="task-2"]')).not.toBeInTheDocument();
    expect(screen.getAllByTitle("总浮动：0 天").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("自由浮动：0 天").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-gantt-task-id="task-2"] [data-gantt-column-key="lateFinish"][title="2026-09-01"]')).toBeInTheDocument();
    expect(container.querySelector('[data-gantt-task-id="task-2"] [data-gantt-column-key="lateFinish"][title="2026-09-10"]')).not.toBeInTheDocument();
  });
});
