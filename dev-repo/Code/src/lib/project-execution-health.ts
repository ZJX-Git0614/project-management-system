import type { ProjectExecutionScope, ProjectExecutionScopeTask } from "@/lib/project-execution";

export const EXECUTION_HEALTH_STATUSES = ["HEALTHY", "AT_RISK", "OFF_TRACK", "UNKNOWN"] as const;
export type ProjectExecutionHealthStatus = (typeof EXECUTION_HEALTH_STATUSES)[number];

export type ProjectExecutionHealthEvidence = {
  code: string;
  severity: "HIGH" | "MEDIUM";
  message: string;
  count: number;
};

export type ProjectExecutionHealthInput = {
  scope: ProjectExecutionScope;
  today?: string;
  openHighRiskCount?: number;
  openMatterCount?: number;
  overdueMatterCount?: number;
  blockedMatterCount?: number;
};

const dateAtMidnight = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
};

const isAbsoluteDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const isCritical = (task: ProjectExecutionScopeTask) => (
  task.scheduleStatus === "CRITICAL" || task.scheduleStatus === "NEGATIVE_FLOAT" || (task.totalFloatMinutes ?? Number.POSITIVE_INFINITY) <= 0
);

export const evaluateProjectExecutionHealth = (input: ProjectExecutionHealthInput) => {
  const today = input.today ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const todayTime = dateAtMidnight(today);
  const tasks = input.scope.effectiveTasks;
  const evidence: ProjectExecutionHealthEvidence[] = [];

  if (tasks.length === 0) {
    return {
      status: "UNKNOWN" as const,
      label: "待定义范围",
      evidence: [{ code: "EMPTY_SCOPE", severity: "MEDIUM" as const, message: "阶段尚未关联有效的 WBS 末级任务", count: 0 }],
    };
  }

  const invalidTasks = tasks.filter((task) => ["INVALID_DEPENDENCY", "NEGATIVE_FLOAT"].includes(task.scheduleStatus));
  if (invalidTasks.length > 0) {
    evidence.push({ code: "INVALID_SCHEDULE", severity: "HIGH", message: `${invalidTasks.length} 项任务存在无效依赖或负浮动`, count: invalidTasks.length });
  }

  const overdueTasks = todayTime === null ? [] : tasks.filter((task) => {
    const finish = dateAtMidnight(task.finishDate);
    return task.progress < 100 && finish !== null && finish < todayTime;
  });
  if (overdueTasks.length > 0) {
    evidence.push({ code: "OVERDUE_TASK", severity: "HIGH", message: `${overdueTasks.length} 项末级任务已逾期未完成`, count: overdueTasks.length });
  }

  const overdueCriticalTasks = overdueTasks.filter(isCritical);
  if (overdueCriticalTasks.length > 0) {
    evidence.push({ code: "OVERDUE_CRITICAL", severity: "HIGH", message: `${overdueCriticalTasks.length} 项关键任务已逾期`, count: overdueCriticalTasks.length });
  }

  const incompleteCriticalTasks = tasks.filter((task) => task.progress < 100 && isCritical(task));
  if (incompleteCriticalTasks.length > 0) {
    evidence.push({ code: "INCOMPLETE_CRITICAL", severity: "MEDIUM", message: `${incompleteCriticalTasks.length} 项关键任务尚未完成`, count: incompleteCriticalTasks.length });
  }

  const nearCriticalTasks = tasks.filter((task) => task.progress < 100 && task.scheduleStatus === "NEAR_CRITICAL");
  if (nearCriticalTasks.length > 0) {
    evidence.push({ code: "NEAR_CRITICAL", severity: "MEDIUM", message: `${nearCriticalTasks.length} 项任务接近关键路径`, count: nearCriticalTasks.length });
  }

  if ((input.openHighRiskCount ?? 0) > 0) {
    evidence.push({ code: "OPEN_HIGH_RISK", severity: "MEDIUM", message: `${input.openHighRiskCount} 项高风险尚未关闭`, count: input.openHighRiskCount ?? 0 });
  }
  if ((input.overdueMatterCount ?? 0) > 0) {
    evidence.push({ code: "OVERDUE_MATTER", severity: "MEDIUM", message: `${input.overdueMatterCount} 项关联事项逾期`, count: input.overdueMatterCount ?? 0 });
  }
  if ((input.blockedMatterCount ?? 0) > 0) {
    evidence.push({ code: "BLOCKED_MATTER", severity: "MEDIUM", message: `${input.blockedMatterCount} 项关联事项处于阻塞状态`, count: input.blockedMatterCount ?? 0 });
  }

  const hasAbsoluteAnchor = tasks.some((task) => isAbsoluteDate(task.startDate) || isAbsoluteDate(task.finishDate));
  if (!hasAbsoluteAnchor && evidence.length === 0) {
    return {
      status: "UNKNOWN" as const,
      label: "待排期锚定",
      evidence: [{ code: "RELATIVE_SCHEDULE", severity: "MEDIUM" as const, message: "阶段仅包含相对 T0 排期，暂无法判断日历偏差", count: tasks.length }],
    };
  }

  const status: ProjectExecutionHealthStatus = evidence.some((item) => item.severity === "HIGH")
    ? "OFF_TRACK"
    : evidence.length > 0
      ? "AT_RISK"
      : "HEALTHY";
  return {
    status,
    label: status === "HEALTHY" ? "健康" : status === "AT_RISK" ? "需关注" : "已偏离",
    evidence: evidence.slice(0, 6),
    summary: {
      taskCount: tasks.length,
      completedTaskCount: input.scope.completedTaskCount,
      openMatterCount: input.openMatterCount ?? 0,
      openHighRiskCount: input.openHighRiskCount ?? 0,
    },
  };
};
