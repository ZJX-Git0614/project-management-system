import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { getGanttBaselinePermissions, isProjectGanttManager } from "@/lib/gantt-baseline-service";
import {
  GANTT_CALENDAR_MODES,
  GANTT_HOURS_PER_DAY,
  normalizeGanttCalendarMode,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { prisma } from "@/lib/prisma";
import { recalculateProjectGanttSchedule } from "@/lib/gantt-task-service";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();
  const project = await prisma.project.findUnique({
    where: { id },
    select: { ganttCalendarMode: true, ganttHardFinishDate: true },
  });
  if (!project) return notFound("项目");
  return ok({
    calendarMode: normalizeGanttCalendarMode(project.ganttCalendarMode),
    hoursPerDay: GANTT_HOURS_PER_DAY,
    hardFinishDate: project.ganttHardFinishDate || "",
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:edit")) return forbidden();
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json() as { calendarMode?: unknown; hardFinishDate?: unknown };
  const updatingCalendarMode = body.calendarMode !== undefined;
  const updatingHardFinishDate = body.hardFinishDate !== undefined;
  if (!updatingCalendarMode && !updatingHardFinishDate) return err("未提供需要更新的排期设置");
  if (updatingCalendarMode && !GANTT_CALENDAR_MODES.includes(body.calendarMode as GanttCalendarMode)) {
    return err("工期计算方式仅支持自然日或工作日");
  }
  const existing = await prisma.project.findUnique({
    where: { id },
    select: { ganttCalendarMode: true, ganttHardFinishDate: true, ganttBaselineState: true, ganttBaselineVersion: true },
  });
  if (!existing) return notFound("项目");
  const [canMaintainDraft, canPublishBaseline, isProjectManager] = await Promise.all([
    userHasPermission(user, "project-gantt:baseline-draft"),
    userHasPermission(user, "project-gantt:baseline-publish"),
    isProjectGanttManager(id, user.userId),
  ]);
  const baselinePermissions = getGanttBaselinePermissions({
    baselineState: existing.ganttBaselineState,
    baselineVersion: existing.ganttBaselineVersion,
    canMaintainDraft,
    canPublishBaseline,
    isProjectManager,
  });
  if (baselinePermissions.planningMutationBlocker) {
    return err(baselinePermissions.planningMutationBlocker, 409, "GANTT_BASELINE_LOCKED");
  }
  const calendarMode = updatingCalendarMode
    ? body.calendarMode as GanttCalendarMode
    : normalizeGanttCalendarMode(existing.ganttCalendarMode);
  const hardFinishDate = updatingHardFinishDate ? String(body.hardFinishDate ?? "").trim() : existing.ganttHardFinishDate;
  if (hardFinishDate && !/^\d{4}-\d{2}-\d{2}$/.test(hardFinishDate)) {
    return err("项目硬完成时间格式应为 YYYY-MM-DD，或留空取消硬约束");
  }
  await prisma.project.update({
    where: { id },
    data: { ganttCalendarMode: calendarMode, ganttHardFinishDate: hardFinishDate },
  });
  await recalculateProjectGanttSchedule(id, calendarMode);
  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_GANTT_TASK",
      entityId: id,
      actionType: "UPDATE",
      operator: user.displayName,
      detail: `更新项目排期设置：${calendarMode === "WORKING_DAYS" ? "工作日" : "自然日"}，项目硬完成时间${hardFinishDate || "未设置"}`,
    },
  });

  return ok({ calendarMode, hoursPerDay: GANTT_HOURS_PER_DAY, hardFinishDate });
}
