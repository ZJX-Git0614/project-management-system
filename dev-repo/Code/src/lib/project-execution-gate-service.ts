import { Prisma } from "@prisma/client";

import { evaluateProjectExecutionGate } from "@/lib/project-execution-gate";

export type ProjectExecutionGateClient = Prisma.TransactionClient;

const taskSelect = {
  id: true,
  parentId: true,
  taskCode: true,
  taskName: true,
  taskCategory: true,
  startDate: true,
  finishDate: true,
  durationDays: true,
  estimatedWorkHours: true,
  progress: true,
  scheduleStatus: true,
  totalFloatMinutes: true,
} satisfies Prisma.ProjectGanttTaskSelect;

export const loadProjectExecutionGateEvaluation = async (
  db: ProjectExecutionGateClient,
  projectId: string,
  executionId: string,
) => {
  const [project, execution, tasks, matters, risks] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true, ganttRevision: true } }),
    db.projectExecution.findFirst({
      where: { id: executionId, projectId },
      select: {
        id: true,
        name: true,
        status: true,
        taskLinks: { select: { ganttTaskId: true, relationType: true } },
      },
    }),
    db.projectGanttTask.findMany({ where: { projectId }, select: taskSelect }),
    db.weeklyItem.findMany({
      where: { projectId },
      select: {
        id: true,
        status: true,
        dueDate: true,
        ganttTaskId: true,
        ganttTaskLinks: { select: { ganttTaskId: true } },
      },
    }),
    db.riskRegisterItem.findMany({
      where: { projectId },
      select: {
        id: true,
        level: true,
        status: true,
        ganttTaskId: true,
        weeklyItem: { select: { ganttTaskId: true, ganttTaskLinks: { select: { ganttTaskId: true } } } },
        weeklyItemLinks: { select: { weeklyItem: { select: { ganttTaskId: true, ganttTaskLinks: { select: { ganttTaskId: true } } } } } },
      },
    }),
  ]);
  if (!project) throw new Error("项目不存在");
  if (!execution) throw new Error("执行阶段不存在");
  if (project.status === "COMPLETED" || project.status === "VOIDED") throw new Error("已完成或已作废的项目不能申请阶段 Gate");

  const matterInputs = matters.map((matter) => ({
    id: matter.id,
    status: matter.status,
    dueDate: matter.dueDate,
    ganttTaskIds: Array.from(new Set([
      ...(matter.ganttTaskId ? [matter.ganttTaskId] : []),
      ...matter.ganttTaskLinks.map((link) => link.ganttTaskId),
    ])),
  }));
  const riskInputs = risks.map((risk) => ({
    id: risk.id,
    level: risk.level,
    status: risk.status,
    ganttTaskIds: Array.from(new Set([
      ...(risk.ganttTaskId ? [risk.ganttTaskId] : []),
      ...(risk.weeklyItem?.ganttTaskId ? [risk.weeklyItem.ganttTaskId] : []),
      ...(risk.weeklyItem?.ganttTaskLinks.map((link) => link.ganttTaskId) ?? []),
      ...risk.weeklyItemLinks.flatMap((link) => [
        ...(link.weeklyItem.ganttTaskId ? [link.weeklyItem.ganttTaskId] : []),
        ...link.weeklyItem.ganttTaskLinks.map((taskLink) => taskLink.ganttTaskId),
      ]),
    ])),
  }));
  const evaluation = evaluateProjectExecutionGate({
    projectId,
    executionId,
    ganttRevision: project.ganttRevision,
    links: execution.taskLinks,
    tasks,
    matters: matterInputs,
    risks: riskInputs,
  });
  return { project, execution, evaluation };
};
