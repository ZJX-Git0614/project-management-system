import { NextRequest } from "next/server";

import { ensureMutableProject, err, forbidden, notFound, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { hasProjectAccess } from "@/lib/project-access";
import {
  parseDeliverableType,
  parseOutsourceMode,
  serializeDeliverable,
} from "@/lib/project-delivery-procurement";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

type RouteContext = { params: Promise<{ id: string }> };

const deliveryInclude = {
  status: true,
  revisions: { select: { stage: true, listType: true, status: true } },
} as const;

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  const canViewList = await userHasPermission(user, "project-deliverables:view");
  const canViewStatus = await userHasPermission(user, "project-delivery-status:view");
  if (!canViewList && !canViewStatus) return forbidden();

  const { id: projectId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return notFound("项目");

  const deliverables = await prisma.projectDeliverable.findMany({
    where: { projectId, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: deliveryInclude,
  });
  return ok(deliverables.map(serializeDeliverable));
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-deliverables:create")) return forbidden();

  const { id: projectId } = await params;
  if (!await hasProjectAccess(user, projectId)) return forbidden();
  const readOnly = await ensureMutableProject(projectId);
  if (readOnly) return readOnly;

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const quantity = Number(body.quantity ?? 0);
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  const type = parseDeliverableType(body.typeCode ?? body.type);
  const outsourceMode = parseOutsourceMode(body.outsourceModeCode ?? body.outsourceMode);
  if (!name) return err("交付物名称不能为空");
  if (name.length > 200) return err("交付物名称不能超过 200 个字符");
  if (!Number.isFinite(quantity) || quantity <= 0) return err("交付物数量必须大于 0");
  if (!unit) return err("交付物单位不能为空");
  if (!type) return err("交付物类型必须为软件或硬件");
  if (!outsourceMode) return err("是否外协必须为否、是或部分");

  const linkedGanttTaskId = typeof body.linkedGanttTaskId === "string" && body.linkedGanttTaskId.trim()
    ? body.linkedGanttTaskId.trim()
    : null;
  if (linkedGanttTaskId) {
    const task = await prisma.projectGanttTask.findFirst({ where: { id: linkedGanttTaskId, projectId }, select: { id: true } });
    if (!task) return err("关联 WBS 任务不属于当前项目");
  }

  const latest = await prisma.projectDeliverable.findFirst({
    where: { projectId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : (latest?.sortOrder ?? -1) + 1;
  const remark = typeof body.remark === "string" ? body.remark.trim() : "";

  const deliverable = await prisma.$transaction(async (tx) => {
    const created = await tx.projectDeliverable.create({
      data: {
        projectId,
        name,
        quantity,
        unit,
        type,
        outsourceMode,
        sortOrder,
        linkedGanttTaskId,
        remark,
        status: { create: {} },
      },
      include: deliveryInclude,
    });
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "DELIVERABLE",
        entityId: created.id,
        actionType: "CREATE",
        operator: user.displayName,
        detail: `新增交付物：${created.name}（${type === "SOFTWARE" ? "软件" : "硬件"}，${quantity}${unit}）`,
      },
    });
    return created;
  });

  return ok(serializeDeliverable(deliverable), 201);
}
