import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { BudgetCategoryKind } from "@/domain/enums";

const VALID_KINDS = new Set<string>(Object.values(BudgetCategoryKind));

const serialize = (c: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  name: string;
  kind: string;
  description: string;
  sortOrder: number;
}) => ({
  id: c.id,
  projectId: c.projectId,
  name: c.name,
  kind: c.kind,
  description: c.description,
  sortOrder: c.sortOrder,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

// PUT /api/projects/[id]/budget-categories/[catId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; catId: string }> },
) {
  const { id, catId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectBudgetCategory.findUnique({ where: { id: catId } });
  if (!existing || existing.projectId !== id) return notFound("预算分类");

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const kind = String(body.kind ?? "").trim();
  const description = String(body.description ?? "").trim();
  const sortOrder = Number(body.sortOrder ?? 0);

  if (!name) return err("分类名称不能为空");
  if (!VALID_KINDS.has(kind)) return err("分类类型不合法");

  try {
    const category = await prisma.projectBudgetCategory.update({
      where: { id: catId },
      data: { name, kind, description, sortOrder },
    });

    await prisma.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_BUDGET_CATEGORY",
        entityId: category.id,
        actionType: "UPDATE",
        operator: user.displayName,
        detail: `更新预算分类「${name}」`,
      },
    });

    return ok(serialize(category));
  } catch (e) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err(`分类名称「${name}」已存在`);
    }
    throw e;
  }
}

// DELETE /api/projects/[id]/budget-categories/[catId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; catId: string }> },
) {
  const { id, catId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectBudgetCategory.findUnique({ where: { id: catId } });
  if (!existing || existing.projectId !== id) return notFound("预算分类");

  const itemCount = await prisma.projectBudgetItem.count({ where: { categoryId: catId } });
  if (itemCount > 0) {
    return err(`分类「${existing.name}」下还有 ${itemCount} 条预算条目，请先清理`);
  }

  await prisma.projectBudgetCategory.delete({ where: { id: catId } });

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_BUDGET_CATEGORY",
      entityId: catId,
      actionType: "DELETE",
      operator: user.displayName,
      detail: `删除预算分类「${existing.name}」`,
    },
  });

  return ok({ id: catId });
}
