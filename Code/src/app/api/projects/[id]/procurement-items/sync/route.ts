import { MaterialListType, MaterialRevisionStatus, ProcurementSourceType, ProcurementStatus } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string }> };

const editableSourceStatuses = new Set<ProcurementStatus>([
  ProcurementStatus.DRAFT,
  ProcurementStatus.PENDING_PURCHASE,
  ProcurementStatus.SOURCING,
  ProcurementStatus.ON_HOLD,
]);

const materialIdentity = (item: { materialCode: string; name: string; specification: string; unit: string } | null) => {
  if (!item) return null;
  const code = item.materialCode.trim();
  return code
    ? `CODE:${code.toUpperCase()}`
    : `NAME:${item.name.trim()}|SPEC:${item.specification.trim()}|UNIT:${item.unit.trim()}`;
};

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-procurement:create")) return forbidden();

  const { id: projectId } = await params;
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const body = await req.json().catch(() => ({}));
  const sourceRevisionId = typeof body.sourceRevisionId === "string" ? body.sourceRevisionId.trim() : "";
  if (!sourceRevisionId) return err("请选择要同步的 BOM 或线缆清单版本");

  const revision = await prisma.projectMaterialRevision.findFirst({
    where: { id: sourceRevisionId, projectId, status: MaterialRevisionStatus.RELEASED },
    include: {
      deliverable: { include: { status: true } },
      items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!revision) return notFound("已发布的物料版本");
  if (!revision.items.length) return err("该物料版本没有可同步的物料");

  const sourceType = revision.listType === MaterialListType.BOM ? ProcurementSourceType.BOM : ProcurementSourceType.CABLE_LIST;
  const configuredQuantity = revision.stage === "PROTOTYPE"
    ? revision.deliverable.status?.prototypeQuantity ?? 0
    : revision.deliverable.status?.massProductionQuantity ?? 0;
  const targetQuantity = configuredQuantity > 0 ? configuredQuantity : revision.deliverable.quantity;
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.projectProcurementItem.findMany({
      where: { projectId, deliverableId: revision.deliverableId, stage: revision.stage, sourceType },
      select: {
        id: true,
        sourceMaterialItemId: true,
        status: true,
        sourceMaterialItem: { select: { materialCode: true, name: true, specification: true, unit: true } },
      },
    });
    const existingByMaterialId = new Map(existing.flatMap((item) => item.sourceMaterialItemId ? [[item.sourceMaterialItemId, item] as const] : []));
    const existingByMaterialIdentity = new Map(existing.flatMap((item) => {
      const identity = materialIdentity(item.sourceMaterialItem);
      return identity ? [[identity, item] as const] : [];
    }));
    let createdCount = 0;
    let updatedCount = 0;
    const locked: string[] = [];

    for (const material of revision.items) {
      const plannedQuantity = Math.round(material.quantityPerUnit * targetQuantity * 10000) / 10000;
      const current = existingByMaterialId.get(material.id) ?? existingByMaterialIdentity.get(materialIdentity(material) ?? "");
      if (current && !editableSourceStatuses.has(current.status)) {
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
            plannedAmount: 0,
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
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "PROCUREMENT_BOM_SYNC",
        entityId: revision.id,
        actionType: "SYNC",
        operator: user.displayName,
        detail: `同步${revision.listType === MaterialListType.BOM ? "BOM" : "线缆清单"} V${revision.version}：新增 ${createdCount} 条，更新 ${updatedCount} 条，锁定 ${locked.length} 条`,
      },
    });
    return { createdCount, updatedCount, locked };
  });

  return ok({
    sourceRevisionId: revision.id,
    deliverableName: revision.deliverable.name,
    targetQuantity,
    ...result,
    warning: result.locked.length ? "已下单或后续状态的采购条目不会被 BOM 同步覆盖" : null,
  });
}
