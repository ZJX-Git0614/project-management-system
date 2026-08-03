import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";

import { err, notFound, ok } from "@/lib/api-utils";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import {
  buildGanttExcel,
  buildGanttExcelTemplate,
  buildProjectXml,
  convertProjectXmlToMpp,
  ganttTransferCapabilities,
} from "@/lib/gantt-file-transfer";
import { getOrderedGanttTasks, serializeGanttTask } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";

const safeFileName = (value: string) => value.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || "project";

const downloadResponse = (content: Buffer, fileName: string, contentType: string) => new Response(new Uint8Array(content), {
  headers: {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "no-store",
  },
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:view"))) return err("权限不足", 403);

  const format = req.nextUrl.searchParams.get("format")?.toLowerCase();
  if (!format) return ok(await ganttTransferCapabilities());

  const project = await prisma.project.findUnique({ where: { id }, select: { name: true, code: true } });
  if (!project) return notFound("项目");
  const tasks = (await getOrderedGanttTasks(id)).map(serializeGanttTask);
  const scheduleMetadata = await prisma.projectScheduleImportMetadata.findUnique({ where: { projectId: id } });
  const baseName = safeFileName(project.code || project.name);

  if (format === "template") {
    return downloadResponse(
      buildGanttExcelTemplate(),
      "Ceastar-PMS-项目进度导入模板.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }

  if (format === "xlsx") {
    return downloadResponse(
      buildGanttExcel(tasks),
      `${baseName}-项目进度.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  }

  const projectXml = buildProjectXml(project.name, tasks, scheduleMetadata ? {
    projectSettings: scheduleMetadata.projectSettings as Prisma.JsonObject,
    calendars: scheduleMetadata.calendars as Prisma.JsonObject,
    resources: scheduleMetadata.resources as Prisma.JsonObject,
    assignments: scheduleMetadata.assignments as Prisma.JsonObject,
    taskUidMap: scheduleMetadata.taskUidMap as Record<string, string>,
  } : null);
  if (format === "xml") {
    return downloadResponse(projectXml, `${baseName}-项目进度.xml`, "application/xml; charset=utf-8");
  }
  if (format === "mpp") {
    try {
      const mpp = await convertProjectXmlToMpp(projectXml);
      return downloadResponse(mpp, `${baseName}-项目进度.mpp`, "application/vnd.ms-project");
    } catch (error) {
      return err(error instanceof Error ? error.message : "MPP 导出失败", 501);
    }
  }

  return err("不支持的导出格式");
}
