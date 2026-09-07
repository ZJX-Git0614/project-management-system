import { MaterialRevisionStatus, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string; deliverableId: string; revisionId: string }> };

export async function PUT(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-delivery-status:publish-material-revision")) return forbidden();

  const { id: projectId, deliverableId, revisionId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const revision = await prisma.projectMaterialRevision.findFirst({
    where: { id: revisionId, projectId, deliverableId },
    include: { deliverable: { select: { name: true } } },
  });
  if (!revision) return notFound("物料版本");
  if (revision.status === MaterialRevisionStatus.SUPERSEDED) return err("已替代的物料版本不能重新发布");
  if (revision.status === MaterialRevisionStatus.RELEASED) return ok({ id: revision.id, status: revision.status });

  const body = await req.json().catch(() => ({}));
  const sourceDocumentFileId = typeof body.sourceDocumentFileId === "string" && body.sourceDocumentFileId.trim()
    ? body.sourceDocumentFileId.trim()
    : revision.sourceDocumentFileId;
  if (!sourceDocumentFileId) return err("发布 BOM 或线缆清单时必须关联已上传的项目文档");
  const document = await prisma.projectDocumentFile.findFirst({
    where: { id: sourceDocumentFileId, projectId },
    select: { id: true },
  });
  if (!document) return err("关联文档不属于当前项目");

  const releasedAt = new Date();
  const published = await prisma.$transaction(async (tx) => {
    const releasedHead = await tx.projectMaterialRevision.findFirst({
      where: {
        deliverableId,
        stage: revision.stage,
        listType: revision.listType,
        status: MaterialRevisionStatus.RELEASED,
        id: { not: revision.id },
      },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    await tx.projectMaterialRevision.updateMany({
      where: {
        deliverableId,
        stage: revision.stage,
        listType: revision.listType,
        status: MaterialRevisionStatus.RELEASED,
        id: { not: revision.id },
      },
      data: { status: MaterialRevisionStatus.SUPERSEDED },
    });
    await tx.projectMaterialRevision.update({
      where: { id: revision.id },
      data: {
        status: MaterialRevisionStatus.RELEASED,
        sourceDocumentFileId,
        releasedAt,
        supersedesRevisionId: releasedHead?.id ?? null,
      },
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "MATERIAL_REVISION",
        entityId: revision.id,
        actionType: "PUBLISH",
        operator: user.displayName,
        detail: `${revision.deliverable.name} ${revision.stage === "PROTOTYPE" ? "样机" : "量产"}${revision.listType === "BOM" ? "BOM" : "线缆清单"} V${revision.version} 已发布`,
      },
    });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) return false;
    throw error;
  });

  if (!published) return err("物料版本已被其他操作发布，请刷新后重试", 409);

  return ok({
    id: revision.id,
    status: MaterialRevisionStatus.RELEASED,
    sourceDocumentFileId,
    releasedAt: releasedAt.toISOString(),
  });
}
