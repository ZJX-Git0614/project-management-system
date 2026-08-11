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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:view"))) return err("权限不足", 403);

  const kind = req.nextUrl.searchParams.get("diagram")?.toUpperCase() as GanttNetworkDiagramKind | undefined;
  if (kind !== "AON" && kind !== "AOA") return err("diagram 参数必须为 AON 或 AOA");

  const project = await prisma.project.findUnique({
    where: { id },
    select: { name: true, code: true },
  });
  if (!project) return notFound("项目");

  const [tasks, dependencies] = await Promise.all([
    prisma.projectGanttTask.findMany({
      where: { projectId: id },
      select: { id: true, taskCode: true, taskName: true, parentId: true, sortOrder: true },
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
  const suffix = kind === "AON" ? "单代号网络图" : "双代号网络图";
  return buildGanttNetworkDiagramDownloadResponse(xml, `${baseName}-${suffix}.drawio`);
}
