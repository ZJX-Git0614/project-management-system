import { DeliverableLifecycleStatus, DeliverableType } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import { parseDeliverableType, parseOutsourceMode, serializeDeliverable } from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; deliverableId: string }> };

const deliveryInclude = {
  status: true,
  revisions: { select: { stage: true, listType: true, status: true } },
} as const;

class StaleDeliverableWriteError extends Error {}

const parseExpectedUpdatedAt = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-deliverables:edit")) return forbidden();

  const { id: projectId, deliverableId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const existing = await prisma.projectDeliverable.findFirst({
    where: { id: deliverableId, projectId, archivedAt: null },
    include: {
      ...deliveryInclude,
      _count: { select: { revisions: true, procurementItems: true } },
    },
  });
  if (!existing) return notFound("交付物");

  const body = await req.json().catch(() => ({}));
  const expectedUpdatedAt = parseExpectedUpdatedAt(body.updatedAt);
  if (!expectedUpdatedAt) return err("缺少有效的交付物版本信息，请刷新后重试", 409);
  const name = typeof body.name === "string" ? body.name.trim() : existing.name;
  const quantity = body.quantity === undefined ? existing.quantity : Number(body.quantity);
  const unit = typeof body.unit === "string" ? body.unit.trim() : existing.unit;
  const type = body.type === undefined && body.typeCode === undefined
    ? existing.type
    : parseDeliverableType(body.typeCode ?? body.type);
  const outsourceMode = body.outsourceMode === undefined && body.outsourceModeCode === undefined
    ? existing.outsourceMode
    : parseOutsourceMode(body.outsourceModeCode ?? body.outsourceMode);
  const remark = typeof body.remark === "string" ? body.remark.trim() : existing.remark;

  if (!name || name.length > 200) return err("交付物名称不能为空且不能超过 200 个字符");
  if (!Number.isFinite(quantity) || quantity <= 0) return err("交付物数量必须大于 0");
  if (!unit) return err("交付物单位不能为空");
  if (!type) return err("交付物类型必须为软件或硬件");
  if (!outsourceMode) return err("是否外协必须为否、是或部分");

  const affectsTechnicalScope = type !== existing.type || quantity !== existing.quantity;
  if (affectsTechnicalScope && (existing._count.revisions > 0 || existing._count.procurementItems > 0)) {
    return err("已有物料版本或采购记录时不能修改交付物类型或数量，请新增交付物版本承接范围变更");
  }
  if (type !== existing.type && existing.status?.lifecycleStatus !== DeliverableLifecycleStatus.DRAFT) {
    return err("只有草稿状态且没有物料或采购记录的交付物可以修改类型");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const write = await tx.projectDeliverable.updateMany({
      where: { id: deliverableId, projectId, archivedAt: null, updatedAt: expectedUpdatedAt },
      data: { name, quantity, unit, type, outsourceMode, remark },
    });
    if (write.count !== 1) throw new StaleDeliverableWriteError();
    if (type !== existing.type) {
      await tx.projectDeliverableStatus.updateMany({
        where: { deliverableId },
        data: {
          gitUrl: "",
          gitRef: "",
          hasPrototype: false,
          prototypeQuantity: 0,
          massProductionQuantity: type === DeliverableType.HARDWARE ? quantity : 0,
        },
      });
    }
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "DELIVERABLE",
        entityId: deliverableId,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新交付物：${existing.name} → ${name}（${quantity}${unit}）`,
      },
    });
    return tx.projectDeliverable.findUniqueOrThrow({ where: { id: deliverableId }, include: deliveryInclude });
  }).catch((error: unknown) => {
    if (error instanceof StaleDeliverableWriteError) return null;
    throw error;
  });

  if (!updated) return err("交付物已被其他用户更新，请刷新后重试", 409);
  return ok(serializeDeliverable(updated));
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-deliverables:delete")) return forbidden();

  const { id: projectId, deliverableId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;
  const body = await req.json().catch(() => ({}));
  const expectedUpdatedAt = parseExpectedUpdatedAt(body.updatedAt);
  if (!expectedUpdatedAt) return err("缺少有效的交付物版本信息，请刷新后重试", 409);

  const existing = await prisma.projectDeliverable.findFirst({
    where: { id: deliverableId, projectId, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!existing) return notFound("交付物");

  const archived = await prisma.$transaction(async (tx) => {
    const write = await tx.projectDeliverable.updateMany({
      where: { id: deliverableId, projectId, archivedAt: null, updatedAt: expectedUpdatedAt },
      data: { archivedAt: new Date() },
    });
    if (write.count !== 1) throw new StaleDeliverableWriteError();
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "DELIVERABLE",
        entityId: deliverableId,
        actionType: "ARCHIVE",
        operator: user.displayName,
        detail: `归档交付物：${existing.name}；物料版本及采购审计链保留`,
      },
    });
    return true;
  }).catch((error: unknown) => {
    if (error instanceof StaleDeliverableWriteError) return false;
    throw error;
  });

  if (!archived) return err("交付物已被其他用户更新，请刷新后重试", 409);
  return ok({ id: deliverableId, archived: true });
}
