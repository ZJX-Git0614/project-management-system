import { NextRequest } from "next/server";

import { forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { evaluateProjectExecutionHealth } from "@/lib/project-execution-health";
import { resolveProjectExecutionScope, serializeProjectExecution } from "@/lib/project-execution";
import { serializeProjectExecutionGate } from "@/lib/project-execution-gate";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();

  const { id: projectId } = await params;
  const [project, canViewMatters, canViewRisks] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, status: true, ganttRevision: true } }),
    userHasPermission(user, "weekly-items:view"),
    userHasPermission(user, "risk-register:view"),
  ]);
  if (!project) return notFound("项目");

  const [executions, tasks, matters, risks, gates] = await Promise.all([
    prisma.projectExecution.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        ownerMember: { select: { id: true, personName: true, roleName: true } },
        taskLinks: {
          orderBy: { createdAt: "asc" },
          include: {
            ganttTask: {
              select: {
                id: true, parentId: true, taskCode: true, taskName: true, taskCategory: true,
                startDate: true, finishDate: true, durationDays: true, estimatedWorkHours: true,
                progress: true, scheduleStatus: true, totalFloatMinutes: true,
              },
            },
          },
        },
      },
    }),
    prisma.projectGanttTask.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, parentId: true, taskCode: true, taskName: true, taskCategory: true,
        startDate: true, finishDate: true, durationDays: true, estimatedWorkHours: true,
        progress: true, scheduleStatus: true, totalFloatMinutes: true,
      },
    }),
    canViewMatters ? prisma.weeklyItem.findMany({
      where: { projectId },
      select: {
        id: true, status: true, dueDate: true, ganttTaskId: true,
        ganttTaskLinks: { select: { ganttTaskId: true } },
      },
    }) : Promise.resolve([]),
    canViewRisks ? prisma.riskRegisterItem.findMany({
      where: { projectId },
      select: {
        id: true, level: true, status: true, ganttTaskId: true,
        weeklyItem: { select: { ganttTaskId: true, ganttTaskLinks: { select: { ganttTaskId: true } } } },
        weeklyItemLinks: { select: { weeklyItem: { select: { ganttTaskId: true, ganttTaskLinks: { select: { ganttTaskId: true } } } } } },
      },
    }) : Promise.resolve([]),
    prisma.projectExecutionGate.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const latestGateByExecutionId = new Map<string, typeof gates[number]>();
  gates.forEach((gate) => {
    if (!latestGateByExecutionId.has(gate.executionId)) latestGateByExecutionId.set(gate.executionId, gate);
  });
  const matterInputs = matters.map((matter) => ({
    id: matter.id,
    status: matter.status,
    dueDate: matter.dueDate,
    ganttTaskIds: Array.from(new Set([
      ...(matter.ganttTaskId ? [matter.ganttTaskId] : []),
      ...matter.ganttTaskLinks.map((link) => link.ganttTaskId),
    ])),
  }));
  const riskTaskIds = (risk: typeof risks[number]) => Array.from(new Set([
    ...(risk.ganttTaskId ? [risk.ganttTaskId] : []),
    ...(risk.weeklyItem?.ganttTaskId ? [risk.weeklyItem.ganttTaskId] : []),
    ...(risk.weeklyItem?.ganttTaskLinks.map((link) => link.ganttTaskId) ?? []),
    ...risk.weeklyItemLinks.flatMap((link) => [
      ...(link.weeklyItem.ganttTaskId ? [link.weeklyItem.ganttTaskId] : []),
      ...link.weeklyItem.ganttTaskLinks.map((taskLink) => taskLink.ganttTaskId),
    ]),
  ]));
  const riskInputs = risks.map((risk) => ({ id: risk.id, level: risk.level, status: risk.status, ganttTaskIds: riskTaskIds(risk) }));

  const stages = executions.map((execution) => {
    const scope = resolveProjectExecutionScope(execution.taskLinks, tasks);
    const effectiveIds = new Set(scope.effectiveTaskIds);
    const scopedMatters = matterInputs.filter((matter) => matter.ganttTaskIds.some((taskId) => effectiveIds.has(taskId)));
    const scopedRisks = riskInputs.filter((risk) => risk.ganttTaskIds.some((taskId) => effectiveIds.has(taskId)));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const health = evaluateProjectExecutionHealth({
      scope,
      today,
      openHighRiskCount: scopedRisks.filter((risk) => risk.level === "高" && risk.status !== "已关闭").length,
      openMatterCount: scopedMatters.filter((matter) => matter.status !== "DONE").length,
      overdueMatterCount: scopedMatters.filter((matter) => matter.status !== "DONE" && matter.dueDate && matter.dueDate < today).length,
      blockedMatterCount: scopedMatters.filter((matter) => /阻塞|BLOCKED/u.test(matter.status)).length,
    });
    return {
      ...serializeProjectExecution(execution, tasks),
      health,
      latestGate: latestGateByExecutionId.has(execution.id)
        ? serializeProjectExecutionGate(latestGateByExecutionId.get(execution.id)!)
        : null,
      related: {
        matters: canViewMatters ? { openCount: scopedMatters.filter((matter) => matter.status !== "DONE").length, overdueCount: scopedMatters.filter((matter) => matter.status !== "DONE" && matter.dueDate && matter.dueDate < today).length } : undefined,
        risks: canViewRisks ? { openHighRiskCount: scopedRisks.filter((risk) => risk.level === "高" && risk.status !== "已关闭").length } : undefined,
      },
    };
  });

  const currentStage = stages.find((stage) => stage.status === "IN_PROGRESS") ?? stages.find((stage) => stage.status !== "COMPLETED" && stage.status !== "ARCHIVED") ?? null;
  const alerts = stages.flatMap((stage) => stage.health.evidence.map((evidence) => ({
    stageId: stage.id,
    stageName: stage.name,
    health: stage.health.status,
    ...evidence,
  }))).slice(0, 20);
  return ok({
    project,
    permissions: { matters: canViewMatters, risks: canViewRisks },
    summary: {
      stageCount: stages.length,
      offTrackCount: stages.filter((stage) => stage.health.status === "OFF_TRACK").length,
      atRiskCount: stages.filter((stage) => stage.health.status === "AT_RISK").length,
      currentStageId: currentStage?.id ?? null,
    },
    stages,
    alerts,
  });
}
