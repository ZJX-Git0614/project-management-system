import { NextRequest } from "next/server";

import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import {
  applyProjectResourceScheduleCandidate,
  RESOURCE_SCHEDULE_CANDIDATE_KINDS,
  resourceConflictAnalysis,
  resourceScheduleAnalysis,
  serializeResourceCandidate,
  serializeResourceConflict,
} from "@/lib/gantt-resource-service";
import type { ResourceScheduleCandidateKind } from "@/lib/gantt-resource-schedule";

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
    const { context, result } = includeCandidates
      ? await resourceScheduleAnalysis(id)
      : await resourceConflictAnalysis(id);
    const candidates = includeCandidates
      ? (result as Awaited<ReturnType<typeof resourceScheduleAnalysis>>["result"]).candidates
      : [];
    const isAdmin = user.assignedRoleNames.includes("管理员");
    return ok({
      revision: context.currentProject.ganttRevision,
      snapshotHash: result.snapshotHash,
      conflicts: result.conflicts.map((conflict) => serializeResourceConflict(conflict, context.summaries, isAdmin)),
      candidates: candidates.map((candidate) => serializeResourceCandidate(candidate, context.summaries, isAdmin)),
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
  const body = await req.json() as Record<string, unknown>;
  const candidateKind = String(body.candidateKind ?? "") as ResourceScheduleCandidateKind;
  if (!candidateKinds.has(candidateKind)) return err("优化排期方案无效");
  const requestedRevision = Number(body.revision);
  const requestedSnapshotHash = String(body.snapshotHash ?? "");
  try {
    return ok(await applyProjectResourceScheduleCandidate({
      projectId: id,
      candidateKind,
      expectedRevision: requestedRevision,
      expectedSnapshotHash: requestedSnapshotHash,
      operator: user.displayName,
    }));
  } catch (error) {
    return err(error instanceof Error ? error.message : "优化排期应用失败", 409, "RESOURCE_SCHEDULE_APPLY_FAILED");
  }
}
