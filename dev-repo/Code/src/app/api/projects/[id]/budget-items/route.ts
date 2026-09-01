import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ensureMutableProject, err, notFound, ok, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"

const serialize = (item: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  categoryId: string;
  sortOrder: number;
  title: string;
  groupName: string;
  person: string;
  personMonths: number;
  monthlyCostPerPerson: number;
  unitPrice: number;
  sampleQuantity: number;
  productionQuantity: number;
  amount: number;
  minRate: number;
  maxRate: number;
  defaultRate: number;
  currentRate: number;
  remark: string;
}) => ({
  id: item.id,
  projectId: item.projectId,
  categoryId: item.categoryId,
  sortOrder: item.sortOrder,
  title: item.title,
  groupName: item.groupName,
  person: item.person,
  personMonths: item.personMonths,
  monthlyCostPerPerson: item.monthlyCostPerPerson,
  unitPrice: item.unitPrice,
  sampleQuantity: item.sampleQuantity,
  productionQuantity: item.productionQuantity,
  amount: item.amount,
  minRate: item.minRate,
  maxRate: item.maxRate,
  defaultRate: item.defaultRate,
  currentRate: item.currentRate,
  remark: item.remark,
  createdAt: item.createdAt.toISOString(),
  updatedAt: item.updatedAt.toISOString(),
});

// GET /api/projects/[id]/budget-items
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

  const items = await prisma.projectBudgetItem.findMany({
    where: { projectId: id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      category: true,
      ganttTasks: { select: { id: true, taskCode: true, taskName: true } },
    },
  });

  return ok(
    items.map((i) => ({
      ...serialize(i),
      category: i.category
        ? {
            id: i.category.id,
            name: i.category.name,
            kind: i.category.kind,
          }
        : null,
      linkedTasks: i.ganttTasks,
    })),
  );
}

// POST /api/projects/[id]/budget-items
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
  const categoryId = String(body.categoryId ?? "").trim();
  if (!categoryId) return err("预算分类不能为空");

  const category = await prisma.projectBudgetCategory.findUnique({ where: { id: categoryId } });
  if (!category || category.projectId !== id) return notFound("预算分类");

  const data = buildItemData(category.kind, body);
  if ("error" in data) return err(data.error);

  const item = await prisma.projectBudgetItem.create({
    data: { projectId: id, categoryId, ...data.fields },
  });

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_BUDGET_ITEM",
      entityId: item.id,
      actionType: "CREATE",
      operator: user.displayName,
      detail: `新增预算条目（${category.name} / ${summarizeItem(category.kind, data.fields)}）`,
    },
  });

  return ok(serialize(item), 201);
}

type ItemFields = {
  sortOrder: number;
  title: string;
  groupName: string;
  person: string;
  personMonths: number;
  monthlyCostPerPerson: number;
  unitPrice: number;
  sampleQuantity: number;
  productionQuantity: number;
  amount: number;
  minRate: number;
  maxRate: number;
  defaultRate: number;
  currentRate: number;
  remark: string;
};

function stripManpower() {
  return { groupName: "", person: "", personMonths: 0, monthlyCostPerPerson: 0 };
}
function stripPurchase() {
  return { unitPrice: 0, sampleQuantity: 0, productionQuantity: 0, amount: 0 };
}
function stripRate() {
  return { minRate: 0, maxRate: 0, defaultRate: 0, currentRate: 0 };
}

function buildItemData(
  kind: string,
  body: Record<string, unknown>,
): { fields: ItemFields } | { error: string } {
  const sortOrder = Number(body.sortOrder ?? 0);
  const remark = String(body.remark ?? "");

  if (kind === "MANPOWER") {
    const groupName = String(body.groupName ?? "").trim();
    const person = String(body.person ?? "").trim();
    const personMonths = Number(body.personMonths ?? 0);
    const monthlyCostPerPerson = Number(body.monthlyCostPerPerson ?? 0);
    if (!groupName) return { error: "组别不能为空" };
    if (!person) return { error: "人员不能为空" };
    if (!Number.isFinite(personMonths) || personMonths < 0) return { error: "人月必须为非负数" };
    if (!Number.isFinite(monthlyCostPerPerson) || monthlyCostPerPerson < 0)
      return { error: "人均月成本必须为非负数" };
    return {
      fields: {
        sortOrder,
        title: "",
        groupName,
        person,
        personMonths,
        monthlyCostPerPerson,
        ...stripPurchase(),
        ...stripRate(),
        remark,
      },
    };
  }

  if (kind === "PURCHASE") {
    const title = String(body.title ?? "").trim();
    const unitPrice = Number(body.unitPrice ?? 0);
    const sampleQuantity = Number(body.sampleQuantity ?? 0);
    const productionQuantity = Number(body.productionQuantity ?? 0);
    if (!title) return { error: "项目/物料名称不能为空" };
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: "单价必须为非负数" };
    if (!Number.isFinite(sampleQuantity) || sampleQuantity < 0) return { error: "样机数量必须为非负数" };
    if (!Number.isFinite(productionQuantity) || productionQuantity < 0)
      return { error: "量产数量必须为非负数" };
    return {
      fields: {
        sortOrder,
        title,
        ...stripManpower(),
        unitPrice,
        sampleQuantity,
        productionQuantity,
        amount: 0,
        ...stripRate(),
        remark,
      },
    };
  }

  if (kind === "OTHER") {
    const title = String(body.title ?? "").trim();
    const amount = Number(body.amount ?? 0);
    if (!title) return { error: "差旅事项不能为空" };
    if (!Number.isFinite(amount) || amount < 0) return { error: "金额必须为非负数" };
    return {
      fields: {
        sortOrder,
        title,
        ...stripManpower(),
        unitPrice: 0,
        sampleQuantity: 0,
        productionQuantity: 0,
        amount,
        ...stripRate(),
        remark,
      },
    };
  }

  if (kind === "RATE") {
    const title = String(body.title ?? "").trim();
    const minRate = Number(body.minRate ?? 0);
    const maxRate = Number(body.maxRate ?? 0);
    const currentRate = Number(body.currentRate ?? 0);
    if (!title) return { error: "费率名称不能为空" };
    if (!Number.isFinite(minRate) || minRate < 0) return { error: "建议下限必须为非负数" };
    if (!Number.isFinite(maxRate) || maxRate < 0) return { error: "建议上限必须为非负数" };
    if (minRate > maxRate) return { error: "建议下限不能大于建议上限" };
    if (!Number.isFinite(currentRate) || currentRate < 0) return { error: "当前使用值必须为非负数" };
    // currentRate 超出建议上下限时允许保存，由 UI 提醒。
    return {
      fields: {
        sortOrder,
        title,
        ...stripManpower(),
        ...stripPurchase(),
        amount: 0,
        minRate,
        maxRate,
        defaultRate: 0,
        currentRate,
        remark,
      },
    };
  }

  return { error: `不支持的分类类型：${kind}` };
}

function summarizeItem(kind: string, f: ItemFields): string {
  if (kind === "MANPOWER") return `${f.person}（${f.groupName}）`;
  if (kind === "PURCHASE") return f.title;
  if (kind === "RATE") return f.title;
  return f.title;
}
