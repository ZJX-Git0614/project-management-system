import type { GanttCalendarMode } from "@/lib/gantt-calendar";
import {
  type GanttHalfDay,
  type GanttScheduleMode,
  type GanttUserPriority,
  type ResolvedGanttPlan,
} from "@/lib/gantt-planning-rules";
import { prisma } from "@/lib/prisma";
import {
  refreshProjectGanttDerivedState,
  renumberProjectGanttTaskCodes,
  replaceGanttTaskDependencies,
} from "@/lib/gantt-task-service";
import {
  resolveEffectiveGanttOwnerMemberIds,
  synchronizeGanttOwnerHierarchy,
} from "@/lib/gantt-owner-service";

export type CreateGanttTaskDependencies = Array<{
  predecessorTaskId: string;
  type: number;
  lag: number;
  lagFormat: number;
}>;

export type CreateGanttTaskParams = {
  projectId: string;
  parentId: string | null;
  requestedOwnerMemberIds: string[];
  taskCategory: string;
  taskName: string;
  taskDescription: string;
  plan: Pick<ResolvedGanttPlan, "startDate" | "finishDate" | "durationDays" | "startSlot" | "finishSlot"> & {
    taskMode: GanttScheduleMode;
  };
  actualStartDate: string;
  actualEndDate: string;
  actualStartSlot: GanttHalfDay;
  actualFinishSlot: GanttHalfDay;
  estimatedWorkHours: number;
  actualWorkHours: number;
  progress: number;
  parentBoundaryMode: string;
  schedulePriority: number;
  userPriority: GanttUserPriority;
  effortDriven: boolean;
  parallelizable: boolean;
  isMilestone: boolean;
  budgetItemId: string | null;
  predecessorTask: string;
  remark: string;
  dependencies: CreateGanttTaskDependencies;
  calendarMode: GanttCalendarMode;
};

/**
 * Creates a WBS task and refreshes every task-derived field in the same
 * transaction. The route owns HTTP validation; this use case owns the
 * persistence boundary and is reusable by assistant or batch callers.
 */
export const createProjectGanttTask = async (params: CreateGanttTaskParams) => {
  const created = await prisma.$transaction(async (tx) => {
    const siblings = await tx.projectGanttTask.findMany({
      where: { projectId: params.projectId, parentId: params.parentId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { sortOrder: true, taskCategory: true },
    });
    const categorySiblings = params.taskCategory
      ? siblings.filter((task) => task.taskCategory === params.taskCategory)
      : [];
    const insertAfterSortOrder = categorySiblings.at(-1)?.sortOrder ?? siblings.at(-1)?.sortOrder ?? 0;
    const sortOrder = insertAfterSortOrder + 1;
    const inheritedOwnerMemberIds = params.parentId
      ? await resolveEffectiveGanttOwnerMemberIds({
          tx,
          projectId: params.projectId,
          taskId: params.parentId,
        })
      : [];
    // A new task is initially a leaf. A parent may aggregate several owners,
    // but a leaf must have exactly zero or one direct responsible person.
    const ownerMemberIds = params.requestedOwnerMemberIds.length > 0
      ? params.requestedOwnerMemberIds
      : inheritedOwnerMemberIds.length === 1 ? inheritedOwnerMemberIds : [];
    const ownerMemberId = ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;

    await tx.projectGanttTask.updateMany({
      where: { projectId: params.projectId, parentId: params.parentId, sortOrder: { gte: sortOrder } },
      data: { sortOrder: { increment: 1 } },
    });

    const createdTask = await tx.projectGanttTask.create({
      data: {
        projectId: params.projectId,
        parentId: params.parentId,
        ownerMemberId,
        ownerLinks: ownerMemberIds.length > 0
          ? { createMany: { data: ownerMemberIds.map((projectMemberId) => ({ projectMemberId })) } }
          : undefined,
        taskCode: "",
        taskCategory: params.taskCategory,
        taskName: params.taskName,
        taskDescription: params.taskDescription,
        startDate: params.plan.startDate,
        finishDate: params.plan.finishDate,
        durationDays: params.plan.durationDays,
        durationMinutes: Math.round(params.plan.durationDays * 450),
        actualStartDate: params.actualStartDate,
        actualEndDate: params.actualEndDate,
        startSlot: params.plan.startSlot,
        finishSlot: params.plan.finishSlot,
        actualStartSlot: params.actualStartSlot,
        actualFinishSlot: params.actualFinishSlot,
        estimatedWorkHours: params.estimatedWorkHours,
        actualWorkHours: params.actualWorkHours,
        progress: params.progress,
        taskMode: params.plan.taskMode,
        parentBoundaryMode: params.parentBoundaryMode,
        schedulePriority: params.schedulePriority,
        userPriority: params.userPriority,
        effectivePriority: params.userPriority,
        effortDriven: params.effortDriven,
        parallelizable: params.parallelizable,
        isMilestone: params.isMilestone,
        budgetItemId: params.budgetItemId,
        predecessorTask: params.predecessorTask,
        remark: params.remark,
        sortOrder,
      },
    });
    await replaceGanttTaskDependencies(tx, params.projectId, createdTask.id, params.dependencies);
    await synchronizeGanttOwnerHierarchy({ tx, projectId: params.projectId });
    await tx.project.update({
      where: { id: params.projectId },
      data: { ganttRevision: { increment: 1 } },
    });
    await renumberProjectGanttTaskCodes(params.projectId, tx);
    await refreshProjectGanttDerivedState(params.projectId, params.calendarMode, tx);
    return createdTask;
  }, { timeout: 30_000, maxWait: 10_000 });

  return { taskId: created.id };
};
