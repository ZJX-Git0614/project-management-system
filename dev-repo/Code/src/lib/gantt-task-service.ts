import { prisma } from "@/lib/prisma";
import {
  assignMissingGanttTaskCodes,
  nextGanttTaskCode,
  orderGanttTasksByHierarchy,
  renumberGanttTaskCodes,
} from "@/lib/gantt-task-codes";

type GanttTaskRecord = Awaited<ReturnType<typeof prisma.projectGanttTask.findMany>>[number];

export const serializeGanttTask = (task: GanttTaskRecord) => ({
  ...task,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});

export const getOrderedGanttTasks = async (projectId: string) => {
  const tasks = await prisma.projectGanttTask.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { startDate: "asc" }, { createdAt: "asc" }],
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
