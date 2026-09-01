import { NextRequest } from "next/server";

import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import {
  applyProjectDurationSuggestions,
  applyProjectResourceScheduleCandidate,
  RESOURCE_SCHEDULE_CANDIDATE_KINDS,
  resourceConflictAnalysis,
  resourceScheduleAnalysis,
  serializeResourceCandidate,
  serializeResourceConflict,
} from "@/lib/gantt-resource-service";
import type { ResourceScheduleCandidateKind, ResourceScheduleModeOverride } from "@/lib/gantt-resource-schedule";
import type { GanttCalendarMode } from "@/lib/gantt-calendar";

const candidateKinds = new Set<ResourceScheduleCandidateKind>(RESOURCE_SCHEDULE_CANDIDATE_KINDS);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:view"))) return err("权限不足", 403);
  try {
    const includeCandidates = req.nextUrl.searchParams.get("includeCandidates") === "1";
    const isAdmin = user.assignedRoleNames.includes("管理员");
    if (includeCandidates) {
      const modeOverride = String(req.nextUrl.searchParams.get("modeOverride") ?? "PRESERVE") as ResourceScheduleModeOverride;
      if (!["PRESERVE", "AUTO", "DURATION_FORWARD", "DURATION_BACKWARD"].includes(modeOverride)) {
        return err("全局排期方式无效");
      }
      const scopeRootTaskIds = req.nextUrl.searchParams.getAll("scopeRootTaskId").map((value) => value.trim()).filter(Boolean);
      const requestedCalendarMode = req.nextUrl.searchParams.get("calendarMode");
      const calendarModeOverride = requestedCalendarMode === "WORKING_DAYS" || requestedCalendarMode === "CALENDAR_DAYS"
        ? requestedCalendarMode as GanttCalendarMode
        : undefined;
      if (requestedCalendarMode && !calendarModeOverride) return err("工期计算方式仅支持自然日或工作日");
      const { context, result, scope } = await resourceScheduleAnalysis(id, {
        scopeRootTaskIds,
        modeOverride,
        calendarModeOverride,
      });
      return ok({
        revision: context.currentProject.ganttRevision,
        snapshotHash: result.snapshotHash,
        scope,
        conflicts: result.conflicts.map((conflict) => serializeResourceConflict(conflict, context.summaries, isAdmin)),
        issues: result.issues ?? [],
        durationSuggestions: result.durationSuggestions ?? [],
        durationSuggestionIssues: result.durationSuggestionIssues ?? [],
        candidates: result.candidates.map((candidate) => serializeResourceCandidate(candidate, context.summaries, isAdmin)),
      });
    }
    const { context, result } = await resourceConflictAnalysis(id);
    return ok({
      revision: context.currentProject.ganttRevision,
      snapshotHash: result.snapshotHash,
      conflicts: result.conflicts.map((conflict) => serializeResourceConflict(conflict, context.summaries, isAdmin)),
      issues: result.issues ?? [],
      candidates: [],
    });
  } catch (error) {
    return notFound(error instanceof Error ? error.message : "项目");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:edit"))) return err("权限不足", 403);
  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");
  const body = await req.json() as Record<string, unknown>;
  const action = String(body.action ?? "APPLY_SCHEDULE");
  const requestedRevision = Number(body.revision);
  const requestedSnapshotHash = String(body.snapshotHash ?? "");
  if (action === "APPLY_DURATION_SUGGESTIONS") {
    const taskIds = Array.isArray(body.taskIds)
      ? body.taskIds.map((value) => String(value).trim()).filter(Boolean)
      : [];
    try {
      return ok(await applyProjectDurationSuggestions({
        projectId: id,
        taskIds,
        expectedRevision: requestedRevision,
        expectedSnapshotHash: requestedSnapshotHash,
        operator: user.displayName,
      }));
    } catch (error) {
      return err(error instanceof Error ? error.message : "系统建议工期应用失败", 409, "DURATION_SUGGESTION_APPLY_FAILED");
    }
  }
  const candidateKind = String(body.candidateKind ?? "") as ResourceScheduleCandidateKind;
  if (!candidateKinds.has(candidateKind)) return err("正式自动排期方案无效");
  const modeOverride = String(body.modeOverride ?? "PRESERVE") as ResourceScheduleModeOverride;
  if (!["PRESERVE", "AUTO", "DURATION_FORWARD", "DURATION_BACKWARD"].includes(modeOverride)) {
    return err("全局排期方式无效");
  }
  const scopeRootTaskIds = Array.isArray(body.scopeRootTaskIds)
    ? body.scopeRootTaskIds.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const calendarModeOverride = body.calendarMode === "WORKING_DAYS" || body.calendarMode === "CALENDAR_DAYS"
    ? body.calendarMode as GanttCalendarMode
    : undefined;
  if (body.calendarMode !== undefined && !calendarModeOverride) return err("工期计算方式仅支持自然日或工作日");
  try {
    return ok(await applyProjectResourceScheduleCandidate({
      projectId: id,
      candidateKind,
      expectedRevision: requestedRevision,
      expectedSnapshotHash: requestedSnapshotHash,
      operator: user.displayName,
      scopeRootTaskIds,
      modeOverride,
      calendarModeOverride,
    }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "正式自动排期应用失败", 409, "RESOURCE_SCHEDULE_APPLY_FAILED");
  }
}
