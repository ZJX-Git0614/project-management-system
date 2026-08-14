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
import { refreshProjectGanttDerivedState } from "@/lib/gantt-task-service";
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
    select: { ganttCalendarMode: true, ganttHardFinishDate: true, startDate: true },
  });
  if (!project) return notFound("项目");
  return ok({
    calendarMode: normalizeGanttCalendarMode(project.ganttCalendarMode),
    hoursPerDay: GANTT_HOURS_PER_DAY,
    // `ganttHardFinishDate` is retained as the storage column for backwards
    // compatibility. In the UI it is the optional WBS completion anchor used
    // by backward scheduling, not a second project-level hard-finish feature.
    wbsFinishDate: project.ganttHardFinishDate || "",
    hardFinishDate: project.ganttHardFinishDate || "",
    projectStartDate: project.startDate || "",
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

  const body = await req.json() as {
    calendarMode?: unknown;
    wbsFinishDate?: unknown;
    // Kept for already-deployed clients during the settings API transition.
    hardFinishDate?: unknown;
    projectStartDate?: unknown;
  };
  const updatingCalendarMode = body.calendarMode !== undefined;
  const updatingWbsFinishDate = body.wbsFinishDate !== undefined || body.hardFinishDate !== undefined;
  const updatingProjectStartDate = body.projectStartDate !== undefined;
  if (!updatingCalendarMode && !updatingWbsFinishDate && !updatingProjectStartDate) return err("未提供需要更新的排期设置");
  if (updatingCalendarMode && !GANTT_CALENDAR_MODES.includes(body.calendarMode as GanttCalendarMode)) {
    return err("工期计算方式仅支持自然日或工作日");
  }
  const existing = await prisma.project.findUnique({
    where: { id },
    select: { ganttCalendarMode: true, ganttHardFinishDate: true, startDate: true, ganttBaselineState: true, ganttBaselineVersion: true },
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
  const wbsFinishDate = updatingWbsFinishDate
    ? String(body.wbsFinishDate ?? body.hardFinishDate ?? "").trim()
    : existing.ganttHardFinishDate;
  const projectStartDate = updatingProjectStartDate ? String(body.projectStartDate ?? "").trim() : existing.startDate;
  if (wbsFinishDate && !/^\d{4}-\d{2}-\d{2}$/.test(wbsFinishDate)) {
    return err("WBS 完成日期格式应为 YYYY-MM-DD，或留空取消倒排锚点");
  }
  if (projectStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(projectStartDate)) {
    return err("项目 T0 日期格式应为 YYYY-MM-DD，或留空使用相对排期");
  }
  await prisma.project.update({
    where: { id },
    data: { ganttCalendarMode: calendarMode, ganttHardFinishDate: wbsFinishDate, startDate: projectStartDate },
  });
  await refreshProjectGanttDerivedState(id, calendarMode);
  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_GANTT_TASK",
      entityId: id,
      actionType: "UPDATE",
      operator: user.displayName,
      detail: `更新项目排期设置：${calendarMode === "WORKING_DAYS" ? "工作日" : "自然日"}，项目 T0 ${projectStartDate || "未设置"}，WBS 完成日期 ${wbsFinishDate || "未设置"}`,
    },
  });

  return ok({
    calendarMode,
    hoursPerDay: GANTT_HOURS_PER_DAY,
    wbsFinishDate,
    // Backward-compatible alias for clients not yet updated.
    hardFinishDate: wbsFinishDate,
    projectStartDate,
  });
}
