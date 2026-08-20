import { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { ensureMutableProject, err, notFound, ok } from "@/lib/api-utils";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";
import {
  getGanttPlanMutationBlockReasonForActor,
  hasGanttTaskPlanningMutation,
  isProjectGanttManager,
} from "@/lib/gantt-baseline-service";
import {
  estimatedHoursForDuration,
  isValidGanttDurationDays,
  roundGanttHours,
} from "@/lib/gantt-calendar";
import {
  deriveGanttPriority,
  ganttSchedulePriorityFor,
  normalizeGanttCompletion,
  normalizeGanttHalfDay,
  normalizeGanttUserPriority,
  resolveGanttTaskPlan,
} from "@/lib/gantt-planning-rules";
import {
  convertFixedSuccessorsBlockedByActualCompletion,
  deleteGanttTaskSubtrees,
  GanttRevisionConflictError,
  getProjectGanttCalendarMode,
  getOrderedGanttTasks,
  parseGanttDependencyInput,
  refreshProjectGanttDerivedState,
  replaceGanttTaskDependencies,
  serializeGanttTaskList,
} from "@/lib/gantt-task-service";
import { synchronizeGanttTaskCategoriesAfterNameChange } from "@/lib/gantt-hierarchy";
import {
  applyGanttOwnerChange,
  applyGanttOwnerSet,
  GanttOwnerReadOnlyError,
  shouldApplyGanttOwnerChange,
} from "@/lib/gantt-owner-service";
import { previewProjectManualScheduleImpact, resourceConflictAnalysis } from "@/lib/gantt-resource-service";

const normalizeParentBoundaryMode = (value: unknown) => (
  String(value ?? "").trim().toUpperCase() === "LOCKED" ? "LOCKED" : "ROLLUP"
);

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:edit"))) return err("权限不足", 403);

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;

  const existing = await prisma.projectGanttTask.findFirst({
    where: { id: taskId, projectId: id },
    include: {
      ownerLinks: { select: { projectMemberId: true } },
      predecessorDependencies: {
        select: { predecessorTaskId: true, type: true, lag: true, lagFormat: true },
      },
    },
  });
  if (!existing) return notFound("甘特任务");

  const body = await req.json() as Record<string, unknown>;
  // Parent owners are derived from their leaves. The inline grid submits a
  // full draft for every edit, so parent owner ids must be ignored here
  // instead of treating the derived multi-owner value as an invalid leaf edit.
  const childCount = await prisma.projectGanttTask.count({ where: { projectId: id, parentId: taskId } });
  const isParentTask = childCount > 0;
  const planningMutation = hasGanttTaskPlanningMutation(existing, body);
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason && planningMutation) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");
  const requestedTaskCategory = "taskCategory" in body
    ? String(body.taskCategory ?? "").trim()
    : existing.taskCategory;
  if (requestedTaskCategory !== existing.taskCategory) {
    return err("任务类别由任务层级自动生成，不允许直接修改");
  }
  const taskName = String("taskName" in body ? body.taskName ?? "" : existing.taskName).trim();
  const taskDescription = String(body.taskDescription ?? existing.taskDescription ?? "").trim() || "无";
  const requestedStartDate = String("startDate" in body ? body.startDate ?? "" : existing.startDate).trim();
  const requestedFinishDate = String("finishDate" in body ? body.finishDate ?? "" : existing.finishDate ?? "").trim();
  const requestedStartSlot = normalizeGanttHalfDay("startSlot" in body ? body.startSlot : existing.startSlot);
  const requestedFinishSlot = normalizeGanttHalfDay("finishSlot" in body ? body.finishSlot : existing.finishSlot, "PM");
  const durationDays = Number("durationDays" in body ? body.durationDays ?? 0 : existing.durationDays);
  if (!isValidGanttDurationDays(durationDays)) return err("工期只能为空或以 0.5 天为单位填写");
  const calendarMode = await getProjectGanttCalendarMode(id);
  const plan = resolveGanttTaskPlan({
    taskMode: "taskMode" in body ? body.taskMode : existing.taskMode,
    startDate: requestedStartDate,
    startSlot: requestedStartSlot,
    finishDate: requestedFinishDate,
    finishSlot: requestedFinishSlot,
    durationDays,
    mode: calendarMode,
  });
  if (plan.error) return err(plan.error);
  const persistedPlan = planningMutation ? plan : {
    taskMode: existing.taskMode,
    startDate: existing.startDate,
    startSlot: normalizeGanttHalfDay(existing.startSlot),
    finishDate: existing.finishDate,
    finishSlot: normalizeGanttHalfDay(existing.finishSlot, "PM"),
    durationDays: existing.durationDays,
  };
  const actualStartDate = String("actualStartDate" in body ? body.actualStartDate ?? "" : existing.actualStartDate).trim();
  const actualEndDate = String("actualEndDate" in body ? body.actualEndDate ?? "" : existing.actualEndDate).trim();
  const actualStartSlot = normalizeGanttHalfDay("actualStartSlot" in body ? body.actualStartSlot : existing.actualStartSlot);
  const actualFinishSlot = normalizeGanttHalfDay("actualFinishSlot" in body ? body.actualFinishSlot : existing.actualFinishSlot, "PM");
  const estimatedWorkHours = planningMutation
    ? estimatedHoursForDuration(persistedPlan.durationDays)
    : existing.estimatedWorkHours;
  const requestedActualWorkHours = Number(body.actualWorkHours ?? existing.actualWorkHours);
  const actualWorkHours = roundGanttHours(requestedActualWorkHours);
  const completion = normalizeGanttCompletion({
    progress: Number("progress" in body ? body.progress ?? 0 : existing.progress),
    actualStartDate,
    actualEndDate,
    previousProgress: existing.progress,
    today: new Date().toISOString().slice(0, 10),
  });
  const isMilestone = "isMilestone" in body ? Boolean(body.isMilestone) : existing.isMilestone;
  const parentBoundaryMode = normalizeParentBoundaryMode(
    "parentBoundaryMode" in body ? body.parentBoundaryMode : existing.parentBoundaryMode,
  );
  // `schedulePriority` is an effective, system-derived value. The inline
  // editor sends a complete draft, so retain the current stored value here
  // and let the project-wide recalculation update it after the mutation.
  // This prevents callers from bypassing the readonly priority rules by
  // submitting a handcrafted numeric priority.
  if ("schedulePriority" in body && Number(body.schedulePriority) !== Number(existing.schedulePriority)) {
    return err("排期优先级由关键路径、依赖关系和子任务自动计算，不允许直接修改");
  }
  const schedulePriority = existing.schedulePriority;
  const userPriority = "userPriority" in body
    ? normalizeGanttUserPriority(body.userPriority)
    : normalizeGanttUserPriority(existing.userPriority);
  const effortDriven = "effortDriven" in body ? body.effortDriven === true : existing.effortDriven;
  const parallelizable = "parallelizable" in body ? body.parallelizable === true : existing.parallelizable;
  const predecessorTask = String("predecessorTask" in body ? body.predecessorTask ?? "" : existing.predecessorTask).trim();
  const remark = String(body.remark ?? existing.remark ?? "").trim();
  const dependencies = parseGanttDependencyInput(body);
  const hasDependencyInput = "predecessorDependencies" in body || "predecessorTaskIds" in body || "predecessorTaskId" in body;
  const budgetItemId = "budgetItemId" in body
    ? (body.budgetItemId ? String(body.budgetItemId) : null)
    : existing.budgetItemId;
  const hasOwnerIdsInput = "ownerMemberIds" in body || "ownerMemberId" in body;
  const ownerMemberIds = Array.isArray(body.ownerMemberIds)
    ? [...new Set(body.ownerMemberIds.map((value) => String(value).trim()).filter(Boolean))]
    : ("ownerMemberId" in body ? (body.ownerMemberId ? [String(body.ownerMemberId).trim()] : []) : null);
  const existingOwnerLinks = existing.ownerLinks ?? [];
  const existingOwnerMemberIds = existingOwnerLinks.length > 0
    ? existingOwnerLinks.map((link) => link.projectMemberId)
    : existing.ownerMemberId ? [existing.ownerMemberId] : [];
  const ownerMemberId = ownerMemberIds === null
    ? existing.ownerMemberId
    : ownerMemberIds.length === 1 ? ownerMemberIds[0] : null;
  const ownerChanged = shouldApplyGanttOwnerChange({
    isParentTask,
    hasOwnerInput: hasOwnerIdsInput,
    currentOwnerMemberIds: existingOwnerMemberIds,
    nextOwnerMemberIds: ownerMemberIds,
    ownerChangeMode: body.ownerChangeMode,
  });
  const nextDependencies = hasDependencyInput ? dependencies : existing.predecessorDependencies;
  const userPriorityChanged = "userPriority" in body
    && userPriority !== normalizeGanttUserPriority(existing.userPriority);
  const needsDependencyRoleCheck = userPriorityChanged || body.previewScheduleImpact === true;
  const outgoingFsDependencyCount = needsDependencyRoleCheck
    ? await prisma.projectGanttDependency.count({
      where: { projectId: id, predecessorTaskId: taskId, type: 1 },
    })
    : 0;

  if (actualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(actualStartDate)) return err("实际开始时间格式应为 YYYY-MM-DD");
  if (completion.error) return err(completion.error);
  if (!Number.isFinite(requestedActualWorkHours) || requestedActualWorkHours < 0) return err("实际工时必须为大于或等于 0 的数字");
  if (budgetItemId) {
    const budgetItem = await prisma.projectBudgetItem.findFirst({ where: { id: budgetItemId, projectId: id }, select: { id: true } });
    if (!budgetItem) return notFound("预算条目");
  }
  const requestedOwners = ownerChanged && ownerMemberIds && ownerMemberIds.length > 0
    ? await prisma.projectMember.findMany({
      where: { id: { in: ownerMemberIds }, projectId: id },
      select: {
        id: true,
        accountId: true,
        personName: true,
        capacityHoursPerDay: true,
        productivityRate: true,
        maxConcurrentAssignments: true,
      },
    })
    : [];
  if (ownerChanged && ownerMemberIds && ownerMemberIds.length > 1) {
    return err("末级任务只能指定一名负责人；父级负责人由子任务自动汇总");
  }
  if (ownerChanged && ownerMemberIds && requestedOwners.length !== ownerMemberIds.length) return err("负责人必须来自当前项目组成员");

  const actualMutation = ("progress" in body && Number(body.progress) !== existing.progress)
    || ("actualStartDate" in body && actualStartDate !== existing.actualStartDate)
    || ("actualEndDate" in body && actualEndDate !== existing.actualEndDate)
    || ("actualStartSlot" in body && actualStartSlot !== normalizeGanttHalfDay(existing.actualStartSlot))
    || ("actualFinishSlot" in body && actualFinishSlot !== normalizeGanttHalfDay(existing.actualFinishSlot, "PM"))
    || ("actualWorkHours" in body && Math.abs(actualWorkHours - existing.actualWorkHours) > 0.001);
  if (userPriorityChanged) {
    const priorityIsSystemDerived = childCount > 0
      || existing.effectivePriority === "HIGHEST"
      || outgoingFsDependencyCount > 0
      || nextDependencies.some((dependency) => Number(dependency.type ?? 1) === 1);
    if (priorityIsSystemDerived) {
      return err("当前任务优先级由关键路径、FS 关系或子任务自动计算，不允许手动修改");
    }
  }
  let canReopenCompletedTask = false;
  if (existing.progress === 100 && actualMutation) {
    if (childCount === 0) {
      const project = await prisma.project.findUnique({
        where: { id },
        select: { ganttBaselineState: true },
      });
      const reopening = completion.progress < 100 && completion.actualEndDate === "";
      const canReopen = reopening
        && project?.ganttBaselineState === "CHANGE_DRAFT"
        && await isProjectGanttManager(id, user.userId);
      if (!canReopen) {
        return err("已完成的末级任务已只读。仅项目经理在变更基线草案中将进度改回未完成后，才能重新打开任务。", 409, "GANTT_TASK_COMPLETED");
      }
      canReopenCompletedTask = true;
    }
  }
  if (actualMutation && childCount > 0) {
    return err("父级汇总任务的实际开始、实际完成、实际工时和当前进度由子任务自动汇总，请更新末级任务");
  }
  if (actualMutation && childCount === 0 && !canReopenCompletedTask) {
    return err("末级任务的进度、实际日期和实际工时需要提交进度审批，审批通过后系统会自动更新", 409, "GANTT_PROGRESS_APPROVAL_REQUIRED");
  }

  if (body.previewScheduleImpact === true) {
    const proposedPriority = deriveGanttPriority({
      userPriority,
      // The CPM calculation persists the effective priority, which is the
      // durable critical-path result available before this preview reruns the
      // entire project schedule.
      isCritical: existing.effectivePriority === "HIGHEST",
      hasSupportedDependency: outgoingFsDependencyCount > 0
        || nextDependencies.some((dependency) => Number(dependency.type ?? 1) === 1),
    });
    const impact = await previewProjectManualScheduleImpact({
      projectId: id,
      taskId,
      patch: {
        startDate: plan.startDate,
        finishDate: plan.finishDate,
        durationDays: plan.durationDays,
        taskMode: plan.taskMode,
        parentBoundaryMode,
        schedulePriority: ganttSchedulePriorityFor(proposedPriority.effectivePriority),
        effortDriven,
        parallelizable,
        ...(ownerChanged ? {
          ownerAssignments: requestedOwners.map((owner) => ({
            ownerKey: owner.accountId ? `account:${owner.accountId}` : `person:${owner.personName}`,
            unitsPercent: 100,
            plannedWorkHours: 0,
            capacityHoursPerDay: owner.capacityHoursPerDay,
            productivityRate: owner.productivityRate,
            maxConcurrentAssignments: owner.maxConcurrentAssignments,
          })),
        } : {}),
        ...(hasDependencyInput ? { predecessorDependencies: dependencies } : {}),
      },
    });
    return ok(impact);
  }

  const tasksBeforeActualMutation = actualMutation
    ? serializeGanttTaskList(await getOrderedGanttTasks(id))
    : [];

  try {
    await prisma.$transaction(async (tx) => {
      const baseData = {
        taskName,
        taskDescription,
        startDate: persistedPlan.startDate,
        finishDate: persistedPlan.finishDate,
        durationDays: persistedPlan.durationDays,
        durationMinutes: Math.round(persistedPlan.durationDays * 450),
        actualStartDate: completion.actualStartDate,
        actualEndDate: completion.actualEndDate,
        startSlot: persistedPlan.startSlot,
        finishSlot: persistedPlan.finishSlot,
        actualStartSlot,
        actualFinishSlot,
        estimatedWorkHours,
        actualWorkHours,
        progress: completion.progress,
        taskMode: persistedPlan.taskMode,
        parentBoundaryMode,
        schedulePriority,
        userPriority,
        effortDriven,
        parallelizable,
        isMilestone,
        budgetItemId,
        predecessorTask,
        remark,
        ...(("startDate" in body || "finishDate" in body || "durationDays" in body || "taskMode" in body || ownerChanged || hasDependencyInput)
          ? { resourceNotBeforeDate: "" }
          : {}),
      };

      const updated = await tx.projectGanttTask.update({
        where: { id: taskId },
        data: baseData,
      });

      if (taskName !== existing.taskName) {
        const projectTasks = await tx.projectGanttTask.findMany({
          where: { projectId: id },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true, parentId: true, sortOrder: true, createdAt: true, taskCategory: true, taskName: true },
        });
        const synchronized = synchronizeGanttTaskCategoriesAfterNameChange(
          projectTasks,
          taskId,
          existing.taskName,
          taskName,
        );
        const previousCategoryById = new Map(projectTasks.map((item) => [item.id, item.taskCategory]));
        const categoryUpdates = synchronized.filter((item) => previousCategoryById.get(item.id) !== item.taskCategory);
        await Promise.all(categoryUpdates.map((item) => tx.projectGanttTask.update({
          where: { id: item.id },
          data: { taskCategory: item.taskCategory },
        })));
      }

      if (ownerChanged) {
        if (ownerMemberIds) {
          await applyGanttOwnerSet({
            tx,
            projectId: id,
            taskId,
            nextOwnerMemberIds: ownerMemberIds,
            allowBranchReassignment: body.ownerChangeMode === "BRANCH_REASSIGN",
          });
        } else {
          await applyGanttOwnerChange({
            tx,
            projectId: id,
            taskId,
            nextOwnerMemberId: ownerMemberId,
            allowBranchReassignment: body.ownerChangeMode === "BRANCH_REASSIGN",
          });
        }
      }
      if (hasDependencyInput) await replaceGanttTaskDependencies(tx, id, taskId, dependencies);
      const releasedSuccessors = actualMutation
        ? await convertFixedSuccessorsBlockedByActualCompletion(id, [taskId], calendarMode, tx)
        : [];
      if (actualMutation) {
        const releasedText = releasedSuccessors.length > 0
          ? `；${releasedSuccessors.map((task) => `${task.taskCode} · ${task.taskName}`).join("、")} 因实际完成约束转为自动排期`
          : "";
        await tx.operationHistory.create({
          data: {
            projectId: id,
            entityType: "ProjectGanttTask",
            entityId: taskId,
            actionType: "UPDATE_ACTUAL",
            operator: user.displayName,
            detail: `更新任务「${existing.taskCode} · ${existing.taskName}」执行事实：进度 ${existing.progress}% → ${completion.progress}%，实际完成 ${existing.actualEndDate || "未填写"} → ${completion.actualEndDate || "未填写"}${releasedText}`,
          },
        });
        await refreshProjectGanttDerivedState(id, calendarMode, tx);
      }
      await tx.project.update({ where: { id }, data: { ganttRevision: { increment: 1 } } });
      return updated;
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof GanttOwnerReadOnlyError) return err(error.message, 409);
    throw error;
  }
  if (!actualMutation) {
    await refreshProjectGanttDerivedState(id, calendarMode, prisma);
  }
  const normalizedTasks = serializeGanttTaskList(await getOrderedGanttTasks(id));
  const normalizedTask = normalizedTasks.find((item) => item.id === taskId);
  if (!normalizedTask) return notFound("甘特任务");
  if (actualMutation && tasksBeforeActualMutation.length > 0) {
    const beforeById = new Map(tasksBeforeActualMutation.map((task) => [task.id, task] as const));
    const affectedTasks = normalizedTasks.filter((task) => {
      const before = beforeById.get(task.id);
      return task.id !== taskId
        && Number(task.progress) < 100
        && Boolean(before)
        && (before!.startDate !== task.startDate
          || before!.finishDate !== task.finishDate
          || before!.taskMode !== task.taskMode);
    });
    if (affectedTasks.length > 0) {
      try {
        const affectedAccountIds = affectedTasks.flatMap((task) => (
          task.ownerMembers.map((owner) => owner.accountId).filter((accountId): accountId is string => Boolean(accountId))
        ));
        const managers = await prisma.projectMember.findMany({
          where: { projectId: id, accountId: { not: null }, roleName: { contains: "项目经理" } },
          select: { accountId: true },
        });
        const accountIds = [...new Set([
          ...affectedAccountIds,
          ...managers.map((manager) => manager.accountId).filter((accountId): accountId is string => Boolean(accountId)),
        ])];
        const preview = affectedTasks.slice(0, 8).map((task) => {
          const before = beforeById.get(task.id)!;
          return `${task.taskCode} · ${task.taskName}：${before.startDate || "未排期"}~${before.finishDate || "未排期"} → ${task.startDate || "未排期"}~${task.finishDate || "未排期"}`;
        });
        const remaining = affectedTasks.length - preview.length;
        const detail = `任务「${normalizedTask.taskCode} · ${normalizedTask.taskName}」的实际执行信息已更新。系统已刷新汇总、浮动与关键路径信息；如需调整未完成任务的计划日期，请运行正式自动排期。受影响 ${affectedTasks.length} 条任务：${preview.join("；")}${remaining > 0 ? `；另有 ${remaining} 条` : ""}`;
        if (accountIds.length > 0) {
          await prisma.systemNotification.createMany({
            data: accountIds.map((accountId) => ({
              projectId: id,
              accountId,
              category: "WBS_SCHEDULE",
              title: "实际进度已更新，请执行正式自动排期",
              detail,
              severity: "WARNING",
              sourceType: "ProjectGanttTask",
              sourceId: taskId,
            })),
          });
        }
      } catch (error) {
        console.error("[gantt-schedule] actual-change notification failed", error);
      }
    }
  }
  const conflictAnalysis = await resourceConflictAnalysis(id);
  const scheduleWarnings = [
    ...conflictAnalysis.result.conflicts
      .filter((conflict) => conflict.taskIds.includes(taskId))
      .map((conflict) => `${conflict.startDate} 至 ${conflict.finishDate} 存在负责人${conflict.reason === "CAPACITY_EXCEEDED" ? "容量" : "并发"}冲突`),
    ...conflictAnalysis.result.issues
      .filter((issue) => issue.taskIds.includes(taskId))
      .map((issue) => issue.message),
  ];
  return ok({ ...normalizedTask, scheduleWarnings: [...new Set(scheduleWarnings)] });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const user = await getAuthenticatedUser(req);
  if (!user) return err("未登录", 401);
  if (!(await userHasPermission(user, "project-gantt:delete"))) return err("权限不足", 403);

  const mutableError = await ensureMutableProject(id);
  if (mutableError) return mutableError;
  const baselineLockReason = await getGanttPlanMutationBlockReasonForActor({
    projectId: id,
    userId: user.userId,
    isAdministrator: user.assignedRoleNames.includes("管理员"),
  });
  if (baselineLockReason) return err(baselineLockReason, 409, "GANTT_BASELINE_LOCKED");

  const existing = await prisma.projectGanttTask.findFirst({ where: { id: taskId, projectId: id } });
  if (!existing) return notFound("甘特任务");

  try {
    const result = await deleteGanttTaskSubtrees({
      projectId: id,
      rootTaskIds: [taskId],
      operator: user.displayName,
      operatorUserId: user.userId,
    });
    return ok({ message: "甘特任务已删除", ...result });
  } catch (error) {
    if (error instanceof GanttRevisionConflictError) {
      return err(error.message, 409, error.code);
    }
    return err(error instanceof Error ? error.message : "删除失败");
  }
}
