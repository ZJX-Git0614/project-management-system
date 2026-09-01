import { prisma } from "@/lib/prisma";
import {
  describeAssistantExportFilters,
  selectGanttExportRows,
  selectWeeklyExportRows,
  type AssistantProjectExportIntent,
} from "@/lib/assistant-export";
import { ganttTaskDepthById } from "@/lib/gantt-task-service";

export type AssistantExportDataObservation = {
  exportType: AssistantProjectExportIntent["exportType"];
  totalRows: number;
  matchedRows: number;
  appliedFilters: string[];
  taskCategories?: Array<{ name: string; count: number }>;
  taskDepths?: Array<{ depth: number; count: number }>;
  taskProgress?: { notStarted: number; inProgress: number; completed: number };
};

export const observeAssistantProjectExportData = async (
  projectId: string,
  intent: AssistantProjectExportIntent,
): Promise<AssistantExportDataObservation> => {
  if (intent.exportType === "gantt") {
    const rows = await prisma.projectGanttTask.findMany({
      where: { projectId },
      select: {
        id: true,
        parentId: true,
        taskCode: true,
        taskCategory: true,
        taskName: true,
        sortOrder: true,
        createdAt: true,
        progress: true,
      },
    });
    const categoryMap = new Map<string, number>();
    rows.forEach((row) => {
      const category = row.taskCategory.trim() || "未分类";
      categoryMap.set(category, (categoryMap.get(category) ?? 0) + 1);
    });
    const depthMap = new Map<number, number>();
    ganttTaskDepthById(rows).forEach((depth) => depthMap.set(depth, (depthMap.get(depth) ?? 0) + 1));
    return {
      exportType: "gantt",
      totalRows: rows.length,
      matchedRows: selectGanttExportRows(rows, intent).length,
      appliedFilters: describeAssistantExportFilters(intent),
      taskCategories: Array.from(categoryMap, ([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"))
        .slice(0, 80),
      taskDepths: Array.from(depthMap, ([depth, count]) => ({ depth, count })).sort((a, b) => a.depth - b.depth),
      taskProgress: {
        notStarted: rows.filter((row) => row.progress <= 0).length,
        inProgress: rows.filter((row) => row.progress > 0 && row.progress < 100).length,
        completed: rows.filter((row) => row.progress >= 100).length,
      },
    };
  }
  if (intent.exportType === "weekly") {
    const rows = await prisma.weeklyItem.findMany({
      where: { projectId },
      select: { priority: true, progress: true },
    });
    return {
      exportType: "weekly",
      totalRows: rows.length,
      matchedRows: selectWeeklyExportRows(rows, intent).length,
      appliedFilters: describeAssistantExportFilters(intent),
    };
  }
  const totalRows = intent.exportType === "risk"
    ? await prisma.riskRegisterItem.count({ where: { projectId } })
    : intent.exportType === "budget"
      ? await prisma.projectBudgetItem.count({ where: { projectId } })
      : 0;
  return {
    exportType: intent.exportType,
    totalRows,
    matchedRows: totalRows,
    appliedFilters: describeAssistantExportFilters(intent),
  };
};

export const formatAssistantExportDataObservation = (observation: AssistantExportDataObservation) => JSON.stringify({
  exportType: observation.exportType,
  totalRows: observation.totalRows,
  matchedRows: observation.matchedRows,
  appliedFilters: observation.appliedFilters,
  taskCategories: observation.taskCategories,
  taskDepths: observation.taskDepths,
  taskProgress: observation.taskProgress,
});
