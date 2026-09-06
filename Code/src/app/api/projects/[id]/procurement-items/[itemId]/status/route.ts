import { ProcurementStatus } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import {
  isProcurementTransitionAllowed,
  parseProcurementStatus,
  procurementStatusLabel,
} from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

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
  if (!await userHasPermission(user, "project-procurement:edit")) return forbidden();

  const { id: projectId, itemId } = await params;
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

  const orderedQuantity = nonNegative(body.orderedQuantity, item.orderedQuantity);
  const receivedQuantity = nonNegative(body.receivedQuantity, item.receivedQuantity);
  const acceptedQuantity = nonNegative(body.acceptedQuantity, item.acceptedQuantity);
  const unitPrice = nonNegative(body.unitPrice, item.unitPrice);
  const orderAmount = nonNegative(body.orderAmount, item.orderAmount);
  const actualAmount = nonNegative(body.actualAmount, item.actualAmount);
  const expectedArrivalDate = parseDate(body.expectedArrivalDate, item.expectedArrivalDate);
  const actualArrivalDate = parseDate(body.actualArrivalDate, item.actualArrivalDate);
  if ([orderedQuantity, receivedQuantity, acceptedQuantity, unitPrice, orderAmount, actualAmount].some((value) => value === null)) {
    return err("数量和金额必须为非负数");
  }
  if (expectedArrivalDate === undefined || actualArrivalDate === undefined) return err("日期格式无效");
  if (orderedQuantity! > item.plannedQuantity) return err("下单数量不能超过计划数量");
  if (receivedQuantity! > orderedQuantity!) return err("到货数量不能超过已下单数量");
  if (acceptedQuantity! > receivedQuantity!) return err("验收数量不能超过已到货数量");

  const orderNo = typeof body.orderNo === "string" ? body.orderNo.trim() : item.orderNo;
  if (nextStatus === ProcurementStatus.ORDERED && (!orderNo || orderedQuantity! <= 0)) {
    return err("标记已下单时必须填写订单号和已下单数量");
  }
  if ((nextStatus === ProcurementStatus.PARTIALLY_RECEIVED || nextStatus === ProcurementStatus.RECEIVED) && receivedQuantity! <= 0) {
    return err("更新到货状态时必须填写已到货数量");
  }
  if (nextStatus === ProcurementStatus.ACCEPTED && acceptedQuantity! <= 0) return err("验收通过时必须填写验收数量");

  const note = typeof body.note === "string" ? body.note.trim() : "";
  const updated = await prisma.$transaction(async (tx) => {
    const record = await tx.projectProcurementItem.update({
      where: { id: itemId },
      data: {
        status: nextStatus,
        orderedQuantity: orderedQuantity!,
        receivedQuantity: receivedQuantity!,
        acceptedQuantity: acceptedQuantity!,
        unitPrice: unitPrice!,
        orderAmount: orderAmount!,
        actualAmount: actualAmount!,
        orderNo,
        supplierName: typeof body.supplierName === "string" ? body.supplierName.trim() : item.supplierName,
        expectedArrivalDate,
        actualArrivalDate: actualArrivalDate ?? (
          nextStatus === ProcurementStatus.RECEIVED
          || nextStatus === ProcurementStatus.ACCEPTED
          || nextStatus === ProcurementStatus.CLOSED
            ? new Date()
            : null
        ),
        note: note || item.note,
      },
    });
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
      await tx.operationHistory.create({
        data: {
          projectId,
          entityType: "PROCUREMENT_STATUS",
          entityId: itemId,
          actionType: "STATUS_CHANGED",
          operator: user.displayName,
          detail: `采购状态变更：${item.name}（${procurementStatusLabel(item.status)} → ${procurementStatusLabel(nextStatus)}）${note ? `；${note}` : ""}`,
        },
      });
    }
    return record;
  });

  return ok({
    ...updated,
    statusCode: updated.status,
    status: procurementStatusLabel(updated.status),
    expectedArrivalDate: updated.expectedArrivalDate?.toISOString().slice(0, 10) ?? null,
    actualArrivalDate: updated.actualArrivalDate?.toISOString().slice(0, 10) ?? null,
  });
}
