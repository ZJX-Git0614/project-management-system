import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import {
  describeAssistantExportFilters,
  selectGanttExportRows,
  selectWeeklyExportRows,
  type AssistantProjectExportIntent,
} from "@/lib/assistant-export";
import { ITEM_STATUS_LABEL } from "@/lib/constants";
import { itemStatusFromProgress } from "@/lib/item-progress";

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const toCsv = (headers: string[], rows: unknown[][]) => `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
const plannedEnd = (startDate: string, durationDays: number) => {
  const date = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + Math.max(0, durationDays - 1));
  return date.toISOString().slice(0, 10);
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
  const { actionId } = await params;
  const action = await prisma.assistantActionRun.findFirst({
    where: { id: actionId, userId: user.userId, toolId: { in: ["project.export", "schedule.analysis.export"] }, status: "SUCCEEDED" },
  });
  if (!action) return NextResponse.json({ success: false, error: "导出记录不存在" }, { status: 404 });
  const args = JSON.parse(action.argsJson || "{}") as Partial<AssistantProjectExportIntent> & { analysisRunId?: string };
  const project = await prisma.project.findUnique({ where: { id: action.projectId }, select: { code: true, name: true } });
  if (!project) return NextResponse.json({ success: false, error: "项目不存在" }, { status: 404 });

  let fileLabel = "项目数据";
  let csv = "";
  if (action.toolId === "schedule.analysis.export") {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { id: args.analysisRunId, projectId: action.projectId } });
    if (!run) return NextResponse.json({ success: false, error: "计划分析记录不存在" }, { status: 404 });
    const analysis = JSON.parse(run.resultJson || "{}") as {
      issues?: Array<{ ruleId?: string; severity?: string; taskCodes?: string[]; message?: string; facts?: Record<string, unknown>; expected?: Record<string, unknown>; impactTaskIds?: string[]; suggestion?: string }>;
      changes?: Array<{ taskCode?: string; taskName?: string; field?: string; before?: unknown; after?: unknown }>;
    };
    fileLabel = "计划差异与冲突";
    const issueRows = (analysis.issues ?? []).map((item) => [
      "冲突", item.ruleId, item.severity, item.taskCodes?.join(" / "), item.message,
      JSON.stringify(item.facts ?? {}), JSON.stringify(item.expected ?? {}), item.impactTaskIds?.join(" / "), item.suggestion,
    ]);
    const changeRows = (analysis.changes ?? []).map((item) => [
      "差异", "FIELD_CHANGE", "INFO", item.taskCode, `${item.taskName || ""} · ${item.field || ""}`,
      JSON.stringify(item.before ?? null), JSON.stringify(item.after ?? null), "", "请核对后决定是否合并",
    ]);
    csv = toCsv(["类型", "规则/字段", "级别", "任务", "说明", "事实/原值", "期望/新值", "影响任务", "建议"], [...issueRows, ...changeRows]);
  } else if (args.exportType === "gantt") {
    const allRows = await prisma.projectGanttTask.findMany({ where: { projectId: action.projectId } });
    const rows = selectGanttExportRows(allRows, args);
    fileLabel = "任务进度";
    csv = toCsv(["任务ID", "任务类别", "任务名称", "计划开始", "计划完成", "实际开始", "实际完成", "进度"], rows.map((item) => [item.taskCode, item.taskCategory, item.taskName, item.startDate, item.finishDate || plannedEnd(item.startDate, item.durationDays), item.actualStartDate, item.actualEndDate, `${item.progress}%`]));
  } else if (args.exportType === "weekly") {
    const allRows = await prisma.weeklyItem.findMany({ where: { projectId: action.projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const rows = selectWeeklyExportRows(allRows, args);
    fileLabel = "项目事项";
    csv = toCsv(["事项ID", "事项名称", "责任人", "优先级", "状态", "进度"], rows.map((item) => [item.matterCode, item.title, item.owner, item.priority, ITEM_STATUS_LABEL[itemStatusFromProgress(item.progress)], `${item.progress}%`]));
  } else if (args.exportType === "risk") {
    const rows = await prisma.riskRegisterItem.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" } });
    fileLabel = "风险登记册";
    csv = toCsv(["风险", "类别", "概率", "影响", "等级", "措施", "责任人", "状态"], rows.map((item) => [item.riskName, item.category, item.probability, item.impact, item.level, item.response, item.owner, item.status]));
  } else {
    const rows = await prisma.projectBudgetItem.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" }, include: { category: true } });
    fileLabel = "项目预算";
    csv = toCsv(["分类", "预算项", "人员", "数量", "单价", "金额", "备注"], rows.map((item) => [item.category?.name, item.title, item.person, item.sampleQuantity + item.productionQuantity, item.unitPrice, item.amount, item.remark]));
  }
  const filterLabels = action.toolId === "project.export" && args.exportType
    ? describeAssistantExportFilters(args as AssistantProjectExportIntent)
    : [];
  const fileName = `${project.code || project.name}-${fileLabel}${filterLabels.length > 0 ? `-${filterLabels.join("-")}` : ""}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  });
}
