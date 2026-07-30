import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectGanttPanel } from "@/components/project-gantt-panel";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectGanttTask } from "@/domain/models";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    delete: mocks.delete,
  },
}));

vi.mock("@/lib/use-permission", () => ({
  usePermission: () => ({ can: () => true }),
}));

vi.mock("@/components/confirm-provider", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(true),
}));

vi.mock("@/components/gantt-timeline", () => ({
  GanttTimeline: ({
    creatingParentId,
    onDeleteSelected,
    onCreateTask,
    projectMembers,
    tasks,
  }: {
    creatingParentId: string | null;
    onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
    onCreateTask?: (parentTask?: ProjectGanttTask) => void;
    projectMembers: Array<{ id: string }>;
    tasks: ProjectGanttTask[];
  }) => (
    <div data-testid="gantt-timeline">
      <span data-testid="task-count">{tasks.length}</span>
      <span data-testid="creating-parent">{creatingParentId ?? "idle"}</span>
      <span data-testid="member-count">{projectMembers.length}</span>
      <button type="button" onClick={() => onCreateTask?.()}>
        测试新增任务
      </button>
      <button type="button" onClick={() => onCreateTask?.(tasks[0])}>
        测试新增子任务
      </button>
      <button type="button" onClick={() => void onDeleteSelected?.(tasks.map((task) => task.id))}>
        测试删除父子任务
      </button>
    </div>
  ),
}));

const rootTask: ProjectGanttTask = {
  id: "task-1",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  projectId: "project-1",
  parentId: null,
  taskCode: "Task001",
  taskCategory: "设计",
  taskName: "根任务",
  taskDescription: "",
  startDate: "2026-07-24",
  durationDays: 1,
  actualStartDate: "",
  actualEndDate: "",
  progress: 0,
  predecessorTask: "",
  remark: "",
  sortOrder: 1,
};

const childTask: ProjectGanttTask = {
  ...rootTask,
  id: "task-2",
  parentId: rootTask.id,
  taskCode: "Task001.001",
  taskName: "子任务",
  sortOrder: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ProjectGanttPanel", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.put.mockReset();
    mocks.delete.mockReset();
  });

  it.each([
    ["测试新增任务", "root"],
    ["测试新增子任务", rootTask.id],
  ])("keeps the Gantt mounted while %s refreshes task data", async (buttonName, expectedParentId) => {
    const refresh = deferred<ProjectGanttTask[]>();
    let taskRequestCount = 0;
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      taskRequestCount += 1;
      return taskRequestCount === 1 ? Promise.resolve([rootTask]) : refresh.promise;
    });
    mocks.post.mockResolvedValue({});

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("gantt-timeline")).toBeInTheDocument();
    expect(screen.queryByText("加载中...")).not.toBeInTheDocument();
    expect(screen.getByTestId("creating-parent")).toHaveTextContent(expectedParentId);

    refresh.resolve([rootTask, { ...rootTask, id: "task-2", parentId: expectedParentId === "root" ? null : rootTask.id }]);

    await waitFor(() => expect(screen.getByTestId("task-count")).toHaveTextContent("2"));
    expect(screen.getByTestId("creating-parent")).toHaveTextContent("idle");
  });

  it("deletes only the selected root task and refreshes after cascade deletion", async () => {
    let taskRequestCount = 0;
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      taskRequestCount += 1;
      return Promise.resolve(taskRequestCount === 1 ? [rootTask, childTask] : []);
    });
    mocks.delete.mockResolvedValue({});

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("task-count")).toHaveTextContent("2"));
    await user.click(screen.getByRole("button", { name: "测试删除父子任务" }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));
    expect(mocks.delete).toHaveBeenCalledWith("/api/projects/project-1/gantt-tasks/task-1");
    await waitFor(() => expect(screen.getByTestId("task-count")).toHaveTextContent("0"));
  });

  it("loads project members and applies the project-wide working-day mode", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([{ id: "member-1", personName: "张三", roleName: "项目经理" }]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.resolve([rootTask]);
    });
    mocks.put.mockResolvedValue({ calendarMode: "WORKING_DAYS", hoursPerDay: 7.5 });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("member-count")).toHaveTextContent("1"));
    const calendarModeGroup = screen.getByRole("group", { name: "工期计算方式" });
    const calendarDayButton = within(calendarModeGroup).getByRole("button", { name: "自然日" });
    const workingDayButton = within(calendarModeGroup).getByRole("button", { name: "工作日" });

    expect(calendarModeGroup).toHaveClass("h-8");
    expect(calendarDayButton).toHaveClass("h-8", "text-xs");
    expect(workingDayButton).toHaveClass("h-8", "text-xs");
    expect(calendarDayButton).toHaveAttribute("aria-pressed", "true");

    await user.click(workingDayButton);

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-settings",
      { calendarMode: "WORKING_DAYS" },
    ));
    await waitFor(() => expect(workingDayButton).toHaveAttribute("aria-pressed", "true"));
  });

  it("uses compact toolbar buttons to undo and redo the latest deletion", async () => {
    const deletionBatch = {
      id: "batch-1",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      projectId: "project-1",
      operatorUserId: "user-1",
      operatorName: "张三",
      status: "AVAILABLE",
      rootTaskIds: ["task-1"],
      summary: {
        rootTaskIds: ["task-1"],
        rootTasks: [{ id: "task-1", taskCode: "Task001", taskName: "根任务" }],
        taskIds: ["task-1"],
        deletedTaskCount: 1,
        descendantTaskCount: 0,
        dependencyCount: 0,
        internalDependencyCount: 0,
        externalDependencyCount: 0,
        detachedWeeklyItemCount: 0,
        detachedRiskCount: 0,
        clearedPredecessorCount: 0,
        ganttRevision: 3,
      },
      revisionBeforeDelete: 3,
      revisionAfterDelete: 4,
      expiresAt: "2026-08-29T00:00:00.000Z",
      restoredAt: null,
    };
    mocks.get.mockImplementation((url: string) => {
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([deletionBatch]);
      return Promise.resolve([]);
    });
    mocks.post.mockResolvedValue({ message: "已恢复 1 条甘特任务", restoredTaskCount: 1 });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    const undoButton = await screen.findByRole("button", { name: "撤销删除" });
    const redoButton = screen.getByRole("button", { name: "取消撤销" });
    expect(screen.queryByText("最近删除可撤销")).not.toBeInTheDocument();
    expect(undoButton).toBeEnabled();
    expect(redoButton).toBeDisabled();
    expect(undoButton).toHaveClass("size-8");
    expect(redoButton).toHaveClass("size-8");
    expect(undoButton.parentElement).toHaveClass("gap-2");
    await user.click(undoButton);

    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/projects/project-1/gantt-tasks/deletions/batch-1/restore",
    ));
    await waitFor(() => expect(redoButton).toBeEnabled());
    await user.click(redoButton);

    await waitFor(() => expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/projects/project-1/gantt-tasks/deletions/batch-1/redo",
    ));
  });
});
