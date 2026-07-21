import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // Seed is intentionally limited to non-business baseline data.
  // It must not create demo projects, budgets, weekly items, risks, or gantt tasks.
  const defaultRoles = [
    { roleName: "管理员", allowMultiple: true, systemPreset: true, persons: JSON.stringify([]) },
    { roleName: "项目经理", allowMultiple: false, systemPreset: true, persons: JSON.stringify([]) },
    { roleName: "项目成员", allowMultiple: true, systemPreset: true, persons: JSON.stringify([]) },
  ];

  for (const role of defaultRoles) {
    await prisma.roleConfig.upsert({
      where: { roleName: role.roleName },
      update: {},
      create: role,
    });
  }

  await prisma.userAccount.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      displayName: "系统管理员",
      enabled: true,
      assignedRoleNames: JSON.stringify(["管理员"]),
      passwordHash: hashSync("admin123", 10),
      passwordResetRequired: false,
      passwordUpdatedAt: new Date(),
    },
  });

  const { cloneDefaultPermissionTree } = await import("../src/lib/permissions");
  await prisma.permissionTree.upsert({
    where: { id: "default_tree" },
    update: {},
    create: {
      id: "default_tree",
      data: JSON.stringify(cloneDefaultPermissionTree()),
    },
  });

  console.log("基础数据初始化完成：管理员账号、系统角色、默认权限树已就绪。");
  console.log("未写入任何项目、预算、事项、风险或甘特图业务数据。");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
