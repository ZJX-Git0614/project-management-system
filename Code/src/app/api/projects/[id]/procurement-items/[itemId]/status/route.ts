import { ProcurementStatus } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import {
  isProcurementTransitionAllowed,
  isProcurementTerminalStatus,
  parseProcurementStatus,
  procurementStatusLabel,
  validateProcurementProgress,
} from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

class StaleProcurementWriteError extends Error {}

const money = (value: number) => Math.round(value * 100) / 100;

const nonNegative = (value: unknown, fallback: number) => {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const parseDate = (value: unknown, fallback: Date | null) => {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export async function PUT(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-procurement:status-change")) return forbidden();

  const { id: projectId, itemId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const item = await prisma.projectProcurementItem.findFirst({ where: { id: itemId, projectId } });
  if (!item) return notFound("采购条目");

  const body = await req.json().catch(() => ({}));
  const nextStatus = parseProcurementStatus(body.status ?? body.statusCode);
  if (!nextStatus) return err("采购状态无效");
  if (!isProcurementTransitionAllowed(item.status, nextStatus)) {
    return err(`不允许从${procurementStatusLabel(item.status)}变更为${procurementStatusLabel(nextStatus)}`);
  }
  if (item.status === nextStatus && isProcurementTerminalStatus(item.status)) return err("已关闭或已取消的采购条目不可继续修改");

  const orderedQuantity = nonNegative(body.orderedQuantity, item.orderedQuantity);
  const receivedQuantity = nonNegative(body.receivedQuantity, item.receivedQuantity);
  const acceptedQuantity = nonNegative(body.acceptedQuantity, item.acceptedQuantity);
  const unitPrice = nonNegative(body.unitPrice, item.unitPrice);
  const derivedOrderAmount = orderedQuantity === null || unitPrice === null ? 0 : money(orderedQuantity * unitPrice);
  const orderInputsChanged = body.orderedQuantity !== undefined || body.unitPrice !== undefined;
  const orderAmount = nonNegative(body.orderAmount, orderInputsChanged ? derivedOrderAmount : item.orderAmount || derivedOrderAmount);
  const derivedActualAmount = receivedQuantity === null || unitPrice === null ? 0 : money(receivedQuantity * unitPrice);
  const actualInputsChanged = body.receivedQuantity !== undefined || body.unitPrice !== undefined;
  const actualAmount = nonNegative(body.actualAmount, actualInputsChanged ? derivedActualAmount : item.actualAmount || derivedActualAmount);
  const expectedArrivalDate = parseDate(body.expectedArrivalDate, item.expectedArrivalDate);
  const parsedActualArrivalDate = parseDate(body.actualArrivalDate, item.actualArrivalDate);
  if ([orderedQuantity, receivedQuantity, acceptedQuantity, unitPrice, orderAmount, actualAmount].some((value) => value === null)) {
    return err("数量和金额必须为非负数");
  }
  if (expectedArrivalDate === undefined || parsedActualArrivalDate === undefined) return err("日期格式无效");

  const orderNo = typeof body.orderNo === "string" ? body.orderNo.trim() : item.orderNo;
  const supplierName = typeof body.supplierName === "string" ? body.supplierName.trim() : item.supplierName;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const recordsArrival = nextStatus === ProcurementStatus.PARTIALLY_RECEIVED
    || nextStatus === ProcurementStatus.RECEIVED
    || nextStatus === ProcurementStatus.INSPECTING
    || nextStatus === ProcurementStatus.ACCEPTED
    || nextStatus === ProcurementStatus.REJECTED
    || nextStatus === ProcurementStatus.CLOSED;
  const actualArrivalDate = parsedActualArrivalDate ?? (recordsArrival ? new Date() : null);
  const progressError = validateProcurementProgress({
    status: nextStatus,
    plannedQuantity: item.plannedQuantity,
    orderedQuantity: orderedQuantity!,
    receivedQuantity: receivedQuantity!,
    acceptedQuantity: acceptedQuantity!,
    supplierName,
    orderNo,
    orderAmount: orderAmount!,
    expectedArrivalDate,
    actualArrivalDate,
    note,
  });
  if (progressError) return err(progressError);

  const updated = await prisma.$transaction(async (tx) => {
    const write = await tx.projectProcurementItem.updateMany({
      where: { id: itemId, status: item.status, updatedAt: item.updatedAt },
      data: {
        status: nextStatus,
        orderedQuantity: orderedQuantity!,
        receivedQuantity: receivedQuantity!,
        acceptedQuantity: acceptedQuantity!,
        unitPrice: unitPrice!,
        plannedAmount: money(item.plannedQuantity * unitPrice!),
        orderAmount: orderAmount!,
        actualAmount: actualAmount!,
        orderNo,
        supplierName,
        expectedArrivalDate,
        actualArrivalDate,
        note: note || item.note,
      },
    });
    if (write.count !== 1) throw new StaleProcurementWriteError();
    if (item.status !== nextStatus) {
      await tx.projectProcurementStatusLog.create({
        data: {
          procurementItemId: itemId,
          fromStatus: item.status,
          toStatus: nextStatus,
          note,
          operatorUserId: user.userId,
          operatorName: user.displayName,
        },
      });
    }
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROCUREMENT_STATUS",
        entityId: itemId,
        actionType: item.status === nextStatus ? "UPDATE" : "STATUS_CHANGED",
        operator: user.displayName,
        detail: item.status === nextStatus
          ? `采购执行信息更新：${item.name}（下单 ${orderedQuantity}${item.unit}，到货 ${receivedQuantity}${item.unit}，验收 ${acceptedQuantity}${item.unit}，订单金额 ${orderAmount} ${item.currency}）`
          : `采购状态变更：${item.name}（${procurementStatusLabel(item.status)} → ${procurementStatusLabel(nextStatus)}）${note ? `；${note}` : ""}`,
      },
    });
    return await tx.projectProcurementItem.findUniqueOrThrow({ where: { id: itemId } });
  }).catch((error: unknown) => {
    if (error instanceof StaleProcurementWriteError) return null;
    throw error;
  });

  if (!updated) return err("采购条目已被其他用户更新，请刷新后重试", 409);

  return ok({
    ...updated,
    statusCode: updated.status,
    status: procurementStatusLabel(updated.status),
    expectedArrivalDate: updated.expectedArrivalDate?.toISOString().slice(0, 10) ?? null,
    actualArrivalDate: updated.actualArrivalDate?.toISOString().slice(0, 10) ?? null,
  });
}
