import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, unauthorized, notFound } from "@/lib/api-utils"

// DELETE /api/system-persons/[personId]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ personId: string }> }
) {
  const { personId } = await params
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

  const person = await prisma.systemPerson.findUnique({
    where: { id: personId },
  })
  if (!person) return notFound("系统人员")

  await prisma.systemPerson.delete({ where: { id: personId } })

  return ok({ message: "系统人员已删除" })
}
