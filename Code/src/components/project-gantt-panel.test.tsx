import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectGanttPanel } from "@/components/project-gantt-panel";
import type { GanttTaskDraft } from "@/components/gantt-timeline";
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
    onInsertTasks,
    onReassignBranch,
    onUpdateTask,
    projectMembers,
    tasks,
  }: {
    creatingParentId: string | null;
    onDeleteSelected?: (taskIds: string[]) => void | Promise<void>;
    onCreateTask?: (parentTask?: ProjectGanttTask) => void;
    onInsertTasks?: (anchorTaskId: string, placement: "SIBLING_AFTER", count: number) => void | Promise<void>;
    onReassignBranch?: (taskId: string, ownerMemberId: string | null) => void | Promise<void>;
    onUpdateTask?: (task: ProjectGanttTask, draft: GanttTaskDraft, columnKey?: string) => void | Promise<void>;
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
      <button type="button" onClick={() => void onInsertTasks?.(tasks[0].id, "SIBLING_AFTER", 2)}>
        测试批量插入任务
      </button>
      <button
        type="button"
        onClick={() => void onUpdateTask?.(tasks[0], {
          taskCategory: tasks[0].taskCategory,
          taskName: tasks[0].taskName,
          taskDescription: tasks[0].taskDescription || "无",
          startDate: "2026-08-01",
          startSlot: "AM",
          endDate: "2026-08-10",
          finishSlot: "PM",
          durationDays: 10,
          actualStartDate: tasks[0].actualStartDate ?? "",
          actualStartSlot: "AM",
          actualEndDate: tasks[0].actualEndDate ?? "",
          actualFinishSlot: "PM",
          estimatedWorkHours: 75,
          actualWorkHours: tasks[0].actualWorkHours ?? 0,
          progress: tasks[0].progress ?? 0,
          taskMode: "AUTO",
          parentBoundaryMode: "ROLLUP",
          schedulePriority: 500,
          userPriority: "MEDIUM",
          effortDriven: false,
          parallelizable: false,
          isMilestone: false,
          ownerMemberId: tasks[0].ownerMemberId ?? null,
          ownerMemberIds: [],
          predecessorTaskIds: [],
          remark: tasks[0].remark ?? "",
        }, "startDate")}
      >
        测试编辑父任务计划
      </button>
      <button
        type="button"
        onClick={() => void onUpdateTask?.(tasks[0], {
          taskCategory: tasks[0].taskCategory,
          taskName: tasks[0].taskName,
          taskDescription: tasks[0].taskDescription || "无",
          startDate: tasks[0].startDate,
          startSlot: "AM",
          endDate: tasks[0].finishDate ?? "",
          finishSlot: "PM",
          durationDays: tasks[0].durationDays,
          actualStartDate: tasks[0].actualStartDate ?? "",
          actualStartSlot: "AM",
          actualEndDate: tasks[0].actualEndDate ?? "",
          actualFinishSlot: "PM",
          estimatedWorkHours: tasks[0].estimatedWorkHours ?? 0,
          actualWorkHours: tasks[0].actualWorkHours ?? 0,
          progress: tasks[0].progress ?? 0,
          taskMode: "AUTO",
          parentBoundaryMode: "ROLLUP",
          schedulePriority: 500,
          userPriority: "MEDIUM",
          effortDriven: false,
          parallelizable: false,
          isMilestone: false,
          ownerMemberId: "member-1",
          ownerMemberIds: ["member-1"],
          predecessorTaskIds: [],
          remark: tasks[0].remark ?? "",
        }, "owner")}
      >
        测试编辑负责人
      </button>
      <button type="button" onClick={() => void onReassignBranch?.(tasks[0].id, "member-1")}>
        测试批量改派负责人
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

const backgroundGanttGet = (url: string) => {
  if (url.endsWith("/gantt-tasks/baseline")) {
    return Promise.resolve({
      project: {
        ganttBaselineVersion: 0,
        ganttBaselineState: "DRAFT",
        ganttBaselinePublishedAt: null,
        ganttBaselinePublishedBy: "",
      },
      baseline: null,
      draft: null,
      validation: { projectId: "project-1", taskCount: 0, valid: true, blockers: [] },
      permissions: {
        canPrepareDraft: false,
        canPublish: true,
        canEditPlanning: true,
        canEditActuals: true,
        planningMutationBlocker: null,
      },
      blockers: [],
    });
  }
  if (url.includes("/gantt-tasks/resource-schedule")) {
    return Promise.resolve({
      revision: 0,
      snapshotHash: "test",
      conflicts: [],
      issues: [],
      candidates: [],
      resourceConstrainedTaskIds: [],
    });
  }
  return null;
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
    window.sessionStorage.clear();
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.put.mockReset();
    mocks.delete.mockReset();
  });

  it("shows the WBS load error instead of silently presenting an empty task list", async () => {
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.reject(new Error("接口暂时不可用"));
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    expect(await screen.findByText("加载项目 WBS 失败")).toBeInTheDocument();
    expect(screen.getByText("接口暂时不可用")).toBeInTheDocument();
  });

  it("revalidates an initially empty WBS response before showing an empty plan", async () => {
    let taskRequestCount = 0;
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      taskRequestCount += 1;
      return Promise.resolve(taskRequestCount === 1 ? [] : [rootTask]);
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    await waitFor(() => expect(screen.getByTestId("task-count")).toHaveTextContent("1"));
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/projects\/project-1\/gantt-tasks\?refresh=/));
  });

  it.each([
    ["测试新增任务", "root"],
    ["测试新增子任务", rootTask.id],
  ])("keeps the Gantt mounted while %s refreshes task data", async (buttonName, expectedParentId) => {
    const refresh = deferred<ProjectGanttTask[]>();
    let taskRequestCount = 0;
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      taskRequestCount += 1;
      return taskRequestCount === 1 ? Promise.resolve([rootTask]) : refresh.promise;
    });
    let snapshotCount = 0;
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/history/snapshots")) {
        snapshotCount += 1;
        return Promise.resolve({ snapshotId: `snapshot-${snapshotCount}` });
      }
      return Promise.resolve({ ...rootTask, id: "created-task" });
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks",
      expect.objectContaining({ parentId: expectedParentId === "root" ? null : rootTask.id }),
    ));
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
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      taskRequestCount += 1;
      return Promise.resolve(taskRequestCount === 1 ? [rootTask, childTask] : []);
    });
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/deletions")) {
        return Promise.resolve({
          deletionBatchId: "batch-1",
          deletedTaskCount: 2,
          detachedWeeklyItemCount: 0,
          detachedRiskCount: 0,
        });
      }
      return Promise.resolve({});
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("task-count")).toHaveTextContent("2"));
    await user.click(screen.getByRole("button", { name: "测试删除父子任务" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/deletions",
      { rootTaskIds: [rootTask.id] },
    ));
    await waitFor(() => expect(screen.getByTestId("task-count")).toHaveTextContent("0"));
  });

  it("loads project members and applies the project-wide working-day mode", async () => {
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([{ id: "member-1", personName: "张三", roleName: "项目经理" }]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.resolve([rootTask]);
    });
    let snapshotCount = 0;
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/history/snapshots")) {
        snapshotCount += 1;
        return Promise.resolve({ snapshotId: `calendar-snapshot-${snapshotCount}` });
      }
      return Promise.resolve({});
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

  it("keeps a manually edited parent schedule as a locked boundary instead of rolling it back", async () => {
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.resolve([rootTask, childTask]);
    });
    mocks.post.mockResolvedValue({ snapshotId: "parent-plan-snapshot" });
    mocks.put.mockImplementation((_url: string, body: Record<string, unknown>) => {
      if (body.previewScheduleImpact) {
        return Promise.resolve({
          requiresConfirmation: false,
          affectedTaskIds: [rootTask.id],
          affectedTasks: [],
          issues: [],
          conflicts: [],
        });
      }
      return Promise.resolve({ ...rootTask, parentBoundaryMode: "LOCKED", taskMode: "DURATION_FORWARD" });
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: "测试编辑父任务计划" }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/task-1",
      expect.objectContaining({
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        taskMode: "DURATION_FORWARD",
        parentBoundaryMode: "LOCKED",
      }),
    ));
  });

  it("saves an owner change directly without opening the manual schedule impact flow", async () => {
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.resolve([rootTask]);
    });
    mocks.post.mockResolvedValue({ snapshotId: "owner-snapshot" });
    mocks.put.mockResolvedValue({ ...rootTask, ownerMemberId: "member-1" });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: "测试编辑负责人" }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/task-1",
      expect.objectContaining({ ownerMemberId: "member-1", ownerMemberIds: ["member-1"] }),
    ));
    expect(mocks.put.mock.calls.some(([, body]) => Boolean((body as Record<string, unknown>).previewScheduleImpact))).toBe(false);
  });

  it("sends branch reassignment as an explicit owner operation", async () => {
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.resolve([rootTask, childTask]);
    });
    mocks.post.mockResolvedValue({ snapshotId: "branch-owner-snapshot" });
    mocks.put.mockResolvedValue({ ...rootTask, ownerMemberId: "member-1" });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: "测试批量改派负责人" }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/task-1",
      { ownerMemberId: "member-1", ownerChangeMode: "BRANCH_REASSIGN" },
    ));
  });

  it("does not let a stalled history snapshot block applying duration suggestions", async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url.includes("/gantt-tasks/resource-schedule") && url.includes("includeCandidates=1")) {
        return Promise.resolve({
          revision: 0,
          snapshotHash: "duration-suggestion-test",
          conflicts: [],
          issues: [],
          candidates: [],
          durationSuggestions: [{
            taskId: rootTask.id,
            parentTaskId: "",
            ownerKey: "member-1",
            suggestedDurationDays: 2,
            source: "SYSTEM_SUGGESTED",
            reason: "测试建议",
          }],
          durationSuggestionIssues: [],
        });
      }
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      if (url.endsWith("/deletions")) return Promise.resolve([]);
      return Promise.resolve([rootTask]);
    });
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/history/snapshots")) return new Promise(() => {});
      if (url.endsWith("/resource-schedule")) return Promise.resolve({ message: "已确认 1 条系统建议工期" });
      return Promise.resolve({});
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: /自动排期/ }));
    await screen.findByText("系统建议工期");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "确认选中建议 1" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/resource-schedule",
      expect.objectContaining({
        action: "APPLY_DURATION_SUGGESTIONS",
        taskIds: [rootTask.id],
      }),
    ), { timeout: 7_000 });
    expect(await screen.findByText("操作已完成，但未加入撤销历史", {}, { timeout: 7_000 })).toBeInTheDocument();
    expect(screen.queryByText("正式自动排期预览")).not.toBeInTheDocument();
  }, 10_000);

  it("records structure changes as snapshots and restores the before snapshot on undo", async () => {
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      return Promise.resolve([rootTask]);
    });
    let snapshotCount = 0;
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/history/snapshots")) {
        snapshotCount += 1;
        return Promise.resolve({ snapshotId: `structure-snapshot-${snapshotCount}` });
      }
      if (url.endsWith("/structure")) {
        return Promise.resolve({ tasks: [rootTask], createdTaskIds: ["created-1", "created-2"] });
      }
      if (url.endsWith("/history/restore")) return Promise.resolve({ restoredTaskCount: 1 });
      return Promise.resolve({});
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    await screen.findByTestId("gantt-timeline");
    await user.click(screen.getByRole("button", { name: "测试批量插入任务" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/structure",
      {
        operation: "INSERT",
        anchorTaskId: rootTask.id,
        placement: "SIBLING_AFTER",
        count: 2,
      },
    ));
    const undoButton = screen.getByRole("button", { name: "撤销" });
    await waitFor(() => expect(undoButton).toBeEnabled());
    await user.click(undoButton);

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks/history/restore",
      {
        snapshotId: "structure-snapshot-1",
        actionLabel: "撤销：插入 2 条同级任务",
      },
    ));
  });

  it("uses compact toolbar buttons to undo and redo the current session history", async () => {
    window.sessionStorage.setItem("ceastar:gantt-history:v1:project-1", JSON.stringify({
      entries: [{
        id: "entry-1",
        kind: "DELETION",
        label: "删除任务",
        deletionBatchId: "batch-1",
        target: { taskIds: [rootTask.id], anchorTaskId: rootTask.id },
      }],
      cursor: 0,
    }));
    mocks.get.mockImplementation((url: string) => {
      const backgroundResponse = backgroundGanttGet(url);
      if (backgroundResponse) return backgroundResponse;
      if (url.endsWith("/export")) return Promise.resolve({ mppExport: false });
      if (url.endsWith("/members")) return Promise.resolve([]);
      if (url.endsWith("/gantt-settings")) return Promise.resolve({ calendarMode: "CALENDAR_DAYS", hoursPerDay: 7.5 });
      return Promise.resolve([]);
    });
    mocks.post.mockImplementation((url: string) => {
      if (url.endsWith("/restore")) {
        return Promise.resolve({ message: "已恢复 1 条甘特任务", restoredTaskCount: 1 });
      }
      if (url.endsWith("/redo")) {
        return Promise.resolve({ deletionBatchId: "batch-2", deletedTaskCount: 1 });
      }
      return Promise.resolve({});
    });

    render(<ProjectGanttPanel projectId="project-1" projectStatus={ProjectStatus.IN_PROGRESS} />);

    const user = userEvent.setup();
    const undoButton = await screen.findByRole("button", { name: "撤销" });
    const redoButton = screen.getByRole("button", { name: "重做" });
    await waitFor(() => expect(undoButton).toBeEnabled());
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
