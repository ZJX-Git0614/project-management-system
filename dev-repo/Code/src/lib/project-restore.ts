import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";

import { hashPassword } from "@/lib/auth";
import { ASSISTANT_ARTIFACT_STORAGE_ROOT } from "@/lib/assistant-artifact-storage";
import { prisma } from "@/lib/prisma";
import { getProjectDocumentDirectory, PROJECT_DOCUMENT_STORAGE_ROOT } from "@/lib/project-document-storage";
import {
  DEFAULT_SYSTEM_BACKUP_ROOT,
  getManualMigrationPaths,
  postgresToolConnectionUrl,
  runSystemCommand,
  runSystemCommandOutput,
  withSystemDataOperationLock,
} from "@/lib/system-backup";

export const PROJECT_RESTORE_PROTECTION_DAYS = 30;
export const PROJECT_RESTORE_SESSION_HOURS = 6;
export const PROJECT_RESTORE_ROOT = path.join(DEFAULT_SYSTEM_BACKUP_ROOT, ".project-restore");

type Scalar = string | number | boolean | null | Record<string, unknown> | unknown[];
type TableSnapshot = {
  table: string;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, Scalar>>;
};
export type ProjectDataSnapshot = {
  projectId: string;
  projectName: string;
  tables: TableSnapshot[];
};
type RestoreSessionFile = {
  id: string;
  createdAt: string;
  expiresAt: string;
  sourceFileName: string;
  documentArchiveFileName: string;
  snapshots: ProjectDataSnapshot[];
  sourceAccounts: Array<{ id: string; username: string; displayName: string }>;
  documentArchivePath: string;
  documentCheck: { supplied: boolean; requiredCount: number; missingFiles: string[] };
};

export type ProjectAccountResolution = {
  sourceAccountId: string;
  action: "MAP" | "UNASSIGNED" | "RESTORE_DISABLED";
  targetAccountId?: string;
};

const directProjectTables = [
  "Project",
  "ProjectBudgetCategory",
  "ProjectBudgetItem",
  "ProjectBudgetSetting",
  "ProjectMember",
  "ProjectGanttTask",
  "ProjectGanttDependency",
  "ProjectExecution",
  "ProjectExecutionGate",
  "ProjectGanttDeletionBatch",
  "ProjectScheduleImportMetadata",
  "ProjectScheduleSnapshot",
  "ProjectModuleHistorySnapshot",
  "ScheduleAnalysisRun",
  "WeeklyItem",
  "MonthlyItem",
  "TodoItem",
  "OperationHistory",
  "RiskRegisterItem",
  "ProjectDocumentFile",
  "AssistantAttachment",
  "DocumentRevision",
  "AssistantArtifact",
  "AssistantPlanRun",
  "AssistantActionRun",
  "AssistantChatMessage",
] as const;

const childTableQueries: Record<string, string> = {
  ProjectExecutionTask: `SELECT link.* FROM "ProjectExecutionTask" link JOIN "ProjectExecution" execution ON execution.id = link."executionId" WHERE execution."projectId" = $1`,
  ProjectExecutionGateCriterion: `SELECT criterion.* FROM "ProjectExecutionGateCriterion" criterion JOIN "ProjectExecutionGate" gate ON gate.id = criterion."gateId" WHERE gate."projectId" = $1`,
  ProjectGanttTaskOwner: `SELECT owner_link.* FROM "ProjectGanttTaskOwner" owner_link JOIN "ProjectGanttTask" task ON task.id = owner_link."taskId" WHERE task."projectId" = $1`,
  WeeklyItemGanttTask: `SELECT link.* FROM "WeeklyItemGanttTask" link JOIN "WeeklyItem" item ON item.id = link."weeklyItemId" WHERE item."projectId" = $1`,
  RiskRegisterItemWeeklyItem: `SELECT link.* FROM "RiskRegisterItemWeeklyItem" link JOIN "RiskRegisterItem" risk ON risk.id = link."riskItemId" WHERE risk."projectId" = $1`,
  DocumentExtraction: `SELECT extraction.* FROM "DocumentExtraction" extraction JOIN "AssistantAttachment" attachment ON attachment.id = extraction."attachmentId" WHERE attachment."projectId" = $1`,
  AssistantPlanStep: `SELECT step.* FROM "AssistantPlanStep" step JOIN "AssistantPlanRun" plan ON plan.id = step."planId" WHERE plan."projectId" = $1`,
};

const insertOrder = [
  "Project",
  "ProjectBudgetCategory",
  "ProjectBudgetItem",
  "ProjectBudgetSetting",
  "ProjectMember",
  "ProjectExecution",
  "ProjectGanttTask",
  "ProjectExecutionTask",
  "ProjectExecutionGate",
  "ProjectExecutionGateCriterion",
  "ProjectGanttTaskOwner",
  "ProjectGanttDependency",
  "ProjectGanttDeletionBatch",
  "ProjectScheduleImportMetadata",
  "ProjectScheduleSnapshot",
  "ProjectModuleHistorySnapshot",
  "ScheduleAnalysisRun",
  "WeeklyItem",
  "WeeklyItemGanttTask",
  "MonthlyItem",
  "TodoItem",
  "OperationHistory",
  "RiskRegisterItem",
  "RiskRegisterItemWeeklyItem",
  "ProjectDocumentFile",
  "AssistantAttachment",
  "DocumentExtraction",
  "DocumentRevision",
  "AssistantArtifact",
  "AssistantPlanRun",
  "AssistantPlanStep",
  "AssistantActionRun",
  "AssistantChatMessage",
];

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

const getTableColumns = async (client: PrismaClient | Prisma.TransactionClient, table: string) => (await
  client.$queryRawUnsafe<Array<{ column_name: string; data_type: string; udt_name: string }>>(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    table,
  )
).map((column) => ({
  name: column.column_name,
  type: column.data_type === "USER-DEFINED" ? column.udt_name : column.data_type,
}));

const extractTable = async (
  client: PrismaClient | Prisma.TransactionClient,
  table: string,
  projectId: string,
  query?: string,
): Promise<TableSnapshot> => {
  const columns = await getTableColumns(client, table);
  if (columns.length === 0) return { table, columns, rows: [] };
  const rows = await client.$queryRawUnsafe<Array<Record<string, Scalar>>>(
    query ?? `SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(table === "Project" ? "id" : "projectId")} = $1`,
    projectId,
  );
  return { table, columns, rows };
};

const sortTaskRows = (rows: Array<Record<string, Scalar>>) => {
  const pending = [...rows];
  const sorted: Array<Record<string, Scalar>> = [];
  const inserted = new Set<string>();
  while (pending.length > 0) {
    const ready = pending.filter((row) => !row.parentId || inserted.has(String(row.parentId)));
    if (ready.length === 0) return rows;
    ready.forEach((row) => {
      sorted.push(row);
      inserted.add(String(row.id));
      pending.splice(pending.indexOf(row), 1);
    });
  }
  return sorted;
};

export const extractProjectSnapshots = async (
  client: PrismaClient | Prisma.TransactionClient,
  projectIds: string[],
) => {
  const snapshots: ProjectDataSnapshot[] = [];
  for (const projectId of projectIds) {
    const tables: TableSnapshot[] = [];
    for (const table of directProjectTables) tables.push(await extractTable(client, table, projectId));
    for (const [table, query] of Object.entries(childTableQueries)) tables.push(await extractTable(client, table, projectId, query));
    const project = tables.find((table) => table.table === "Project")?.rows[0];
    if (!project) continue;
    const taskTable = tables.find((table) => table.table === "ProjectGanttTask");
    if (taskTable) taskTable.rows = sortTaskRows(taskTable.rows);
    snapshots.push({ projectId, projectName: String(project.name ?? projectId), tables });
  }
  return snapshots;
};

const temporaryDatabaseUrl = (databaseName: string) => {
  if (!process.env.DATABASE_URL) throw new Error("服务器未配置 DATABASE_URL");
  const url = new URL(postgresToolConnectionUrl(process.env.DATABASE_URL));
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const inspectDump = async (dumpPath: string) => {
  if (!process.env.DATABASE_URL) throw new Error("服务器未配置 DATABASE_URL");
  const databaseName = `ceastar_restore_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`.toLowerCase();
  const baseUrl = postgresToolConnectionUrl(process.env.DATABASE_URL);
  const tempUrl = temporaryDatabaseUrl(databaseName);
  await runSystemCommand("createdb", [`--maintenance-db=${baseUrl}`, databaseName]);
  const client = new PrismaClient({ datasources: { db: { url: tempUrl } } });
  try {
    await runSystemCommand("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${tempUrl}`, dumpPath]);
    for (const migrationPath of await getManualMigrationPaths()) {
      await runSystemCommand("psql", ["--no-psqlrc", "--set=ON_ERROR_STOP=1", `--dbname=${tempUrl}`, `--file=${migrationPath}`]);
    }
    const projects = await client.project.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true, code: true, status: true } });
    const snapshots = await extractProjectSnapshots(client, projects.map((project) => project.id));
    const sourceAccountIds = Array.from(new Set(snapshots.flatMap((snapshot) => (
      snapshot.tables.find((table) => table.table === "ProjectMember")?.rows
        .map((row) => typeof row.accountId === "string" ? row.accountId : "") ?? []
    )).filter(Boolean)));
    const sourceAccounts = sourceAccountIds.length > 0
      ? await client.userAccount.findMany({ where: { id: { in: sourceAccountIds } }, select: { id: true, username: true, displayName: true } })
      : [];
    return { projects, snapshots, sourceAccounts };
  } finally {
    await client.$disconnect().catch(() => undefined);
    await runSystemCommand("dropdb", [`--maintenance-db=${baseUrl}`, "--if-exists", databaseName]).catch(() => undefined);
  }
};

const validateArchive = async (archivePath: string) => {
  const listing = await runSystemCommandOutput("tar", ["-tzf", archivePath]);
  const entries = listing.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => path.isAbsolute(entry) || entry.split(/[\\/]/).includes(".."))) {
    throw new Error("文档归档包含不安全路径，已拒绝读取");
  }
  const verbose = await runSystemCommandOutput("tar", ["-tvzf", archivePath]);
  if (verbose.split(/\r?\n/).some((line) => /^[lh]/.test(line))) {
    throw new Error("文档归档包含链接文件，已拒绝读取");
  }
  return entries;
};

const documentRows = (snapshots: ProjectDataSnapshot[]) => snapshots.flatMap((snapshot) => [
  ...(snapshot.tables.find((table) => table.table === "ProjectDocumentFile")?.rows.map((row) => ({
    projectId: snapshot.projectId,
    storedName: String(row.storedName ?? ""),
    archiveSuffix: `/${snapshot.projectId}/${String(row.storedName ?? "")}`,
  })) ?? []),
  ...(snapshot.tables.find((table) => table.table === "AssistantAttachment")?.rows.map((row) => ({
    projectId: snapshot.projectId,
    storedName: String(row.storedName ?? ""),
    archiveSuffix: `/attachments/${snapshot.projectId}/${String(row.storedName ?? "")}`,
  })) ?? []),
  ...(snapshot.tables.find((table) => table.table === "AssistantArtifact")?.rows.map((row) => ({
    projectId: snapshot.projectId,
    storedName: String(row.storedName ?? ""),
    archiveSuffix: `/outputs/${snapshot.projectId}/${String(row.storedName ?? "")}`,
  })) ?? []),
]);

export const createProjectRestorePreview = async ({
  sessionId,
  dumpPath,
  sourceFileName,
  documentArchivePath,
  documentArchiveFileName,
}: {
  sessionId: string;
  dumpPath: string;
  sourceFileName: string;
  documentArchivePath?: string;
  documentArchiveFileName?: string;
}) => {
  const inspected = await inspectDump(dumpPath);
  const documents = documentRows(inspected.snapshots);
  const archiveEntries = documentArchivePath ? await validateArchive(documentArchivePath) : [];
  const missingFiles = documents.filter((document) => !archiveEntries.some((entry) => (
    entry.endsWith(document.archiveSuffix) || entry === document.archiveSuffix.slice(1)
  ))).map((document) => `${document.projectId}/${document.storedName}`);
  const currentProjects = await prisma.project.findMany({
    where: { id: { in: inspected.projects.map((project) => project.id) } },
    select: { id: true, name: true, code: true },
  });
  const currentAccounts = await prisma.userAccount.findMany({
    select: { id: true, username: true, displayName: true, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  const createdAt = new Date();
  const session: RestoreSessionFile = {
    id: sessionId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PROJECT_RESTORE_SESSION_HOURS * 60 * 60 * 1000).toISOString(),
    sourceFileName,
    documentArchiveFileName: documentArchiveFileName ?? "",
    snapshots: inspected.snapshots,
    sourceAccounts: inspected.sourceAccounts,
    documentArchivePath: documentArchivePath ?? "",
    documentCheck: { supplied: Boolean(documentArchivePath), requiredCount: documents.length, missingFiles },
  };
  const sessionDirectory = path.join(PROJECT_RESTORE_ROOT, "sessions", sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(path.join(sessionDirectory, "session.json"), JSON.stringify(session));

  const affectedProjectsByAccount = new Map<string, string[]>();
  inspected.snapshots.forEach((snapshot) => {
    const members = snapshot.tables.find((table) => table.table === "ProjectMember")?.rows ?? [];
    members.forEach((member) => {
      if (typeof member.accountId !== "string") return;
      const ids = affectedProjectsByAccount.get(member.accountId) ?? [];
      if (!ids.includes(snapshot.projectId)) ids.push(snapshot.projectId);
      affectedProjectsByAccount.set(member.accountId, ids);
    });
  });
  const accountIssues = inspected.sourceAccounts.flatMap((account) => {
    const sameId = currentAccounts.find((candidate) => candidate.id === account.id);
    if (sameId) return [];
    const candidates = currentAccounts.filter((candidate) => candidate.username === account.username || candidate.displayName === account.displayName);
    return [{ ...account, affectedProjectIds: affectedProjectsByAccount.get(account.id) ?? [], candidates }];
  });
  return {
    sessionId,
    expiresAt: session.expiresAt,
    projects: inspected.projects.map((project) => ({
      ...project,
      action: currentProjects.some((current) => current.id === project.id) ? "REPLACE" : "ADD",
      currentProject: currentProjects.find((current) => current.id === project.id) ?? null,
      counts: Object.fromEntries(inspected.snapshots.find((snapshot) => snapshot.projectId === project.id)?.tables.map((table) => [table.table, table.rows.length]) ?? []),
    })),
    accountIssues,
    availableAccounts: currentAccounts,
    documentCheck: session.documentCheck,
  };
};

export const readRestoreSession = async (sessionId: string) => {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) throw new Error("恢复会话编号无效");
  const file = path.join(PROJECT_RESTORE_ROOT, "sessions", sessionId, "session.json");
  const session = JSON.parse(await readFile(file, "utf8")) as RestoreSessionFile;
  if (new Date(session.expiresAt).getTime() < Date.now()) throw new Error("恢复预检已过期，请重新选择备份文件");
  return session;
};

const parameterValue = (value: Scalar, type: string) => {
  if (value === null || value === undefined) return null;
  if (type === "json" || type === "jsonb") return typeof value === "string" ? value : JSON.stringify(value);
  return value;
};

const insertTableRows = async (tx: Prisma.TransactionClient, table: TableSnapshot) => {
  if (table.rows.length === 0) return;
  const columnsByName = new Map(table.columns.map((column) => [column.name, column]));
  for (const row of table.rows) {
    const columns = Object.keys(row).filter((name) => columnsByName.has(name));
    const values = columns.map((name) => parameterValue(row[name], columnsByName.get(name)!.type));
    const placeholders = columns.map((name, index) => `$${index + 1}::${columnsByName.get(name)!.type}`);
    await tx.$executeRawUnsafe(
      `INSERT INTO ${quoteIdentifier(table.table)} (${columns.map(quoteIdentifier).join(",")}) VALUES (${placeholders.join(",")})`,
      ...values,
    );
  }
};

export const transformProjectSnapshotAccounts = (
  snapshot: ProjectDataSnapshot,
  accountTargets: Map<string, string | null>,
) => {
  const copy = structuredClone(snapshot);
  const memberTable = copy.tables.find((table) => table.table === "ProjectMember");
  const taskTable = copy.tables.find((table) => table.table === "ProjectGanttTask");
  const ownerLinkTable = copy.tables.find((table) => table.table === "ProjectGanttTaskOwner");
  if (!memberTable) return copy;
  const canonicalMemberByAccount = new Map<string, string>();
  const removedMemberToCanonical = new Map<string, string>();
  memberTable.rows = memberTable.rows.filter((member) => {
    const sourceAccountId = typeof member.accountId === "string" ? member.accountId : "";
    if (!sourceAccountId) return true;
    const targetAccountId = accountTargets.get(sourceAccountId) ?? null;
    member.accountId = targetAccountId;
    if (!targetAccountId) return true;
    const canonical = canonicalMemberByAccount.get(targetAccountId);
    if (!canonical) {
      canonicalMemberByAccount.set(targetAccountId, String(member.id));
      return true;
    }
    removedMemberToCanonical.set(String(member.id), canonical);
    return false;
  });
  taskTable?.rows.forEach((task) => {
    if (typeof task.ownerMemberId === "string" && removedMemberToCanonical.has(task.ownerMemberId)) {
      task.ownerMemberId = removedMemberToCanonical.get(task.ownerMemberId)!;
    }
  });
  if (ownerLinkTable) {
    const uniqueLinks = new Set<string>();
    ownerLinkTable.rows = ownerLinkTable.rows.filter((link) => {
      if (typeof link.projectMemberId === "string" && removedMemberToCanonical.has(link.projectMemberId)) {
        link.projectMemberId = removedMemberToCanonical.get(link.projectMemberId)!;
      }
      const key = `${String(link.taskId ?? "")}:${String(link.projectMemberId ?? "")}`;
      if (!link.taskId || !link.projectMemberId || uniqueLinks.has(key)) return false;
      uniqueLinks.add(key);
      return true;
    });
  }
  return copy;
};

const applyProjectSnapshotsUnlocked = async ({
  snapshots,
  resolutions,
  sourceAccounts,
  operatorName,
}: {
  snapshots: ProjectDataSnapshot[];
  resolutions: ProjectAccountResolution[];
  sourceAccounts: Array<{ id: string; username: string; displayName: string }>;
  operatorName: string;
}) => {
  const currentAccounts = await prisma.userAccount.findMany({ select: { id: true, username: true } });
  const currentAccountIds = new Set(currentAccounts.map((account) => account.id));
  const resolutionBySourceId = new Map(resolutions.map((resolution) => [resolution.sourceAccountId, resolution]));
  const accountTargets = new Map<string, string | null>();
  const historicalAccounts: Array<{ source: typeof sourceAccounts[number]; username: string }> = [];
  for (const source of sourceAccounts) {
    if (currentAccountIds.has(source.id)) {
      accountTargets.set(source.id, source.id);
      continue;
    }
    const resolution = resolutionBySourceId.get(source.id);
    if (!resolution) throw new Error(`请处理备份账号「${source.displayName}」的关联方式`);
    if (resolution.action === "MAP") {
      if (!resolution.targetAccountId || !currentAccountIds.has(resolution.targetAccountId)) throw new Error(`账号「${source.displayName}」的映射目标无效`);
      accountTargets.set(source.id, resolution.targetAccountId);
    } else if (resolution.action === "UNASSIGNED") {
      accountTargets.set(source.id, null);
    } else {
      let username = source.username;
      if (currentAccounts.some((account) => account.username === username)) username = `${username}.restored.${source.id.slice(-6)}`;
      historicalAccounts.push({ source, username });
      accountTargets.set(source.id, source.id);
    }
  }
  const transformed = snapshots.map((snapshot) => transformProjectSnapshotAccounts(snapshot, accountTargets));

  await prisma.$transaction(async (tx) => {
    for (const historical of historicalAccounts) {
      await tx.userAccount.create({
        data: {
          id: historical.source.id,
          username: historical.username,
          displayName: historical.source.displayName,
          enabled: false,
          assignedRoleNames: "[]",
          passwordHash: hashPassword(randomUUID()),
          passwordResetRequired: true,
          passwordUpdatedAt: new Date(),
        },
      });
    }
    for (const snapshot of transformed) {
      await tx.assistantActionRun.deleteMany({ where: { projectId: snapshot.projectId } });
      await tx.assistantChatMessage.deleteMany({ where: { projectId: snapshot.projectId } });
      await tx.project.deleteMany({ where: { id: snapshot.projectId } });
      for (const tableName of insertOrder) {
        const table = snapshot.tables.find((candidate) => candidate.table === tableName);
        if (table) await insertTableRows(tx, table);
      }
      await tx.operationHistory.create({
        data: {
          projectId: snapshot.projectId,
          entityType: "PROJECT_RESTORE",
          entityId: snapshot.projectId,
          actionType: "RESTORE",
          operator: operatorName,
          detail: `从系统备份恢复完整项目「${snapshot.projectName}」`,
        },
      });
    }
  }, { timeout: 120_000, maxWait: 30_000 });
  return { historicalAccounts };
};

export const applyProjectSnapshots = (params: {
  snapshots: ProjectDataSnapshot[];
  resolutions: ProjectAccountResolution[];
  sourceAccounts: Array<{ id: string; username: string; displayName: string }>;
  operatorName: string;
}) => withSystemDataOperationLock(() => applyProjectSnapshotsUnlocked(params));

const projectDocumentSourceDirectory = async (extractedRoot: string, projectId: string) => {
  const candidates = [
    path.join(extractedRoot, path.basename(PROJECT_DOCUMENT_STORAGE_ROOT), projectId),
    path.join(extractedRoot, "project-documents", projectId),
    path.join(extractedRoot, projectId),
  ];
  for (const candidate of candidates) {
    if (await stat(candidate).then((value) => value.isDirectory()).catch(() => false)) return candidate;
  }
  return null;
};

export const restoreProjectDocuments = async (session: RestoreSessionFile, projectIds: string[]) => {
  const stagingRoot = path.join(PROJECT_RESTORE_ROOT, "document-staging", session.id);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  if (session.documentArchivePath) {
    await validateArchive(session.documentArchivePath);
    await runSystemCommand("tar", ["-xzf", session.documentArchivePath, "--no-same-owner", "--no-same-permissions", "-C", stagingRoot]);
  }
  for (const projectId of projectIds) {
    const target = getProjectDocumentDirectory(projectId);
    await rm(target, { recursive: true, force: true });
    const source = await projectDocumentSourceDirectory(stagingRoot, projectId);
    if (source) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, force: true });
    }
    for (const kind of ["attachments", "outputs"] as const) {
      const assistantTarget = path.join(ASSISTANT_ARTIFACT_STORAGE_ROOT, kind, projectId);
      const assistantSource = path.join(stagingRoot, path.basename(ASSISTANT_ARTIFACT_STORAGE_ROOT), kind, projectId);
      await rm(assistantTarget, { recursive: true, force: true });
      if (await stat(assistantSource).then((value) => value.isDirectory()).catch(() => false)) {
        await mkdir(path.dirname(assistantTarget), { recursive: true });
        await cp(assistantSource, assistantTarget, { recursive: true, force: true });
      }
    }
  }
  await rm(stagingRoot, { recursive: true, force: true });
};

export const createProjectProtectionSnapshot = async (batchId: string, projectIds: string[]) => {
  const directory = path.join(PROJECT_RESTORE_ROOT, "protection", batchId);
  const snapshots = await extractProjectSnapshots(prisma, projectIds);
  await mkdir(path.join(directory, "documents"), { recursive: true });
  await mkdir(path.join(directory, "assistant"), { recursive: true });
  await writeFile(path.join(directory, "snapshot.json"), JSON.stringify({ createdAt: new Date().toISOString(), targetProjectIds: projectIds, snapshots }));
  for (const projectId of projectIds) {
    const source = getProjectDocumentDirectory(projectId);
    if (await stat(source).then((value) => value.isDirectory()).catch(() => false)) {
      await cp(source, path.join(directory, "documents", projectId), { recursive: true, force: true });
    }
    for (const kind of ["attachments", "outputs"] as const) {
      const source = path.join(ASSISTANT_ARTIFACT_STORAGE_ROOT, kind, projectId);
      if (await stat(source).then((value) => value.isDirectory()).catch(() => false)) {
        await cp(source, path.join(directory, "assistant", kind, projectId), { recursive: true, force: true });
      }
    }
  }
  return directory;
};

export const rollbackProjectRestore = async (batch: { protectionSnapshotDir: string; operatorName: string }) => {
  const payload = JSON.parse(await readFile(path.join(batch.protectionSnapshotDir, "snapshot.json"), "utf8")) as { targetProjectIds?: string[]; snapshots: ProjectDataSnapshot[] };
  const sourceAccounts = Array.from(new Set(payload.snapshots.flatMap((snapshot) => (
    snapshot.tables.find((table) => table.table === "ProjectMember")?.rows.map((row) => String(row.accountId ?? "")).filter(Boolean) ?? []
  )))).map((id) => ({ id, username: "", displayName: "" }));
  const existing = new Set((await prisma.userAccount.findMany({ where: { id: { in: sourceAccounts.map((account) => account.id) } }, select: { id: true } })).map((account) => account.id));
  const originalProjectIds = new Set(payload.snapshots.map((snapshot) => snapshot.projectId));
  const addedProjectIds = (payload.targetProjectIds ?? []).filter((projectId) => !originalProjectIds.has(projectId));
  if (addedProjectIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.assistantActionRun.deleteMany({ where: { projectId: { in: addedProjectIds } } });
      await tx.assistantChatMessage.deleteMany({ where: { projectId: { in: addedProjectIds } } });
      await tx.project.deleteMany({ where: { id: { in: addedProjectIds } } });
    });
  }
  await applyProjectSnapshots({
    snapshots: payload.snapshots,
    sourceAccounts,
    resolutions: sourceAccounts.filter((account) => !existing.has(account.id)).map((account) => ({ sourceAccountId: account.id, action: "UNASSIGNED" })),
    operatorName: batch.operatorName,
  });
  for (const snapshot of payload.snapshots) {
    const target = getProjectDocumentDirectory(snapshot.projectId);
    const source = path.join(batch.protectionSnapshotDir, "documents", snapshot.projectId);
    await rm(target, { recursive: true, force: true });
    if (await stat(source).then((value) => value.isDirectory()).catch(() => false)) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, force: true });
    }
    for (const kind of ["attachments", "outputs"] as const) {
      const assistantTarget = path.join(ASSISTANT_ARTIFACT_STORAGE_ROOT, kind, snapshot.projectId);
      const assistantSource = path.join(batch.protectionSnapshotDir, "assistant", kind, snapshot.projectId);
      await rm(assistantTarget, { recursive: true, force: true });
      if (await stat(assistantSource).then((value) => value.isDirectory()).catch(() => false)) {
        await mkdir(path.dirname(assistantTarget), { recursive: true });
        await cp(assistantSource, assistantTarget, { recursive: true, force: true });
      }
    }
  }
  for (const projectId of addedProjectIds) {
    await rm(getProjectDocumentDirectory(projectId), { recursive: true, force: true });
    await rm(path.join(ASSISTANT_ARTIFACT_STORAGE_ROOT, "attachments", projectId), { recursive: true, force: true });
    await rm(path.join(ASSISTANT_ARTIFACT_STORAGE_ROOT, "outputs", projectId), { recursive: true, force: true });
  }
  return payload.snapshots;
};

export const cleanupExpiredProjectRestoreFiles = async () => {
  const sessionRoot = path.join(PROJECT_RESTORE_ROOT, "sessions");
  const sessions = await readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of sessions) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(sessionRoot, entry.name);
    const session = await readFile(path.join(directory, "session.json"), "utf8").then((value) => JSON.parse(value) as RestoreSessionFile).catch(() => null);
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) await rm(directory, { recursive: true, force: true });
  }
  const expired = await prisma.projectRestoreBatch.findMany({ where: { expiresAt: { lt: new Date() }, status: { in: ["COMPLETED", "ROLLED_BACK", "FAILED"] } } });
  for (const batch of expired) {
    if (batch.protectionSnapshotDir) await rm(batch.protectionSnapshotDir, { recursive: true, force: true });
  }
  await prisma.projectRestoreBatch.updateMany({ where: { id: { in: expired.map((batch) => batch.id) } }, data: { protectionSnapshotDir: "", status: "EXPIRED" } });
};
