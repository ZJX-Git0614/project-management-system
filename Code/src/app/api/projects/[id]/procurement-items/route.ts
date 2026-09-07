import { ProcurementSourceType, ProcurementStatus } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import { parseProcurementSourceType, procurementStatusLabel } from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string }> };

const procurementInclude = {
  deliverable: { select: { id: true, name: true } },
  sourceRevision: { select: { id: true, version: true, stage: true, listType: true } },
  sourceMaterialItem: { select: { id: true, materialCode: true } },
  buyerMember: { select: { id: true, personName: true, roleName: true } },
} as const;

const serializeProcurement = (item: {
  id: string;
  projectId: string;
  sourceType: ProcurementSourceType;
  sourceRevisionId: string | null;
  sourceMaterialItemId: string | null;
  deliverableId: string | null;
  name: string;
  specification: string;
  plannedQuantity: number;
  orderedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  unit: string;
  unitPrice: number;
  plannedAmount: number;
  orderAmount: number;
  actualAmount: number;
  currency: string;
  status: ProcurementStatus;
  supplierName: string;
  purchaseRequestNo: string;
  orderNo: string;
  expectedArrivalDate: Date | null;
  actualArrivalDate: Date | null;
  note: string;
  createdAt: Date;
  updatedAt: Date;
  deliverable: { id: string; name: string } | null;
  sourceRevision: { id: string; version: number; stage: string; listType: string } | null;
  sourceMaterialItem: { id: string; materialCode: string } | null;
  buyerMember: { id: string; personName: string; roleName: string } | null;
}) => ({
  ...item,
  statusCode: item.status,
  status: procurementStatusLabel(item.status),
  expectedArrivalDate: item.expectedArrivalDate?.toISOString().slice(0, 10) ?? null,
  actualArrivalDate: item.actualArrivalDate?.toISOString().slice(0, 10) ?? null,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
});

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-procurement:view")) return forbidden();

  const { id: projectId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return notFound("项目");

  const items = await prisma.projectProcurementItem.findMany({
    where: { projectId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: procurementInclude,
  });
  return ok(items.map(serializeProcurement));
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-procurement:create")) return forbidden();

  const { id: projectId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  const plannedQuantity = Number(body.plannedQuantity ?? body.quantity ?? 0);
  const unitPrice = Number(body.unitPrice ?? 0);
  const sourceType = body.sourceType === undefined
    ? ProcurementSourceType.MANUAL
    : parseProcurementSourceType(body.sourceType);
  if (!name) return err("采购物料名称不能为空");
  if (!unit) return err("采购单位不能为空");
  if (!Number.isFinite(plannedQuantity) || plannedQuantity <= 0) return err("计划采购数量必须大于 0");
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return err("采购单价必须为非负数");
  if (!sourceType) return err("采购来源类型无效");
  if (sourceType !== ProcurementSourceType.MANUAL) return err("BOM 或线缆清单来源必须通过物料版本同步接口创建");

  const deliverableId = typeof body.deliverableId === "string" && body.deliverableId.trim() ? body.deliverableId.trim() : null;
  const sourceRevisionId = typeof body.sourceRevisionId === "string" && body.sourceRevisionId.trim() ? body.sourceRevisionId.trim() : null;
  const sourceMaterialItemId = typeof body.sourceMaterialItemId === "string" && body.sourceMaterialItemId.trim() ? body.sourceMaterialItemId.trim() : null;
  const buyerMemberId = typeof body.buyerMemberId === "string" && body.buyerMemberId.trim() ? body.buyerMemberId.trim() : null;
  if (sourceRevisionId || sourceMaterialItemId) return err("手工采购条目不能伪造 BOM 或线缆清单来源");
  if (deliverableId && !await prisma.projectDeliverable.findFirst({ where: { id: deliverableId, projectId }, select: { id: true } })) {
    return err("关联交付物不属于当前项目");
  }
  if (buyerMemberId && !await prisma.projectMember.findFirst({ where: { id: buyerMemberId, projectId }, select: { id: true } })) {
    return err("采购负责人不属于当前项目");
  }

  const plannedAmount = Math.round(plannedQuantity * unitPrice * 100) / 100;
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.projectProcurementItem.create({
      data: {
        projectId,
        sourceType,
        sourceRevisionId,
        sourceMaterialItemId,
        deliverableId,
        name,
        specification: typeof body.specification === "string" ? body.specification.trim() : "",
        plannedQuantity,
        unit,
        unitPrice,
        plannedAmount,
        currency: typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : "CNY",
        buyerMemberId,
        supplierName: typeof body.supplierName === "string" ? body.supplierName.trim() : "",
        note: typeof body.note === "string" ? body.note.trim() : "",
      },
      include: procurementInclude,
    });
    await tx.projectProcurementStatusLog.create({
      data: {
        procurementItemId: created.id,
        fromStatus: null,
        toStatus: created.status,
        note: "创建采购条目",
        operatorUserId: user.userId,
        operatorName: user.displayName,
      },
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROCUREMENT_ITEM",
        entityId: created.id,
        actionType: "CREATE",
        operator: user.displayName,
        detail: `新增采购条目：${created.name}（${plannedQuantity}${unit}，计划金额 ${plannedAmount} ${created.currency}）`,
      },
    });
    return created;
  });
  return ok(serializeProcurement(item), 201);
}
