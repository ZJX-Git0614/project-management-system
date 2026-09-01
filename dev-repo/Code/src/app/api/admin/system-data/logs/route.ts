import * as XLSX from "@e965/xlsx";
import { NextRequest } from "next/server";

import { requireSuperAdmin } from "@/lib/admin-auth";
import { err, ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { createStoreZip } from "@/lib/simple-zip";
import { recordSystemEvent, SYSTEM_LOG_CAPACITY_BYTES, SYSTEM_LOG_RETENTION_DAYS } from "@/lib/system-event-log";

type UnifiedLog = {
  id: string;
  createdAt: string;
  level: string;
  category: string;
  module: string;
  eventType: string;
  operator: string;
  projectId: string;
  projectName: string;
  message: string;
  details: string;
  traceId: string;
};

const parseDate = (value: string | null, endOfDay = false) => {
  if (!value) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const includesKeyword = (item: UnifiedLog, keyword: string) => !keyword || [
  item.operator,
  item.projectName,
  item.projectId,
  item.message,
  item.eventType,
  item.module,
].some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));

const loadLogs = async (req: NextRequest) => {
  const start = parseDate(req.nextUrl.searchParams.get("start"));
  const end = parseDate(req.nextUrl.searchParams.get("end"), true);
  const level = req.nextUrl.searchParams.get("level")?.trim() || "";
  const category = req.nextUrl.searchParams.get("category")?.trim() || "";
  const moduleName = req.nextUrl.searchParams.get("module")?.trim() || "";
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() || "";
  const operator = req.nextUrl.searchParams.get("operator")?.trim() || "";
  const keyword = (req.nextUrl.searchParams.get("keyword")?.trim() || "").toLocaleLowerCase("zh-CN");
  const createdAt = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } : undefined;
  const commonLimit = 100_000;

  const [system, operations, audits] = await Promise.all([
    prisma.systemEventLog.findMany({
      where: {
        ...(createdAt ? { createdAt } : {}),
        ...(level ? { level } : {}),
        ...(category ? { category } : {}),
        ...(moduleName ? { module: moduleName } : {}),
        ...(projectId ? { projectId } : {}),
        ...(operator ? { operatorName: { contains: operator, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: commonLimit,
    }),
    category && category !== "BUSINESS" ? Promise.resolve([]) : prisma.operationHistory.findMany({
      where: {
        ...(createdAt ? { createdAt } : {}),
        ...(projectId ? { projectId } : {}),
        ...(operator ? { operator: { contains: operator, mode: "insensitive" } } : {}),
        ...(moduleName ? { entityType: moduleName } : {}),
      },
      include: { project: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: commonLimit,
    }),
    category && category !== "ADMIN" ? Promise.resolve([]) : prisma.adminAuditLog.findMany({
      where: {
        ...(createdAt ? { createdAt } : {}),
        ...(projectId ? { projectId } : {}),
        ...(operator ? { operator: { contains: operator, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: commonLimit,
    }),
  ]);

  const unified: UnifiedLog[] = [
    ...system.map((item) => ({
      id: item.id,
      createdAt: item.createdAt.toISOString(),
      level: item.level,
      category: item.category,
      module: item.module,
      eventType: item.eventType,
      operator: item.operatorName,
      projectId: item.projectId,
      projectName: item.projectName,
      message: item.message,
      details: item.details,
      traceId: item.traceId,
    })),
    ...operations.map((item) => ({
      id: item.id,
      createdAt: item.createdAt.toISOString(),
      level: "INFO",
      category: "BUSINESS",
      module: item.entityType,
      eventType: item.actionType,
      operator: item.operator,
      projectId: item.projectId,
      projectName: item.project.name,
      message: item.detail,
      details: JSON.stringify({ entityId: item.entityId }),
      traceId: "",
    })),
    ...audits.map((item) => ({
      id: item.id,
      createdAt: item.createdAt.toISOString(),
      level: "SECURITY",
      category: "ADMIN",
      module: "admin",
      eventType: item.actionType,
      operator: item.operator,
      projectId: item.projectId,
      projectName: item.projectName,
      message: item.detail,
      details: item.snapshot,
      traceId: "",
    })),
  ];

  return unified
    .filter((item) => (!level || item.level === level) && (!moduleName || item.module === moduleName))
    .filter((item) => includesKeyword(item, keyword))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

const buildWorkbook = (logs: UnifiedLog[]) => {
  const rows = logs.map((item) => ({
    时间: item.createdAt,
    级别: item.level,
    类别: item.category,
    模块: item.module,
    事件: item.eventType,
    操作人: item.operator,
    项目ID: item.projectId,
    项目名称: item.projectName,
    摘要: item.message,
    追踪ID: item.traceId,
    详情: item.details,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [20, 10, 12, 20, 24, 16, 24, 24, 50, 24, 60].map((wch) => ({ wch }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "系统日志");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
};

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("response" in auth) return auth.response;
  try {
    const logs = await loadLogs(req);
    if (req.nextUrl.searchParams.get("export") !== "zip") {
      const sizeBytes = (await prisma.systemEventLog.aggregate({ _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
      return ok({
        logs: logs.slice(0, 200),
        total: logs.length,
        retentionDays: SYSTEM_LOG_RETENTION_DAYS,
        capacityBytes: SYSTEM_LOG_CAPACITY_BYTES,
        sizeBytes,
      });
    }

    const exportedAt = new Date();
    const jsonl = logs.map((item) => JSON.stringify(item)).join("\n");
    const notes = [
      "Ceastar PMS 系统日志导出",
      `导出时间：${exportedAt.toISOString()}`,
      `导出操作人：${auth.user.displayName}`,
      `记录数量：${logs.length}`,
      `固定保留期：${SYSTEM_LOG_RETENTION_DAYS} 天`,
      "日志已排除密码、令牌、密钥、完整文档内容及未脱敏请求正文。",
      "ZIP 内包含便于人工查看的 XLSX 和便于机器分析的 JSONL。",
    ].join("\r\n");
    const archive = createStoreZip([
      { name: "系统日志.xlsx", data: buildWorkbook(logs) },
      { name: "系统日志.jsonl", data: jsonl },
      { name: "导出说明.txt", data: notes },
    ]);
    await recordSystemEvent({
      category: "ADMIN",
      module: "system-data",
      eventType: "EXPORT_SYSTEM_LOGS",
      operatorId: auth.user.userId,
      operatorName: auth.user.displayName,
      message: `导出系统日志 ${logs.length} 条`,
      details: Object.fromEntries(req.nextUrl.searchParams.entries()),
    });
    const stamp = exportedAt.toISOString().replace(/[-:]/g, "").slice(0, 15);
    return new Response(new Uint8Array(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`Ceastar-PMS-系统日志-${stamp}.zip`)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : "读取系统日志失败", 500);
  }
}
