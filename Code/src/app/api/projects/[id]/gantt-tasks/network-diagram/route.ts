import { NextRequest } from "next/server";

import { err, notFound } from "@/lib/api-utils";
import {
  buildGanttNetworkDiagramDownloadResponse,
  buildGanttNetworkDiagramXml,
  type GanttNetworkDiagramKind,
} from "@/lib/gantt-network-diagram";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

const safeFileName = (value: string) => value.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || "project";

const diagramKindLabels: Record<GanttNetworkDiagramKind, string> = {
  AON: "单代号网络图",
  AOA: "双代号网络图",
  CRITICAL_PATH: "关键路径网络图",
  MILESTONE_TIMELINE: "里程碑时间线",
  TIME_SCALED_NETWORK: "时标网络图",
};

const isGanttNetworkDiagramKind = (value: string): value is GanttNetworkDiagramKind => (
  value === "AON"
  || value === "AOA"
  || value === "CRITICAL_PATH"
  || value === "MILESTONE_TIMELINE"
  || value === "TIME_SCALED_NETWORK"
);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:view"))) return err("权限不足", 403);

  const requestedKind = req.nextUrl.searchParams.get("diagram")?.toUpperCase() ?? "";
  if (!isGanttNetworkDiagramKind(requestedKind)) {
    return err("diagram 参数必须为 AON、AOA、CRITICAL_PATH、MILESTONE_TIMELINE 或 TIME_SCALED_NETWORK");
  }
  const kind = requestedKind;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { name: true, code: true },
  });
  if (!project) return notFound("项目");

  const [tasks, dependencies] = await Promise.all([
    prisma.projectGanttTask.findMany({
      where: { projectId: id },
      select: {
        id: true,
        taskCode: true,
        taskName: true,
        parentId: true,
        sortOrder: true,
        startDate: true,
        finishDate: true,
        durationDays: true,
        isMilestone: true,
        scheduleStatus: true,
        earlyStartDate: true,
        earlyFinishDate: true,
        lateStartDate: true,
        lateFinishDate: true,
        totalFloatMinutes: true,
        freeFloatMinutes: true,
      },
      orderBy: [{ sortOrder: "asc" }, { taskCode: "asc" }, { id: "asc" }],
    }),
    prisma.projectGanttDependency.findMany({
      where: { projectId: id },
      select: { id: true, predecessorTaskId: true, successorTaskId: true, type: true, lag: true, lagFormat: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const xml = buildGanttNetworkDiagramXml({ projectName: project.name || project.code, kind, tasks, dependencies });
  const baseName = safeFileName(project.code || project.name);
  return buildGanttNetworkDiagramDownloadResponse(xml, `${baseName}-${diagramKindLabels[kind]}.drawio`);
}
