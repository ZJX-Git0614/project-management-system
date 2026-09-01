import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { ok, notFound, unauthorizedFromRequest, forbidden } from "@/lib/api-utils"

// GET /api/projects/[id]/operation-history
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "project-info:view")) return forbidden();

  const project = await prisma.project.findUnique({ where: { id } })
  if (!project) return notFound("项目")

  const { searchParams } = new URL(req.url)
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 500)
  const entityType = searchParams.get("entityType")
  const actionType = searchParams.get("actionType")

  const where: Record<string, unknown> = { projectId: id }
  if (entityType) where.entityType = entityType
  if (actionType) where.actionType = actionType

  const history = await prisma.operationHistory.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  })

  return ok(
    history.map((h) => ({
      ...h,
      createdAt: h.createdAt.toISOString(),
      updatedAt: h.updatedAt.toISOString(),
    }))
  )
}
