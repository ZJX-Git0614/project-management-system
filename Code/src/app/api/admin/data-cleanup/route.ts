import { rm } from "node:fs/promises";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { forbidden, ok, unauthorized, err, notFound } from "@/lib/api-utils";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { getProjectDocumentDirectory } from "@/lib/project-document-storage";

type CleanupModuleId =
  | "project-members"
  | "project-gantt"
  | "weekly-items"
  | "project-budget"
  | "risk-register"
  | "todos"
  | "all-business"
  | "entire-project";

interface CleanupModule {
  id: CleanupModuleId;
  label: string;
  description: string;
}

const CLEANUP_MODULES: CleanupModule[] = [
  { id: "project-members", label: "项目组成员", description: "清空项目成员列表，不删除后台账号。" },
  { id: "project-gantt", label: "项目进度甘特图", description: "清空项目进度管理中的任务与甘特图数据。" },
  { id: "weekly-items", label: "项目事项", description: "清空项目事项管理中的事项记录。" },
  { id: "project-budget", label: "项目预算", description: "清空预算分类、预算明细和预算设置。" },
  { id: "risk-register", label: "风险登记册", description: "清空项目风险登记册记录。" },
  { id: "todos", label: "待办事项", description: "清空待办中心数据。" },
  { id: "all-business", label: "全部业务模块", description: "清空上述所有业务模块数据，保留项目、账号、权限和操作日志。" },
  { id: "entire-project", label: "整个项目", description: "删除项目主档及其全部业务数据、文档和项目助手记录；后台账号与权限不受影响。" },
];

const BUSINESS_MODULE_IDS = CLEANUP_MODULES
  .filter((item) => item.id !== "all-business" && item.id !== "entire-project")
  .map((item) => item.id);

const MODULE_LABEL_BY_ID = Object.fromEntries(CLEANUP_MODULES.map((item) => [item.id, item.label])) as Record<CleanupModuleId, string>;

async function requireAdmin(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return { response: unauthorized() };

  const account = await prisma.userAccount.findUnique({ where: { id: user.userId } });
  if (!account) return { response: unauthorized() };

  const roleNames = JSON.parse(account.assignedRoleNames) as string[];
  if (!roleNames.includes(ADMIN_ROLE_NAME)) return { response: forbidden() };

  return { user: { ...user, displayName: account.displayName } };
}

async function countModule(projectId: string, moduleId: CleanupModuleId): Promise<number> {
  if (moduleId === "project-members") return prisma.projectMember.count({ where: { projectId } });
  if (moduleId === "project-gantt") {
    const [tasks, metadata] = await Promise.all([
      prisma.projectGanttTask.count({ where: { projectId } }),
      prisma.projectScheduleImportMetadata.count({ where: { projectId } }),
    ]);
    return tasks + metadata;
  }
  if (moduleId === "weekly-items") return prisma.weeklyItem.count({ where: { projectId } });
  if (moduleId === "risk-register") return prisma.riskRegisterItem.count({ where: { projectId } });
  if (moduleId === "todos") return prisma.todoItem.count({ where: { projectId } });
  if (moduleId === "project-budget") {
    const [categories, items, settings] = await Promise.all([
      prisma.projectBudgetCategory.count({ where: { projectId } }),
      prisma.projectBudgetItem.count({ where: { projectId } }),
      prisma.projectBudgetSetting.count({ where: { projectId } }),
    ]);
    return categories + items + settings;
  }

  if (moduleId === "all-business") {
    const counts: number[] = await Promise.all(BUSINESS_MODULE_IDS.map((id) => countModule(projectId, id)));
    return counts.reduce((sum: number, value: number) => sum + value, 0);
  }

  const [business, documents, histories, chatMessages, actionRuns] = await Promise.all([
    countModule(projectId, "all-business"),
    prisma.projectDocumentFile.count({ where: { projectId } }),
    prisma.operationHistory.count({ where: { projectId } }),
    prisma.assistantChatMessage.count({ where: { projectId } }),
    prisma.assistantActionRun.count({ where: { projectId } }),
  ]);
  return 1 + business + documents + histories + chatMessages + actionRuns;
}

async function deleteModule(tx: Prisma.TransactionClient, projectId: string, moduleId: CleanupModuleId): Promise<number> {
  if (moduleId === "project-members") return (await tx.projectMember.deleteMany({ where: { projectId } })).count;
  if (moduleId === "project-gantt") {
    const [tasks, metadata] = await Promise.all([
      tx.projectGanttTask.deleteMany({ where: { projectId } }),
      tx.projectScheduleImportMetadata.deleteMany({ where: { projectId } }),
    ]);
    return tasks.count + metadata.count;
  }
  if (moduleId === "weekly-items") return (await tx.weeklyItem.deleteMany({ where: { projectId } })).count;
  if (moduleId === "risk-register") return (await tx.riskRegisterItem.deleteMany({ where: { projectId } })).count;
  if (moduleId === "todos") return (await tx.todoItem.deleteMany({ where: { projectId } })).count;
  if (moduleId === "project-budget") {
    const items = await tx.projectBudgetItem.deleteMany({ where: { projectId } });
    const categories = await tx.projectBudgetCategory.deleteMany({ where: { projectId } });
    const settings = await tx.projectBudgetSetting.deleteMany({ where: { projectId } });
    return items.count + categories.count + settings.count;
  }

  if (moduleId === "entire-project") {
    throw new Error("整个项目必须通过项目级删除流程处理");
  }

  let total = 0;
  for (const id of BUSINESS_MODULE_IDS) {
    total += await deleteModule(tx, projectId, id);
  }
  return total;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;

  const projects = await prisma.project.findMany({
    orderBy: [{ createdAt: "desc" }],
    select: { id: true, name: true, code: true, status: true },
  });

  const counts = await Promise.all(
    projects.map(async (project) => {
      const entries = await Promise.all(
        CLEANUP_MODULES.map(async (module) => [module.id, await countModule(project.id, module.id)] as const),
      );
      return [project.id, Object.fromEntries(entries)] as const;
    }),
  );
  const recentAudits = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      createdAt: true,
      actionType: true,
      operator: true,
      projectId: true,
      projectName: true,
      detail: true,
    },
  });

  return ok({
    modules: CLEANUP_MODULES,
    projects,
    countsByProjectId: Object.fromEntries(counts),
    recentAudits,
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("response" in auth) return auth.response;

  const body = await req.json().catch(() => ({}));
  const moduleId = String(body.moduleId ?? "") as CleanupModuleId;
  const projectId = body.projectId ? String(body.projectId) : "";
  const confirmText = String(body.confirmText ?? "");

  if (!CLEANUP_MODULES.some((item) => item.id === moduleId)) return err("请选择要清理的模块");
  const deletingProject = moduleId === "entire-project";
  const expectedConfirmation = deletingProject ? "删除项目" : "清空";
  if (confirmText !== expectedConfirmation) return err(`请输入“${expectedConfirmation}”确认操作`);
  if (!projectId) return err("请选择项目");

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, code: true } });
  if (!project) return notFound("项目");

  const moduleLabel = MODULE_LABEL_BY_ID[moduleId];
  const projectRecordCount = deletingProject ? await countModule(projectId, moduleId) : 0;
  const result = await prisma.$transaction(async (tx) => {
    if (deletingProject) {
      const deletedCount = projectRecordCount;
      const detail = `超级管理员删除整个项目「${project.name}」（${project.code || "无编号"}），共移除 ${deletedCount} 条关联记录`;
      await tx.adminAuditLog.create({
        data: {
          actionType: "DELETE_PROJECT",
          operator: auth.user.displayName,
          projectId,
          projectName: project.name,
          detail,
          snapshot: JSON.stringify({ project, deletedCount }),
        },
      });
      await tx.assistantChatMessage.deleteMany({ where: { projectId } });
      await tx.assistantActionRun.deleteMany({ where: { projectId } });
      await tx.project.delete({ where: { id: projectId } });
      return { deletedCount };
    }

    const deletedCount = await deleteModule(tx, projectId, moduleId);
    const detail = `超级管理员清空「${project.name}」的「${moduleLabel}」数据，共删除 ${deletedCount} 条`;
    await tx.operationHistory.create({
      data: {
        projectId,
        entityType: "ADMIN_DATA_CLEANUP",
        entityId: `${moduleId}:${projectId}`,
        actionType: "DELETE",
        operator: auth.user.displayName,
        detail,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actionType: "DELETE_MODULE_DATA",
        operator: auth.user.displayName,
        projectId,
        projectName: project.name,
        detail,
        snapshot: JSON.stringify({ project, moduleId, moduleLabel, deletedCount }),
      },
    });
    return { deletedCount };
  });

  let storageWarning = "";
  if (deletingProject) {
    try {
      await rm(getProjectDocumentDirectory(projectId), { recursive: true, force: true });
    } catch {
      storageWarning = "；数据库已删除，但文档存储目录清理失败，请检查服务器文件权限";
    }
  }

  return ok({
    project,
    moduleId,
    moduleLabel,
    deletedCount: result.deletedCount,
    projectDeleted: deletingProject,
    message: deletingProject
      ? `整个项目已删除，独立审计日志已保留${storageWarning}`
      : "清理完成，已写入操作日志",
  });
}
