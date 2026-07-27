import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  assignMissingGanttTaskCodes,
  nextGanttTaskCode,
  orderGanttTasksByHierarchy,
  renumberGanttTaskCodes,
} from "@/lib/gantt-task-codes";

const ganttTaskInclude = {
  predecessorDependencies: {
    orderBy: { createdAt: "asc" },
    include: {
      predecessorTask: {
        select: { id: true, taskCode: true, taskName: true },
      },
    },
  },
} satisfies Prisma.ProjectGanttTaskInclude;

type GanttTaskRecord = Prisma.ProjectGanttTaskGetPayload<{ include: typeof ganttTaskInclude }>;

export const serializeGanttTask = (task: GanttTaskRecord) => {
  const predecessorTaskIds = task.predecessorDependencies.map((dependency) => dependency.predecessorTaskId);
  const predecessorNames = task.predecessorDependencies
    .map((dependency) => dependency.predecessorTask.taskName)
    .filter(Boolean);

  return {
    ...task,
    predecessorTaskIds,
    predecessorTask: predecessorNames.length > 0 ? predecessorNames.join(",") : task.predecessorTask,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    predecessorDependencies: task.predecessorDependencies.map((dependency) => ({
      ...dependency,
      createdAt: dependency.createdAt.toISOString(),
      updatedAt: dependency.updatedAt.toISOString(),
    })),
  };
};

export const getOrderedGanttTasks = async (projectId: string) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
    include: ganttTaskInclude,
  });
  const normalizedTasks = assignMissingGanttTaskCodes(tasks);
  const taskCodeUpdates = normalizedTasks.filter((task) => {
    const original = tasks.find((item) => item.id === task.id);
    return original && original.taskCode !== task.taskCode;
  });

  if (taskCodeUpdates.length > 0) {
    await prisma.$transaction(
      taskCodeUpdates.map((task) => (
        prisma.projectGanttTask.update({
          where: { id: task.id },
          data: { taskCode: task.taskCode },
        })
      ))
    );
  }

  return orderGanttTasksByHierarchy(normalizedTasks);
};

export const replaceGanttTaskDependencies = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  successorTaskId: string,
  dependencies: Array<{ predecessorTaskId: string; type?: number; lag?: number; lagFormat?: number }>,
) => {
  const uniqueDependencies = [...new Map(
    dependencies
      .filter((dependency) => dependency.predecessorTaskId && dependency.predecessorTaskId !== successorTaskId)
      .map((dependency) => [dependency.predecessorTaskId, dependency]),
  ).values()];

  if (uniqueDependencies.length > 0) {
    const validCount = await tx.projectGanttTask.count({
      where: {
        projectId,
        id: { in: uniqueDependencies.map((dependency) => dependency.predecessorTaskId) },
      },
    });
    if (validCount !== uniqueDependencies.length) {
      throw new Error("紧前任务不存在或不属于当前项目");
    }
  }

  await tx.projectGanttDependency.deleteMany({ where: { successorTaskId } });
  if (uniqueDependencies.length === 0) return;

  await tx.projectGanttDependency.createMany({
    data: uniqueDependencies.map((dependency) => ({
      projectId,
      successorTaskId,
      predecessorTaskId: dependency.predecessorTaskId,
      type: Number.isInteger(dependency.type) ? dependency.type! : 1,
      lag: Number.isInteger(dependency.lag) ? dependency.lag! : 0,
      lagFormat: Number.isInteger(dependency.lagFormat) ? dependency.lagFormat! : 7,
    })),
  });
};

export const parseGanttDependencyInput = (body: Record<string, unknown>) => {
  if (Array.isArray(body.predecessorDependencies)) {
    return body.predecessorDependencies.map((value) => {
      const dependency = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        predecessorTaskId: String(dependency.predecessorTaskId ?? "").trim(),
        type: Number(dependency.type ?? 1),
        lag: Number(dependency.lag ?? 0),
        lagFormat: Number(dependency.lagFormat ?? 7),
      };
    });
  }

  const ids = Array.isArray(body.predecessorTaskIds)
    ? body.predecessorTaskIds
    : body.predecessorTaskId
      ? [body.predecessorTaskId]
      : [];
  return ids.map((value) => ({ predecessorTaskId: String(value).trim(), type: 1, lag: 0, lagFormat: 7 }));
};

export const getNextGanttTaskCode = async (projectId: string, parentId: string | null) => {
  const tasks = await getOrderedGanttTasks(projectId);
  return nextGanttTaskCode(tasks, parentId);
};

export const renumberProjectGanttTaskCodes = async (projectId: string) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
  });
  const renumberedTasks = renumberGanttTaskCodes(tasks);
  const updates = renumberedTasks.filter((task) => {
    const original = tasks.find((item) => item.id === task.id);
    return original && original.taskCode !== task.taskCode;
  });

  if (updates.length === 0) return;

  await prisma.$transaction(
    updates.map((task) => (
      prisma.projectGanttTask.update({
        where: { id: task.id },
        data: { taskCode: task.taskCode },
      })
    ))
  );
};
