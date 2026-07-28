import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { getUserFromRequest } from "@/lib/auth"
import { ok, err, unauthorized } from "@/lib/api-utils"

// GET /api/system-persons
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

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
  const user = getUserFromRequest(req)
  if (!user) return unauthorized()

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
