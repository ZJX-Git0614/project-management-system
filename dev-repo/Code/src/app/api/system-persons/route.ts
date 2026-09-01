import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth"
import { ok, err, forbidden, unauthorizedFromRequest } from "@/lib/api-utils"

// GET /api/system-persons
export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:view")) return forbidden()

  const persons = await prisma.systemPerson.findMany({
    orderBy: { createdAt: "asc" },
  })

  return ok(
    persons.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }))
  )
}

// POST /api/system-persons
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req)
  if (!user) return unauthorizedFromRequest(req)
  if (!await userHasPermission(user, "role-config:edit")) return forbidden()

  const body = await req.json()
  if (!body.personName) return err("人员姓名不能为空")

  const person = await prisma.systemPerson.create({
    data: {
      personName: body.personName,
    },
  })

  return ok(
    {
      ...person,
      createdAt: person.createdAt.toISOString(),
      updatedAt: person.updatedAt.toISOString(),
    },
    201
  )
}
