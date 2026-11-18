import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { createProjectGanttTask, readProjectGanttTasks } from "@/modules/wbs";
import {
  isProjectAuthorizationResponse,
  requireProjectPermission,
} from "@/lib/project-authorization";
import {
  estimatedHoursForDuration,
  isValidGanttDurationDays,
  roundGanttHours,
} from "@/lib/gantt-calendar";
import {
  normalizeGanttCompletion,
  normalizeGanttHalfDay,
  normalizeGanttUserPriority,
  resolveGanttTaskPlan,
} from "@/lib/gantt-planning-rules";
import {
  getProjectGanttCalendarMode,
  getOrderedGanttTasks,
  parseGanttDependencyInput,
  serializeGanttTaskList,
} from "@/lib/gantt-task-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PARENT_BOUNDARY_MODES = new Set(["ROLLUP", "TARGET", "LOCKED"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireProjectPermission(req, id, "project-gantt:view");
  if (isProjectAuthorizationResponse(user)) return user;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return notFound("项目");

  const response = ok(await readProjectGanttTasks({
    projectId: id,
    projectStartDate: project.startDate,
  }));
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  return response;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireProjectPermission(req, id, "project-gantt:create");
  if (isProjectAuthorizationResponse(user)) return user;

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");

  const body = await req.json() as Record<string, unknown>;
  const taskName = String(body.taskName ?? "").trim();
  const taskDescription = String(body.taskDescription ?? "").trim() || "无";
  const requestedStartDate = String(body.startDate ?? "").trim();
  const requestedFinishDate = String(body.finishDate ?? "").trim();
  const requestedStartSlot = normalizeGanttHalfDay(body.startSlot);
  const requestedFinishSlot = normalizeGanttHalfDay(body.finishSlot, "PM");
  const durationDays = Number(body.durationDays ?? 0);
  if (!isValidGanttDurationDays(durationDays)) return err("工期只能为空或以 0.5 天为单位填写");
  const calendarMode = await getProjectGanttCalendarMode(id);
  const plan = resolveGanttTaskPlan({
    taskMode: body.taskMode,
    startDate: requestedStartDate,
    startSlot: requestedStartSlot,
    finishDate: requestedFinishDate,
    finishSlot: requestedFinishSlot,
    durationDays,
    mode: calendarMode,
  });
  if (plan.error) return err(plan.error);
  const actualStartDate = String(body.actualStartDate ?? "").trim();
  const actualEndDate = String(body.actualEndDate ?? "").trim();
  const actualStartSlot = normalizeGanttHalfDay(body.actualStartSlot);
  const actualFinishSlot = normalizeGanttHalfDay(body.actualFinishSlot, "PM");
  const estimatedWorkHours = estimatedHoursForDuration(plan.durationDays);
  const actualWorkHours = roundGanttHours(Number(body.actualWorkHours ?? 0));
  const requestedProgress = Number(body.progress ?? 0);
  const completion = normalizeGanttCompletion({
    progress: requestedProgress,
    actualStartDate,
    actualEndDate,
    today: new Date().toISOString().slice(0, 10),
  });
  const parentBoundaryMode = String(body.parentBoundaryMode ?? "ROLLUP").trim().toUpperCase();
  const schedulePriority = Number(body.schedulePriority ?? 500);
  const userPriority = normalizeGanttUserPriority(body.userPriority);
  const effortDriven = body.effortDriven === true;
  const parallelizable = body.parallelizable === true;
  const isMilestone = Boolean(body.isMilestone);
  const predecessorTask = String(body.predecessorTask ?? "").trim();
  const remark = String(body.remark ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const parentId = body.parentId ? String(body.parentId) : null;
  const requestedOwnerMemberIds = Array.isArray(body.ownerMemberIds)
    ? [...new Set(body.ownerMemberIds.map((value) => String(value).trim()).filter(Boolean))]
    : (body.ownerMemberId ? [String(body.ownerMemberId).trim()] : []);
  const budgetItemId = body.budgetItemId ? String(body.budgetItemId) : null;

  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (completion.error) return err(completion.error);
  if (!Number.isFinite(Number(body.actualWorkHours ?? 0)) || Number(body.actualWorkHours ?? 0) < 0) return err("实际工时必须为大于或等于 0 的数字");
  if (
    completion.progress !== 0
    || completion.actualStartDate
    || completion.actualEndDate
    || actualWorkHours > 0
  ) {
    return err("新增任务只能创建计划数据；执行进度、实际日期和实际工时请在任务创建后通过进度提交审批更新", 409, "GANTT_PROGRESS_APPROVAL_REQUIRED");
  }
  if (!PARENT_BOUNDARY_MODES.has(parentBoundaryMode)) return err("父任务边界方式无效");
  if (!Number.isInteger(schedulePriority) || schedulePriority < 0 || schedulePriority > 1000) {
    return err("排期优先级必须是 0 到 1000 的整数");
  }
  const parentTask = parentId
    ? await prisma.projectGanttTask.findFirst({
        where: { id: parentId, projectId: id },
        select: { id: true, taskCategory: true, taskName: true },
      })
    : null;
  if (parentId && !parentTask) return notFound("父级甘特任务");
  const taskCategory = parentTask
    ? parentTask.taskCategory.trim() || parentTask.taskName.trim()
    : taskName;
  if (budgetItemId) {
    const budgetItem = await prisma.projectBudgetItem.findFirst({ where: { id: budgetItemId, projectId: id }, select: { id: true } });
    if (!budgetItem) return notFound("预算条目");
  }
  if (requestedOwnerMemberIds.length > 0) {
    if (requestedOwnerMemberIds.length > 1) {
      return err("末级任务只能指定一名负责人；父级负责人由子任务自动汇总");
    }
    const owners = await prisma.projectMember.findMany({ where: { id: { in: requestedOwnerMemberIds }, projectId: id }, select: { id: true } });
    if (owners.length !== requestedOwnerMemberIds.length) return err("负责人必须来自当前项目组成员");
  }

  const created = await createProjectGanttTask({
    projectId: id,
    parentId,
    requestedOwnerMemberIds,
    taskCategory,
    taskName,
    taskDescription,
    plan,
    actualStartDate: completion.actualStartDate,
    actualEndDate: completion.actualEndDate,
    actualStartSlot,
    actualFinishSlot,
    estimatedWorkHours,
    actualWorkHours,
    progress: completion.progress,
    parentBoundaryMode,
    schedulePriority,
    userPriority,
    effortDriven,
    parallelizable,
    isMilestone,
    budgetItemId,
    predecessorTask,
    remark,
    dependencies,
    calendarMode,
  });
  const normalizedTask = serializeGanttTaskList(await getOrderedGanttTasks(id)).find((item) => item.id === created.taskId);
  if (!normalizedTask) return err("新增任务后读取失败", 500);

  return ok(normalizedTask, 201);
}
