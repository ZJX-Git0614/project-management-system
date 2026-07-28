import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectGanttPanel } from "@/components/project-gantt-panel";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectGanttTask } from "@/domain/models";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: vi.fn(),
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
    tasks,
  }: {
    creatingParentId: string | null;
    onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
    onCreateTask?: (parentTask?: ProjectGanttTask) => void;
    tasks: ProjectGanttTask[];
  }) => (
    <div data-testid="gantt-timeline">
      <span data-testid="task-count">{tasks.length}</span>
      <span data-testid="creating-parent">{creatingParentId ?? "idle"}</span>
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
  startDate: "2026-07-24",
  durationDays: 1,
  actualStartDate: "",
  actualEndDate: "",
  progress: 0,
  predecessorTask: "",
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
});
