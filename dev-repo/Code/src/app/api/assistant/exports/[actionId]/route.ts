import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import {
  describeAssistantExportFilters,
  normalizeAssistantProjectExportIntent,
  selectGanttExportRows,
  selectWeeklyExportRows,
  type AssistantProjectExportIntent,
} from "@/lib/assistant-export";
import { buildGanttExcel, type GanttExcelProgressReport } from "@/lib/gantt-file-transfer";
import { getOrderedGanttTasks, serializeGanttTask } from "@/lib/gantt-task-service";
import {
  buildAssistantBudgetWorkbook,
  buildAssistantRiskWorkbook,
  buildAssistantScheduleAnalysisWorkbook,
  buildAssistantWeeklyWorkbook,
} from "@/lib/assistant-project-export-workbook";
import {
  ITEM_HEALTH_LABEL,
  ITEM_PRIORITY_LABEL,
  ITEM_RISK_STATUS_LABEL,
  ITEM_STATUS_LABEL,
} from "@/lib/constants";
import { itemStatusFromProgress } from "@/lib/item-progress";
import type { ProjectGanttTask } from "@/domain/models";

const displayLabel = (labels: Readonly<Record<string, string>>, value: string) => labels[value] ?? value;

const workbookResponse = (workbook: Buffer, fileName: string) => new NextResponse(new Uint8Array(workbook), {
  headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  },
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ actionId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
  const { actionId } = await params;
  const action = await prisma.assistantActionRun.findFirst({
    where: { id: actionId, userId: user.userId, toolId: { in: ["project.export", "schedule.analysis.export"] }, status: "SUCCEEDED" },
  });
  if (!action) return NextResponse.json({ success: false, error: "导出记录不存在" }, { status: 404 });
  const args = JSON.parse(action.argsJson || "{}") as Partial<AssistantProjectExportIntent> & { analysisRunId?: string };
  const project = await prisma.project.findUnique({
    where: { id: action.projectId },
    select: { code: true, name: true, amountWan: true },
  });
  if (!project) return NextResponse.json({ success: false, error: "项目不存在" }, { status: 404 });

  if (action.toolId === "schedule.analysis.export") {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { id: args.analysisRunId, projectId: action.projectId } });
    if (!run) return NextResponse.json({ success: false, error: "计划分析记录不存在" }, { status: 404 });
    const analysis = JSON.parse(run.resultJson || "{}") as {
      issues?: Array<{ ruleId?: string; severity?: string; taskCodes?: string[]; message?: string; facts?: Record<string, unknown>; expected?: Record<string, unknown>; impactTaskIds?: string[]; suggestion?: string }>;
      changes?: Array<{ taskCode?: string; taskName?: string; field?: string; before?: unknown; after?: unknown }>;
    };
    return workbookResponse(buildAssistantScheduleAnalysisWorkbook({
      projectCode: project.code,
      projectName: project.name,
      issues: analysis.issues ?? [],
      changes: analysis.changes ?? [],
    }), `${project.code || project.name}-计划差异与冲突分析.xlsx`);
  }

  if (args.exportType === "gantt") {
    const exportIntent = normalizeAssistantProjectExportIntent(args);
    if (!exportIntent || exportIntent.exportType !== "gantt") {
      return NextResponse.json({ success: false, error: "甘特导出条件不合法" }, { status: 400 });
    }
    const orderedRows = await getOrderedGanttTasks(action.projectId);
    const serializedRows = orderedRows.map((task) => ({
      ...serializeGanttTask(task),
      parentId: task.parentId ?? null,
    })) as Array<ProjectGanttTask & { parentId: string | null }>;
    const rows = selectGanttExportRows(serializedRows, exportIntent);
    const actionResult = JSON.parse(action.resultJson || "{}") as {
      progressReport?: GanttExcelProgressReport;
    };
    const workbook = buildGanttExcel(rows, {
      report: exportIntent.includeProgressReport ? actionResult.progressReport : undefined,
      reportFilters: describeAssistantExportFilters(exportIntent),
    });
    const filterLabels = describeAssistantExportFilters(exportIntent);
    const suffix = filterLabels.length > 0 ? `-${filterLabels.join("-")}` : "";
    return workbookResponse(workbook, `${project.code || project.name}-任务进度${suffix}.xlsx`);
  }

  if (args.exportType === "weekly") {
    const allRows = await prisma.weeklyItem.findMany({ where: { projectId: action.projectId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const rows = selectWeeklyExportRows(allRows, args);
    const workbook = buildAssistantWeeklyWorkbook({
      projectCode: project.code,
      projectName: project.name,
      rows: rows.map((item) => ({
        ...item,
        priority: displayLabel(ITEM_PRIORITY_LABEL, item.priority),
        status: ITEM_STATUS_LABEL[itemStatusFromProgress(item.progress)],
        health: displayLabel(ITEM_HEALTH_LABEL, item.health),
        riskStatus: displayLabel(ITEM_RISK_STATUS_LABEL, item.riskStatus),
      })),
    });
    const filterLabels = describeAssistantExportFilters(args as AssistantProjectExportIntent);
    const suffix = filterLabels.length > 0 ? `-${filterLabels.join("-")}` : "";
    return workbookResponse(workbook, `${project.code || project.name}-项目事项${suffix}.xlsx`);
  }

  if (args.exportType === "risk") {
    const rows = await prisma.riskRegisterItem.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" } });
    return workbookResponse(buildAssistantRiskWorkbook({
      projectCode: project.code,
      projectName: project.name,
      rows,
    }), `${project.code || project.name}-风险登记册.xlsx`);
  }

  const [setting, categories] = await Promise.all([
    prisma.projectBudgetSetting.findUnique({ where: { projectId: action.projectId } }),
    prisma.projectBudgetCategory.findMany({
      where: { projectId: action.projectId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    }),
  ]);
  const workbook = buildAssistantBudgetWorkbook({
    projectCode: project.code,
    projectName: project.name,
    contractAmount: setting?.contractAmount ?? project.amountWan * 10_000,
    profitTargetRate: setting?.profitTargetRate ?? 0,
    categories,
  });
  return workbookResponse(workbook, `${project.code || project.name}-项目预算分析.xlsx`);
}
