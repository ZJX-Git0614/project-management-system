import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ensureMutableProject, err, notFound, ok, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"

const serialize = (s: Awaited<ReturnType<typeof prisma.projectBudgetSetting.findUnique>>) => {
  if (!s) return null;
  return {
    id: s.id,
    projectId: s.projectId,
    contractAmount: s.contractAmount,
    profitTargetRate: s.profitTargetRate,
    note: s.note,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
};

// GET /api/projects/[id]/budget-setting
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

  const setting = await prisma.projectBudgetSetting.findUnique({ where: { projectId: id } });
  return ok(serialize(setting));
}

// PUT /api/projects/[id]/budget-setting
// 只管理：合同金额（自动从项目信息 amountWan 同步）+ 利润率目标 + 备注
// 公摊/审价/风险已迁入 RATE 分类
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-budget:edit")) return forbidden();

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const body = await req.json();
  // 合同金额以「项目信息」中的 amountWan（万元）为准，不接受前端传入
  const project = await prisma.project.findUnique({ where: { id }, select: { amountWan: true } });
  if (!project) return notFound("项目");
  const contractAmount = (project.amountWan || 0) * 10000;
  const profitTargetRate = Number(body.profitTargetRate ?? 0);
  const note = String(body.note ?? "").trim();

  if (!Number.isFinite(profitTargetRate) || profitTargetRate < 0) return err("利润率目标必须为非负数");

  const setting = await prisma.projectBudgetSetting.upsert({
    where: { projectId: id },
    create: { projectId: id, contractAmount, profitTargetRate, note },
    update: { contractAmount, profitTargetRate, note },
  });

  await prisma.operationHistory.create({
    data: {
      projectId: id,
      entityType: "PROJECT_BUDGET_SETTING",
      entityId: setting.id,
      actionType: "UPDATE",
      operator: user.displayName,
      detail: `更新预算设置（合同 ${contractAmount} / 利润率目标 ${profitTargetRate}%）`,
    },
  });

  return ok(serialize(setting));
}
