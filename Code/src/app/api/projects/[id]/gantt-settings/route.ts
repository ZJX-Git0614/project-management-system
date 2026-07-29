import { NextRequest } from "next/server";

import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { getUserFromRequest } from "@/lib/auth";
import {
  GANTT_CALENDAR_MODES,
  GANTT_HOURS_PER_DAY,
  normalizeGanttCalendarMode,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { prisma } from "@/lib/prisma";
import { recalculateProjectGanttSchedule } from "@/lib/gantt-task-service";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getUserFromRequest(req)) return unauthorized();
  const project = await prisma.project.findUnique({
    where: { id },
    select: { ganttCalendarMode: true },
  });
  if (!project) return notFound("项目");
  return ok({
    calendarMode: normalizeGanttCalendarMode(project.ganttCalendarMode),
    hoursPerDay: GANTT_HOURS_PER_DAY,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json() as { calendarMode?: unknown };
  if (!GANTT_CALENDAR_MODES.includes(body.calendarMode as GanttCalendarMode)) {
    return err("工期计算方式仅支持自然日或工作日");
  }
  const calendarMode = body.calendarMode as GanttCalendarMode;
  await prisma.project.update({
    where: { id },
    data: { ganttCalendarMode: calendarMode },
  });
  await recalculateProjectGanttSchedule(id, calendarMode);
  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_GANTT_TASK",
      entityId: id,
      actionType: "UPDATE",
      operator: user.displayName,
      detail: `将项目工期计算方式调整为${calendarMode === "WORKING_DAYS" ? "工作日" : "自然日"}`,
    },
  });

  return ok({ calendarMode, hoursPerDay: GANTT_HOURS_PER_DAY });
}
