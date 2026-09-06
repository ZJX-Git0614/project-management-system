import { DeliverableType, MaterialRevisionStatus, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { parseDeliveryStage, parseMaterialListType } from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; deliverableId: string }> };
type MaterialRevisionWithRelations = Prisma.ProjectMaterialRevisionGetPayload<{
  include: {
    sourceDocumentFile: { select: { id: true; storedName: true; originalName: true } };
    items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] };
  };
}>;

const parseRevisionStatus = (value: unknown) => {
  const normalized = String(value ?? "DRAFT").trim().toUpperCase();
  return normalized === MaterialRevisionStatus.RELEASED ? MaterialRevisionStatus.RELEASED : MaterialRevisionStatus.DRAFT;
};

const serializeRevision = (revision: MaterialRevisionWithRelations) => ({
  id: revision.id,
  stage: revision.stage,
  listType: revision.listType,
  version: revision.version,
  status: revision.status,
  sourceDocumentFile: revision.sourceDocumentFile,
  releasedAt: revision.releasedAt?.toISOString() ?? null,
  createdAt: revision.createdAt.toISOString(),
  items: revision.items,
});

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-deliverables:view")) return forbidden();

  const { id: projectId, deliverableId } = await params;
  const deliverable = await prisma.projectDeliverable.findFirst({ where: { id: deliverableId, projectId, archivedAt: null }, select: { id: true } });
  if (!deliverable) return notFound("交付物");

  const revisions = await prisma.projectMaterialRevision.findMany({
    where: { projectId, deliverableId },
    orderBy: [{ stage: "asc" }, { listType: "asc" }, { version: "desc" }],
    include: {
      sourceDocumentFile: { select: { id: true, storedName: true, originalName: true } },
      items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  return ok(revisions.map(serializeRevision));
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-deliverables:edit")) return forbidden();

  const { id: projectId, deliverableId } = await params;
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const deliverable = await prisma.projectDeliverable.findFirst({ where: { id: deliverableId, projectId, archivedAt: null } });
  if (!deliverable) return notFound("交付物");
  if (deliverable.type !== DeliverableType.HARDWARE) return err("只有硬件交付物可以维护 BOM 或线缆清单");

  const body = await req.json().catch(() => ({}));
  const stage = parseDeliveryStage(body.stage);
  const listType = parseMaterialListType(body.listType);
  const status = parseRevisionStatus(body.status);
  if (!stage || !listType) return err("清单阶段和类型无效");

  const sourceDocumentFileId = typeof body.sourceDocumentFileId === "string" && body.sourceDocumentFileId.trim()
    ? body.sourceDocumentFileId.trim()
    : null;
  if (status === MaterialRevisionStatus.RELEASED && !sourceDocumentFileId) {
    return err("发布 BOM 或线缆清单时必须关联已上传的项目文档");
  }
  if (sourceDocumentFileId) {
    const document = await prisma.projectDocumentFile.findFirst({ where: { id: sourceDocumentFileId, projectId }, select: { id: true } });
    if (!document) return err("关联文档不属于当前项目");
  }

  const rawItems: unknown[] = Array.isArray(body.items) ? body.items as unknown[] : [];
  if (!rawItems.length) return err("BOM 或线缆清单至少需要一条物料");
  const items = rawItems.map((raw, index) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const unit = typeof item.unit === "string" ? item.unit.trim() : "";
    const quantityPerUnit = Number(item.quantityPerUnit ?? 0);
    if (!name || !unit || !Number.isFinite(quantityPerUnit) || quantityPerUnit <= 0) return null;
    return {
      materialCode: typeof item.materialCode === "string" ? item.materialCode.trim() : "",
      name,
      specification: typeof item.specification === "string" ? item.specification.trim() : "",
      unit,
      quantityPerUnit,
      manufacturer: typeof item.manufacturer === "string" ? item.manufacturer.trim() : "",
      preferredSupplier: typeof item.preferredSupplier === "string" ? item.preferredSupplier.trim() : "",
      remark: typeof item.remark === "string" ? item.remark.trim() : "",
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
    };
  });
  if (items.some((item) => !item)) return err("每条物料必须填写名称、单位和大于 0 的单台用量");

  const latest = await prisma.projectMaterialRevision.findFirst({
    where: { deliverableId, stage, listType },
    orderBy: { version: "desc" },
    select: { version: true, id: true },
  });
  const requestedVersion = body.version === undefined ? null : Number(body.version);
  const version = requestedVersion === null ? (latest?.version ?? 0) + 1 : requestedVersion;
  if (!Number.isInteger(version) || version <= 0) return err("版本号必须为正整数");
  if (await prisma.projectMaterialRevision.findFirst({ where: { deliverableId, stage, listType, version }, select: { id: true } })) {
    return err("该阶段、清单类型和版本号已存在");
  }

  const revision = await prisma.$transaction(async (tx) => {
    const created = await tx.projectMaterialRevision.create({
      data: {
        projectId,
        deliverableId,
        stage,
        listType,
        version,
        status,
        sourceDocumentFileId,
        releasedAt: status === MaterialRevisionStatus.RELEASED ? new Date() : null,
        supersedesRevisionId: latest?.id ?? null,
        items: { create: items as NonNullable<typeof items[number]>[] },
      },
      include: {
        sourceDocumentFile: { select: { id: true, storedName: true, originalName: true } },
        items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (status === MaterialRevisionStatus.RELEASED) {
      await tx.projectMaterialRevision.updateMany({
        where: {
          deliverableId,
          stage,
          listType,
          status: MaterialRevisionStatus.RELEASED,
          id: { not: created.id },
        },
        data: { status: MaterialRevisionStatus.SUPERSEDED },
      });
    }
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "MATERIAL_REVISION",
        entityId: created.id,
        actionType: status === MaterialRevisionStatus.RELEASED ? "PUBLISH" : "CREATE",
        operator: user.displayName,
        detail: `${deliverable.name} ${stage === "PROTOTYPE" ? "样机" : "量产"}${listType === "BOM" ? "BOM" : "线缆清单"} V${version}${status === MaterialRevisionStatus.RELEASED ? "已发布" : "已保存草稿"}`,
      },
    });
    return created;
  });

  return ok(serializeRevision(revision), 201);
}
