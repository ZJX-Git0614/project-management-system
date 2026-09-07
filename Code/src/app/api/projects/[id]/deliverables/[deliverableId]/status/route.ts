import { DeliverableLifecycleStatus, DeliverableType, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import {
  parseDeliveryStatus,
  serializeDeliverable,
  validateDeliveryReviewGate,
} from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; deliverableId: string }> };

const deliveryInclude = {
  status: true,
  revisions: { select: { stage: true, listType: true, status: true } },
} as const;

const deliveryTransitions: Partial<Record<DeliverableLifecycleStatus, DeliverableLifecycleStatus[]>> = {
  DRAFT: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["READY_FOR_REVIEW", "CANCELLED"],
  READY_FOR_REVIEW: ["ACCEPTED", "REJECTED", "IN_PROGRESS"],
  REJECTED: ["IN_PROGRESS", "CANCELLED"],
  ACCEPTED: ["DELIVERED"],
};

const terminalDeliveryStatuses = new Set<DeliverableLifecycleStatus>([
  DeliverableLifecycleStatus.DELIVERED,
  DeliverableLifecycleStatus.CANCELLED,
]);

class StaleDeliveryStatusWriteError extends Error {}

const parseBoolean = (value: unknown, fallback: boolean) => (
  typeof value === "boolean" ? value : fallback
);

const parseNonNegativeNumber = (value: unknown, fallback: number) => {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export async function PUT(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-delivery-status:status-change")) return forbidden();

  const { id: projectId, deliverableId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const deliverable = await prisma.projectDeliverable.findFirst({
    where: { id: deliverableId, projectId, archivedAt: null },
    include: deliveryInclude,
  });
  if (!deliverable) return notFound("交付物");

  const body = await req.json().catch(() => ({}));
  const current = deliverable.status;
  const nextStatus = parseDeliveryStatus(body.lifecycleStatus ?? current?.lifecycleStatus);
  if (!nextStatus) return err("交付状态无效");
  const currentStatus = current?.lifecycleStatus ?? DeliverableLifecycleStatus.DRAFT;
  if (currentStatus === nextStatus && terminalDeliveryStatuses.has(currentStatus)) {
    return err("已交付或已取消的交付物不可继续修改");
  }
  if (currentStatus !== nextStatus && deliveryTransitions[currentStatus]?.includes(nextStatus) !== true) {
    return err(`不允许从 ${currentStatus} 变更为 ${nextStatus}`);
  }

  const gitUrl = typeof body.gitUrl === "string" ? body.gitUrl.trim() : (current?.gitUrl ?? "");
  const gitRef = typeof body.gitRef === "string" ? body.gitRef.trim() : (current?.gitRef ?? "");
  const hasPrototype = parseBoolean(body.hasPrototype, current?.hasPrototype ?? false);
  const prototypeQuantity = parseNonNegativeNumber(body.prototypeQuantity, current?.prototypeQuantity ?? 0);
  const massProductionQuantity = parseNonNegativeNumber(body.massProductionQuantity, current?.massProductionQuantity ?? deliverable.quantity);
  if (prototypeQuantity === null || massProductionQuantity === null) return err("样机和量产数量必须为非负数");
  if (deliverable.type === DeliverableType.HARDWARE && hasPrototype && prototypeQuantity <= 0) {
    return err("选择有样机时，样机数量必须大于 0");
  }
  const effectivePrototypeQuantity = hasPrototype ? prototypeQuantity! : 0;
  if (deliverable.type === DeliverableType.HARDWARE && effectivePrototypeQuantity + massProductionQuantity! > deliverable.quantity) {
    return err("样机数量与量产数量合计不能超过交付物总数量");
  }

  const gateError = validateDeliveryReviewGate({
    deliverable,
    nextStatus,
    gitUrl,
    hasPrototype,
    prototypeQuantity: effectivePrototypeQuantity,
    massProductionQuantity: massProductionQuantity!,
  });
  if (gateError) return err(gateError);

  const statusData = {
    lifecycleStatus: nextStatus,
    gitUrl: deliverable.type === DeliverableType.SOFTWARE ? gitUrl : "",
    gitRef: deliverable.type === DeliverableType.SOFTWARE ? gitRef : "",
    hasPrototype: deliverable.type === DeliverableType.HARDWARE ? hasPrototype : false,
    prototypeQuantity: deliverable.type === DeliverableType.HARDWARE ? effectivePrototypeQuantity : 0,
    massProductionQuantity: deliverable.type === DeliverableType.HARDWARE ? massProductionQuantity! : 0,
    acceptedAt: nextStatus === DeliverableLifecycleStatus.ACCEPTED ? new Date() : current?.acceptedAt ?? null,
    deliveredAt: nextStatus === DeliverableLifecycleStatus.DELIVERED ? new Date() : current?.deliveredAt ?? null,
  };
  const saved = await prisma.$transaction(async (tx) => {
    if (current) {
      const write = await tx.projectDeliverableStatus.updateMany({
        where: { deliverableId, updatedAt: current.updatedAt },
        data: statusData,
      });
      if (write.count !== 1) throw new StaleDeliveryStatusWriteError();
    } else {
      await tx.projectDeliverableStatus.create({
        data: {
        deliverableId,
          ...statusData,
        },
      });
    }
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "DELIVERY_STATUS",
        entityId: deliverableId,
        actionType: currentStatus === nextStatus ? "UPDATE" : "STATUS_CHANGED",
        operator: user.displayName,
        detail: currentStatus === nextStatus
          ? `更新交付物状态资料：${deliverable.name}（${nextStatus}）`
          : `交付物状态变更：${deliverable.name}（${currentStatus} → ${nextStatus}）`,
      },
    });
    return true;
  }).catch((error: unknown) => {
    if (error instanceof StaleDeliveryStatusWriteError) return false;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  });

  if (!saved) return err("交付物状态已被其他用户更新，请刷新后重试", 409);

  const updated = await prisma.projectDeliverable.findUnique({ where: { id: deliverableId }, include: deliveryInclude });
  return ok(serializeDeliverable(updated!));
}
