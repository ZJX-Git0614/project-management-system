import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";

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
  const action = await prisma.assistantActionRun.findFirst({ where: { id: actionId, userId: user.userId, toolId: "project.export", status: "SUCCEEDED" } });
  if (!action) return NextResponse.json({ success: false, error: "导出记录不存在" }, { status: 404 });
  const args = JSON.parse(action.argsJson || "{}") as { exportType?: string };
  const project = await prisma.project.findUnique({ where: { id: action.projectId }, select: { code: true, name: true } });
  if (!project) return NextResponse.json({ success: false, error: "项目不存在" }, { status: 404 });

  let fileLabel = "项目数据";
  let csv = "";
  if (args.exportType === "gantt") {
    const rows = await prisma.projectGanttTask.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" } });
    fileLabel = "任务进度";
    csv = toCsv(["任务ID", "任务类别", "任务名称", "计划开始", "计划完成", "实际开始", "实际完成", "进度"], rows.map((item) => [item.taskCode, item.taskCategory, item.taskName, item.startDate, plannedEnd(item.startDate, item.durationDays), item.actualStartDate, item.actualEndDate, `${item.progress}%`]));
  } else if (args.exportType === "weekly") {
    const rows = await prisma.weeklyItem.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" } });
    fileLabel = "本周事项";
    csv = toCsv(["事项ID", "事项名称", "责任人", "优先级", "状态", "进度"], rows.map((item) => [item.matterCode, item.title, item.owner, item.priority, item.status, `${item.progress}%`]));
  } else if (args.exportType === "risk") {
    const rows = await prisma.riskRegisterItem.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" } });
    fileLabel = "风险登记册";
    csv = toCsv(["风险", "类别", "概率", "影响", "等级", "措施", "责任人", "状态"], rows.map((item) => [item.riskName, item.category, item.probability, item.impact, item.level, item.response, item.owner, item.status]));
  } else {
    const rows = await prisma.projectBudgetItem.findMany({ where: { projectId: action.projectId }, orderBy: { sortOrder: "asc" }, include: { category: true } });
    fileLabel = "项目预算";
    csv = toCsv(["分类", "预算项", "人员", "数量", "单价", "金额", "备注"], rows.map((item) => [item.category?.name, item.title, item.person, item.sampleQuantity + item.productionQuantity, item.unitPrice, item.amount, item.remark]));
  }
  const fileName = `${project.code || project.name}-${fileLabel}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    },
  });
}
