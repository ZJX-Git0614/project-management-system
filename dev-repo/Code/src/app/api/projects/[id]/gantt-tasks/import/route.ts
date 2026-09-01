import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getGanttPlanMutationBlockReasonForActor } from "@/lib/gantt-baseline-service";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import { extractAssistantDocument } from "@/lib/assistant-document-processing";
import { estimatedHoursForDuration, roundGanttHours } from "@/lib/gantt-calendar";
import { refreshProjectGanttDerivedState, renumberProjectGanttTaskCodes, replaceGanttTaskDependencies } from "@/lib/gantt-task-service";
import { synchronizeGanttOwnerHierarchy } from "@/lib/gantt-owner-service";
import { prisma } from "@/lib/prisma";
import { analyzeSchedule, matchScheduleTasks } from "@/lib/schedule-analysis";
import { buildImportedScheduleSnapshot, getCurrentScheduleSnapshot } from "@/lib/schedule-snapshot";
import { getAssistantAttachmentPath } from "@/lib/assistant-artifact-storage";
import { orderImportedScheduleTasksByHierarchy, parseScheduleImportSource } from "@/lib/schedule-file-merge";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const PREVIEW_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
const APPLY_TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 300_000 } as const;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);

  const project = await prisma.project.findUnique({ where: { id }, select: { id: true, name: true, startDate: true } });
  if (!project) return notFound("项目");

  const formData = await req.formData();
  const file = formData.get("file");
  const attachmentId = String(formData.get("attachmentId") || "").trim();
  const requestedMode = String(formData.get("mode") || "APPEND").trim().toUpperCase();
  const hierarchyMode = String(formData.get("hierarchyMode") || "AUTO").trim().toUpperCase() === "FLAT" ? "FLAT" : "AUTO";
  const mode = ["PREVIEW", "ANALYZE", "SNAPSHOT", "APPEND", "MERGE"].includes(requestedMode)
    ? requestedMode
    : "APPEND";
  const requiredPermissions = ["PREVIEW", "ANALYZE", "SNAPSHOT"].includes(mode)
    ? ["project-gantt:view"]
    : ["project-gantt:create", "project-gantt:edit"];
  const permitted = await Promise.all(requiredPermissions.map((permission) => userHasPermission(user, permission)));
  if (permitted.some((allowed) => !allowed)) return err("权限不足", 403);
  const requestedStatusDate = String(formData.get("statusDate") || "").trim();
  const matchResolutions = (() => {
    try {
      const parsed = JSON.parse(String(formData.get("matchResolutions") || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")]))
        : {};
    } catch {
      return {} as Record<string, string>;
    }
  })();
  const statusDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStatusDate)
    ? requestedStatusDate
    : new Date().toISOString().slice(0, 10);
  if (["APPEND", "MERGE"].includes(mode)) {
    const mutableError = await ensureMutableProject(id);
    if (mutableError) return mutableError;
    const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
      projectId: id,
      userId: user.userId,
      isAdministrator: user.assignedRoleNames.includes("管理员"),
    });
    if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");
  }
  let sourceFileName = "";
  let sourceBuffer: Buffer;
  let extractedText = "";
  if (file instanceof File) {
    sourceFileName = file.name;
    sourceBuffer = Buffer.from(await file.arrayBuffer());
    if ([".docx", ".pdf"].includes(extname(sourceFileName).toLocaleLowerCase("en-US"))) {
      try {
        const extraction = await extractAssistantDocument(sourceFileName, sourceBuffer);
        const blockingDiagnostic = extraction.diagnostics.find((diagnostic) => diagnostic.severity === "ERROR");
        if (blockingDiagnostic) return err(blockingDiagnostic.message);
        extractedText = extraction.content;
      } catch (error) {
        return err(error instanceof Error ? error.message : "文档内容提取失败");
      }
    }
  } else if (attachmentId) {
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { id: attachmentId, projectId: id, userId: user.userId, status: "READY" },
      select: { originalName: true, storedName: true, sizeBytes: true, extraction: { select: { content: true, diagnosticsJson: true } } },
    });
    if (!attachment) return err("智能助手附件不存在、尚未解析完成或不属于当前项目");
    sourceFileName = attachment.originalName;
    if (attachment.sizeBytes > MAX_IMPORT_BYTES) return err("导入文件不能超过 50 MB");
    sourceBuffer = await readFile(getAssistantAttachmentPath(id, attachment.storedName));
    extractedText = attachment.extraction?.content ?? "";
    if ([".docx", ".pdf"].includes(extname(sourceFileName).toLocaleLowerCase("en-US"))) {
      const diagnostics = (() => {
        try {
          const parsed = JSON.parse(attachment.extraction?.diagnosticsJson || "[]");
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic?.severity === "ERROR" && typeof diagnostic?.message === "string");
      if (blockingDiagnostic) return err(blockingDiagnostic.message);
    }
  } else {
    return err("请选择要导入的项目进度文件");
  }
  if (sourceBuffer.length <= 0) return err("导入文件为空");
  if (sourceBuffer.length > MAX_IMPORT_BYTES) return err("导入文件不能超过 50 MB");

  try {
    const importBundle = await parseScheduleImportSource(
      { fileName: sourceFileName, buffer: sourceBuffer, extractedText },
      project.startDate,
      { hierarchyMode },
    );
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
    const incomingSnapshot = buildImportedScheduleSnapshot(sourceFileName, importBundle, statusDate);
    const analysis = analyzeSchedule(currentSnapshot, incomingSnapshot);
    if (["PREVIEW", "ANALYZE", "SNAPSHOT"].includes(mode)) {
      const persisted = await prisma.$transaction(async (tx) => {
        const snapshot = await tx.projectScheduleSnapshot.create({
          data: {
            projectId: id,
            sourceFileName,
            schemaVersion: incomingSnapshot.schemaVersion,
            normalizedJson: JSON.stringify(incomingSnapshot),
            createdBy: user.displayName,
          },
        });
        const run = await tx.scheduleAnalysisRun.create({
          data: {
            projectId: id,
            snapshotId: snapshot.id,
            sourceFileName,
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
            detail: `预览文件“${sourceFileName}”并生成计划差异与冲突分析，未修改当前计划`,
          },
        });
        return { snapshotId: snapshot.id, analysisRunId: run.id };
      }, PREVIEW_TRANSACTION_OPTIONS);
      const matchByIncomingTaskId = new Map(analysis.matches.map((match) => [match.incomingTaskId, match]));
      return ok({
        mode: "PREVIEW",
        hierarchyMode,
        fileName: sourceFileName,
        attachmentId: attachmentId || undefined,
        ...persisted,
        analysis,
        sourceWarnings: importBundle.warnings ?? [],
        previewTasks: importedTasks.map((task) => ({
          id: task.externalId,
          parentId: task.parentExternalId,
          taskCode: task.wbsCode || task.outlineNumber || task.externalId,
          taskName: task.taskName,
          taskDescription: task.taskDescription,
          ownerName: task.ownerName,
          startDate: task.startDate,
          finishDate: task.finishDate,
          durationDays: task.durationDays,
          progress: task.progress,
          taskMode: task.taskMode,
          isMilestone: task.isMilestone,
          predecessorExternalIds: task.predecessorExternalIds,
          match: (() => {
            const match = matchByIncomingTaskId.get(task.externalId);
            if (!match) return null;
            return {
              ...match,
              candidateTasks: (match.candidateTaskIds ?? []).flatMap((candidateId) => {
                const candidate = currentSnapshot.tasks.find((item) => item.id === candidateId);
                return candidate ? [{ id: candidate.id, taskCode: candidate.taskCode, taskName: candidate.taskName }] : [];
              }),
            };
          })(),
        })),
        fieldMappings: [
          { source: "任务名称 / Name", target: "任务名称", required: true, status: "MATCHED" },
          { source: "任务ID / UID / WBS", target: "任务ID与层级匹配", required: false, status: "MATCHED" },
          { source: "父任务 / WBS / 大纲级别", target: "父子层级", required: false, status: "MATCHED" },
          { source: "开始 / 完成 / 工期", target: "计划时间与工期", required: false, status: "MATCHED" },
          { source: "负责人 / Resource", target: "负责人", required: false, status: "MATCHED" },
          { source: "前置任务 / Predecessors", target: "紧前任务", required: false, status: "MATCHED" },
        ],
        currentPlanModified: false,
      });
    }

    const ambiguousMatches = analysis.matches.filter((match) => match.rule === "AMBIGUOUS");
    if (mode === "MERGE") {
      const invalidResolution = ambiguousMatches.find((match) => {
        const resolution = matchResolutions[match.incomingTaskId];
        return !resolution || (resolution !== "__new__" && !(match.candidateTaskIds ?? []).includes(resolution));
      });
      if (invalidResolution) {
        return err("存在尚未确认的疑似任务匹配，请选择现有任务或明确作为新任务导入", 409, "SCHEDULE_MATCH_RESOLUTION_REQUIRED");
      }
    }
    const blockingErrors = analysis.issues.filter((issue) => (
      issue.severity === "ERROR"
      && !(issue.ruleId === "SCHEDULE_SUSPICIOUS_MATCH" && (mode === "APPEND" || Boolean(matchResolutions[issue.taskIds[0]])))
    ));
    if (blockingErrors.length > 0) {
      return err("导入预览仍存在阻断错误，请先处理后再应用", 409, "SCHEDULE_IMPORT_BLOCKED");
    }

    const mergeMatches = mode === "MERGE"
      ? matchScheduleTasks(currentSnapshot.tasks, incomingSnapshot.tasks).map((match) => {
          if (match.rule !== "AMBIGUOUS") return match;
          const resolution = matchResolutions[match.incomingTaskId];
          return resolution === "__new__"
            ? { ...match, currentTaskId: null, rule: "UNMATCHED" as const, confidence: 1 }
            : { ...match, currentTaskId: resolution, rule: "DATABASE_ID" as const, confidence: 1 };
        })
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
      const orderedImportedTasks = orderImportedScheduleTasksByHierarchy(importedTasks);
      for (const task of orderedImportedTasks) {
        const parentId = mode === "MERGE" && task.parentDatabaseId
          ? task.parentDatabaseId
          : task.parentExternalId ? createdIdByExternalId.get(task.parentExternalId) ?? null : null;
        const parentKey = parentId ?? "";
        const sortOrder = (nextSortOrderByParent.get(parentKey) ?? 0) + 1;
        nextSortOrderByParent.set(parentKey, sortOrder);
        const ownerNames = task.ownerName
          ? task.ownerName.split(/[、,，;；/]/u).map((name) => name.trim()).filter(Boolean)
          : [];
        const ownerMatches = [...new Set(ownerNames.flatMap((name) => memberIdsByName.get(name) ?? []))];
        const ownerMemberIds = task.ownerMemberId && memberIds.has(task.ownerMemberId)
          ? [task.ownerMemberId]
          : ownerMatches;
        const ownerMemberId = ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
        const data = {
            projectId: id,
            parentId,
            ownerMemberId,
            ownerLinks: ownerMemberIds.length > 0
              ? { createMany: { data: ownerMemberIds.map((projectMemberId) => ({ projectMemberId })) } }
              : undefined,
            taskCode: mode === "MERGE" ? (task.wbsCode || task.outlineNumber || "") : "",
            taskCategory: task.taskCategory,
            taskName: task.taskName,
            taskDescription: task.taskDescription.trim() || "无",
            startDate: task.startDate,
            finishDate: task.finishDate,
            durationDays: task.durationDays,
            durationMinutes: Math.round(task.durationDays * 450),
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
            remark: task.remark,
            taskMode: task.taskMode,
            isMilestone: task.isMilestone,
            externalUid: task.databaseId ? undefined : task.externalId,
            wbsCode: task.wbsCode,
            outlineNumber: task.outlineNumber,
            calendarUid: task.calendarUid,
            constraintType: task.constraintType,
            constraintDate: task.constraintDate,
            resourceNotBeforeDate: "",
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
          const updated = await tx.projectGanttTask.update({
            where: { id: existingId },
            data: {
              ...data,
              ownerLinks: {
                deleteMany: {},
                ...(ownerMemberIds.length > 0
                  ? { createMany: { data: ownerMemberIds.map((projectMemberId) => ({ projectMemberId })) } }
                  : {}),
              },
            },
          });
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

      await synchronizeGanttOwnerHierarchy({ tx, projectId: id });

      if (importBundle.metadata) {
        const taskUidMap = Object.fromEntries(createdIdByExternalId);
        await tx.projectScheduleImportMetadata.upsert({
          where: { projectId: id },
          create: {
            projectId: id,
            sourceFileName,
            projectSettings: importBundle.metadata.projectSettings as Prisma.InputJsonValue,
            calendars: importBundle.metadata.calendars as Prisma.InputJsonValue,
            resources: importBundle.metadata.resources as Prisma.InputJsonValue,
            assignments: importBundle.metadata.assignments as Prisma.InputJsonValue,
            taskUidMap: taskUidMap as Prisma.InputJsonValue,
          },
          update: {
            sourceFileName,
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
            ? `从文件“${sourceFileName}”合并项目计划：更新 ${updatedCount} 个，新增 ${createdCount} 个`
            : `从文件“${sourceFileName}”追加导入 ${createdCount} 个项目进度任务`,
        },
      });
      await renumberProjectGanttTaskCodes(id, tx);
      await refreshProjectGanttDerivedState(id, undefined, tx);
      return { createdCount, updatedCount };
    }, APPLY_TRANSACTION_OPTIONS);

    return ok({ importedCount: importedTasks.length, fileName: sourceFileName, mode, ...applyResult, analysis, currentPlanModified: true });
  } catch (error) {
    return err(error instanceof Error ? error.message : "项目进度文件导入失败");
  }
}
