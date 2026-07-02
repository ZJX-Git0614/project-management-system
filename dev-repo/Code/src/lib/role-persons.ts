import { prisma } from "@/lib/prisma"

const parseRoleNames = (value: string | string[] | null | undefined): string[] => {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

const uniqueNames = (items: string[]) => Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)))

export const buildPersonsByRoleFromAccounts = async () => {
  const accounts = await prisma.userAccount.findMany({
    where: { enabled: true },
    select: {
      displayName: true,
      assignedRoleNames: true,
    },
    orderBy: { createdAt: "asc" },
  })

  return (roleName: string) =>
    uniqueNames(
      accounts
        .filter((account) => parseRoleNames(account.assignedRoleNames).includes(roleName))
        .map((account) => account.displayName),
    )
}

export const syncRoleConfigPersonsFromAccounts = async () => {
  const [roles, accounts] = await Promise.all([
    prisma.roleConfig.findMany({ select: { id: true, roleName: true } }),
    prisma.userAccount.findMany({
      where: { enabled: true },
      select: { displayName: true, assignedRoleNames: true },
      orderBy: { createdAt: "asc" },
    }),
  ])

  await Promise.all(
    roles.map((role) => {
      const persons = uniqueNames(
        accounts
          .filter((account) => parseRoleNames(account.assignedRoleNames).includes(role.roleName))
          .map((account) => account.displayName),
      )

      return prisma.roleConfig.update({
        where: { id: role.id },
        data: { persons: JSON.stringify(persons) },
      })
    }),
  )
}
