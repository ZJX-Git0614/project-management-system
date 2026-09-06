import { DeliverableLifecycleStatus, DeliverableType } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
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
  if (!await userHasPermission(user, "project-delivery-status:edit")) return forbidden();

  const { id: projectId, deliverableId } = await params;
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

  const gateError = validateDeliveryReviewGate({
    deliverable,
    nextStatus,
    gitUrl,
    hasPrototype,
  });
  if (gateError) return err(gateError);

  await prisma.$transaction(async (tx) => {
    await tx.projectDeliverableStatus.upsert({
      where: { deliverableId },
      create: {
        deliverableId,
        lifecycleStatus: nextStatus,
        gitUrl: deliverable.type === DeliverableType.SOFTWARE ? gitUrl : "",
        gitRef: deliverable.type === DeliverableType.SOFTWARE ? gitRef : "",
        hasPrototype: deliverable.type === DeliverableType.HARDWARE ? hasPrototype : false,
        prototypeQuantity: deliverable.type === DeliverableType.HARDWARE ? prototypeQuantity : 0,
        massProductionQuantity: deliverable.type === DeliverableType.HARDWARE ? massProductionQuantity : 0,
        acceptedAt: nextStatus === DeliverableLifecycleStatus.ACCEPTED ? new Date() : null,
        deliveredAt: nextStatus === DeliverableLifecycleStatus.DELIVERED ? new Date() : null,
      },
      update: {
        lifecycleStatus: nextStatus,
        gitUrl: deliverable.type === DeliverableType.SOFTWARE ? gitUrl : "",
        gitRef: deliverable.type === DeliverableType.SOFTWARE ? gitRef : "",
        hasPrototype: deliverable.type === DeliverableType.HARDWARE ? hasPrototype : false,
        prototypeQuantity: deliverable.type === DeliverableType.HARDWARE ? prototypeQuantity : 0,
        massProductionQuantity: deliverable.type === DeliverableType.HARDWARE ? massProductionQuantity : 0,
        acceptedAt: nextStatus === DeliverableLifecycleStatus.ACCEPTED ? new Date() : current?.acceptedAt ?? null,
        deliveredAt: nextStatus === DeliverableLifecycleStatus.DELIVERED ? new Date() : current?.deliveredAt ?? null,
      },
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "DELIVERY_STATUS",
        entityId: deliverableId,
        actionType: "STATUS_CHANGED",
        operator: user.displayName,
        detail: `交付物状态变更：${deliverable.name}（${currentStatus} → ${nextStatus}）`,
      },
    });
  });

  const updated = await prisma.projectDeliverable.findUnique({ where: { id: deliverableId }, include: deliveryInclude });
  return ok(serializeDeliverable(updated!));
}
