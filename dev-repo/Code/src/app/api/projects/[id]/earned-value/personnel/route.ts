import { NextRequest } from "next/server";

import { forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { buildPersonnelEarnedValue } from "@/lib/personnel-earned-value";
import { authorizeProjectAccess } from "@/lib/project-authorization";
import { buildProjectEarnedValueAnalysis } from "@/lib/project-earned-value-analysis";
import { getOrderedGanttTasks, serializeGanttTaskList } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/projects/[id]/earned-value/personnel
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "earned-value:view")) return forbidden();
  const accessError = await authorizeProjectAccess(user, id);
  if (accessError) return accessError;
  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, amountWan: true } });
  if (!project) return notFound("项目");

  const requestedDate = req.nextUrl.searchParams.get("statusDate")?.trim() ?? "";
  const statusDate = datePattern.test(requestedDate) ? requestedDate : new Date().toISOString().slice(0, 10);
  const [tasks, budgetItems, worklogs, members, budgetLaborAllocations, taskLaborAssignments] = await Promise.all([
    getOrderedGanttTasks(id).then(serializeGanttTaskList),
    prisma.projectBudgetItem.findMany({
      where: { projectId: id },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      include: { category: { select: { name: true, kind: true } } },
    }),
    prisma.projectTaskWorklog.findMany({
      where: { projectId: id },
      select: { taskId: true, projectMemberId: true, actualHours: true, actualCostSnapshot: true },
    }),
    prisma.projectMember.findMany({
      where: { projectId: id },
      select: { id: true, personName: true, roleName: true },
      orderBy: [{ personName: "asc" }, { createdAt: "asc" }],
    }),
    prisma.projectBudgetLaborAllocation.findMany({
      where: { projectId: id },
      select: { budgetItemId: true, projectMemberId: true, plannedHours: true, plannedHourlyCost: true },
    }),
    prisma.projectGanttTaskLaborAssignment.findMany({
      where: { task: { projectId: id } },
      select: { taskId: true, projectMemberId: true, plannedWorkHours: true },
    }),
  ]);
  const analysis = buildProjectEarnedValueAnalysis({
    tasks,
    budgetItems: budgetItems.map((item) => ({
      ...item,
      kind: item.category.kind,
      categoryName: item.category.name,
    })),
    contractAmount: Math.max(0, project.amountWan * 10_000),
    statusDate,
    worklogs,
  });
  const personnel = buildPersonnelEarnedValue({
    analysis,
    members,
    budgetLaborAllocations,
    taskLaborAssignments,
    worklogs,
  });
  return ok(personnel);
}
