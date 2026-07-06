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
    orderBy: [{ createdAt: "asc" }],
  })

  return ok(items)
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

  const item = await prisma.riskRegisterItem.create({
    data: {
      projectId: id,
      riskName: body.riskName,
      linkedItemName: body.linkedItemName || "",
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

  return ok(item, 201)
}
