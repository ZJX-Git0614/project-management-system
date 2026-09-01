import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ensureMutableProject, err, notFound, ok, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"
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

// GET /api/projects/[id]/budget-categories
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-budget:view")) return forbidden();

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return notFound("项目");

  const categories = await prisma.projectBudgetCategory.findMany({
    where: { projectId: id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return ok(categories.map(serialize));
}

// POST /api/projects/[id]/budget-categories
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-budget:create")) return forbidden();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const kind = String(body.kind ?? "").trim();
  const description = String(body.description ?? "").trim();
  const sortOrder = Number(body.sortOrder ?? 0);

  if (!name) return err("分类名称不能为空");
  if (!VALID_KINDS.has(kind)) return err("分类类型不合法（MANPOWER/PURCHASE/OTHER）");
  if (!Number.isFinite(sortOrder)) return err("排序必须为整数");

  try {
    const category = await prisma.projectBudgetCategory.create({
      data: { projectId: id, name, kind, description, sortOrder },
    });

    await prisma.operationHistory.create({
      data: {
        projectId: id,
        entityType: "PROJECT_BUDGET_CATEGORY",
        entityId: category.id,
        actionType: "CREATE",
        operator: user.displayName,
        detail: `新增预算分类「${name}（${kind}）」`,
      },
    });

    return ok(serialize(category), 201);
  } catch (e) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return err(`分类名称「${name}」已存在`);
    }
    throw e;
  }
}
