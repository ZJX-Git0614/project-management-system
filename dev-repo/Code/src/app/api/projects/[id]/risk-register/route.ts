import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized, notFound } from "@/lib/api-utils"

// GET /api/projects/[id]/risk-register
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")

  const items = await prisma.riskRegisterItem.findMany({
    where: { projectId: id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      ganttTask: { select: { id: true, taskName: true } },
    },
  })

  return ok(items.map((item) => ({
    ...item,
    ganttTaskId: item.ganttTaskId ?? null,
    linkedItemName: item.ganttTask?.taskName ?? item.linkedItemName,
  })))
}

// POST /api/projects/[id]/risk-register
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")

  const body = await req.json()
  if (!body.riskName?.trim()) return err("风险名称不能为空")
  const lastItem = await prisma.riskRegisterItem.findFirst({
    where: { projectId: id },
    orderBy: [{ sortOrder: "desc" }, { createdAt: "desc" }],
    select: { sortOrder: true },
  })

  const requestedTaskId = typeof body.ganttTaskId === "string" ? body.ganttTaskId.trim() : ""
  const linkedTask = requestedTaskId
    ? await prisma.projectGanttTask.findFirst({
        where: { id: requestedTaskId, projectId: id },
        select: { id: true, taskName: true },
      })
    : null
  if (requestedTaskId && !linkedTask) return err("关联任务不存在或不属于当前项目")

  const item = await prisma.riskRegisterItem.create({
    data: {
      projectId: id,
      sortOrder: (lastItem?.sortOrder ?? 0) + 1,
      riskName: body.riskName,
      ganttTaskId: linkedTask?.id ?? null,
      linkedItemName: linkedTask?.taskName ?? (requestedTaskId ? "" : body.linkedItemName || ""),
      category: body.category || "",
      trigger: body.trigger || "",
      probability: body.probability || "中",
      impact: body.impact || "中",
      level: body.level || "中",
      response: body.response || "",
      owner: body.owner || "",
      status: body.status || "识别中",
      targetDate: body.targetDate || "",
    },
  })

  return ok({
    ...item,
    ganttTaskId: item.ganttTaskId ?? null,
    linkedItemName: linkedTask?.taskName ?? item.linkedItemName,
  }, 201)
}
