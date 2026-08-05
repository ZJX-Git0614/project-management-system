import { NextRequest } from "next/server";

import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { normalizeStructureCount, placeRowsAroundAnchor, type FlatRowPosition } from "@/lib/flat-row-structure";
import { prisma } from "@/lib/prisma";
import { renumberRiskCodes } from "@/lib/risk-register-codes";
import { requireUser, userHasPermission } from "@/lib/server-auth";

type StructureOperation = "INSERT" | "COPY" | "MOVE";

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
  const anchorRiskId = String(body.anchorRiskId ?? "").trim();
  const operation = body.operation as StructureOperation;
  const position = body.position as FlatRowPosition;
  if (!anchorRiskId) return err("目标风险不能为空");
  if (!["INSERT", "COPY", "MOVE"].includes(operation)) return err("不支持的风险结构操作");
  if (position !== "BEFORE" && position !== "AFTER") return err("风险插入位置无效");
  const permission = operation === "MOVE" ? "risk-register:edit" : "risk-register:create";
  if (!(await userHasPermission(user, permission))) return err("权限不足", 403);

  const sourceRiskIds = Array.isArray(body.sourceRiskIds)
    ? [...new Set(body.sourceRiskIds.filter((riskId: unknown): riskId is string => typeof riskId === "string" && riskId.length > 0))]
    : [];
  if (operation !== "INSERT" && sourceRiskIds.length === 0) return err("请选择要复制或剪切的风险");

  try {
    const result = await prisma.$transaction(async (tx) => {
      const currentRisks = await tx.riskRegisterItem.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        include: { weeklyItemLinks: { select: { weeklyItemId: true } } },
      });
      if (!currentRisks.some((risk) => risk.id === anchorRiskId)) throw new Error("目标风险不存在");

      const sourceRiskIdSet = new Set(sourceRiskIds);
      const sourceRisks = currentRisks.filter((risk) => sourceRiskIdSet.has(risk.id));
      if (operation !== "INSERT" && sourceRisks.length !== sourceRiskIds.length) {
        throw new Error("复制或剪切的风险不存在或不属于当前项目");
      }

      const createdRisks: typeof currentRisks = [];
      if (operation === "INSERT") {
        const count = normalizeStructureCount(body.count);
        for (let index = 0; index < count; index += 1) {
          createdRisks.push(await tx.riskRegisterItem.create({
            data: {
              projectId,
              sortOrder: currentRisks.length + index + 1,
              riskCode: "",
              riskName: "新风险",
              owner: user.displayName,
            },
            include: { weeklyItemLinks: { select: { weeklyItemId: true } } },
          }));
        }
      } else if (operation === "COPY") {
        for (const source of sourceRisks) {
          const created = await tx.riskRegisterItem.create({
            data: {
              projectId,
              sortOrder: currentRisks.length + createdRisks.length + 1,
              riskCode: "",
              ganttTaskId: source.ganttTaskId,
              weeklyItemId: source.weeklyItemId,
              riskName: source.riskName,
              linkedItemName: source.linkedItemName,
              category: source.category,
              trigger: source.trigger,
              probability: source.probability,
              impact: source.impact,
              level: source.level,
              response: source.response,
              owner: source.owner,
              status: source.status,
              targetDate: source.targetDate,
            },
            include: { weeklyItemLinks: { select: { weeklyItemId: true } } },
          });
          const sourceWeeklyItemIds = source.weeklyItemLinks.length > 0
            ? source.weeklyItemLinks.map((link) => link.weeklyItemId)
            : source.weeklyItemId ? [source.weeklyItemId] : [];
          if (sourceWeeklyItemIds.length > 0) {
            await tx.riskRegisterItemWeeklyItem.createMany({
              data: sourceWeeklyItemIds.map((weeklyItemId) => ({ riskItemId: created.id, weeklyItemId })),
              skipDuplicates: true,
            });
          }
          createdRisks.push({
            ...created,
            weeklyItemLinks: sourceWeeklyItemIds.map((weeklyItemId) => ({ weeklyItemId })),
          });
        }
      }

      const rowsToPlace = operation === "MOVE" ? sourceRisks : createdRisks;
      const allRisks = operation === "MOVE" ? currentRisks : [...currentRisks, ...createdRisks];
      const orderedRisks = placeRowsAroundAnchor(allRisks, rowsToPlace, anchorRiskId, position);
      const renumberedRisks = renumberRiskCodes(
        orderedRisks.map((risk, index) => ({ ...risk, sortOrder: index + 1 })),
      );

      await Promise.all(renumberedRisks.map((risk) => tx.riskRegisterItem.update({
        where: { id: risk.id },
        data: { sortOrder: risk.sortOrder, riskCode: risk.riskCode },
      })));

      const label = operation === "INSERT" ? "插入风险" : operation === "COPY" ? "复制粘贴风险" : "剪切移动风险";
      await tx.operationHistory.create({
        data: {
          projectId,
          entityType: "RISK_REGISTER",
          entityId: anchorRiskId,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: label,
        },
      });

      return {
        createdRiskIds: createdRisks.map((risk) => risk.id),
        movedRiskIds: operation === "MOVE" ? sourceRisks.map((risk) => risk.id) : [],
      };
    });

    return ok(result);
  } catch (error) {
    return err(error instanceof Error ? error.message : "风险结构操作失败");
  }
}
