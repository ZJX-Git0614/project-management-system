import { NextRequest } from "next/server";

import { ensureMutableProject, err, ok } from "@/lib/api-utils";
import { placeRowsAroundAnchor, normalizeStructureCount, type FlatRowPosition } from "@/lib/flat-row-structure";
import { prisma } from "@/lib/prisma";
import { requireUser, userHasPermission } from "@/lib/server-auth";
import { renumberWeeklyMatterCodes } from "@/lib/weekly-matter-codes";

type StructureOperation = "INSERT" | "COPY" | "MOVE";

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if ("status" in user) return user;

  const body = await req.json();
  const projectId = String(body.projectId ?? "").trim();
  const anchorItemId = String(body.anchorItemId ?? "").trim();
  const operation = body.operation as StructureOperation;
  const position = body.position as FlatRowPosition;
  if (!projectId || !anchorItemId) return err("项目和目标事项不能为空");
  if (!["INSERT", "COPY", "MOVE"].includes(operation)) return err("不支持的事项结构操作");
  if (position !== "BEFORE" && position !== "AFTER") return err("事项插入位置无效");
  const permission = operation === "MOVE" ? "weekly-items:edit" : "weekly-items:create";
  if (!(await userHasPermission(user, permission))) return err("权限不足", 403);

  const mutableError = await ensureMutableProject(projectId);
  if (mutableError) return mutableError;

  const sourceItemIds = Array.isArray(body.sourceItemIds)
    ? [...new Set(body.sourceItemIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0))]
    : [];
  if (operation !== "INSERT" && sourceItemIds.length === 0) return err("请选择要复制或剪切的事项");

  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentItems = await tx.weeklyItem.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        include: { ganttTaskLinks: { select: { ganttTaskId: true } } },
      });
      if (!currentItems.some((item) => item.id === anchorItemId)) throw new Error("目标事项不存在");

      const sourceItemIdSet = new Set(sourceItemIds);
      const sourceItems = currentItems.filter((item) => sourceItemIdSet.has(item.id));
      if (operation !== "INSERT" && sourceItems.length !== sourceItemIds.length) {
        throw new Error("复制或剪切的事项不存在或不属于当前项目");
      }

      const createdItems: typeof currentItems = [];
      if (operation === "INSERT") {
        const count = normalizeStructureCount(body.count);
        for (let index = 0; index < count; index += 1) {
          createdItems.push(await tx.weeklyItem.create({
            data: {
              projectId,
              matterCode: "",
              sortOrder: currentItems.length + index + 1,
              title: "新事项",
              owner: user.displayName,
              priority: "NORMAL",
            },
            include: { ganttTaskLinks: { select: { ganttTaskId: true } } },
          }));
        }
      } else if (operation === "COPY") {
        for (const source of sourceItems) {
          const created = await tx.weeklyItem.create({
            data: {
              projectId,
              matterCode: "",
              sortOrder: currentItems.length + createdItems.length + 1,
              title: source.title,
              ganttTaskId: source.ganttTaskId,
              taskName: source.taskName,
              description: source.description,
              dueDate: source.dueDate,
              status: source.status,
              owner: source.owner,
              priority: source.priority,
              plannedStartDate: source.plannedStartDate,
              actualStartDate: source.actualStartDate,
              plannedEndDate: source.plannedEndDate,
              actualEndDate: source.actualEndDate,
              progress: source.progress,
              health: source.health,
              issueAndAction: source.issueAndAction,
              dependency: source.dependency,
              risk: source.risk,
              riskStatus: source.riskStatus,
              remark: source.remark,
            },
            include: { ganttTaskLinks: { select: { ganttTaskId: true } } },
          });
          const sourceTaskIds = source.ganttTaskLinks.length > 0
            ? source.ganttTaskLinks.map((link) => link.ganttTaskId)
            : source.ganttTaskId ? [source.ganttTaskId] : [];
          if (sourceTaskIds.length > 0) {
            await tx.weeklyItemGanttTask.createMany({
              data: sourceTaskIds.map((ganttTaskId) => ({ weeklyItemId: created.id, ganttTaskId })),
              skipDuplicates: true,
            });
          }
          createdItems.push({
            ...created,
            ganttTaskLinks: sourceTaskIds.map((ganttTaskId) => ({ ganttTaskId })),
          });
        }
      }

      const rowsToPlace = operation === "MOVE" ? sourceItems : createdItems;
      const allItems = operation === "MOVE" ? currentItems : [...currentItems, ...createdItems];
      const orderedItems = placeRowsAroundAnchor(allItems, rowsToPlace, anchorItemId, position);
      const renumberedItems = renumberWeeklyMatterCodes(
        orderedItems.map((item, index) => ({ ...item, sortOrder: index + 1 })),
      );

      await Promise.all(renumberedItems.map((item) => tx.weeklyItem.update({
        where: { id: item.id },
        data: { sortOrder: item.sortOrder, matterCode: item.matterCode },
      })));

      const label = operation === "INSERT" ? "插入事项" : operation === "COPY" ? "复制粘贴事项" : "剪切移动事项";
      await tx.operationHistory.create({
        data: {
          projectId,
          entityType: "WEEKLY_ITEM",
          entityId: anchorItemId,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: label,
        },
      });

      return {
        createdItemIds: createdItems.map((item) => item.id),
        movedItemIds: operation === "MOVE" ? sourceItems.map((item) => item.id) : [],
      };
    });

    return ok(result);
  } catch (error) {
    return err(error instanceof Error ? error.message : "事项结构操作失败");
  }
}
