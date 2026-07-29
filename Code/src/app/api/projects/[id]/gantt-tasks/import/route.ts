import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";

import { getUserFromRequest } from "@/lib/auth";
import { ensureMutableProject, err, notFound, ok, unauthorized } from "@/lib/api-utils";
import { parseGanttImportFile } from "@/lib/gantt-file-transfer";
import { estimatedHoursForDuration, roundGanttHours } from "@/lib/gantt-calendar";
import { recalculateProjectGanttSchedule, renumberProjectGanttTaskCodes, replaceGanttTaskDependencies } from "@/lib/gantt-task-service";
import { prisma } from "@/lib/prisma";
import { analyzeSchedule, matchScheduleTasks } from "@/lib/schedule-analysis";
import { buildImportedScheduleSnapshot, getCurrentScheduleSnapshot } from "@/lib/schedule-snapshot";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const PREVIEW_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
const APPLY_TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 300_000 } as const;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req);
  if (!user) return unauthorized();

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true, startDate: true } });
  if (!project) return notFound("项目");

  const formData = await req.formData();
  const file = formData.get("file");
  const requestedMode = String(formData.get("mode") || "APPEND").trim().toUpperCase();
  const mode = ["PREVIEW", "ANALYZE", "SNAPSHOT", "APPEND", "MERGE"].includes(requestedMode)
    ? requestedMode
    : "APPEND";
  const requestedStatusDate = String(formData.get("statusDate") || "").trim();
  const statusDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStatusDate)
    ? requestedStatusDate
    : new Date().toISOString().slice(0, 10);
  if (["APPEND", "MERGE"].includes(mode)) {
    const mutableError = await ensureMutableProject(id);
    if (mutableError) return mutableError;
  }
  if (!(file instanceof File)) return err("请选择要导入的项目进度文件");
  if (file.size <= 0) return err("导入文件为空");
  if (file.size > MAX_IMPORT_BYTES) return err("导入文件不能超过 50 MB");

  try {
    const importBundle = await parseGanttImportFile(file.name, Buffer.from(await file.arrayBuffer()), {
      fallbackStartDate: project.startDate,
    });
    const importedTasks = importBundle.tasks;
    const externalIds = new Set<string>();
    for (const task of importedTasks) {
      if (externalIds.has(task.externalId)) return err(`导入文件中的任务ID重复：${task.externalId}`);
      externalIds.add(task.externalId);
    }
    const taskNameByExternalId = new Map(importedTasks.map((task) => [task.externalId, task.taskName]));
    for (const task of importedTasks) {
      if (task.parentExternalId && !externalIds.has(task.parentExternalId)) {
        return err(`任务“${task.taskName}”引用了不存在的父任务：${task.parentExternalId}`);
      }
    }

    const currentSnapshot = await getCurrentScheduleSnapshot(id, statusDate);
    const incomingSnapshot = buildImportedScheduleSnapshot(file.name, importBundle, statusDate);
    const analysis = analyzeSchedule(currentSnapshot, incomingSnapshot);
    if (["PREVIEW", "ANALYZE", "SNAPSHOT"].includes(mode)) {
      const persisted = await prisma.$transaction(async (tx) => {
        const snapshot = await tx.projectScheduleSnapshot.create({
          data: {
            projectId: id,
            sourceFileName: file.name,
            schemaVersion: incomingSnapshot.schemaVersion,
            normalizedJson: JSON.stringify(incomingSnapshot),
            createdBy: user.displayName,
          },
        });
        const run = await tx.scheduleAnalysisRun.create({
          data: {
            projectId: id,
            snapshotId: snapshot.id,
            sourceFileName: file.name,
            statusDate,
            resultJson: JSON.stringify(analysis),
            createdBy: user.displayName,
          },
        });
        await tx.operationHistory.create({
          data: {
            projectId: id,
            entityType: "SCHEDULE_ANALYSIS",
            entityId: run.id,
            actionType: "CREATE",
            operator: user.displayName,
            detail: `预览文件“${file.name}”并生成计划差异与冲突分析，未修改当前计划`,
          },
        });
        return { snapshotId: snapshot.id, analysisRunId: run.id };
      }, PREVIEW_TRANSACTION_OPTIONS);
      return ok({ mode: "PREVIEW", fileName: file.name, ...persisted, analysis, currentPlanModified: false });
    }

    const mergeMatches = mode === "MERGE"
      ? matchScheduleTasks(currentSnapshot.tasks, incomingSnapshot.tasks)
      : [];
    const existingIdByExternalId = new Map(mergeMatches.flatMap((match) => (
      match.currentTaskId ? [[match.incomingTaskId, match.currentTaskId] as const] : []
    )));
    const projectMembers = await prisma.projectMember.findMany({
      where: { projectId: id },
      select: { id: true, personName: true },
    });
    const memberIds = new Set(projectMembers.map((member) => member.id));
    const memberIdsByName = new Map<string, string[]>();
    projectMembers.forEach((member) => {
      memberIdsByName.set(member.personName, [...(memberIdsByName.get(member.personName) ?? []), member.id]);
    });

    const applyResult = await prisma.$transaction(async (tx) => {
      const existing = await tx.projectGanttTask.findMany({
        where: { projectId: id },
        select: { parentId: true, sortOrder: true },
      });
      const nextSortOrderByParent = new Map<string, number>();
      for (const task of existing) {
        const key = task.parentId ?? "";
        nextSortOrderByParent.set(key, Math.max(nextSortOrderByParent.get(key) ?? 0, task.sortOrder));
      }

      const createdIdByExternalId = new Map<string, string>(existingIdByExternalId);
      let createdCount = 0;
      let updatedCount = 0;
      for (const task of importedTasks) {
        const parentId = mode === "MERGE" && task.parentDatabaseId
          ? task.parentDatabaseId
          : task.parentExternalId ? createdIdByExternalId.get(task.parentExternalId) ?? null : null;
        const parentKey = parentId ?? "";
        const sortOrder = (nextSortOrderByParent.get(parentKey) ?? 0) + 1;
        nextSortOrderByParent.set(parentKey, sortOrder);
        const ownerMatches = task.ownerName ? memberIdsByName.get(task.ownerName) ?? [] : [];
        const ownerMemberId = task.ownerMemberId && memberIds.has(task.ownerMemberId)
          ? task.ownerMemberId
          : ownerMatches.length === 1 ? ownerMatches[0] : null;
        const data = {
            projectId: id,
            parentId,
            ownerMemberId,
            taskCode: mode === "MERGE" ? (task.wbsCode || task.outlineNumber || "") : "",
            taskCategory: task.taskCategory,
            taskName: task.taskName,
            startDate: task.startDate,
            finishDate: task.finishDate,
            durationDays: task.durationDays,
            durationMinutes: task.durationDays * 450,
            durationFormat: task.durationFormat,
            actualStartDate: task.actualStartDate,
            actualEndDate: task.actualEndDate,
            estimatedWorkHours: estimatedHoursForDuration(task.durationDays),
            actualWorkHours: roundGanttHours(task.actualWorkHours),
            progress: task.progress,
            predecessorTask: task.predecessorExternalIds
              .map((externalId) => taskNameByExternalId.get(externalId) ?? "")
              .filter(Boolean)
              .join(","),
            taskMode: task.taskMode,
            isMilestone: task.isMilestone,
            externalUid: task.databaseId ? undefined : task.externalId,
            wbsCode: task.wbsCode,
            outlineNumber: task.outlineNumber,
            calendarUid: task.calendarUid,
            constraintType: task.constraintType,
            constraintDate: task.constraintDate,
            baselineStartDate: task.baselineStartDate,
            baselineFinishDate: task.baselineFinishDate,
            baselineCost: task.baselineCost,
            budgetAtCompletion: task.budgetAtCompletion,
            actualCost: task.actualCost,
            baselines: task.baselines as Prisma.InputJsonValue,
            sortOrder,
        };
        const existingId = existingIdByExternalId.get(task.externalId);
        if (existingId) {
          const updated = await tx.projectGanttTask.update({ where: { id: existingId }, data });
          createdIdByExternalId.set(task.externalId, updated.id);
          updatedCount += 1;
        } else {
          const created = await tx.projectGanttTask.create({ data: { ...data, externalUid: task.externalId } });
          createdIdByExternalId.set(task.externalId, created.id);
          createdCount += 1;
        }
      }

      for (const task of importedTasks) {
        const successorTaskId = createdIdByExternalId.get(task.externalId);
        if (!successorTaskId) continue;
        await replaceGanttTaskDependencies(tx, id, successorTaskId, task.predecessorDependencies.flatMap((dependency) => {
          const dependencyIndex = task.predecessorDependencies.indexOf(dependency);
          const predecessorTaskId = mode === "MERGE" && task.predecessorDatabaseIds?.[dependencyIndex]
            ? task.predecessorDatabaseIds[dependencyIndex]
            : createdIdByExternalId.get(dependency.predecessorExternalId);
          return predecessorTaskId ? [{
            predecessorTaskId,
            type: dependency.type,
            lag: dependency.lag,
            lagFormat: dependency.lagFormat,
          }] : [];
        }));
      }

      if (importBundle.metadata) {
        const taskUidMap = Object.fromEntries(createdIdByExternalId);
        await tx.projectScheduleImportMetadata.upsert({
          where: { projectId: id },
          create: {
            projectId: id,
            sourceFileName: file.name,
            projectSettings: importBundle.metadata.projectSettings as Prisma.InputJsonValue,
            calendars: importBundle.metadata.calendars as Prisma.InputJsonValue,
            resources: importBundle.metadata.resources as Prisma.InputJsonValue,
            assignments: importBundle.metadata.assignments as Prisma.InputJsonValue,
            taskUidMap: taskUidMap as Prisma.InputJsonValue,
          },
          update: {
            sourceFileName: file.name,
            projectSettings: importBundle.metadata.projectSettings as Prisma.InputJsonValue,
            calendars: importBundle.metadata.calendars as Prisma.InputJsonValue,
            resources: importBundle.metadata.resources as Prisma.InputJsonValue,
            assignments: importBundle.metadata.assignments as Prisma.InputJsonValue,
            taskUidMap: taskUidMap as Prisma.InputJsonValue,
          },
        });
      }

      await tx.operationHistory.create({
        data: {
          projectId: id,
          entityType: "PROJECT_GANTT_IMPORT",
          entityId: id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: mode === "MERGE"
            ? `从文件“${file.name}”合并项目计划：更新 ${updatedCount} 个，新增 ${createdCount} 个`
            : `从文件“${file.name}”追加导入 ${createdCount} 个项目进度任务`,
        },
      });
      return { createdCount, updatedCount };
    }, APPLY_TRANSACTION_OPTIONS);
    await renumberProjectGanttTaskCodes(id);
    await recalculateProjectGanttSchedule(id);

    return ok({ importedCount: importedTasks.length, fileName: file.name, mode, ...applyResult, analysis, currentPlanModified: true });
  } catch (error) {
    return err(error instanceof Error ? error.message : "项目进度文件导入失败");
  }
}
