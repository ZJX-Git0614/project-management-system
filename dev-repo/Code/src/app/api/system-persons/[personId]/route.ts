import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"
import { ok, forbidden, notFound, unauthorizedFromRequest } from "@/lib/api-utils"

// DELETE /api/system-persons/[personId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ personId: string }> }
) {
  const { personId } = await params
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:edit")) return forbidden()

  const person = await prisma.systemPerson.findUnique({
    where: { id: personId },
  })
  if (!person) return notFound("系统人员")

  await prisma.systemPerson.delete({ where: { id: personId } })

  return ok({ message: "系统人员已删除" })
}
