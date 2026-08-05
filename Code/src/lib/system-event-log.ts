import { prisma } from "@/lib/prisma";

export const SYSTEM_LOG_RETENTION_DAYS = 180;
export const SYSTEM_LOG_CAPACITY_BYTES = 5 * 1024 * 1024 * 1024;

const SECRET_KEY = /password|passwd|token|secret|api[-_]?key|authorization|cookie|content|document/i;

const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 5) return "[已省略]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 1000 ? `${value.slice(0, 1000)}...[已截断]` : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? "[已脱敏]" : redactValue(item, depth + 1),
  ]));
};

export const sanitizeSystemLogDetails = (details: unknown) => redactValue(details ?? {});

export const recordSystemEvent = async (input: {
  level?: "INFO" | "WARN" | "ERROR" | "SECURITY";
  category?: "BUSINESS" | "ADMIN" | "SYSTEM" | "ERROR";
  module: string;
  eventType: string;
  operatorId?: string;
  operatorName?: string;
  projectId?: string;
  projectName?: string;
  message: string;
  details?: unknown;
  traceId?: string;
}) => {
  const details = JSON.stringify(sanitizeSystemLogDetails(input.details));
  const sizeBytes = Buffer.byteLength([
    input.message,
    details,
    input.module,
    input.eventType,
    input.operatorName,
    input.projectName,
  ].filter(Boolean).join("\n"), "utf8");
  return prisma.systemEventLog.create({
    data: {
      level: input.level ?? "INFO",
      category: input.category ?? "SYSTEM",
      module: input.module,
      eventType: input.eventType,
      operatorId: input.operatorId ?? "",
      operatorName: input.operatorName ?? "",
      projectId: input.projectId ?? "",
      projectName: input.projectName ?? "",
      message: input.message,
      details,
      traceId: input.traceId ?? "",
      sizeBytes,
    },
  }).catch((error) => {
    console.error("[system-event-log] write failed", error);
    return null;
  });
};

export const cleanupSystemEventLogs = async (now = new Date()) => {
  const cutoff = new Date(now.getTime() - SYSTEM_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [expired, expiredOperations, expiredAudits] = await prisma.$transaction([
    prisma.systemEventLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.operationHistory.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.adminAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  let total = (await prisma.systemEventLog.aggregate({ _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;
  let capacityDeleted = 0;
  for (const level of ["INFO", "WARN", "ERROR", "SECURITY"]) {
    while (total > SYSTEM_LOG_CAPACITY_BYTES) {
      const batch = await prisma.systemEventLog.findMany({
        where: { level },
        orderBy: { createdAt: "asc" },
        take: 1000,
        select: { id: true, sizeBytes: true },
      });
      if (batch.length === 0) break;
      await prisma.systemEventLog.deleteMany({ where: { id: { in: batch.map((item) => item.id) } } });
      const removedBytes = batch.reduce((sum, item) => sum + item.sizeBytes, 0);
      total = Math.max(0, total - removedBytes);
      capacityDeleted += batch.length;
    }
  }
  if (expired.count > 0 || expiredOperations.count > 0 || expiredAudits.count > 0 || capacityDeleted > 0) {
    await recordSystemEvent({
      category: "SYSTEM",
      module: "system-data",
      eventType: "LOG_RETENTION_CLEANUP",
      message: `系统日志清理完成：系统事件 ${expired.count} 条、业务操作 ${expiredOperations.count} 条、管理员审计 ${expiredAudits.count} 条，容量清理 ${capacityDeleted} 条`,
      details: { retentionDays: SYSTEM_LOG_RETENTION_DAYS, capacityBytes: SYSTEM_LOG_CAPACITY_BYTES },
    });
  }
  return {
    expired: expired.count,
    expiredOperations: expiredOperations.count,
    expiredAudits: expiredAudits.count,
    capacityDeleted,
    remainingBytes: total,
  };
};
