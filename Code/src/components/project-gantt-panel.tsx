"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BriefcaseBusiness, CalendarDays, ChevronDown, Download, FileSpreadsheet, FileType2, FlagTriangleRight, Maximize2, Minimize2, Network, Redo2, TriangleAlert, Undo2, Upload, WandSparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GanttTimeline, type GanttTaskDraft } from "@/components/gantt-timeline";
import { OperationErrorDialog } from "@/components/operation-error-dialog";
import { useConfirm } from "@/components/confirm-provider";
import { usePermission } from "@/lib/use-permission";
import { api } from "@/lib/api-client";
import { buildGanttRows, getGanttDateRange } from "@/lib/gantt";
import {
  calculateTaskDurationDays,
  isValidGanttDurationDays,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { renumberGanttTaskCodes } from "@/lib/gantt-task-codes";
import { ganttTaskDepths } from "@/lib/gantt-column-layout";
import {
  changeGanttTaskHierarchy,
  synchronizeGanttTaskCategories,
  type GanttHierarchyDirection,
} from "@/lib/gantt-hierarchy";
import {
  emptyGanttHistoryState,
  parseGanttHistoryState,
  pushGanttHistoryEntry,
  type GanttHistoryEntry,
  type GanttHistoryFocusTarget,
  type GanttHistoryState,
} from "@/lib/gantt-history";
import { cn } from "@/lib/utils";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectGanttTask, ProjectMember } from "@/domain/models";

interface ProjectGanttPanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
}

interface FetchTasksOptions {
  showLoading?: boolean;
  clearOnError?: boolean;
}

interface GanttTransferCapabilities {
  mppExport: boolean;
}

interface GanttSettings {
  calendarMode: GanttCalendarMode;
  hoursPerDay: number;
  hardFinishDate: string;
}

interface GanttDeleteResult {
  deletionBatchId?: string;
  deletedTaskCount?: number;
  detachedWeeklyItemCount?: number;
  detachedRiskCount?: number;
  affectedRiskCount?: number;
  clearedPredecessorCount?: number;
  expiresAt?: string;
}

interface GanttRestoreResult {
  message: string;
  restoredTaskCount: number;
  warnings?: string[];
}

interface GanttStructureResult {
  tasks: ProjectGanttTask[];
  createdTaskIds?: string[];
  movedTaskIds?: string[];
}

interface GanttHistorySnapshotResult {
  snapshotId: string;
  createdAt: string;
}

export interface GanttHistoryFocusRequest extends GanttHistoryFocusTarget {
  requestId: number;
}

let fallbackClientIdSequence = 0;
const createClientId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  fallbackClientIdSequence += 1;
  return `client-${fallbackClientIdSequence}`;
};

type ScheduleImportPreview = {
  file?: File;
  attachmentId?: string;
  fileName: string;
  hierarchyMode: "AUTO" | "FLAT";
  analysisRunId: string;
  snapshotId: string;
  analysis: {
    summary: {
      currentTasks: number;
      incomingTasks: number;
      matched: number;
      added: number;
      removedCandidates: number;
      changedFields: number;
      errors: number;
      warnings: number;
    };
    issues: Array<{ ruleId: string; severity: "INFO" | "WARNING" | "ERROR"; taskCodes: string[]; message: string; suggestion: string }>;
  };
  sourceWarnings?: Array<{ sourceFile: string; taskName?: string; message: string }>;
  previewTasks: Array<{
    id: string;
    parentId: string | null;
    taskCode: string;
    taskName: string;
    taskDescription: string;
    ownerName: string;
    startDate: string;
    finishDate: string;
    durationDays: number;
    progress: number;
    taskMode: string;
    isMilestone: boolean;
    predecessorExternalIds: string[];
    match: {
      currentTaskId: string | null;
      rule: string;
      confidence: number;
      candidateTaskIds?: string[];
      candidateTasks?: Array<{ id: string; taskCode: string; taskName: string }>;
    } | null;
  }>;
  fieldMappings: Array<{ source: string; target: string; required: boolean; status: string }>;
};

type ResourceConflictTask = {
  id: string;
  projectId: string;
  projectName: string;
  taskCode: string;
  taskName: string;
  startDate: string;
  finishDate: string;
  isCurrentProject: boolean;
};

type ResourceConflictView = {
  id: string;
  ownerKey: string;
  taskIds: string[];
  startDate: string;
  finishDate: string;
  tasks: ResourceConflictTask[];
};

type ResourceScheduleCandidateView = {
  id: string;
  kind: "MINIMAL_CHANGE" | "EARLIEST_FINISH" | "ON_TIME" | "RESOURCE_SMOOTHING";
  title: string;
  explanation: string;
  applicable: boolean;
  changes: Array<{
    taskId: string;
    startDate: string;
    finishDate: string;
    taskMode?: "AUTO" | "DURATION_FORWARD" | "DURATION_BACKWARD";
    task: ResourceConflictTask | null;
  }>;
  remainingConflicts: ResourceConflictView[];
  issues: Array<{
    id: string;
    code: string;
    severity: "WARNING" | "ERROR";
    taskIds: string[];
    message: string;
    suggestion: string;
  }>;
  resourceConstrainedTaskIds: string[];
  metrics: {
    completionDate: string;
    delayedDays: number;
    movedTaskCount: number;
    totalShiftDays: number;
  };
};

type ResourceScheduleAnalysisView = {
  revision: number;
  snapshotHash: string;
  conflicts: ResourceConflictView[];
  issues: Array<{
    id: string;
    code: string;
    severity: "WARNING" | "ERROR";
    taskIds: string[];
    message: string;
    suggestion: string;
  }>;
  candidates: ResourceScheduleCandidateView[];
  scope?: {
    rootTaskIds: string[];
    taskIds: string[];
    modeOverride: ResourceScheduleModeOverride;
  };
};

type ResourceScheduleModeOverride = "PRESERVE" | "AUTO" | "DURATION_FORWARD" | "DURATION_BACKWARD";

type ResourceScheduleRequest = {
  scopeRootTaskIds: string[];
  modeOverride: ResourceScheduleModeOverride;
  scopeLabel: string;
};

const DEFAULT_RESOURCE_SCHEDULE_REQUEST: ResourceScheduleRequest = {
  scopeRootTaskIds: [],
  modeOverride: "PRESERVE",
  scopeLabel: "全部项目叶子任务",
};

/**
 * A scheduling scope is always a non-overlapping parent branch. A parent with
 * direct leaf children is the smallest useful group; otherwise we continue
 * down until reaching such parents. This avoids selecting both an ancestor and
 * descendant and accidentally scheduling the same leaf twice.
 */
const collectAutoScheduleScopeParents = (tasks: ProjectGanttTask[], rootTaskId: string) => {
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const childrenByParentId = new Map<string, string[]>();
  tasks.forEach((task) => {
    if (!task.parentId || !taskById.has(task.parentId)) return;
    childrenByParentId.set(task.parentId, [...(childrenByParentId.get(task.parentId) ?? []), task.id]);
  });
  const visit = (parentId: string, visited = new Set<string>()): string[] => {
    if (visited.has(parentId)) return [];
    visited.add(parentId);
    const childIds = childrenByParentId.get(parentId) ?? [];
    if (childIds.length === 0) return [];
    // If this parent owns any direct leaf, selecting the parent is the only
    // non-overlapping way to include that leaf together with its siblings.
    if (childIds.some((childId) => (childrenByParentId.get(childId) ?? []).length === 0)) return [parentId];
    return childIds.flatMap((childId) => visit(childId, new Set(visited)));
  };
  return [...new Set(visit(rootTaskId))]
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is ProjectGanttTask => Boolean(task));
};

type ManualScheduleImpactView = {
  requiresConfirmation: boolean;
  affectedTaskIds: string[];
  affectedTasks: Array<{
    id: string;
    projectId: string;
    projectName: string;
    taskCode: string;
    taskName: string;
    startDate: string;
    finishDate: string;
    isCurrentProject: boolean;
  }>;
  issues: Array<{
    id: string;
    code: string;
    severity: "WARNING" | "ERROR";
    taskIds: string[];
    message: string;
    suggestion: string;
  }>;
  conflicts: Array<{
    id: string;
    ownerKey: string;
    taskIds: string[];
    startDate: string;
    finishDate: string;
    severity: "WARNING" | "ERROR";
    reason: "CAPACITY_EXCEEDED" | "CONCURRENCY_EXCEEDED";
  }>;
};

type PendingScheduleUpdate = {
  task: ProjectGanttTask;
  draft: GanttTaskDraft;
  columnKey?: string;
  impact: ManualScheduleImpactView;
};

type GanttBaselineBlockerView = {
  code: string;
  message: string;
  taskIds: string[];
};

type GanttBaselineOverviewView = {
  project: {
    ganttBaselineVersion: number;
    ganttBaselineState: "DRAFT" | "PUBLISHED" | "CHANGE_DRAFT" | string;
    ganttBaselinePublishedAt: string | null;
    ganttBaselinePublishedBy: string;
  };
  baseline: {
    id: string;
    version: number;
    status: string;
    sourceRevision: number;
    reason: string;
    createdAt: string;
    createdByName: string;
  } | null;
  draft: {
    id: string;
    baseVersion: number;
    sourceRevision: number;
    status: string;
    reason: string;
    updatedAt: string;
    updatedByName: string;
  } | null;
  validation: {
    projectId: string;
    taskCount: number;
    valid: boolean;
    blockers: GanttBaselineBlockerView[];
  };
  permissions: {
    canPrepareDraft: boolean;
    canPublish: boolean;
    canEditPlanning: boolean;
    canEditActuals: boolean;
    planningMutationBlocker: string | null;
  };
  blockers: GanttBaselineBlockerView[];
};

export const ProjectGanttPanel = ({ projectId, projectStatus }: ProjectGanttPanelProps) => {
  const [tasks, setTasks] = useState<ProjectGanttTask[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [calendarMode, setCalendarMode] = useState<GanttCalendarMode>("CALENDAR_DAYS");
  const [savingCalendarMode, setSavingCalendarMode] = useState(false);
  const [hardFinishDate, setHardFinishDate] = useState("");
  const [savingHardFinishDate, setSavingHardFinishDate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creatingParentId, setCreatingParentId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [hierarchyChanging, setHierarchyChanging] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);
  const [mppExportAvailable, setMppExportAvailable] = useState(false);
  const [importPreview, setImportPreview] = useState<ScheduleImportPreview | null>(null);
  const [importMatchResolutions, setImportMatchResolutions] = useState<Record<string, string>>({});
  const [historySession, setHistorySession] = useState<{ projectId: string; state: GanttHistoryState }>({ projectId: "", state: emptyGanttHistoryState() });
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyFocusRequest, setHistoryFocusRequest] = useState<GanttHistoryFocusRequest | null>(null);
  const [operationError, setOperationError] = useState<{ title: string; message: string } | null>(null);
  const [resourceAnalysis, setResourceAnalysis] = useState<ResourceScheduleAnalysisView | null>(null);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceAnalysisLoading, setResourceAnalysisLoading] = useState(false);
  const [resourceApplyingKind, setResourceApplyingKind] = useState<ResourceScheduleCandidateView["kind"] | null>(null);
  const [resourceScheduleRequest, setResourceScheduleRequest] = useState<ResourceScheduleRequest>(DEFAULT_RESOURCE_SCHEDULE_REQUEST);
  const [autoScheduleScopeTask, setAutoScheduleScopeTask] = useState<ProjectGanttTask | null>(null);
  const [autoScheduleScopeIds, setAutoScheduleScopeIds] = useState<string[]>([]);
  const [autoScheduleModeOverride, setAutoScheduleModeOverride] = useState<ResourceScheduleModeOverride>("PRESERVE");
  const [pendingScheduleUpdate, setPendingScheduleUpdate] = useState<PendingScheduleUpdate | null>(null);
  const [baselineOverview, setBaselineOverview] = useState<GanttBaselineOverviewView | null>(null);
  const [baselineDialogOpen, setBaselineDialogOpen] = useState(false);
  const [baselineReason, setBaselineReason] = useState("");
  const [baselineBusy, setBaselineBusy] = useState(false);
  const historyFocusRequestIdRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const processedAssistantAttachmentId = useRef<string | null>(null);
  const ganttCardRef = useRef<HTMLDivElement>(null);
  const [ganttPortalContainer, setGanttPortalContainer] = useState<HTMLElement | null>(null);
  const setGanttCardElement = useCallback((element: HTMLDivElement | null) => {
    ganttCardRef.current = element;
    setGanttPortalContainer(element);
  }, []);
  const confirm = useConfirm();
  const { can } = usePermission();
  const searchParams = useSearchParams();

  const readOnly = projectStatus === ProjectStatus.COMPLETED || projectStatus === ProjectStatus.VOIDED;
  const canView = can("project-gantt:view");
  const canEditPlanning = can("project-gantt:edit")
    && !readOnly
    && (baselineOverview?.permissions.canEditPlanning ?? true);
  const canEditActuals = can("project-gantt:edit")
    && !readOnly
    && (baselineOverview?.permissions.canEditActuals ?? true);
  const canCreate = can("project-gantt:create") && !readOnly && canEditPlanning;
  const canEdit = canEditPlanning;
  const canDelete = can("project-gantt:delete") && !readOnly && canEditPlanning;
  const canViewBaselineControl = canView;

  const fetchBaselineOverview = useCallback(async () => {
    try {
      const overview = await api.get<GanttBaselineOverviewView>(`/api/projects/${projectId}/gantt-tasks/baseline`);
      if (!overview?.project || !overview.permissions || !overview.validation) {
        setBaselineOverview(null);
        return null;
      }
      setBaselineOverview(overview);
      return overview;
    } catch {
      setBaselineOverview(null);
      return null;
    }
  }, [projectId]);

  const fetchResourceAnalysis = useCallback(async (
    includeCandidates = false,
    request: ResourceScheduleRequest = DEFAULT_RESOURCE_SCHEDULE_REQUEST,
  ) => {
    try {
      const query = new URLSearchParams();
      if (includeCandidates) query.set("includeCandidates", "1");
      request.scopeRootTaskIds.forEach((taskId) => query.append("scopeRootTaskId", taskId));
      if (includeCandidates && request.modeOverride !== "PRESERVE") {
        query.set("modeOverride", request.modeOverride);
      }
      const data = await api.get<ResourceScheduleAnalysisView>(
        `/api/projects/${projectId}/gantt-tasks/resource-schedule${query.size > 0 ? `?${query.toString()}` : ""}`,
      );
      setResourceAnalysis(data);
      return data;
    } catch {
      setResourceAnalysis(null);
      return null;
    }
  }, [projectId]);

  const fetchTasks = useCallback(async ({ showLoading = false, clearOnError = false }: FetchTasksOptions = {}) => {
    if (showLoading) {
      setLoading(true);
    }

    try {
      const data = await api.get<ProjectGanttTask[]>(`/api/projects/${projectId}/gantt-tasks`);
      setTasks(data);
      void fetchResourceAnalysis(false);
      return data;
    } catch {
      if (clearOnError) {
        setTasks([]);
      }
      return [];
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [fetchResourceAnalysis, projectId]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchTasks({ showLoading: true, clearOnError: true }));
  }, [fetchTasks]);

  useEffect(() => {
    const state = typeof window === "undefined"
      ? emptyGanttHistoryState()
      : parseGanttHistoryState(window.sessionStorage.getItem(`ceastar:gantt-history:v1:${projectId}`));
    setHistorySession({ projectId, state });
  }, [projectId]);

  useEffect(() => {
    if (typeof window === "undefined" || historySession.projectId !== projectId) return;
    window.sessionStorage.setItem(`ceastar:gantt-history:v1:${projectId}`, JSON.stringify(historySession.state));
  }, [historySession, projectId]);

  useEffect(() => {
    if (!projectId) return;
    void Promise.all([
      api.get<ProjectMember[]>(`/api/projects/${projectId}/members`).then(setProjectMembers),
      api.get<GanttSettings>(`/api/projects/${projectId}/gantt-settings`).then((settings) => {
        setCalendarMode(settings.calendarMode);
        setHardFinishDate(settings.hardFinishDate || "");
      }),
      fetchBaselineOverview(),
    ]).catch(() => {
      setProjectMembers([]);
      setCalendarMode("CALENDAR_DAYS");
      setHardFinishDate("");
    });
  }, [fetchBaselineOverview, projectId]);

  useEffect(() => {
    if (!projectId) return;
    void api.get<GanttTransferCapabilities>(`/api/projects/${projectId}/gantt-tasks/export`)
      .then((capabilities) => setMppExportAvailable(capabilities.mppExport))
      .catch(() => setMppExportAvailable(false));
  }, [projectId]);

  useEffect(() => {
    const handleFullscreenChange = () => setFullScreen(document.fullscreenElement === ganttCardRef.current);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const currentHistory = historySession.projectId === projectId ? historySession.state : emptyGanttHistoryState();
  const resourceConflictMessagesByTaskId = useMemo(() => {
    const messagesByTaskId = new Map<string, Set<string>>();
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const append = (taskId: string, message: string) => {
      const messages = messagesByTaskId.get(taskId) ?? new Set<string>();
      messages.add(message);
      messagesByTaskId.set(taskId, messages);
    };
    (resourceAnalysis?.conflicts ?? []).forEach((conflict) => {
      const ownerIdentity = conflict.ownerKey.replace(/^(account|person):/, "");
      const ownerName = conflict.ownerKey.startsWith("account:")
        ? projectMembers.find((member) => member.accountId === ownerIdentity)?.personName ?? "同一负责人"
        : ownerIdentity || "同一负责人";
      const involvedTasks = conflict.tasks
        .map((task) => `${task.isCurrentProject ? "" : `${task.projectName} / `}${task.taskCode ? `${task.taskCode} · ` : ""}${task.taskName}`)
        .join("、");
      const message = `${ownerName}在 ${conflict.startDate} 至 ${conflict.finishDate} 的任务发生重叠：${involvedTasks}`;
      conflict.tasks.filter((task) => task.isCurrentProject).forEach((task) => {
        let taskId: string | null = task.id;
        const visited = new Set<string>();
        while (taskId && !visited.has(taskId)) {
          visited.add(taskId);
          append(taskId, message);
          taskId = taskById.get(taskId)?.parentId ?? null;
        }
      });
    });
    (resourceAnalysis?.issues ?? []).forEach((issue) => {
      issue.taskIds.forEach((taskId) => {
        let currentTaskId: string | null = taskId;
        const visited = new Set<string>();
        while (currentTaskId && !visited.has(currentTaskId)) {
          visited.add(currentTaskId);
          append(currentTaskId, issue.message);
          currentTaskId = taskById.get(currentTaskId)?.parentId ?? null;
        }
      });
    });
    return Object.fromEntries(
      Array.from(messagesByTaskId.entries()).map(([taskId, messages]) => [taskId, Array.from(messages)]),
    );
  }, [projectMembers, resourceAnalysis?.conflicts, resourceAnalysis?.issues, tasks]);
  const autoScheduleScopeCandidates = useMemo(() => (
    autoScheduleScopeTask
      ? collectAutoScheduleScopeParents(tasks, autoScheduleScopeTask.id)
      : []
  ), [autoScheduleScopeTask, tasks]);
  const startAutoSchedule = (parentTask: ProjectGanttTask) => {
    const candidates = collectAutoScheduleScopeParents(tasks, parentTask.id);
    if (candidates.length === 0) {
      setOperationError({
        title: "自动排期范围无效",
        message: "只能对包含末级任务的父级任务进行自动排期。",
      });
      return;
    }
    const defaultRequest = (scopeRootTaskIds: string[], scopeLabel: string): ResourceScheduleRequest => ({
      scopeRootTaskIds,
      modeOverride: "PRESERVE",
      scopeLabel,
    });
    if (candidates.length === 1) {
      const scopeTask = candidates[0];
      void openResourceScheduleDialog(defaultRequest(
        [scopeTask.id],
        `${scopeTask.taskCode || "父任务"} · ${scopeTask.taskName || "未命名任务"}及其子任务`,
      ));
      return;
    }
    setAutoScheduleScopeTask(parentTask);
    setAutoScheduleScopeIds(candidates.map((task) => task.id));
    setAutoScheduleModeOverride("PRESERVE");
  };
  const toggleAutoScheduleScopeTask = (taskId: string) => {
    setAutoScheduleScopeIds((current) => current.includes(taskId)
      ? current.filter((id) => id !== taskId)
      : [...current, taskId]);
  };
  const confirmAutoScheduleScope = () => {
    const parentTask = autoScheduleScopeTask;
    if (!parentTask || autoScheduleScopeIds.length === 0) return;
    const selected = autoScheduleScopeCandidates.filter((task) => autoScheduleScopeIds.includes(task.id));
    if (selected.length === 0) return;
    setAutoScheduleScopeTask(null);
    void openResourceScheduleDialog({
      scopeRootTaskIds: selected.map((task) => task.id),
      modeOverride: autoScheduleModeOverride,
      scopeLabel: `${parentTask.taskCode || "父任务"} · ${parentTask.taskName || "未命名任务"}下 ${selected.length} 个末级父任务`,
    });
  };
  const importPreviewDepthById = useMemo(
    () => ganttTaskDepths(importPreview?.previewTasks ?? []),
    [importPreview?.previewTasks],
  );
  const unresolvedSuspiciousMatchCount = useMemo(() => (
    (importPreview?.previewTasks ?? []).filter((task) => (
      task.match?.rule === "AMBIGUOUS" && !importMatchResolutions[task.id]
    )).length
  ), [importMatchResolutions, importPreview?.previewTasks]);
  const blockingImportErrorCount = useMemo(() => (
    (importPreview?.analysis.issues ?? []).filter((issue) => (
      issue.severity === "ERROR" && issue.ruleId !== "SCHEDULE_SUSPICIOUS_MATCH"
    )).length
  ), [importPreview?.analysis.issues]);
  const setCurrentHistory = (updater: (state: GanttHistoryState) => GanttHistoryState) => {
    setHistorySession((current) => ({
      projectId,
      state: updater(current.projectId === projectId ? current.state : emptyGanttHistoryState()),
    }));
  };
  const historySessionId = () => {
    const key = "ceastar:gantt-history-session:v1";
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = createClientId();
    window.sessionStorage.setItem(key, created);
    return created;
  };
  const captureHistorySnapshot = async (label: string) => api.post<GanttHistorySnapshotResult>(
    `/api/projects/${projectId}/gantt-tasks/history/snapshots`,
    { sessionId: historySessionId(), label },
  );
  const signalHistoryTarget = (target: GanttHistoryFocusTarget) => {
    historyFocusRequestIdRef.current += 1;
    setHistoryFocusRequest({ ...target, requestId: historyFocusRequestIdRef.current });
  };
  const commitHistoryEntry = (entry: GanttHistoryEntry) => {
    setCurrentHistory((state) => pushGanttHistoryEntry(state, entry));
  };
  const runWithSnapshotHistory = async <T,>(
    label: string,
    target: GanttHistoryFocusTarget,
    action: () => Promise<T>,
  ): Promise<T> => {
    const before = await captureHistorySnapshot(`${label}:before`);
    const result = await action();
    void captureHistorySnapshot(`${label}:after`).then((after) => {
      commitHistoryEntry({
        id: createClientId(),
        kind: "SNAPSHOT",
        label,
        beforeSnapshotId: before.snapshotId,
        afterSnapshotId: after.snapshotId,
        target,
      });
    }).catch((error) => {
      setOperationError({
        title: "操作已完成，但未能加入撤销历史",
        message: error instanceof Error ? error.message : "保存操作历史失败",
      });
    });
    return result;
  };

  const openResourceScheduleDialog = async (
    request: ResourceScheduleRequest = DEFAULT_RESOURCE_SCHEDULE_REQUEST,
  ) => {
    setResourceScheduleRequest(request);
    setResourceDialogOpen(true);
    setResourceAnalysisLoading(true);
    const analysis = await fetchResourceAnalysis(true, request);
    setResourceAnalysisLoading(false);
    if (!analysis) {
      setResourceDialogOpen(false);
      setOperationError({ title: "资源排期分析失败", message: "无法读取当前资源冲突，请稍后重试" });
    }
  };

  const applyResourceScheduleCandidate = async (candidate: ResourceScheduleCandidateView) => {
    if (!resourceAnalysis || resourceApplyingKind || !canEditPlanning) return;
    setResourceApplyingKind(candidate.kind);
    try {
      await runWithSnapshotHistory(
        `应用${candidate.title}资源排期`,
        { taskIds: candidate.changes.map((change) => change.taskId) },
        async () => {
          await api.post(`/api/projects/${projectId}/gantt-tasks/resource-schedule`, {
            candidateKind: candidate.kind,
            revision: resourceAnalysis.revision,
            snapshotHash: resourceAnalysis.snapshotHash,
            scopeRootTaskIds: resourceScheduleRequest.scopeRootTaskIds,
            modeOverride: resourceScheduleRequest.modeOverride,
          });
          await fetchTasks();
        },
      );
      setResourceDialogOpen(false);
    } catch (error) {
      setOperationError({
        title: "应用资源排期失败",
        message: error instanceof Error ? error.message : "资源排期方案应用失败",
      });
      await fetchResourceAnalysis(true, resourceScheduleRequest);
    } finally {
      setResourceApplyingKind(null);
    }
  };

  const requestImportPreview = useCallback(async ({ file, attachmentId, fileName, hierarchyMode = "AUTO" }: { file?: File; attachmentId?: string; fileName: string; hierarchyMode?: "AUTO" | "FLAT" }) => {
    setImporting(true);
    try {
      const formData = new FormData();
      if (file) formData.append("file", file);
      if (attachmentId) formData.append("attachmentId", attachmentId);
      formData.append("mode", "PREVIEW");
      formData.append("hierarchyMode", hierarchyMode);
      const response = await fetch(`/api/projects/${projectId}/gantt-tasks/import`, {
        method: "POST",
        headers: api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {},
        body: formData,
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "导入失败");
      setImportPreview({ file, attachmentId, fileName, hierarchyMode, ...body.data });
      setImportMatchResolutions({});
    } catch (error) {
      setOperationError({ title: "计划文件解析失败", message: error instanceof Error ? error.message : "导入失败" });
    } finally {
      setImporting(false);
    }
  }, [projectId]);

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    await requestImportPreview({ file, fileName: file.name });
    if (importInputRef.current) importInputRef.current.value = "";
  };

  useEffect(() => {
    const attachmentId = searchParams?.get("scheduleImportAttachmentId")?.trim() || "";
    const hierarchyMode = searchParams?.get("scheduleImportHierarchyMode") === "FLAT" ? "FLAT" : "AUTO";
    if (!attachmentId || processedAssistantAttachmentId.current === attachmentId) return;
    processedAssistantAttachmentId.current = attachmentId;
    void requestImportPreview({ attachmentId, fileName: "智能助手上传的排期文件", hierarchyMode });
  }, [requestImportPreview, searchParams]);

  const applyImport = async (mode: "APPEND" | "MERGE") => {
    if (!importPreview) return;
    setImporting(true);
    try {
      const body = await runWithSnapshotHistory(
        mode === "MERGE" ? "合并更新计划文件" : "追加导入计划文件",
        { taskIds: [] },
        async () => {
          const formData = new FormData();
          if (importPreview.file) formData.append("file", importPreview.file);
          if (importPreview.attachmentId) formData.append("attachmentId", importPreview.attachmentId);
          formData.append("matchResolutions", JSON.stringify(importMatchResolutions));
          formData.append("mode", mode);
          formData.append("hierarchyMode", importPreview.hierarchyMode);
          const response = await fetch(`/api/projects/${projectId}/gantt-tasks/import`, {
            method: "POST",
            headers: api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {},
            body: formData,
          });
          const responseBody = await response.json();
          if (!response.ok || !responseBody.success) throw new Error(responseBody.error || "导入失败");
          await fetchTasks();
          return responseBody;
        },
      );
      setImportPreview(null);
      alert(mode === "MERGE"
        ? `已合并更新 ${body.data.updatedCount} 个任务，新增 ${body.data.createdCount} 个任务`
        : `已追加导入 ${body.data.createdCount} 个任务`);
    } catch (error) {
      setOperationError({ title: "计划导入失败", message: error instanceof Error ? error.message : "导入失败" });
    } finally {
      setImporting(false);
    }
  };

  const handleExport = async (format: "template" | "xlsx" | "xml" | "mpp") => {
    setExportingFormat(format);
    try {
      const response = await fetch(`/api/projects/${projectId}/gantt-tasks/export?format=${format}`, {
        headers: api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {},
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "导出失败");
      }
      const blob = await response.blob();
      const contentDisposition = response.headers.get("Content-Disposition") || "";
      const encodedName = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : `项目进度.${format}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setOperationError({ title: "计划导出失败", message: error instanceof Error ? error.message : "导出失败" });
    } finally {
      setExportingFormat(null);
    }
  };

  const handleNetworkDiagramExport = async (kind: "AON" | "AOA") => {
    setExportingFormat(`network-${kind}`);
    try {
      const response = await fetch(`/api/projects/${projectId}/gantt-tasks/network-diagram?diagram=${kind}`, {
        headers: api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {},
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "网络图导出失败");
      }
      const blob = await response.blob();
      const contentDisposition = response.headers.get("Content-Disposition") || "";
      const encodedName = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : `${kind === "AON" ? "单代号" : "双代号"}网络图.drawio`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setOperationError({ title: "网络图导出失败", message: error instanceof Error ? error.message : "导出失败" });
    } finally {
      setExportingFormat(null);
    }
  };

  const startCreate = async (parentTask?: ProjectGanttTask) => {
    const parentId = parentTask?.id ?? null;
    setCreatingParentId(parentId ?? "root");
    try {
      await runWithSnapshotHistory("新增任务", { taskIds: [], anchorTaskId: parentTask?.id }, async () => {
        const created = await api.post<ProjectGanttTask>(`/api/projects/${projectId}/gantt-tasks`, {
          parentId,
          taskName: "",
          taskDescription: "无",
          startDate: "",
          durationDays: 0,
          taskMode: "AUTO",
          ownerMemberId: null,
          actualStartDate: "",
          actualEndDate: "",
          estimatedWorkHours: 0,
          actualWorkHours: 0,
          progress: 0,
          predecessorTaskIds: [],
          remark: "",
        });
        await fetchTasks();
        signalHistoryTarget({ taskIds: [created.id], columnKey: "taskName" });
        return created;
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "新建失败");
    } finally {
      setCreatingParentId(null);
    }
  };

  const toTaskUpdatePayload = (draft: GanttTaskDraft) => ({
    ...draft,
    // The editor uses `endDate` consistently, while the API and import/export
    // contract use `finishDate`. Send the canonical API key explicitly so a
    // planned-finish edit can never be silently ignored.
    finishDate: draft.endDate,
  });

  const saveTaskUpdate = async (task: ProjectGanttTask, draft: GanttTaskDraft, columnKey?: string) => {
    setSavingTaskId(task.id);
    try {
      let scheduleWarnings: string[] = [];
      await runWithSnapshotHistory("编辑任务字段", { taskIds: [task.id], columnKey }, async () => {
        const saved = await api.put<ProjectGanttTask & { scheduleWarnings?: string[] }>(
          `/api/projects/${projectId}/gantt-tasks/${task.id}`,
          toTaskUpdatePayload(draft),
        );
        scheduleWarnings = saved.scheduleWarnings ?? [];
        await fetchTasks();
      });
      if (draft.taskMode !== "AUTO" && scheduleWarnings.length > 0) {
        setOperationError({
          title: "固定排期干涉提醒",
          message: scheduleWarnings.join("\n"),
        });
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
      await fetchTasks();
    } finally {
      setSavingTaskId(null);
    }
  };

  const handleUpdateTask = async (task: ProjectGanttTask, draft: GanttTaskDraft, columnKey?: string) => {
    const planColumns = new Set(["startDate", "endDate", "durationDays", "priority", "owner", "predecessor"]);
    const isPlanEdit = Boolean(columnKey && planColumns.has(columnKey));
    const hasChildTasks = tasks.some((candidate) => candidate.parentId === task.id);
    // A direct plan edit establishes a deterministic task mode. Editing a
    // summary date also creates a locked boundary, rather than letting the
    // next roll-up overwrite the project manager's explicit window.
    const nextDraft: GanttTaskDraft = isPlanEdit
      ? {
        ...draft,
        taskMode: draft.taskMode === "AUTO"
          ? columnKey === "durationDays"
            ? (draft.startDate ? "DURATION_FORWARD" : draft.endDate ? "DURATION_BACKWARD" : "AUTO")
            : columnKey === "startDate"
              ? (draft.durationDays > 0 ? "DURATION_FORWARD" : draft.endDate ? "DATES_FIXED" : "AUTO")
              : columnKey === "endDate"
                ? (draft.startDate ? "DATES_FIXED" : draft.durationDays > 0 ? "DURATION_BACKWARD" : "AUTO")
                : "AUTO"
          : draft.taskMode,
        parentBoundaryMode: hasChildTasks && draft.parentBoundaryMode === "ROLLUP"
          ? "LOCKED"
          : draft.parentBoundaryMode,
      }
      : draft;
    if (!isValidGanttDurationDays(nextDraft.durationDays) || (
      !nextDraft.startDate
      && nextDraft.durationDays > 0
      && nextDraft.taskMode === "DURATION_FORWARD"
    )) {
      alert("工期留空或按 0.5 天为单位填写；工期固定正排需要计划开始时间");
      return;
    }
    if (nextDraft.taskMode === "DURATION_BACKWARD" && nextDraft.durationDays > 0 && !nextDraft.endDate) {
      alert("工期固定倒排需要计划完成时间");
      return;
    }
    if (nextDraft.taskMode === "DATES_FIXED" && Boolean(nextDraft.startDate) !== Boolean(nextDraft.endDate)) {
      alert("日期固定需要同时填写计划开始和计划完成时间");
      return;
    }
    if (nextDraft.progress < 0 || nextDraft.progress > 100) {
      alert("当前进度必须在 0-100 之间");
      return;
    }
    if (nextDraft.estimatedWorkHours < 0 || nextDraft.actualWorkHours < 0) {
      alert("预计工时和实际工时不能小于 0");
      return;
    }
    try {
      if (isPlanEdit) {
        setSavingTaskId(task.id);
        const impact = await api.put<ManualScheduleImpactView>(
          `/api/projects/${projectId}/gantt-tasks/${task.id}`,
          { ...toTaskUpdatePayload(nextDraft), previewScheduleImpact: true },
        );
        if (impact.requiresConfirmation) {
          setPendingScheduleUpdate({ task, draft: nextDraft, columnKey, impact });
          return;
        }
      }
      await saveTaskUpdate(task, nextDraft, columnKey);
    } catch (error) {
      alert(error instanceof Error ? error.message : "排期影响分析失败");
      await fetchTasks();
    } finally {
      setSavingTaskId(null);
    }
  };

  const handleDeleteSelected = async (selectedIds: string[]) => {
    const selectedTasks = tasks.filter((task) => selectedIds.includes(task.id));
    if (selectedTasks.length === 0) return;
    const confirmed = fullScreen
      ? window.confirm(`确认删除选中的 ${selectedTasks.length} 个甘特任务？`)
      : await confirm(`确认删除选中的 ${selectedTasks.length} 个甘特任务？`);
    if (!confirmed) return;
    const selectedIdSet = new Set(selectedTasks.map((task) => task.id));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const deleteRoots = selectedTasks.filter((task) => {
      let parentId = task.parentId;
      while (parentId) {
        if (selectedIdSet.has(parentId)) return false;
        parentId = taskById.get(parentId)?.parentId ?? null;
      }
      return true;
    });

    setDeletingSelected(true);
    try {
      const result = await api.post<GanttDeleteResult>(`/api/projects/${projectId}/gantt-tasks/deletions`, {
        rootTaskIds: deleteRoots.map((task) => task.id),
      });
      const deletedTaskCount = result.deletedTaskCount ?? 0;
      const detachedWeeklyItemCount = result.detachedWeeklyItemCount ?? 0;
      const affectedRiskCount = result.affectedRiskCount ?? result.detachedRiskCount ?? 0;
      if (result.deletionBatchId) {
        commitHistoryEntry({
          id: createClientId(),
          kind: "DELETION",
          label: "删除任务",
          deletionBatchId: result.deletionBatchId,
          target: { taskIds: deleteRoots.map((task) => task.id), anchorTaskId: deleteRoots[0]?.id },
        });
      }
      if (deletedTaskCount > 0 && (detachedWeeklyItemCount > 0 || affectedRiskCount > 0)) {
        alert("已删除 " + deletedTaskCount + " 条甘特任务，并更新 " + detachedWeeklyItemCount + " 条事项的任务关联、" + affectedRiskCount + " 条风险的受影响任务范围；风险与事项的关联保持不变，可撤销恢复。");
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    } finally {
      await fetchTasks();
      setDeletingSelected(false);
    }
  };

  const handleInsertTasks = async (
    anchorTaskId: string,
    placement: "SIBLING_BEFORE" | "SIBLING_AFTER" | "CHILD_FIRST" | "CHILD_LAST",
    count: number,
  ) => {
    const label = placement.startsWith("CHILD") ? `插入 ${count} 条子任务` : `插入 ${count} 条同级任务`;
    return runWithSnapshotHistory(label, { taskIds: [], anchorTaskId, columnKey: "taskName" }, async () => {
      const result = await api.post<GanttStructureResult>(`/api/projects/${projectId}/gantt-tasks/structure`, {
        operation: "INSERT",
        anchorTaskId,
        placement,
        count,
      });
      setTasks(result.tasks);
      const createdTaskIds = result.createdTaskIds ?? [];
      signalHistoryTarget({ taskIds: createdTaskIds, anchorTaskId, columnKey: "taskName" });
      return { createdTaskIds };
    });
  };

  const handlePasteTasks = async (
    mode: "COPY" | "MOVE",
    sourceTaskIds: string[],
    anchorTaskId: string,
    position: "BEFORE" | "AFTER",
  ) => runWithSnapshotHistory(
    mode === "COPY" ? "复制粘贴任务" : "剪切移动任务",
    { taskIds: sourceTaskIds, anchorTaskId },
    async () => {
      const result = await api.post<GanttStructureResult>(`/api/projects/${projectId}/gantt-tasks/structure`, {
        operation: mode,
        sourceTaskIds,
        anchorTaskId,
        position,
      });
      setTasks(result.tasks);
      const taskIds = mode === "COPY" ? result.createdTaskIds ?? [] : result.movedTaskIds ?? [];
      signalHistoryTarget({ taskIds, anchorTaskId });
      return { taskIds };
    },
  );

  const handleReorderTasks = async (taskIds: string[], movedTaskId?: string) => {
    setTasks((prev) => {
      const taskById = new Map(prev.map((task) => [task.id, task]));
      return renumberGanttTaskCodes(
        taskIds.map((taskId, index) => ({ ...taskById.get(taskId)!, sortOrder: index + 1 }))
      );
    });
    setReordering(true);
    try {
      await runWithSnapshotHistory("拖拽排序任务", { taskIds: movedTaskId ? [movedTaskId] : [] }, async () => {
        await api.put(`/api/projects/${projectId}/gantt-tasks/reorder`, { taskIds });
        await fetchTasks();
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "排序保存失败");
      await fetchTasks();
    } finally {
      setReordering(false);
    }
  };

  const handleChangeHierarchy = async (taskIds: string[], direction: GanttHierarchyDirection) => {
    const optimistic = changeGanttTaskHierarchy(tasks, taskIds, direction);
    if (optimistic.movedTaskIds.length === 0) return;
    setTasks(renumberGanttTaskCodes(synchronizeGanttTaskCategories(optimistic.tasks, optimistic.changedTasks.map((task) => task.id))));
    setHierarchyChanging(true);
    try {
      await runWithSnapshotHistory(direction === "INDENT" ? "任务层级下移" : "任务层级上移", { taskIds: optimistic.movedTaskIds }, async () => {
        const result = await api.put<{ tasks: ProjectGanttTask[]; movedTaskIds: string[]; message: string }>(
          `/api/projects/${projectId}/gantt-tasks/hierarchy`,
          { taskIds, direction },
        );
        setTasks(result.tasks);
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "任务层级调整失败");
      await fetchTasks();
    } finally {
      setHierarchyChanging(false);
    }
  };

  const handleReassignBranch = async (taskId: string, ownerMemberId: string | null) => {
    await runWithSnapshotHistory("分支批量改派负责人", { taskIds: [taskId], columnKey: "owner" }, async () => {
      await api.put(`/api/projects/${projectId}/gantt-tasks/${taskId}`, {
        ownerMemberId,
        ownerChangeMode: "BRANCH_REASSIGN",
      });
      await fetchTasks();
    });
  };

  const toggleFullScreen = async () => {
    const element = ganttCardRef.current;
    if (!element) return;
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else if (fullScreen) setFullScreen(false);
      else await element.requestFullscreen();
    } catch {
      setFullScreen((current) => !current);
    }
  };

  const changeCalendarMode = async (nextMode: GanttCalendarMode) => {
    if (nextMode === calendarMode || savingCalendarMode || !canEdit) return;
    setSavingCalendarMode(true);
    try {
      await runWithSnapshotHistory("修改工期计算方式", { taskIds: [] }, async () => {
        const settings = await api.put<GanttSettings>(`/api/projects/${projectId}/gantt-settings`, {
          calendarMode: nextMode,
        });
        setCalendarMode(settings.calendarMode);
        await fetchTasks();
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "工期计算方式保存失败");
    } finally {
      setSavingCalendarMode(false);
    }
  };

  const changeHardFinishDate = async (nextValue: string) => {
    if (savingHardFinishDate || !canEdit) return;
    const normalized = nextValue.trim();
    setSavingHardFinishDate(true);
    try {
      await runWithSnapshotHistory("修改项目硬完成时间", { taskIds: [] }, async () => {
        const settings = await api.put<GanttSettings>(`/api/projects/${projectId}/gantt-settings`, {
          hardFinishDate: normalized,
        });
        setCalendarMode(settings.calendarMode);
        setHardFinishDate(settings.hardFinishDate || "");
        await fetchTasks();
      });
    } catch (error) {
      setOperationError({
        title: "项目硬完成时间保存失败",
        message: error instanceof Error ? error.message : "保存失败",
      });
      const settings = await api.get<GanttSettings>(`/api/projects/${projectId}/gantt-settings`).catch(() => null);
      if (settings) setHardFinishDate(settings.hardFinishDate || "");
    } finally {
      setSavingHardFinishDate(false);
    }
  };

  const performBaselineAction = async (
    action: "VALIDATE" | "BEGIN_CHANGE" | "PUBLISH" | "REQUEST_APPROVAL",
  ) => {
    if (baselineBusy) return;
    setBaselineBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/gantt-tasks/baseline`, {
        action,
        reason: baselineReason.trim(),
      });
      await Promise.all([fetchTasks(), fetchBaselineOverview()]);
      if (action === "PUBLISH") {
        setBaselineDialogOpen(false);
        setBaselineReason("");
      }
    } catch (error) {
      setOperationError({
        title: action === "PUBLISH" ? "发布 WBS 基线失败" : "WBS 基线操作失败",
        message: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setBaselineBusy(false);
    }
  };

  const handleUndo = async () => {
    const entry = currentHistory.entries[currentHistory.cursor];
    if (!entry || historyBusy) return;
    setHistoryBusy(true);
    try {
      if (entry.kind === "SNAPSHOT") {
        const result = await api.post<GanttRestoreResult>(`/api/projects/${projectId}/gantt-tasks/history/restore`, {
          snapshotId: entry.beforeSnapshotId,
          actionLabel: `撤销：${entry.label}`,
        });
        if (result.warnings?.length) alert(`${result.message}\n\n注意：\n${result.warnings.join("\n")}`);
      } else {
        const result = await api.post<GanttRestoreResult>(`/api/projects/${projectId}/gantt-tasks/deletions/${entry.deletionBatchId}/restore`);
        if (result.warnings?.length) alert(`${result.message}\n\n注意：\n${result.warnings.join("\n")}`);
      }
      await fetchTasks();
      setCurrentHistory((state) => ({ ...state, cursor: Math.max(-1, state.cursor - 1) }));
      signalHistoryTarget(entry.target);
    } catch (error) {
      setOperationError({ title: "撤销失败", message: error instanceof Error ? error.message : "撤销操作失败" });
    } finally {
      setHistoryBusy(false);
    }
  };

  const handleRedo = async () => {
    const entryIndex = currentHistory.cursor + 1;
    const entry = currentHistory.entries[entryIndex];
    if (!entry || historyBusy) return;
    setHistoryBusy(true);
    try {
      if (entry.kind === "SNAPSHOT") {
        const result = await api.post<GanttRestoreResult>(`/api/projects/${projectId}/gantt-tasks/history/restore`, {
          snapshotId: entry.afterSnapshotId,
          actionLabel: `重做：${entry.label}`,
        });
        if (result.warnings?.length) alert(`${result.message}\n\n注意：\n${result.warnings.join("\n")}`);
      } else {
        const result = await api.post<GanttDeleteResult>(`/api/projects/${projectId}/gantt-tasks/deletions/${entry.deletionBatchId}/redo`);
        if (result.deletionBatchId) {
          setCurrentHistory((state) => ({
            ...state,
            entries: state.entries.map((item, index) => index === entryIndex && item.kind === "DELETION"
              ? { ...item, deletionBatchId: result.deletionBatchId! }
              : item),
          }));
        }
      }
      await fetchTasks();
      setCurrentHistory((state) => ({ ...state, cursor: Math.min(state.entries.length - 1, state.cursor + 1) }));
      signalHistoryTarget(entry.target);
    } catch (error) {
      setOperationError({ title: "重做失败", message: error instanceof Error ? error.message : "重做操作失败" });
    } finally {
      setHistoryBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void handleUndo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        void handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  if (!canView) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          当前账号未获得“项目 WBS 管理”查看权限。
        </CardContent>
      </Card>
    );
  }

  const range = getGanttDateRange(tasks);
  const criticalCount = buildGanttRows(tasks).filter((row) => row.isCritical).length;
  const undoEntry = currentHistory.entries[currentHistory.cursor];
  const redoEntry = currentHistory.entries[currentHistory.cursor + 1];
  const resourceAttentionCount = (resourceAnalysis?.conflicts?.length ?? 0) + (resourceAnalysis?.issues?.length ?? 0);
  const baselineState = baselineOverview?.project.ganttBaselineState ?? "DRAFT";
  const baselineStateLabel = baselineState === "PUBLISHED"
    ? `已发布 V${baselineOverview?.project.ganttBaselineVersion ?? 0}`
    : baselineState === "CHANGE_DRAFT"
      ? `变更草案 V${(baselineOverview?.project.ganttBaselineVersion ?? 0) + 1}`
      : "未发布";
  const baselineBlockers = baselineOverview?.validation.blockers ?? [];

  return (
    <div className="space-y-4">
      <Card
        ref={setGanttCardElement}
        className={cn(
          fullScreen && "fixed inset-0 z-[120] flex h-screen w-screen flex-col overflow-hidden rounded-none border-0 bg-background",
        )}
      >
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">项目WBS管理</CardTitle>
            </div>
            <div className="flex flex-wrap items-start justify-end gap-2">
              {range && (
                <div className="mr-1 grid grid-cols-3 gap-3 text-right text-xs">
                  <div>
                    <div className="text-muted-foreground">总工期</div>
                    <div className="font-semibold">{calculateTaskDurationDays(range.startDate, range.endDate, calendarMode)} 天</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">任务数</div>
                    <div className="font-semibold">{tasks.length}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">关键任务</div>
                    <div className="font-semibold text-destructive">{criticalCount}</div>
                  </div>
                </div>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn(
                  "h-8 text-xs",
                  resourceAttentionCount > 0 && "text-destructive hover:bg-destructive/8 hover:text-destructive",
                )}
                disabled={resourceAnalysisLoading}
                onClick={() => void openResourceScheduleDialog()}
                title={resourceAttentionCount > 0 ? "查看资源冲突、排期约束并选择优化方案" : "检查资源容量和排期约束"}
              >
                <WandSparkles className="size-3.5" />
                资源优化 {resourceAttentionCount}
              </Button>
              {(canCreate || canEdit || canDelete) && (
                <div className="flex items-center gap-2" role="group" aria-label="撤销与重做">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={!undoEntry || historyBusy}
                    onClick={() => void handleUndo()}
                    title={undoEntry ? `撤销：${undoEntry.label}` : "没有可撤销的操作"}
                    aria-label="撤销"
                  >
                    <Undo2 className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={!redoEntry || historyBusy}
                    onClick={() => void handleRedo()}
                    title={redoEntry ? `重做：${redoEntry.label}` : "没有可重做的操作"}
                    aria-label="重做"
                  >
                    <Redo2 className="size-3.5" />
                  </Button>
                </div>
              )}
              <div
                className="inline-flex h-8 items-stretch"
                role="group"
                aria-label="工期计算方式"
                title="工作日按中国法定节假日及调休日历计算，每天 7.5 小时"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn(
                    "h-8 rounded-r-none px-3 text-xs shadow-none",
                    calendarMode === "CALENDAR_DAYS"
                      ? "z-10 border-primary/45 bg-primary/10 text-foreground"
                      : "bg-background/35 text-muted-foreground",
                  )}
                  aria-pressed={calendarMode === "CALENDAR_DAYS"}
                  disabled={!canEdit || savingCalendarMode}
                  onClick={() => void changeCalendarMode("CALENDAR_DAYS")}
                >
                  <CalendarDays className="size-3.5" />自然日
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn(
                    "-ml-px h-8 rounded-l-none px-3 text-xs shadow-none",
                    calendarMode === "WORKING_DAYS"
                      ? "z-10 border-primary/45 bg-primary/10 text-foreground"
                      : "bg-background/35 text-muted-foreground",
                  )}
                  aria-pressed={calendarMode === "WORKING_DAYS"}
                  disabled={!canEdit || savingCalendarMode}
                  onClick={() => void changeCalendarMode("WORKING_DAYS")}
                >
                  <BriefcaseBusiness className="size-3.5" />工作日
                </Button>
              </div>
              <label className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-background/35 px-2 text-xs text-muted-foreground" title="设置后，任何任务及其子任务都不能超过该完成日期；存在冲突时不能发布基线">
                <span className="whitespace-nowrap">项目硬完成</span>
                <Input
                  type="date"
                  value={hardFinishDate}
                  onChange={(event) => setHardFinishDate(event.target.value)}
                  onBlur={(event) => void changeHardFinishDate(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      void api.get<GanttSettings>(`/api/projects/${projectId}/gantt-settings`)
                        .then((settings) => setHardFinishDate(settings.hardFinishDate || ""));
                      event.currentTarget.blur();
                    }
                  }}
                  className="h-6 w-[132px] border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                  disabled={!canEdit || savingHardFinishDate}
                  aria-label="项目硬完成时间"
                />
              </label>
              {canCreate && (
                <>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".mpp,.xml,.xls,.xlsx,.csv,.md,.txt,.docx,.pdf"
                    className="hidden"
                    onChange={(event) => void handleImportFile(event.target.files?.[0])}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={importing}
                    onClick={() => importInputRef.current?.click()}
                    title="支持 MPP、Project XML 和 Excel，导入时追加到现有任务"
                  >
                    <Download className="size-3.5" /> {importing ? "导入中..." : "导入"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2 text-xs text-muted-foreground"
                    disabled={Boolean(exportingFormat)}
                    onClick={() => void handleExport("template")}
                    title="下载符合系统字段的 Excel 导入模板"
                  >
                    <Download className="size-3.5" /> 下载模板
                  </Button>
                </>
              )}
              {canViewBaselineControl && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={baselineBusy}
                  onClick={() => {
                    setBaselineDialogOpen(true);
                    void fetchBaselineOverview();
                  }}
                  title="查看 WBS 基线校验结果、发布状态和变更权限"
                >
                  <FlagTriangleRight className="size-3.5" /> {baselineState === "PUBLISHED" ? `基线 V${baselineOverview?.project.ganttBaselineVersion ?? 0}` : "发布基线"}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={Boolean(exportingFormat)}>
                    <Upload className="size-3.5" /> {exportingFormat ? "导出中..." : "导出"}<ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent container={fullScreen ? ganttPortalContainer : undefined} align="end" className="w-56">
                  <DropdownMenuItem onClick={() => void handleExport("xlsx")}>
                    <FileSpreadsheet className="size-4" /> Excel 工作簿
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleExport("xml")}>
                    <FileType2 className="size-4" /> Microsoft Project XML
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!mppExportAvailable} onClick={() => void handleExport("mpp")}>
                    <FileType2 className="size-4" /> MPP 文件{mppExportAvailable ? "" : "（需安装 Microsoft Project 转换服务）"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>网络图（Draw.io）</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("AON")}>
                    <Network className="size-4" /> 单代号网络图（活动节点）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("AOA")}>
                    <Network className="size-4" /> 双代号网络图（活动箭线）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-8"
                onClick={() => void toggleFullScreen()}
                title={fullScreen ? "退出全屏" : "全屏编辑"}
                aria-label={fullScreen ? "退出全屏" : "全屏编辑"}
              >
                {fullScreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className={cn("pb-0", fullScreen && "min-h-0 flex-1 overflow-hidden px-3")}>
          <GanttTimeline
            canCreate={canCreate}
            canDelete={canDelete}
            canEdit={canEdit}
            canEditActuals={canEditActuals}
            allowCompletedTaskReopen={canEditPlanning && baselineState === "CHANGE_DRAFT"}
            creatingParentId={creatingParentId}
            deletingSelected={deletingSelected}
            fullScreen={fullScreen}
            portalContainer={fullScreen ? ganttPortalContainer : undefined}
            calendarMode={calendarMode}
            hierarchyChanging={hierarchyChanging}
            historyFocusRequest={historyFocusRequest}
            onChangeHierarchy={handleChangeHierarchy}
            onAutoSchedule={startAutoSchedule}
            onCreateTask={startCreate}
            onDeleteSelected={handleDeleteSelected}
            onInsertTasks={handleInsertTasks}
            onPasteTasks={handlePasteTasks}
            onActionError={(message) => setOperationError({ title: "甘特任务操作失败", message })}
            onReorderTasks={handleReorderTasks}
            onReassignBranch={handleReassignBranch}
            onUpdateTask={handleUpdateTask}
            projectId={projectId}
            projectMembers={projectMembers}
            reordering={reordering}
            resourceConflictMessagesByTaskId={resourceConflictMessagesByTaskId}
            savingTaskId={savingTaskId}
            tasks={tasks}
          />
        </CardContent>
      </Card>
      <Dialog
        open={baselineDialogOpen}
        onOpenChange={(open) => {
          if (!baselineBusy) setBaselineDialogOpen(open);
        }}
      >
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>WBS 基线管理</DialogTitle>
            <DialogDescription>
              基线发布前可自由调整计划。发布后任务结构、计划日期、工期、负责人、依赖关系和项目硬完成时间将锁定；实际工时、实际日期和进度仍可持续更新。
            </DialogDescription>
          </DialogHeader>
          {!baselineOverview ? (
            <div className="rounded-md border border-destructive/35 bg-destructive/5 px-3 py-4 text-sm">
              未能读取当前 WBS 基线状态。请重新打开此窗口或检查“项目 WBS 管理”查看权限。
            </div>
          ) : (
            <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1 text-sm">
              <section className="grid gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-muted-foreground">当前状态</div>
                  <div className="mt-1 font-medium">{baselineStateLabel}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">当前计划修订</div>
                  <div className="mt-1 font-medium">{baselineOverview.baseline?.sourceRevision ?? baselineOverview.draft?.sourceRevision ?? "尚未发布"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">计划编辑权限</div>
                  <div className="mt-1 font-medium">{baselineOverview.permissions.canEditPlanning ? "允许编辑" : "已锁定"}</div>
                </div>
                {baselineOverview.project.ganttBaselinePublishedAt && (
                  <div className="sm:col-span-3 text-xs text-muted-foreground">
                    最近发布：{new Date(baselineOverview.project.ganttBaselinePublishedAt).toLocaleString("zh-CN")} · {baselineOverview.project.ganttBaselinePublishedBy || "系统"}
                  </div>
                )}
              </section>
              {baselineOverview.permissions.planningMutationBlocker && (
                <section className="rounded-md border border-amber-500/35 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  {baselineOverview.permissions.planningMutationBlocker}
                </section>
              )}
              <section className={cn(
                "rounded-md border p-3",
                baselineBlockers.length > 0 ? "border-destructive/35 bg-destructive/5" : "border-emerald-500/30 bg-emerald-500/5",
              )}>
                <div className={cn("font-medium", baselineBlockers.length > 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
                  发布校验 {baselineBlockers.length > 0 ? `未通过：${baselineBlockers.length} 项阻断` : "已通过"}
                </div>
                {baselineBlockers.length > 0 ? (
                  <ul className="mt-2 space-y-2 text-xs leading-5">
                    {baselineBlockers.map((blocker) => (
                      <li key={`${blocker.code}-${blocker.taskIds.join("-")}`}>
                        <div>{blocker.message}</div>
                        {blocker.taskIds.length > 0 && <div className="text-muted-foreground">涉及 {blocker.taskIds.length} 个任务</div>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">当前 WBS 满足支持的依赖关系和硬边界规则，可以发布为新的基线版本。</p>
                )}
              </section>
              {(baselineOverview.permissions.canPrepareDraft || baselineOverview.permissions.canPublish) && (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium">基线说明</span>
                  <Input
                    value={baselineReason}
                    onChange={(event) => setBaselineReason(event.target.value)}
                    placeholder={baselineState === "PUBLISHED" ? "说明此次变更原因" : "说明本次基线范围或版本说明（可选）"}
                    className="h-8 text-xs"
                    disabled={baselineBusy}
                  />
                </label>
              )}
              {baselineOverview.draft && (
                <section className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 text-xs leading-5">
                  <div className="font-medium">变更草案</div>
                  <div className="mt-1 text-muted-foreground">
                    基于 V{baselineOverview.draft.baseVersion}，由 {baselineOverview.draft.updatedByName || "项目经理"} 维护。
                    {baselineOverview.draft.reason ? ` ${baselineOverview.draft.reason}` : ""}
                  </div>
                </section>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={baselineBusy}
              onClick={() => void performBaselineAction("VALIDATE")}
            >
              重新校验
            </Button>
            {baselineOverview?.permissions.canPrepareDraft && baselineState === "PUBLISHED" && (
              <Button
                type="button"
                variant="outline"
                disabled={baselineBusy}
                onClick={() => void performBaselineAction("BEGIN_CHANGE")}
              >
                创建变更草案
              </Button>
            )}
            {baselineOverview && !baselineOverview.permissions.canPublish && can("project-gantt:baseline-request") && (
              <Button
                type="button"
                variant="outline"
                disabled={baselineBusy}
                onClick={() => void performBaselineAction("REQUEST_APPROVAL")}
              >
                申请发布审批
              </Button>
            )}
            {baselineOverview?.permissions.canPublish && baselineState !== "PUBLISHED" && (
              <Button
                type="button"
                disabled={baselineBusy || baselineBlockers.length > 0}
                onClick={() => void performBaselineAction("PUBLISH")}
              >
                {baselineState === "CHANGE_DRAFT" ? "发布变更基线" : "发布基线"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingScheduleUpdate)}
        onOpenChange={(open) => {
          if (open || !pendingScheduleUpdate) return;
          setPendingScheduleUpdate(null);
          void fetchTasks();
        }}
      >
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-xl">
          <DialogHeader>
            <DialogTitle>确认手动排期影响</DialogTitle>
            <DialogDescription>
              此次修改会作为手动排期约束保留。系统不会替换您输入的日期，但会按紧前关系重新计算后续自动任务，并保留冲突提示。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1 text-sm">
            {(pendingScheduleUpdate?.impact.affectedTasks.length ?? 0) > 1 && (
              <section className="rounded-md border border-border/70 p-3">
                <div className="font-medium">可能受影响的后续任务</div>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {pendingScheduleUpdate?.impact.affectedTasks
                    .filter((item) => item.id !== pendingScheduleUpdate?.task.id)
                    .slice(0, 8)
                    .map((item) => (
                      <li key={item.id}>{item.taskCode || "任务"} · {item.taskName || "未命名任务"}</li>
                    ))}
                  {(pendingScheduleUpdate?.impact.affectedTasks.length ?? 0) > 9 && (
                    <li>另有 {(pendingScheduleUpdate?.impact.affectedTasks.length ?? 0) - 9} 个后续任务</li>
                  )}
                </ul>
              </section>
            )}
            {(pendingScheduleUpdate?.impact.issues.length ?? 0) > 0 && (
              <section className="rounded-md border border-amber-500/35 bg-amber-500/5 p-3">
                <div className="font-medium text-amber-700 dark:text-amber-400">排期约束</div>
                <ul className="mt-2 space-y-2 text-xs leading-5">
                  {pendingScheduleUpdate?.impact.issues.slice(0, 6).map((issue) => (
                    <li key={issue.id}>
                      <div>{issue.message}</div>
                      <div className="text-muted-foreground">{issue.suggestion}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(pendingScheduleUpdate?.impact.conflicts.length ?? 0) > 0 && (
              <section className="rounded-md border border-destructive/35 bg-destructive/5 p-3">
                <div className="font-medium text-destructive">负责人容量或并发冲突</div>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {pendingScheduleUpdate?.impact.conflicts.slice(0, 6).map((conflict) => (
                    <li key={conflict.id}>{conflict.startDate} 至 {conflict.finishDate} · {conflict.reason === "CAPACITY_EXCEEDED" ? "容量超限" : "并发超限"}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => {
              setPendingScheduleUpdate(null);
              void fetchTasks();
            }}>取消修改</Button>
            <Button
              type="button"
              disabled={Boolean(savingTaskId)}
              onClick={() => {
                const pending = pendingScheduleUpdate;
                if (!pending) return;
                setPendingScheduleUpdate(null);
                void saveTaskUpdate(pending.task, pending.draft, pending.columnKey);
              }}
            >
              仍按此日期保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(autoScheduleScopeTask)}
        onOpenChange={(open) => {
          if (!open) setAutoScheduleScopeTask(null);
        }}
      >
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-xl">
          <DialogHeader>
            <DialogTitle>选择自动排期范围</DialogTitle>
            <DialogDescription>
              只会计算所选末级父任务下的叶子任务。未选分支保留当前日期并继续占用负责人容量，不会被本次自动排期移动。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <section className="rounded-md border border-border/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-medium">影响范围</span>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setAutoScheduleScopeIds(autoScheduleScopeCandidates.map((task) => task.id))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setAutoScheduleScopeIds([])}
                  >
                    清空
                  </button>
                </div>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {autoScheduleScopeCandidates.map((task) => (
                  <label
                    key={task.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm transition-colors hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={autoScheduleScopeIds.includes(task.id)}
                      onChange={() => toggleAutoScheduleScopeTask(task.id)}
                      className="size-4 accent-primary"
                    />
                    <span className="min-w-0 truncate" title={`${task.taskCode} · ${task.taskName}`}>
                      <span className="font-mono text-xs text-muted-foreground">{task.taskCode}</span>
                      <span className="mx-1 text-muted-foreground">·</span>
                      <span>{task.taskName || "未命名任务"}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">已选择 {autoScheduleScopeIds.length} 个末级父任务</div>
            </section>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">子任务排期方式</span>
              <Select
                value={autoScheduleModeOverride}
                onChange={(event) => setAutoScheduleModeOverride(event.target.value as ResourceScheduleModeOverride)}
                className="h-9 text-sm"
              >
                <option value="PRESERVE">保留现有方式，仅排期自动任务</option>
                <option value="AUTO">覆盖为自动排期</option>
                <option value="DURATION_FORWARD">覆盖为工期固定 · 正排</option>
                <option value="DURATION_BACKWARD">覆盖为工期固定 · 倒排</option>
              </Select>
              <span className="block text-xs leading-5 text-muted-foreground">日期固定、已经开始和已完成任务始终保留，不会被覆盖。</span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAutoScheduleScopeTask(null)}>取消</Button>
            <Button type="button" disabled={autoScheduleScopeIds.length === 0} onClick={confirmAutoScheduleScope}>计算方案</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={resourceDialogOpen} onOpenChange={(open) => !resourceApplyingKind && setResourceDialogOpen(open)}>
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>资源冲突与优化排期</DialogTitle>
            <DialogDescription>
              排期范围：{resourceScheduleRequest.scopeLabel}。自动排期只移动当前项目尚未开始的范围内叶子任务；日期固定、进行中和已完成任务不会移动，范围外任务会继续占用负责人容量。系统会先校验负责人、工期、计划锚点、紧前关系和父级硬边界，再给出可应用方案；应用后可通过 WBS 顶部撤销按钮恢复。
            </DialogDescription>
          </DialogHeader>
          {resourceAnalysisLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">正在计算候选方案...</div>
          ) : (
            <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
              <div className="flex items-center gap-2 border-b border-border/70 pb-3 text-sm">
                <TriangleAlert className={cn("size-4", resourceAttentionCount > 0 ? "text-destructive" : "text-muted-foreground")} />
                <span>
                  资源冲突 {resourceAnalysis?.conflicts?.length ?? 0} 组，排期约束告警 {resourceAnalysis?.issues?.length ?? 0} 条
                </span>
              </div>
              {(resourceAnalysis?.issues?.length ?? 0) > 0 && (
                <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                  {resourceAnalysis?.issues.slice(0, 8).map((issue) => (
                    <div key={issue.id} className="flex gap-2">
                      <TriangleAlert className={cn("mt-0.5 size-3.5 shrink-0", issue.severity === "ERROR" ? "text-destructive" : "text-amber-500")} />
                      <div>
                        <div>{issue.message}</div>
                        <div className="mt-0.5 text-muted-foreground">{issue.suggestion}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {(resourceAnalysis?.candidates ?? []).map((candidate) => (
                  <section key={candidate.kind} className="flex min-h-[220px] flex-col rounded-md border border-border/70 p-4">
                    <div className="text-sm font-semibold">{candidate.title}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{candidate.explanation}</p>
                    <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <dt className="text-muted-foreground">调整任务</dt>
                      <dd className="text-right font-medium">{candidate.metrics.movedTaskCount}</dd>
                      <dt className="text-muted-foreground">累计移动</dt>
                      <dd className="text-right font-medium">{candidate.metrics.totalShiftDays} 天</dd>
                      <dt className="text-muted-foreground">预计完成</dt>
                      <dd className="text-right font-medium">{candidate.metrics.completionDate || "-"}</dd>
                      <dt className="text-muted-foreground">剩余冲突</dt>
                      <dd className="text-right font-medium text-destructive">{candidate.remainingConflicts.length}</dd>
                      <dt className="text-muted-foreground">资源约束链</dt>
                      <dd className="text-right font-medium">{candidate.resourceConstrainedTaskIds.length}</dd>
                    </dl>
                    {candidate.changes.length > 0 && (
                      <div className="mt-3 border-t border-border/60 pt-3">
                        <div className="text-[11px] font-medium text-muted-foreground">调整预览</div>
                        <ul className="mt-1 space-y-1 text-[11px] leading-4">
                          {candidate.changes.slice(0, 4).map((change) => (
                            <li key={change.taskId} className="min-w-0">
                              <span className="block truncate" title={`${change.task?.taskCode || ""} ${change.task?.taskName || "任务"}`}>
                                {change.task?.taskCode || "任务"} · {change.task?.taskName || "未命名"}
                              </span>
                              <span className="text-muted-foreground">→ {change.startDate} 至 {change.finishDate}</span>
                            </li>
                          ))}
                          {candidate.changes.length > 4 && <li className="text-muted-foreground">另有 {candidate.changes.length - 4} 个任务</li>}
                        </ul>
                      </div>
                    )}
                    {candidate.issues.length > 0 && (
                      <div className="mt-3 text-[11px] leading-4 text-amber-600 dark:text-amber-400">
                        {candidate.issues.find((issue) => issue.severity === "ERROR")?.message
                          ?? candidate.issues[0]?.message}
                      </div>
                    )}
                    {!candidate.applicable && (
                      <p className="mt-3 text-xs leading-5 text-amber-500">
                        手工排程、进行中任务或其他项目占用使此方案无法减少冲突，请先调整这些约束。
                      </p>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      className="mt-auto w-full"
                      disabled={!candidate.applicable || Boolean(resourceApplyingKind) || !canEditPlanning}
                      onClick={() => void applyResourceScheduleCandidate(candidate)}
                    >
                      {resourceApplyingKind === candidate.kind ? "应用中..." : "应用此方案"}
                    </Button>
                  </section>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={Boolean(resourceApplyingKind)} onClick={() => setResourceDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(importPreview)} onOpenChange={(open) => !open && !importing && setImportPreview(null)}>
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>计划导入预览</DialogTitle>
            <DialogDescription>
              已分析 {importPreview?.fileName}，当前计划尚未修改。稳定任务 ID、外部 UID 或唯一 WBS 会自动匹配；仅名称相同的任务必须先人工确认，不能直接覆盖。
            </DialogDescription>
          </DialogHeader>
          {importPreview && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border text-center text-xs sm:grid-cols-4 lg:grid-cols-8">
                {[
                  ["当前任务", importPreview.analysis.summary.currentTasks],
                  ["文件任务", importPreview.analysis.summary.incomingTasks],
                  ["已匹配", importPreview.analysis.summary.matched],
                  ["新增", importPreview.analysis.summary.added],
                  ["删除候选", importPreview.analysis.summary.removedCandidates],
                  ["字段变化", importPreview.analysis.summary.changedFields],
                  ["错误", importPreview.analysis.summary.errors],
                  ["警告", importPreview.analysis.summary.warnings],
                ].map(([label, value]) => (
                  <div key={String(label)} className="bg-background px-2 py-3">
                    <div className="text-muted-foreground">{label}</div>
                    <div className="mt-1 text-base font-semibold">{value}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-transparent px-3 py-2">
                <div>
                  <div className="text-xs font-medium">导入层级方式</div>
                  <div className="text-[11px] text-muted-foreground">切换后会重新生成完整预览，不会修改当前 WBS。</div>
                </div>
                <Select
                  value={importPreview.hierarchyMode}
                  onChange={(event) => {
                    const hierarchyMode = event.target.value === "FLAT" ? "FLAT" : "AUTO";
                    void requestImportPreview({
                      file: importPreview.file,
                      attachmentId: importPreview.attachmentId,
                      fileName: importPreview.fileName,
                      hierarchyMode,
                    });
                  }}
                  className="h-8 w-[210px] text-xs"
                  aria-label="导入层级方式"
                  disabled={importing}
                >
                  <option value="AUTO">按文件分类生成 WBS 层级</option>
                  <option value="FLAT">保持扁平任务</option>
                </Select>
              </div>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
                <div className="overflow-hidden rounded-md border border-border">
                  <div className="grid grid-cols-[minmax(260px,1fr)_110px_110px_72px_110px] border-b border-border bg-muted/45 px-2 py-2 text-[11px] font-medium text-muted-foreground">
                    <span>导入后的 WBS 层级预览</span><span>计划开始</span><span>计划完成</span><span>工期</span><span>匹配结果</span>
                  </div>
                  <div className="max-h-80 overflow-auto">
                    {importPreview.previewTasks.map((task) => (
                      <div key={task.id} className="grid grid-cols-[minmax(260px,1fr)_110px_110px_72px_110px] items-center border-b border-border/70 px-2 py-1.5 text-xs last:border-b-0">
                        <div className="min-w-0 truncate" style={{ paddingLeft: `${(importPreviewDepthById.get(task.id) ?? 0) * 18}px` }} title={`${task.taskCode} · ${task.taskName}`}>
                          <span className="font-mono text-[10px] text-muted-foreground">{task.taskCode}</span>
                          {task.isMilestone && <span className="mx-1 text-amber-400">★</span>}
                          <span className="ml-1 font-medium">{task.taskName}</span>
                        </div>
                        <span className="font-mono text-[11px]">{task.startDate || "-"}</span>
                        <span className="font-mono text-[11px]">{task.finishDate || "-"}</span>
                        <span>{task.durationDays} 天</span>
                        {task.match?.rule === "AMBIGUOUS" ? (
                          <select
                            value={importMatchResolutions[task.id] ?? ""}
                            onChange={(event) => setImportMatchResolutions((current) => ({ ...current, [task.id]: event.target.value }))}
                            className="h-7 min-w-0 rounded border border-destructive/45 bg-background px-1 text-[11px] text-foreground"
                            aria-label={`选择${task.taskName}的匹配方式`}
                          >
                            <option value="">请选择</option>
                            <option value="__new__">作为新任务</option>
                            {(task.match.candidateTasks ?? []).map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>{candidate.taskCode} · {candidate.taskName}</option>
                            ))}
                          </select>
                        ) : (
                          <span className={cn("truncate text-[11px]", task.match?.currentTaskId ? "text-primary" : "text-emerald-500")}>
                            {task.match?.currentTaskId ? "更新现有任务" : "新增任务"}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-md border border-border">
                    <div className="border-b border-border bg-muted/45 px-3 py-2 text-xs font-medium">字段映射</div>
                    {importPreview.fieldMappings.map((mapping) => (
                      <div key={`${mapping.source}-${mapping.target}`} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border/70 px-3 py-2 text-[11px] last:border-b-0">
                        <span className="truncate text-muted-foreground" title={mapping.source}>{mapping.source}</span>
                        <span>→</span>
                        <span className="truncate" title={mapping.target}>{mapping.target}{mapping.required ? " *" : ""}</span>
                      </div>
                    ))}
                  </div>
                  <div className="max-h-52 overflow-y-auto rounded-md border border-border">
                    {(importPreview.sourceWarnings ?? []).map((warning, index) => (
                      <div key={`source-warning-${index}`} className="border-b border-border px-3 py-2.5 last:border-b-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-amber-500">源文件提示</span>
                          <span className="font-medium">{warning.taskName || warning.sourceFile}</span>
                          <span>{warning.message}</span>
                        </div>
                      </div>
                    ))}
                    {importPreview.analysis.issues.length === 0 && (importPreview.sourceWarnings ?? []).length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-muted-foreground">未发现结构性冲突</div>
                    ) : importPreview.analysis.issues.slice(0, 50).map((issue, index) => (
                      <div key={`${issue.ruleId}-${index}`} className="border-b border-border px-3 py-2.5 last:border-b-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className={issue.severity === "ERROR" ? "font-semibold text-destructive" : "font-semibold text-amber-500"}>
                            {issue.severity === "ERROR" ? "错误" : issue.severity === "WARNING" ? "警告" : "提示"}
                          </span>
                          <span className="font-medium">{issue.taskCodes.filter(Boolean).join("、") || "计划整体"}</span>
                          <span>{issue.message}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">{issue.suggestion}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={importing} onClick={() => setImportPreview(null)}>取消</Button>
            <Button variant="outline" disabled={importing || blockingImportErrorCount > 0} onClick={() => void applyImport("APPEND")}>追加为新任务</Button>
            <Button disabled={importing || blockingImportErrorCount > 0 || unresolvedSuspiciousMatchCount > 0} onClick={() => void applyImport("MERGE")}>
              {importing ? "正在应用..." : "合并更新"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <OperationErrorDialog
        open={Boolean(operationError)}
        title={operationError?.title || "操作失败"}
        message={operationError?.message || "未知错误"}
        container={fullScreen ? ganttPortalContainer : undefined}
        onOpenChange={(open) => !open && setOperationError(null)}
      />
    </div>
  );
};
