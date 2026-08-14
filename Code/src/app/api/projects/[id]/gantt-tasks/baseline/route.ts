import { NextRequest } from "next/server";

import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { APPROVAL_BUSINESS_TYPES, approvalBusinessIdForWbsBaseline } from "@/lib/approval-workflow";
import { serializeApprovalInstance, startApprovalWorkflow } from "@/lib/approval-workflow-server";
import {
  beginProjectGanttBaselineDraft,
  getGanttBaselinePermissions,
  getProjectGanttBaselineOverview,
  isProjectGanttManager,
  publishProjectGanttBaseline,
} from "@/lib/gantt-baseline-service";
import { refreshProjectGanttDerivedState } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const canManageProjectBaseline = async (projectId: string, user: NonNullable<Awaited<ReturnType<typeof getAuthenticatedUser>>>) => (
  isProjectGanttManager(projectId, user.userId)
);

const getBaselinePermissionsForUser = async (
  projectId: string,
  user: NonNullable<Awaited<ReturnType<typeof getAuthenticatedUser>>>,
  overview: Awaited<ReturnType<typeof getProjectGanttBaselineOverview>>,
) => {
  const [canMaintainDraft, canPublishBaseline, manager] = await Promise.all([
    userHasPermission(user, "project-gantt:baseline-draft"),
    userHasPermission(user, "project-gantt:baseline-publish"),
    canManageProjectBaseline(projectId, user),
  ]);
  return getGanttBaselinePermissions({
    baselineState: overview.project.ganttBaselineState,
    baselineVersion: overview.project.ganttBaselineVersion,
    canMaintainDraft,
    canPublishBaseline,
    isProjectManager: manager,
  });
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-gantt:view")) return forbidden();

  const { id } = await params;
  try {
    const overview = await getProjectGanttBaselineOverview(id);
    const permissions = await getBaselinePermissionsForUser(id, user, overview);
    return ok({
      ...overview,
      permissions,
      blockers: overview.validation.blockers,
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : "读取 WBS 基线状态失败", 404);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? "VALIDATE").trim().toUpperCase();
  const reason = String(body.reason ?? "").trim();

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, ganttRevision: true, ganttBaselineVersion: true, ganttBaselineState: true, status: true },
  });
  if (!project) return err("项目不存在", 404);
  if (project.status === "COMPLETED" || project.status === "VOIDED") {
    return err("已完成或已作废的项目不能维护 WBS 基线", 403);
  }

  if (action === "REQUEST_APPROVAL") {
    if (!await userHasPermission(user, "project-gantt:baseline-request")) return forbidden();
    try {
      const overview = await getProjectGanttBaselineOverview(id);
      const approval = await startApprovalWorkflow({
        projectId: id,
        businessType: APPROVAL_BUSINESS_TYPES.WBS_BASELINE_PUBLISH,
        businessId: approvalBusinessIdForWbsBaseline(id),
        requester: user,
        payload: { ganttRevision: project.ganttRevision },
      });
      return ok({
        approvalRequired: true,
        approvalInstance: serializeApprovalInstance(approval),
        validation: overview.validation,
        blockers: overview.validation.blockers,
        permissions: await getBaselinePermissionsForUser(id, user, overview),
      }, 202);
    } catch (error) {
      return err(error instanceof Error ? error.message : "WBS 基线审批发起失败");
    }
  }

  if (action === "VALIDATE") {
    if (!await userHasPermission(user, "project-gantt:view")) return forbidden();
    try {
      await refreshProjectGanttDerivedState(id);
      const overview = await getProjectGanttBaselineOverview(id);
      return ok({
        ...overview,
        permissions: await getBaselinePermissionsForUser(id, user, overview),
        blockers: overview.validation.blockers,
      });
    } catch (error) {
      return err(error instanceof Error ? error.message : "WBS 基线校验失败");
    }
  }

  if (action === "BEGIN_CHANGE") {
    try {
      const overview = await getProjectGanttBaselineOverview(id);
      const permissions = await getBaselinePermissionsForUser(id, user, overview);
      if (!permissions.canPrepareDraft) {
        return err(
          project.ganttBaselineVersion > 0
            ? "创建变更基线草案需要项目经理同时具备“维护 WBS 基线草案”和“发布或变更 WBS 基线”权限。"
            : "创建 WBS 基线草案需要“维护 WBS 基线草案”权限。",
          403,
        );
      }
      const result = await beginProjectGanttBaselineDraft({
        projectId: id,
        actor: { userId: user.userId, displayName: user.displayName },
        reason,
      });
      const nextOverview = await getProjectGanttBaselineOverview(id);
      return ok({
        ...result,
        validation: nextOverview.validation,
        blockers: nextOverview.validation.blockers,
        permissions: await getBaselinePermissionsForUser(id, user, nextOverview),
      });
    } catch (error) {
      return err(error instanceof Error ? error.message : "创建 WBS 基线草案失败");
    }
  }

  if (action === "PUBLISH") {
    if (project.ganttBaselineState === "PUBLISHED") {
      return err("当前基线已发布，请先创建变更基线草案后再发布新版本", 409);
    }
    try {
      const overview = await getProjectGanttBaselineOverview(id);
      const permissions = await getBaselinePermissionsForUser(id, user, overview);
      if (!permissions.canPublish) return err("发布或变更 WBS 基线需要项目经理具备“发布或变更 WBS 基线”权限。", 403);
      await refreshProjectGanttDerivedState(id);
      const result = await publishProjectGanttBaseline({
        projectId: id,
        actor: { userId: user.userId, displayName: user.displayName },
        reason,
      });
      const nextOverview = await getProjectGanttBaselineOverview(id);
      return ok({
        ...result,
        validation: nextOverview.validation,
        blockers: nextOverview.validation.blockers,
        permissions: await getBaselinePermissionsForUser(id, user, nextOverview),
      });
    } catch (error) {
      return err(error instanceof Error ? error.message : "发布 WBS 基线失败", 409);
    }
  }

  return err("不支持的 WBS 基线操作");
}
