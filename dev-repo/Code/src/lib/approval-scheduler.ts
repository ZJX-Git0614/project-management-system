import { TodoType } from "@/domain/enums";
import { runApprovalEffects } from "@/lib/approval-workflow-server";
import { prisma } from "@/lib/prisma";
import { recordSystemEvent } from "@/lib/system-event-log";

const globalScheduler = globalThis as typeof globalThis & {
  ceastarApprovalSchedulerStarted?: boolean;
};

export const runApprovalReminders = async (now = new Date()) => {
  const candidates = await prisma.todoItem.findMany({
    where: {
      type: TodoType.APPROVAL_PENDING,
      status: "OPEN",
      targetAccountId: { not: null },
      dueAt: { lte: now },
    },
    select: {
      id: true,
      projectId: true,
      approvalInstanceId: true,
      targetAccountId: true,
      title: true,
      detail: true,
      lastRemindedAt: true,
      reminderIntervalHours: true,
    },
    orderBy: { dueAt: "asc" },
    take: 200,
  });

  let reminded = 0;
  for (const todo of candidates) {
    const intervalMs = Math.max(1, todo.reminderIntervalHours) * 60 * 60 * 1000;
    const reminderThreshold = new Date(now.getTime() - intervalMs);
    if (todo.lastRemindedAt && todo.lastRemindedAt > reminderThreshold) continue;
    const claimed = await prisma.todoItem.updateMany({
      where: {
        id: todo.id,
        status: "OPEN",
        dueAt: { lte: now },
        OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lte: reminderThreshold } }],
      },
      data: { lastRemindedAt: now, reminderCount: { increment: 1 } },
    });
    if (claimed.count !== 1 || !todo.targetAccountId) continue;
    await prisma.systemNotification.create({
      data: {
        projectId: todo.projectId,
        accountId: todo.targetAccountId,
        category: "审批催办",
        title: `待处理：${todo.title}`,
        detail: todo.detail,
        severity: "WARNING",
        sourceType: "APPROVAL_INSTANCE",
        sourceId: todo.approvalInstanceId || todo.id,
      },
    });
    reminded += 1;
  }
  return reminded;
};

const checkAndRun = async () => {
  try {
    await runApprovalEffects();
    await runApprovalReminders();
  } catch (error) {
    console.error("[approval] scheduled check failed", error);
    await recordSystemEvent({
      level: "ERROR",
      category: "ERROR",
      module: "approval",
      eventType: "APPROVAL_SCHEDULER_FAILED",
      message: error instanceof Error ? error.message : "审批催办或业务结果重试失败",
    });
  }
};

export const startApprovalScheduler = () => {
  if (globalScheduler.ceastarApprovalSchedulerStarted) return;
  globalScheduler.ceastarApprovalSchedulerStarted = true;
  const initialTimer = setTimeout(() => void checkAndRun(), 45_000);
  const interval = setInterval(() => void checkAndRun(), 5 * 60 * 1000);
  initialTimer.unref();
  interval.unref();
};
