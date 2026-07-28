import { NextRequest } from "next/server";

import { hasAssistantProjectAccess } from "@/lib/assistant-project-access";
import { err, ok } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/server-auth";

const parseResult = (value: string) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return { summary: {}, changes: [], issues: [], invalid: true };
  }
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if ("status" in user) return user;
  const { id } = await params;
  if (!(await hasAssistantProjectAccess(user, id))) return err("无权访问当前项目", 403);
  const runId = req.nextUrl.searchParams.get("runId")?.trim();
  if (runId) {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { id: runId, projectId: id } });
    if (!run) return err("计划分析记录不存在", 404);
    return ok({ ...run, result: parseResult(run.resultJson), resultJson: undefined });
  }
  const runs = await prisma.scheduleAnalysisRun.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 30 });
  return ok(runs.map((run) => {
    const result = parseResult(run.resultJson);
    return {
      id: run.id,
      snapshotId: run.snapshotId,
      sourceFileName: run.sourceFileName,
      statusDate: run.statusDate,
      status: run.status,
      createdBy: run.createdBy,
      createdAt: run.createdAt.toISOString(),
      summary: result.summary ?? {},
    };
  }));
}
