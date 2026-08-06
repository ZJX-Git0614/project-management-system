import { NextRequest } from "next/server";

import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { err, forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { ensureDefaultApprovalWorkflows, INSTANCE_INCLUDE, serializeApprovalInstance, startApprovalWorkflow } from "@/lib/approval-workflow-server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:view")) return forbidden();
  const projectId = req.nextUrl.searchParams.get("projectId") || undefined;
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const mine = req.nextUrl.searchParams.get("scope") !== "all" || !user.assignedRoleNames.includes(ADMIN_ROLE_NAME);
  const instances = await prisma.approvalWorkflowInstance.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(status ? { status } : {}),
      ...(mine ? {
        OR: [
          { requesterAccountId: user.userId },
          { nodes: { some: { assignments: { some: { accountId: user.userId } } } } },
          { collaborationThread: { participants: { some: { accountId: user.userId } } } },
        ],
      } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: INSTANCE_INCLUDE,
    take: 200,
  });
  return ok(instances.map(serializeApprovalInstance));
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-center:view")) return forbidden();
  try {
    const body = await req.json() as Record<string, unknown>;
    const projectId = String(body.projectId || "").trim();
    const businessType = String(body.businessType || "").trim();
    const businessId = String(body.businessId || "").trim();
    if (!projectId || !businessType || !businessId) return err("项目、业务类型和业务主键不能为空");
    await ensureDefaultApprovalWorkflows(user);
    const definition = await prisma.approvalWorkflowDefinition.findUnique({
      where: { businessType },
      include: {
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { version: "desc" },
          take: 1,
          select: { triggerPermissionKey: true },
        },
      },
    });
    if (!definition?.enabled || definition.activeVersionNumber <= 0) return err("审批流程未启用");
    const triggerPermissionKey = definition.versions[0]?.triggerPermissionKey || "";
    if (triggerPermissionKey && !await userHasPermission(user, triggerPermissionKey)) return forbidden();
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown>
      : {};
    const instance = await startApprovalWorkflow({ projectId, businessType, businessId, requester: user, payload });
    return ok(serializeApprovalInstance(instance), 201);
  } catch (error) {
    return err(error instanceof Error ? error.message : "审批发起失败");
  }
}
