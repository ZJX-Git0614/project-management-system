import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";

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

// PUT /api/projects/[id]/budget-items/[itemId]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectBudgetItem.findUnique({ where: { id: itemId } });
  if (!existing || existing.projectId !== id) return notFound("预算条目");

  const body = await req.json();
  const categoryId = String(body.categoryId ?? existing.categoryId);
  const category = await prisma.projectBudgetCategory.findUnique({ where: { id: categoryId } });
  if (!category || category.projectId !== id) return notFound("预算分类");

  const data = buildItemData(category.kind, body, {
    title: existing.title,
    groupName: existing.groupName,
    person: existing.person,
    personMonths: existing.personMonths,
    monthlyCostPerPerson: existing.monthlyCostPerPerson,
    unitPrice: existing.unitPrice,
    sampleQuantity: existing.sampleQuantity,
    productionQuantity: existing.productionQuantity,
    amount: existing.amount,
    minRate: existing.minRate,
    maxRate: existing.maxRate,
    defaultRate: existing.defaultRate,
    currentRate: existing.currentRate,
    remark: existing.remark,
    sortOrder: existing.sortOrder,
  });
  if ("error" in data) return err(data.error);

  const item = await prisma.projectBudgetItem.update({
    where: { id: itemId },
    data: { categoryId, ...data.fields },
  });

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_BUDGET_ITEM",
      entityId: item.id,
      actionType: "UPDATE",
      operator: user.displayName,
      detail: `更新预算条目（${category.name}）`,
    },
  });

  return ok(serialize(item));
}

// DELETE /api/projects/[id]/budget-items/[itemId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectBudgetItem.findUnique({
    where: { id: itemId },
    include: { category: true },
  });
  if (!existing || existing.projectId !== id) return notFound("预算条目");

  await prisma.projectBudgetItem.delete({ where: { id: itemId } });

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_BUDGET_ITEM",
      entityId: itemId,
      actionType: "DELETE",
      operator: user.displayName,
      detail: `删除预算条目（${existing.category?.name ?? ""}）`,
    },
  });

  return ok({ id: itemId });
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
  existing: {
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
    sortOrder: number;
  },
): { fields: ItemFields } | { error: string } {
  const sortOrder = Number(body.sortOrder ?? existing.sortOrder ?? 0);
  const remark = String(body.remark ?? existing.remark ?? "");

  if (kind === "MANPOWER") {
    const groupName = String(body.groupName ?? existing.groupName).trim();
    const person = String(body.person ?? existing.person).trim();
    const personMonths = Number(body.personMonths ?? existing.personMonths);
    const monthlyCostPerPerson = Number(body.monthlyCostPerPerson ?? existing.monthlyCostPerPerson);
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
    const title = String(body.title ?? existing.title).trim();
    const unitPrice = Number(body.unitPrice ?? existing.unitPrice);
    const sampleQuantity = Number(body.sampleQuantity ?? existing.sampleQuantity);
    const productionQuantity = Number(body.productionQuantity ?? existing.productionQuantity);
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
    const title = String(body.title ?? existing.title).trim();
    const amount = Number(body.amount ?? existing.amount);
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
    const title = String(body.title ?? existing.title).trim();
    const minRate = Number(body.minRate ?? existing.minRate);
    const maxRate = Number(body.maxRate ?? existing.maxRate);
    const currentRate = Number(body.currentRate ?? existing.currentRate);
    if (!title) return { error: "费率名称不能为空" };
    if (!Number.isFinite(minRate) || minRate < 0) return { error: "建议下限必须为非负数" };
    if (!Number.isFinite(maxRate) || maxRate < 0) return { error: "建议上限必须为非负数" };
    if (minRate > maxRate) return { error: "建议下限不能大于建议上限" };
    if (!Number.isFinite(currentRate) || currentRate < 0) return { error: "当前使用值必须为非负数" };
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
