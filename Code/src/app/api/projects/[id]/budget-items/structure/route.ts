import { NextRequest } from "next/server";

import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { normalizeStructureCount, placeRowsAroundAnchor, type FlatRowPosition } from "@/lib/flat-row-structure";
import { prisma } from "@/lib/prisma";
import { requireUser, userHasPermission } from "@/lib/server-auth";

type StructureOperation = "INSERT" | "COPY" | "MOVE";

const placeholderByKind = (kind: string) => {
  if (kind === "MANPOWER") return { groupName: "新组别", person: "待填写" };
  if (kind === "PURCHASE") return { title: "新物料" };
  if (kind === "OTHER") return { title: "新预算事项" };
  return { title: "新费率" };
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const user = await requireUser(req);
  if ("status" in user) return user;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound("项目");
  const mutableError = await ensureMutableProject(projectId);
  if (mutableError) return mutableError;

  const body = await req.json();
  const anchorItemId = String(body.anchorItemId ?? "").trim();
  const operation = body.operation as StructureOperation;
  const position = body.position as FlatRowPosition;
  if (!anchorItemId) return err("目标预算条目不能为空");
  if (!["INSERT", "COPY", "MOVE"].includes(operation)) return err("不支持的预算结构操作");
  if (position !== "BEFORE" && position !== "AFTER") return err("预算插入位置无效");
  const permission = operation === "MOVE" ? "project-budget:edit" : "project-budget:create";
  if (!(await userHasPermission(user, permission))) return err("权限不足", 403);

  const sourceItemIds = Array.isArray(body.sourceItemIds)
    ? [...new Set(body.sourceItemIds.filter((itemId: unknown): itemId is string => typeof itemId === "string" && itemId.length > 0))]
    : [];
  if (operation !== "INSERT" && sourceItemIds.length === 0) return err("请选择要复制或剪切的预算条目");

  try {
    const result = await prisma.$transaction(async (tx) => {
      const anchor = await tx.projectBudgetItem.findFirst({
        where: { id: anchorItemId, projectId },
        include: { category: true },
      });
      if (!anchor) throw new Error("目标预算条目不存在");

      const currentItems = await tx.projectBudgetItem.findMany({
        where: { projectId, categoryId: anchor.categoryId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      const sourceItemIdSet = new Set(sourceItemIds);
      const sourceItems = currentItems.filter((item) => sourceItemIdSet.has(item.id));
      if (operation !== "INSERT" && sourceItems.length !== sourceItemIds.length) {
        throw new Error("预算条目只能在同一分类内复制或剪切粘贴");
      }

      const createdItems: typeof currentItems = [];
      if (operation === "INSERT") {
        const count = normalizeStructureCount(body.count);
        for (let index = 0; index < count; index += 1) {
          createdItems.push(await tx.projectBudgetItem.create({
            data: {
              projectId,
              categoryId: anchor.categoryId,
              sortOrder: currentItems.length + index + 1,
              ...placeholderByKind(anchor.category.kind),
            },
          }));
        }
      } else if (operation === "COPY") {
        for (const source of sourceItems) {
          createdItems.push(await tx.projectBudgetItem.create({
            data: {
              projectId,
              categoryId: anchor.categoryId,
              sortOrder: currentItems.length + createdItems.length + 1,
              title: source.title,
              groupName: source.groupName,
              person: source.person,
              personMonths: source.personMonths,
              monthlyCostPerPerson: source.monthlyCostPerPerson,
              unitPrice: source.unitPrice,
              sampleQuantity: source.sampleQuantity,
              productionQuantity: source.productionQuantity,
              amount: source.amount,
              minRate: source.minRate,
              maxRate: source.maxRate,
              defaultRate: source.defaultRate,
              currentRate: source.currentRate,
              remark: source.remark,
            },
          }));
        }
      }

      const rowsToPlace = operation === "MOVE" ? sourceItems : createdItems;
      const allItems = operation === "MOVE" ? currentItems : [...currentItems, ...createdItems];
      const orderedItems = placeRowsAroundAnchor(allItems, rowsToPlace, anchorItemId, position);
      await Promise.all(orderedItems.map((item, index) => tx.projectBudgetItem.update({
        where: { id: item.id },
        data: { sortOrder: index + 1 },
      })));

      const label = operation === "INSERT" ? "插入预算条目" : operation === "COPY" ? "复制粘贴预算条目" : "剪切移动预算条目";
      await tx.operationHistory.create({
        data: {
          projectId,
          entityType: "PROJECT_BUDGET_ITEM",
          entityId: anchorItemId,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `${label}（${anchor.category.name}）`,
        },
      });

      return {
        categoryId: anchor.categoryId,
        createdItemIds: createdItems.map((item) => item.id),
        movedItemIds: operation === "MOVE" ? sourceItems.map((item) => item.id) : [],
      };
    });

    return ok(result);
  } catch (error) {
    return err(error instanceof Error ? error.message : "预算结构操作失败");
  }
}
