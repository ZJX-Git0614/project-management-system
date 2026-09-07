import { createHash } from "node:crypto";
import { MaterialListType, MaterialRevisionStatus, Prisma, ProcurementSourceType, ProcurementStatus } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string }> };

const editableSourceStatuses = new Set<ProcurementStatus>([
  ProcurementStatus.DRAFT,
  ProcurementStatus.PENDING_PURCHASE,
  ProcurementStatus.SOURCING,
]);

const procurementSyncSelect = {
  id: true,
  updatedAt: true,
  name: true,
  sourceMaterialItemId: true,
  sourceRevisionId: true,
  status: true,
  orderedQuantity: true,
  receivedQuantity: true,
  acceptedQuantity: true,
  unitPrice: true,
  orderNo: true,
  sourceMaterialItem: { select: { materialCode: true, name: true, specification: true, unit: true } },
} satisfies Prisma.ProjectProcurementItemSelect;

type ExistingProcurementItem = Prisma.ProjectProcurementItemGetPayload<{ select: typeof procurementSyncSelect }>;

const materialIdentity = (item: { materialCode: string; name: string; specification: string; unit: string } | null) => {
  if (!item) return null;
  const code = item.materialCode.trim();
  return code
    ? `CODE:${code.toUpperCase()}`
    : `NAME:${item.name.trim()}|SPEC:${item.specification.trim()}|UNIT:${item.unit.trim()}`;
};

const hasCommittedProcurementFacts = (item: {
  status: ProcurementStatus;
  orderedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  orderNo: string;
}) => (
  !editableSourceStatuses.has(item.status)
  || item.orderedQuantity > 0
  || item.receivedQuantity > 0
  || item.acceptedQuantity > 0
  || Boolean(item.orderNo.trim())
);

const loadReleasedRevision = (projectId: string, sourceRevisionId: string) => prisma.projectMaterialRevision.findFirst({
  where: { id: sourceRevisionId, projectId, status: MaterialRevisionStatus.RELEASED },
  include: {
    deliverable: { include: { status: true } },
    items: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  },
});

type ReleasedRevision = NonNullable<Awaited<ReturnType<typeof loadReleasedRevision>>>;

const resolveTargetQuantity = (revision: ReleasedRevision) => {
  const deliveryStatus = revision.deliverable.status;
  if (revision.stage === "PROTOTYPE" && (!deliveryStatus?.hasPrototype || deliveryStatus.prototypeQuantity <= 0)) {
    return { targetQuantity: 0, error: "请先在交付物状态中启用样机并填写有效的样机数量" };
  }
  const targetQuantity = revision.stage === "PROTOTYPE"
    ? deliveryStatus!.prototypeQuantity
    : deliveryStatus?.massProductionQuantity ?? 0;
  return targetQuantity > 0
    ? { targetQuantity, error: null }
    : { targetQuantity: 0, error: "请先在交付物状态中填写有效的对应阶段数量" };
};

const previewToken = (revision: ReleasedRevision, existing: ExistingProcurementItem[]) => createHash("sha256")
  .update([
    revision.id,
    revision.updatedAt.toISOString(),
    ...existing.map((item) => `${item.id}:${item.updatedAt.toISOString()}`).sort(),
  ].join("|"))
  .digest("hex");

const buildSyncPreview = (revision: ReleasedRevision, existing: ExistingProcurementItem[]) => {
  const existingByMaterialId = new Map(existing.flatMap((item) => item.sourceMaterialItemId ? [[item.sourceMaterialItemId, item] as const] : []));
  const existingByMaterialIdentity = new Map(existing.flatMap((item) => {
    if (item.status === ProcurementStatus.CANCELLED) return [];
    const identity = materialIdentity(item.sourceMaterialItem);
    return identity ? [[identity, item] as const] : [];
  }));
  const matchedExistingIds = new Set<string>();
  const created: string[] = [];
  const updated: string[] = [];
  const cancelled: string[] = [];
  const locked: string[] = [];

  for (const material of revision.items) {
    const current = existingByMaterialId.get(material.id) ?? existingByMaterialIdentity.get(materialIdentity(material) ?? "");
    if (current) matchedExistingIds.add(current.id);
    if (current && hasCommittedProcurementFacts(current)) locked.push(material.name);
    else if (current) updated.push(material.name);
    else created.push(material.name);
  }
  for (const previous of existing) {
    if (matchedExistingIds.has(previous.id) || previous.status === ProcurementStatus.CANCELLED) continue;
    if (hasCommittedProcurementFacts(previous)) locked.push(previous.name);
    else cancelled.push(previous.name);
  }
  return { created, updated, cancelled, locked: [...new Set(locked)] };
};

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-procurement:sync-bom")) return forbidden();

  const { id: projectId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const sourceRevisionId = req.nextUrl.searchParams.get("sourceRevisionId")?.trim() ?? "";
  if (!sourceRevisionId) return err("请选择要同步的 BOM 或线缆清单版本");

  const revision = await loadReleasedRevision(projectId, sourceRevisionId);
  if (!revision) return notFound("已发布的物料版本");
  if (!revision.items.length) return err("该物料版本没有可同步的物料");
  const target = resolveTargetQuantity(revision);
  if (target.error) return err(target.error);
  const sourceType = revision.listType === MaterialListType.BOM ? ProcurementSourceType.BOM : ProcurementSourceType.CABLE_LIST;
  const existing = await prisma.projectProcurementItem.findMany({
    where: { projectId, deliverableId: revision.deliverableId, stage: revision.stage, sourceType },
    select: procurementSyncSelect,
  });
  const changes = buildSyncPreview(revision, existing);
  return ok({
    sourceRevisionId: revision.id,
    deliverableName: revision.deliverable.name,
    targetQuantity: target.targetQuantity,
    previewToken: previewToken(revision, existing),
    createdCount: changes.created.length,
    updatedCount: changes.updated.length,
    cancelledCount: changes.cancelled.length,
    lockedCount: changes.locked.length,
    changes,
  });
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-procurement:sync-bom")) return forbidden();

  const { id: projectId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const body = await req.json().catch(() => ({}));
  const sourceRevisionId = typeof body.sourceRevisionId === "string" ? body.sourceRevisionId.trim() : "";
  if (!sourceRevisionId) return err("请选择要同步的 BOM 或线缆清单版本");
  const expectedPreviewToken = typeof body.previewToken === "string" ? body.previewToken.trim() : "";
  if (body.confirmed !== true || !expectedPreviewToken) return err("请先预览同步差异并确认执行");

  const revision = await loadReleasedRevision(projectId, sourceRevisionId);
  if (!revision) return notFound("已发布的物料版本");
  if (!revision.items.length) return err("该物料版本没有可同步的物料");

  const sourceType = revision.listType === MaterialListType.BOM ? ProcurementSourceType.BOM : ProcurementSourceType.CABLE_LIST;
  const target = resolveTargetQuantity(revision);
  if (target.error) return err(target.error);
  const targetQuantity = target.targetQuantity;
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.projectProcurementItem.findMany({
      where: {
        projectId,
        deliverableId: revision.deliverableId,
        stage: revision.stage,
        sourceType,
      },
      select: procurementSyncSelect,
    });
    if (previewToken(revision, existing) !== expectedPreviewToken) return null;
    const existingByMaterialId = new Map(existing.flatMap((item) => item.sourceMaterialItemId ? [[item.sourceMaterialItemId, item] as const] : []));
    const existingByMaterialIdentity = new Map(existing.flatMap((item) => {
      if (item.status === ProcurementStatus.CANCELLED) return [];
      const identity = materialIdentity(item.sourceMaterialItem);
      return identity ? [[identity, item] as const] : [];
    }));
    let createdCount = 0;
    let updatedCount = 0;
    let cancelledCount = 0;
    const locked: string[] = [];
    const matchedExistingIds = new Set<string>();

    for (const material of revision.items) {
      const plannedQuantity = Math.round(material.quantityPerUnit * targetQuantity * 10000) / 10000;
      const current = existingByMaterialId.get(material.id) ?? existingByMaterialIdentity.get(materialIdentity(material) ?? "");
      if (current) matchedExistingIds.add(current.id);
      if (current && hasCommittedProcurementFacts(current)) {
        locked.push(material.name);
        continue;
      }
      if (current) {
        await tx.projectProcurementItem.update({
          where: { id: current.id },
          data: {
            sourceRevisionId: revision.id,
            sourceMaterialItemId: material.id,
            sourceType,
            deliverableId: revision.deliverableId,
            stage: revision.stage,
            name: material.name,
            specification: material.specification,
            unit: material.unit,
            plannedQuantity,
            plannedAmount: Math.round(plannedQuantity * current.unitPrice * 100) / 100,
            note: `由 ${revision.listType === MaterialListType.BOM ? "BOM" : "线缆清单"} V${revision.version} 同步`,
          },
        });
        updatedCount += 1;
        continue;
      }
      const created = await tx.projectProcurementItem.create({
        data: {
          projectId,
          sourceType,
          sourceRevisionId: revision.id,
          sourceMaterialItemId: material.id,
          deliverableId: revision.deliverableId,
          stage: revision.stage,
          name: material.name,
          specification: material.specification,
          plannedQuantity,
          unit: material.unit,
          plannedAmount: 0,
          note: `由 ${revision.listType === MaterialListType.BOM ? "BOM" : "线缆清单"} V${revision.version} 同步`,
        },
      });
      await tx.projectProcurementStatusLog.create({
        data: {
          procurementItemId: created.id,
          fromStatus: null,
          toStatus: ProcurementStatus.DRAFT,
          note: `从物料版本 ${revision.id} 同步创建`,
          operatorUserId: user.userId,
          operatorName: user.displayName,
        },
      });
      createdCount += 1;
    }
    for (const previous of existing) {
      if (matchedExistingIds.has(previous.id) || previous.status === ProcurementStatus.CANCELLED) continue;
      if (hasCommittedProcurementFacts(previous)) {
        locked.push(previous.name);
        continue;
      }
      await tx.projectProcurementItem.update({
        where: { id: previous.id },
        data: {
          status: ProcurementStatus.CANCELLED,
          note: `物料已从 ${revision.listType === MaterialListType.BOM ? "BOM" : "线缆清单"} V${revision.version} 移除，系统同步取消`,
        },
      });
      await tx.projectProcurementStatusLog.create({
        data: {
          procurementItemId: previous.id,
          fromStatus: previous.status,
          toStatus: ProcurementStatus.CANCELLED,
          note: `物料在版本 ${revision.id} 中已移除`,
          operatorUserId: user.userId,
          operatorName: user.displayName,
        },
      });
      cancelledCount += 1;
    }
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROCUREMENT_BOM_SYNC",
        entityId: revision.id,
        actionType: "SYNC",
        operator: user.displayName,
        detail: `同步${revision.listType === MaterialListType.BOM ? "BOM" : "线缆清单"} V${revision.version}：新增 ${createdCount} 条，更新 ${updatedCount} 条，取消 ${cancelledCount} 条，锁定 ${locked.length} 条`,
      },
    });
    return { createdCount, updatedCount, cancelledCount, locked: [...new Set(locked)] };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) return null;
    throw error;
  });

  if (!result) return err("采购同步预览已过期，数据发生变化，请重新预览后执行", 409);

  return ok({
    sourceRevisionId: revision.id,
    deliverableName: revision.deliverable.name,
    targetQuantity,
    ...result,
    warning: result.locked.length ? "已下单或后续状态的采购条目不会被 BOM 同步覆盖" : null,
  });
}
