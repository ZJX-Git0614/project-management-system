"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BriefcaseBusiness, CalendarDays, ChevronDown, Download, FileSpreadsheet, FileType2, FlagTriangleRight, ListTree, LockKeyhole, Maximize2, Minimize2, Network, Redo2, TriangleAlert, Undo2, Upload, Users, WandSparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GanttDateField } from "@/components/gantt-date-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { ResourceSwimlaneView, ScheduleCalendarView } from "@/components/gantt-schedule-views";
import { OperationErrorDialog } from "@/components/operation-error-dialog";
import { useConfirm } from "@/components/confirm-provider";
import { useSystemFeedback } from "@/components/system-feedback-provider";
import { usePermission } from "@/lib/use-permission";
import { api } from "@/lib/api-client";
import { buildGanttRows, getGanttDateRange } from "@/lib/gantt";
import {
  calculateTaskDurationDays,
  isValidGanttDurationDays,
  type GanttCalendarMode,
} from "@/lib/gantt-calendar";
import { formatGanttRelativeOffset } from "@/lib/gantt-relative-time";
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
  forceFresh?: boolean;
  refreshResourceAnalysis?: boolean;
}

interface GanttTransferCapabilities {
  mppExport: boolean;
}

interface GanttSettings {
  calendarMode: GanttCalendarMode;
  hoursPerDay: number;
  /** Optional backward-scheduling anchor. Stored in the legacy hard-finish column. */
  wbsFinishDate: string;
  projectStartDate: string;
  /** Backward compatibility for a client that has not yet switched to wbsFinishDate. */
  hardFinishDate?: string;
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

interface GanttHistorySnapshotCapture {
  snapshot: GanttHistorySnapshotResult | null;
  warning: string | null;
}

export interface GanttHistoryFocusRequest extends GanttHistoryFocusTarget {
  requestId: number;
}

let fallbackClientIdSequence = 0;
const GANTT_HISTORY_SNAPSHOT_TIMEOUT_MS = 5_000;
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
  kind: "FORMAL";
  title: string;
  explanation: string;
  relativeSchedule: boolean;
  applicable: boolean;
  changes: Array<{
    taskId: string;
    startDate: string;
    finishDate: string;
    relativeStartOffsetDays?: number | null;
    relativeFinishOffsetDays?: number | null;
    durationDays?: number;
    durationMinutes?: number;
    estimatedWorkHours?: number;
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
  resourceCriticalChainTaskIds: string[];
  resourceCriticalChainLinks: Array<{
    predecessorTaskId: string;
    successorTaskId: string;
    ownerKey: string;
  }>;
  criticalTaskIds: string[];
  taskExplanations: Array<{
    taskId: string;
    startDate: string;
    finishDate: string;
    relativeStartOffsetDays?: number | null;
    relativeFinishOffsetDays?: number | null;
    initialTotalFloatDays: number | null;
    finalTotalFloatDays: number | null;
    isCritical: boolean;
    resourceConstrained: boolean;
    resourceCritical: boolean;
    reasonCodes: string[];
    summary: string;
    details: string[];
  }>;
  metrics: {
    completionDate: string;
    relativeCompletionOffsetDays?: number | null;
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
  durationSuggestions: Array<{
    taskId: string;
    parentTaskId: string;
    ownerKey: string;
    suggestedDurationDays: number;
    source: "SYSTEM_SUGGESTED";
    reason: string;
  }>;
  durationSuggestionIssues: Array<{
    id: string;
    taskIds: string[];
    code: string;
    message: string;
  }>;
  scope?: {
    rootTaskIds: string[];
    taskIds: string[];
    modeOverride: ResourceScheduleModeOverride;
  };
};

type ResourceAnalysisRequestContext = {
  requestId: number;
  projectId: string;
};

type ResourceAnalysisFetchResult = {
  data: ResourceScheduleAnalysisView | null;
  isCurrent: boolean;
};

type ResourceScheduleModeOverride = "PRESERVE" | "AUTO" | "DURATION_FORWARD" | "DURATION_BACKWARD";

type ResourceScheduleRequest = {
  scopeRootTaskIds: string[];
  modeOverride: ResourceScheduleModeOverride;
  scopeLabel: string;
  /** A calendar switch is previewed first and persisted only when a candidate is applied. */
  calendarModeOverride?: GanttCalendarMode;
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
  const [projectStartDate, setProjectStartDate] = useState("");
  const [wbsFinishDate, setWbsFinishDate] = useState("");
  const [savingScheduleAnchor, setSavingScheduleAnchor] = useState(false);
  const scheduleAnchorSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const [loading, setLoading] = useState(true);
  const [creatingParentId, setCreatingParentId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [hierarchyChanging, setHierarchyChanging] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [scheduleView, setScheduleView] = useState<"WBS" | "RESOURCE" | "CALENDAR">("WBS");
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
  const [boundaryResolvingTaskId, setBoundaryResolvingTaskId] = useState<string | null>(null);
  const [durationSuggestionsApplying, setDurationSuggestionsApplying] = useState(false);
  const [selectedDurationSuggestionIds, setSelectedDurationSuggestionIds] = useState<string[]>([]);
  const [resourceScheduleRequest, setResourceScheduleRequest] = useState<ResourceScheduleRequest>(DEFAULT_RESOURCE_SCHEDULE_REQUEST);
  const [autoScheduleScopeTask, setAutoScheduleScopeTask] = useState<ProjectGanttTask | null>(null);
  const [autoScheduleScopeIds, setAutoScheduleScopeIds] = useState<string[]>([]);
  const [autoScheduleModeOverride, setAutoScheduleModeOverride] = useState<ResourceScheduleModeOverride>("PRESERVE");
  const [pendingScheduleUpdate, setPendingScheduleUpdate] = useState<PendingScheduleUpdate | null>(null);
  const [baselineOverview, setBaselineOverview] = useState<GanttBaselineOverviewView | null>(null);
  const [baselineDialogOpen, setBaselineDialogOpen] = useState(false);
  const [baselineReason, setBaselineReason] = useState("");
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [baselinePendingAction, setBaselinePendingAction] = useState<"VALIDATE" | "BEGIN_CHANGE" | "PUBLISH" | "REQUEST_APPROVAL" | null>(null);
  const historyFocusRequestIdRef = useRef(0);
  const resourceAnalysisRequestIdRef = useRef(0);
  const resourceAnalysisProjectIdRef = useRef(projectId);
  const importInputRef = useRef<HTMLInputElement>(null);
  const processedAssistantAttachmentId = useRef<string | null>(null);
  const ganttCardRef = useRef<HTMLDivElement>(null);
  const [ganttPortalContainer, setGanttPortalContainer] = useState<HTMLElement | null>(null);
  const setGanttCardElement = useCallback((element: HTMLDivElement | null) => {
    ganttCardRef.current = element;
    setGanttPortalContainer(element);
  }, []);
  const confirm = useConfirm();
  const { notify } = useSystemFeedback();
  const { can } = usePermission();
  const searchParams = useSearchParams();

  const beginResourceAnalysisRequest = useCallback((): ResourceAnalysisRequestContext | null => {
    if (resourceAnalysisProjectIdRef.current !== projectId) return null;
    const context = { requestId: resourceAnalysisRequestIdRef.current + 1, projectId };
    resourceAnalysisRequestIdRef.current = context.requestId;
    return context;
  }, [projectId]);
  const isCurrentResourceAnalysisRequest = useCallback((context: ResourceAnalysisRequestContext) => (
    context.projectId === resourceAnalysisProjectIdRef.current
    && context.requestId === resourceAnalysisRequestIdRef.current
  ), []);

  useLayoutEffect(() => {
    resourceAnalysisProjectIdRef.current = projectId;
  }, [projectId]);

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
    context = beginResourceAnalysisRequest(),
  ): Promise<ResourceAnalysisFetchResult> => {
    if (!context) return { data: null, isCurrent: false };
    try {
      const query = new URLSearchParams();
      if (includeCandidates) query.set("includeCandidates", "1");
      request.scopeRootTaskIds.forEach((taskId) => query.append("scopeRootTaskId", taskId));
      if (includeCandidates && request.modeOverride !== "PRESERVE") {
        query.set("modeOverride", request.modeOverride);
      }
      if (includeCandidates && request.calendarModeOverride) {
        query.set("calendarMode", request.calendarModeOverride);
      }
      const data = await api.get<ResourceScheduleAnalysisView>(
        `/api/projects/${projectId}/gantt-tasks/resource-schedule${query.size > 0 ? `?${query.toString()}` : ""}`,
      );
      if (!isCurrentResourceAnalysisRequest(context)) return { data: null, isCurrent: false };
      setResourceAnalysis(data);
      setSelectedDurationSuggestionIds((current) => {
        const available = new Set((data.durationSuggestions ?? []).map((suggestion) => suggestion.taskId));
        return current.filter((taskId) => available.has(taskId));
      });
      return { data, isCurrent: true };
    } catch {
      const isCurrent = isCurrentResourceAnalysisRequest(context);
      if (isCurrent) setResourceAnalysis(null);
      return { data: null, isCurrent };
    }
  }, [beginResourceAnalysisRequest, isCurrentResourceAnalysisRequest, projectId]);

  useEffect(() => {
    setResourceAnalysis(null);
    setResourceDialogOpen(false);
    setResourceAnalysisLoading(false);
    setResourceApplyingKind(null);
    setBoundaryResolvingTaskId(null);
  }, [projectId]);

  const fetchTasks = useCallback(async ({
    showLoading = false,
    forceFresh = false,
    refreshResourceAnalysis = true,
  }: FetchTasksOptions = {}) => {
    if (showLoading) {
      setLoading(true);
    }

    try {
      const endpoint = forceFresh
        ? `/api/projects/${projectId}/gantt-tasks?refresh=${Date.now()}`
        : `/api/projects/${projectId}/gantt-tasks`;
      let data = await api.get<ProjectGanttTask[]>(endpoint);
      // A page can remain mounted while an import, restore or data rebuild
      // completes in another request. Revalidate once before rendering an
      // empty WBS so a stale HTTP/client-cache response is never mistaken for
      // an empty project plan.
      if (data.length === 0 && !forceFresh) {
        data = await api.get<ProjectGanttTask[]>(`/api/projects/${projectId}/gantt-tasks?refresh=${Date.now()}`);
      }
      setTasks(data);
      if (refreshResourceAnalysis) void fetchResourceAnalysis(false);
      return data;
    } catch (error) {
      // Keep the last known list visible. A transient auth or network failure
      // must never be presented as an empty WBS.
      setOperationError({
        title: "加载项目 WBS 失败",
        message: error instanceof Error ? error.message : "无法读取项目 WBS，请稍后重试。",
      });
      return [];
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [fetchResourceAnalysis, projectId]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchTasks({ showLoading: true }));
  }, [fetchTasks]);

  useEffect(() => {
    const refreshWbsAfterExternalAction = () => {
      if (document.visibilityState !== "visible" || loading) return;
      void fetchTasks({ forceFresh: true });
    };
    window.addEventListener("focus", refreshWbsAfterExternalAction);
    document.addEventListener("visibilitychange", refreshWbsAfterExternalAction);
    return () => {
      window.removeEventListener("focus", refreshWbsAfterExternalAction);
      document.removeEventListener("visibilitychange", refreshWbsAfterExternalAction);
    };
  }, [fetchTasks, loading]);

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
        const nextProjectStartDate = settings.projectStartDate || "";
        const nextWbsFinishDate = settings.wbsFinishDate || settings.hardFinishDate || "";
        setProjectStartDate(nextProjectStartDate);
        setWbsFinishDate(nextWbsFinishDate);
        setAutoScheduleModeOverride(
          nextWbsFinishDate
            ? "DURATION_BACKWARD"
            : nextProjectStartDate
              ? "DURATION_FORWARD"
              : "PRESERVE",
        );
      }),
      fetchBaselineOverview(),
    ]).catch(() => {
      setProjectMembers([]);
      setCalendarMode("CALENDAR_DAYS");
      setProjectStartDate("");
      setWbsFinishDate("");
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
        // Issues already carry their concrete affected tasks. Bubbling these
        // messages to every ancestor makes a child dependency window look like
        // a locked parent-boundary violation in the WBS rows.
        if (taskById.has(taskId)) append(taskId, issue.message);
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
    // Formal scheduling always solves the entire project network.  A parent
    // context-menu entry is only a convenient entry point; treating all other
    // branches as fixed reservations produced invalid results for cross-branch
    // FS dependencies and shared owners.
    const defaultRequest = (scopeLabel: string): ResourceScheduleRequest => ({
      scopeRootTaskIds: [],
      modeOverride: autoScheduleModeOverride,
      scopeLabel,
    });
    if (candidates.length === 1) {
      const scopeTask = candidates[0];
      void openResourceScheduleDialog(defaultRequest(
        `全项目正式排期（从 ${scopeTask.taskCode || "父任务"} · ${scopeTask.taskName || "未命名任务"} 发起）`,
      ));
      return;
    }
    setAutoScheduleScopeTask(parentTask);
    setAutoScheduleScopeIds(candidates.map((task) => task.id));
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
      scopeRootTaskIds: [],
      modeOverride: autoScheduleModeOverride,
      scopeLabel: `全项目正式排期（关注 ${parentTask.taskCode || "父任务"} 下 ${selected.length} 个末级父任务）`,
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
  const captureHistorySnapshotWithinDeadline = async (label: string): Promise<GanttHistorySnapshotCapture> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const request = captureHistorySnapshot(label)
      .then((snapshot) => ({ snapshot, warning: null }))
      .catch((error): GanttHistorySnapshotCapture => ({
        snapshot: null,
        warning: error instanceof Error ? `保存撤销快照失败：${error.message}` : "保存撤销快照失败",
      }));
    const timeout = new Promise<GanttHistorySnapshotCapture>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({
          snapshot: null,
          warning: `保存撤销快照超过 ${GANTT_HISTORY_SNAPSHOT_TIMEOUT_MS / 1000} 秒，已跳过本次撤销记录。`,
        });
      }, GANTT_HISTORY_SNAPSHOT_TIMEOUT_MS);
    });

    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  };
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
    options: { waitForAfterSnapshot?: boolean; isActive?: () => boolean } = {},
  ): Promise<T> => {
    const beforeCapture = await captureHistorySnapshotWithinDeadline(`${label}:before`);
    if (options.isActive && !options.isActive()) {
      throw new Error("当前资源排期请求已失效");
    }
    const result = await action();
    if (!beforeCapture.snapshot) {
      if (!options.isActive || options.isActive()) {
        setOperationError({
          title: "操作已完成，但未加入撤销历史",
          message: beforeCapture.warning ?? "操作前撤销快照不可用，本次操作无法通过撤销恢复。",
        });
      }
      return result;
    }
    const beforeSnapshot = beforeCapture.snapshot;
    const commitAfterSnapshot = (afterCapture: GanttHistorySnapshotCapture) => {
      if (options.isActive && !options.isActive()) return;
      if (!afterCapture.snapshot) {
        setOperationError({
          title: "操作已完成，但未加入撤销历史",
          message: afterCapture.warning ?? "操作后撤销快照不可用，本次操作无法通过撤销恢复。",
        });
        return;
      }
      commitHistoryEntry({
        id: createClientId(),
        kind: "SNAPSHOT",
        label,
        beforeSnapshotId: beforeSnapshot.snapshotId,
        afterSnapshotId: afterCapture.snapshot.snapshotId,
        target,
      });
    };
    const afterCaptureRequest = captureHistorySnapshotWithinDeadline(`${label}:after`);
    if (options.waitForAfterSnapshot) {
      commitAfterSnapshot(await afterCaptureRequest);
    } else {
      void afterCaptureRequest.then(commitAfterSnapshot);
    }
    return result;
  };

  const openResourceScheduleDialog = async (
    request: ResourceScheduleRequest = DEFAULT_RESOURCE_SCHEDULE_REQUEST,
  ) => {
    const context = beginResourceAnalysisRequest();
    if (!context) return;
    setResourceScheduleRequest(request);
    setResourceDialogOpen(true);
    setResourceAnalysisLoading(true);
    const result = await fetchResourceAnalysis(true, request, context);
    if (!result.isCurrent) return;
    setResourceAnalysisLoading(false);
    if (!result.data) {
      setResourceDialogOpen(false);
      setOperationError({ title: "资源排期分析失败", message: "无法读取当前资源冲突，请稍后重试" });
    }
  };

  const openAutomaticSchedule = async () => {
    // A click from the T0 field can race its blur handler. Persist and
    // materialize first so the preview never falls back to T0+N after a date
    // was already supplied by the user.
    if (autoScheduleModeOverride === "DURATION_FORWARD") {
      if (!projectStartDate) {
        setOperationError({ title: "缺少项目 T0 日期", message: "工期固定正排需要先指定项目 T0 日期。" });
        return;
      }
      if (!await updateScheduleAnchors({ projectStartDate, wbsFinishDate: "" })) return;
    }
    if (autoScheduleModeOverride === "DURATION_BACKWARD") {
      if (!wbsFinishDate) {
        setOperationError({ title: "缺少 WBS 完成日期", message: "工期固定倒排需要先指定 WBS 完成日期。" });
        return;
      }
      if (!await updateScheduleAnchors({ projectStartDate: "", wbsFinishDate })) return;
    }
    if (autoScheduleModeOverride === "PRESERVE" && (projectStartDate || wbsFinishDate)) {
      if (!await updateScheduleAnchors({ projectStartDate: "", wbsFinishDate: "" })) return;
    }
    await openResourceScheduleDialog({
      scopeRootTaskIds: [],
      modeOverride: autoScheduleModeOverride,
      scopeLabel: "全项目正式排期",
    });
  };

  const applyResourceScheduleCandidate = async (candidate: ResourceScheduleCandidateView) => {
    if (!resourceAnalysis || resourceApplyingKind || !canEditPlanning) return;
    const currentAnalysisContext: ResourceAnalysisRequestContext = {
      requestId: resourceAnalysisRequestIdRef.current,
      projectId,
    };
    if (!isCurrentResourceAnalysisRequest(currentAnalysisContext)) return;
    const operationContext = beginResourceAnalysisRequest();
    if (!operationContext) return;
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
            ...(resourceScheduleRequest.calendarModeOverride
              ? { calendarMode: resourceScheduleRequest.calendarModeOverride }
              : {}),
          });
          if (resourceScheduleRequest.calendarModeOverride) {
            setCalendarMode(resourceScheduleRequest.calendarModeOverride);
          }
          await fetchTasks({ forceFresh: true, refreshResourceAnalysis: false });
        },
        { waitForAfterSnapshot: true, isActive: () => isCurrentResourceAnalysisRequest(operationContext) },
      );
      if (!isCurrentResourceAnalysisRequest(operationContext)) return;
      setResourceDialogOpen(false);
      setResourceAnalysis(null);
    } catch (error) {
      if (!isCurrentResourceAnalysisRequest(operationContext)) return;
      setOperationError({
        title: "应用资源排期失败",
        message: error instanceof Error ? error.message : "资源排期方案应用失败",
      });
      setResourceApplyingKind(null);
      await fetchResourceAnalysis(true, resourceScheduleRequest);
    } finally {
      if (isCurrentResourceAnalysisRequest(operationContext)) setResourceApplyingKind(null);
    }
  };

  const applyDurationSuggestions = async () => {
    if (!resourceAnalysis || durationSuggestionsApplying || selectedDurationSuggestionIds.length === 0 || !canEditPlanning) return;
    const currentAnalysisContext: ResourceAnalysisRequestContext = {
      requestId: resourceAnalysisRequestIdRef.current,
      projectId,
    };
    if (!isCurrentResourceAnalysisRequest(currentAnalysisContext)) return;
    const accepted = await confirm(
      `确认将选中的 ${selectedDurationSuggestionIds.length} 条系统建议工期写入正式计划？写入后会参与依赖、资源容量和关键路径计算。`,
    );
    if (!accepted || !isCurrentResourceAnalysisRequest(currentAnalysisContext)) return;
    const operationContext = beginResourceAnalysisRequest();
    if (!operationContext) return;
    setDurationSuggestionsApplying(true);
    try {
      await runWithSnapshotHistory(
        "确认系统建议工期",
        { taskIds: selectedDurationSuggestionIds },
        async () => {
          await api.post(`/api/projects/${projectId}/gantt-tasks/resource-schedule`, {
            action: "APPLY_DURATION_SUGGESTIONS",
            taskIds: selectedDurationSuggestionIds,
            revision: resourceAnalysis.revision,
            snapshotHash: resourceAnalysis.snapshotHash,
          });
          await fetchTasks({ forceFresh: true, refreshResourceAnalysis: false });
        },
        { waitForAfterSnapshot: true, isActive: () => isCurrentResourceAnalysisRequest(operationContext) },
      );
      if (!isCurrentResourceAnalysisRequest(operationContext)) return;
      setSelectedDurationSuggestionIds([]);
      // Writing suggested durations is a completed action, not a second scheduling decision.
      // Close the preview immediately so a successful confirmation cannot be mistaken for a stalled dialog.
      setResourceDialogOpen(false);
      setDurationSuggestionsApplying(false);
      void fetchResourceAnalysis(true, resourceScheduleRequest);
    } catch (error) {
      if (!isCurrentResourceAnalysisRequest(operationContext)) return;
      setOperationError({
        title: "确认建议工期失败",
        message: error instanceof Error ? error.message : "系统建议工期写入失败",
      });
      await fetchResourceAnalysis(true, resourceScheduleRequest);
    } finally {
      setDurationSuggestionsApplying(false);
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

  const handleNetworkDiagramExport = async (
    kind: "AON" | "AOA" | "CRITICAL_PATH" | "MILESTONE_TIMELINE" | "TIME_SCALED_NETWORK",
  ) => {
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
      const fallbackNames = {
        AON: "单代号网络图.drawio",
        AOA: "双代号网络图.drawio",
        CRITICAL_PATH: "关键路径网络图.drawio",
        MILESTONE_TIMELINE: "里程碑时间线.drawio",
        TIME_SCALED_NETWORK: "时标网络图.drawio",
      } as const;
      const fileName = encodedName ? decodeURIComponent(encodedName) : fallbackNames[kind];
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
    // Changing an owner may trigger a resource recalculation after save, but
    // it does not change the manual task plan. Keep the schedule-impact
    // confirmation reserved for actual date, duration, priority and FS edits.
    const planColumns = new Set(["startDate", "endDate", "durationDays", "priority", "predecessor"]);
    const isPlanEdit = Boolean(columnKey && planColumns.has(columnKey));
    // A direct plan edit establishes a deterministic task mode. Parent
    // boundary mode is intentionally not changed here: summary tasks keep
    // rolling up their children unless the project manager explicitly picks
    // "锁定父任务边界" from the context menu.
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
    const progressColumns = new Set(["progress", "actualStartDate", "actualEndDate", "actualWorkHours"]);
    const isProgressSubmission = Boolean(columnKey && progressColumns.has(columnKey));
    const isLeafTask = !tasks.some((candidate) => candidate.parentId === task.id);
    try {
      if (isProgressSubmission && isLeafTask) {
        setSavingTaskId(task.id);
        await api.post(`/api/projects/${projectId}/gantt-tasks/${task.id}/progress-submissions`, {
          taskCode: task.taskCode,
          taskName: nextDraft.taskName,
          progress: nextDraft.progress,
          actualStartDate: nextDraft.actualStartDate,
          actualEndDate: nextDraft.actualEndDate,
          actualWorkHours: nextDraft.actualWorkHours,
        });
        notify("任务进度已提交审批，审批通过后将自动更新 WBS。", "success");
        await fetchTasks({ forceFresh: true });
        return;
      }
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

  const handleClearDuration = async (taskId: string) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const hasChildren = tasks.some((candidate) => candidate.parentId === task.id);
    const message = hasChildren
      ? `确认清除“${task.taskCode} · ${task.taskName}”全部子任务的工期和预计工时？父任务自身仍由子任务汇总。`
      : `确认清除“${task.taskCode} · ${task.taskName}”的工期和预计工时？`;
    const accepted = fullScreen ? window.confirm(message) : await confirm(message);
    if (!accepted) return;

    try {
      const result = await runWithSnapshotHistory(
        hasChildren ? "清除全部子任务工期" : "清除任务工期",
        { taskIds: [task.id], columnKey: "durationDays" },
        async () => {
          const response = await api.post<{ affectedCount: number; tasks: ProjectGanttTask[] }>(
            `/api/projects/${projectId}/gantt-tasks/${task.id}/clear-duration`,
            {},
          );
          setTasks(response.tasks);
          return response;
        },
      );
      notify(`已清除 ${result.affectedCount} 条任务的工期。`, "success");
    } catch (error) {
      setOperationError({
        title: "清除任务工期失败",
        message: error instanceof Error ? error.message : "清除失败",
      });
      await fetchTasks({ forceFresh: true });
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
    const accepted = await confirm("切换排期方式时导致资源重新计算，是否继续？\n\n系统会先计算正式自动排期预览；只有在预览中点击“应用正式排期”后才会写入项目。 ");
    if (!accepted) return;
    setSavingCalendarMode(true);
    try {
      await openResourceScheduleDialog({
        scopeRootTaskIds: [],
        modeOverride: autoScheduleModeOverride,
        calendarModeOverride: nextMode,
        scopeLabel: `全项目 · ${nextMode === "WORKING_DAYS" ? "工作日" : "自然日"}排期预览`,
      });
    } catch (error) {
      setOperationError({
        title: "排期方式预览失败",
        message: error instanceof Error ? error.message : "无法计算工期方式切换后的排期预览",
      });
    } finally {
      setSavingCalendarMode(false);
    }
  };

  const updateScheduleAnchors = (changes: Partial<Pick<GanttSettings, "projectStartDate" | "wbsFinishDate">>) => {
    if (!canEdit) return Promise.resolve(false);
    const save = scheduleAnchorSaveQueueRef.current
      .catch(() => false)
      .then(async () => {
        setSavingScheduleAnchor(true);
        try {
          const settings = await api.put<GanttSettings>(`/api/projects/${projectId}/gantt-settings`, {
            ...changes,
          });
          setCalendarMode(settings.calendarMode);
          setProjectStartDate(settings.projectStartDate || "");
          setWbsFinishDate(settings.wbsFinishDate || settings.hardFinishDate || "");
          return true;
        } catch (error) {
          setOperationError({
            title: "项目排期锚点保存失败",
            message: error instanceof Error ? error.message : "保存失败",
          });
          const settings = await api.get<GanttSettings>(`/api/projects/${projectId}/gantt-settings`).catch(() => null);
          if (settings) {
            setProjectStartDate(settings.projectStartDate || "");
            setWbsFinishDate(settings.wbsFinishDate || settings.hardFinishDate || "");
          }
          return false;
        } finally {
          setSavingScheduleAnchor(false);
        }
      });
    scheduleAnchorSaveQueueRef.current = save;
    return save;
  };

  const changeAutoScheduleMode = async (nextMode: ResourceScheduleModeOverride) => {
    if (nextMode === autoScheduleModeOverride || savingScheduleAnchor || !canEditPlanning) return;
    const message = nextMode === "PRESERVE"
      ? "该排期会删除已定的T0日期或者WBS完成日期"
      : nextMode === "DURATION_FORWARD"
        ? "该排期需要指定项目T0日期，并自动清除WBS完成日期"
        : "该排期需要指定WBS完成日期，并自动清除项目T0日期";
    const accepted = await confirm(`${message}\n\n是否已知晓并继续？`);
    if (!accepted) return;
    const changes = nextMode === "PRESERVE"
      ? { projectStartDate: "", wbsFinishDate: "" }
      : nextMode === "DURATION_FORWARD"
        ? { wbsFinishDate: "" }
        : { projectStartDate: "" };
    const saved = await updateScheduleAnchors(changes);
    if (saved) setAutoScheduleModeOverride(nextMode);
  };

  const performBaselineAction = async (
    action: "VALIDATE" | "BEGIN_CHANGE" | "PUBLISH" | "REQUEST_APPROVAL",
  ) => {
    if (baselineBusy) return;
    setBaselineBusy(true);
    setBaselinePendingAction(action);
    try {
      await api.post(`/api/projects/${projectId}/gantt-tasks/baseline`, {
        action,
        reason: baselineReason.trim(),
      });
      if (action === "PUBLISH" || action === "REQUEST_APPROVAL") {
        setBaselineDialogOpen(false);
        setBaselineReason("");
        notify(
          action === "PUBLISH"
            ? "WBS 基线已发布。"
            : "基线发布审批已发起，请在审批中心查看进度。",
          "success",
        );
        // Publishing and approval submission can both trigger derived refreshes.
        // Close immediately after the server accepts the action, then refresh.
        void Promise.all([fetchTasks({ forceFresh: true }), fetchBaselineOverview()]);
        return;
      }
      await Promise.all([fetchTasks(), fetchBaselineOverview()]);
    } catch (error) {
      setOperationError({
        title: action === "PUBLISH" ? "发布 WBS 基线失败" : "WBS 基线操作失败",
        message: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setBaselineBusy(false);
      setBaselinePendingAction(null);
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

  const coordinateMode = /^\d{4}-\d{2}-\d{2}$/.test(projectStartDate) ? "ABSOLUTE" : "AUTO";
  const range = getGanttDateRange(tasks, { coordinateMode });
  const criticalCount = buildGanttRows(tasks, { coordinateMode, calendarMode })
    .filter((row) => row.isCritical)
    .length;
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const resolveLockedParentBoundary = async (lockedParent: ProjectGanttTask) => {
    if (!canEditPlanning || boundaryResolvingTaskId || resourceApplyingKind) return;
    const operationContext = beginResourceAnalysisRequest();
    if (!operationContext) return;
    setBoundaryResolvingTaskId(lockedParent.id);
    setResourceAnalysisLoading(true);
    try {
      await runWithSnapshotHistory(
        "解除父任务锁定边界",
        { taskIds: [lockedParent.id], columnKey: "parentBoundaryMode" },
        async () => {
          await api.put(`/api/projects/${projectId}/gantt-tasks/${lockedParent.id}`, {
            parentBoundaryMode: "ROLLUP",
          });
          await fetchTasks({ forceFresh: true, refreshResourceAnalysis: false });
        },
        { waitForAfterSnapshot: true, isActive: () => isCurrentResourceAnalysisRequest(operationContext) },
      );
      if (!isCurrentResourceAnalysisRequest(operationContext)) return;
      setResourceAnalysis(null);
      const result = await fetchResourceAnalysis(true, resourceScheduleRequest, operationContext);
      if (!result.isCurrent) return;
      if (!result.data) {
        setResourceDialogOpen(false);
        setOperationError({ title: "重新计算失败", message: "父任务边界已解除，但资源排期方案未能重新生成，请重新打开自动排期。" });
      }
    } catch (error) {
      if (!isCurrentResourceAnalysisRequest(operationContext)) return;
      setOperationError({
        title: "解除父任务边界失败",
        message: error instanceof Error ? error.message : "无法解除父任务边界锁定",
      });
    } finally {
      if (isCurrentResourceAnalysisRequest(operationContext)) {
        setResourceAnalysisLoading(false);
        setBoundaryResolvingTaskId(null);
      }
    }
  };
  const renderLockedBoundaryActions = (issue: { code: string; taskIds: string[] }) => {
    if (issue.code !== "PARENT_BOUNDARY_VIOLATION") return null;
    const lockedParent = issue.taskIds
      .map((taskId) => taskById.get(taskId))
      .find((task) => task?.parentBoundaryMode === "LOCKED");
    if (!lockedParent) return null;
    const focusParent = (columnKey: string) => {
      setResourceDialogOpen(false);
      signalHistoryTarget({ taskIds: [lockedParent.id], columnKey });
    };
    return (
      <div className="mt-2 border-l-2 border-destructive/40 pl-2">
        <div className="flex items-center gap-1 font-medium text-destructive">
          <LockKeyhole className="size-3.5" />
          <span>父任务边界：已锁定 · {lockedParent.taskName || lockedParent.id}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            disabled={!canEditPlanning || Boolean(resourceApplyingKind) || boundaryResolvingTaskId === lockedParent.id}
            onClick={() => void resolveLockedParentBoundary(lockedParent)}
          >
            {boundaryResolvingTaskId === lockedParent.id ? "重新计算中..." : "解除锁定并重算"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            disabled={Boolean(resourceApplyingKind) || Boolean(boundaryResolvingTaskId)}
            onClick={() => focusParent("finishDate")}
          >
            调整边界后重算
          </Button>
        </div>
      </div>
    );
  };
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
        <CardHeader className="space-y-3 pb-2">
          <div>
            <CardTitle className="text-sm">项目WBS管理</CardTitle>
          </div>
          <div className="flex flex-wrap items-start justify-start gap-2">
              <div className="inline-flex h-8 items-stretch border border-border/70 bg-background/35" role="group" aria-label="排期视图">
                {([
                  ["WBS", "WBS 与甘特", ListTree],
                  ["RESOURCE", "负责人泳道", Users],
                  ["CALENDAR", "资源日历", CalendarDays],
                ] as const).map(([value, label, Icon]) => (
                  <Button
                    key={value}
                    type="button"
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "size-8 rounded-none border transition-colors",
                      scheduleView === value
                        ? "app-control-selected"
                        : "border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                    )}
                    aria-pressed={scheduleView === value}
                    aria-label={label}
                    title={label}
                    onClick={() => setScheduleView(value)}
                  >
                    <Icon className="size-3.5" />
                  </Button>
                ))}
              </div>
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
                      ? "app-control-selected z-10"
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
                      ? "app-control-selected z-10"
                      : "bg-background/35 text-muted-foreground",
                  )}
                  aria-pressed={calendarMode === "WORKING_DAYS"}
                  disabled={!canEdit || savingCalendarMode}
                  onClick={() => void changeCalendarMode("WORKING_DAYS")}
                >
                  <BriefcaseBusiness className="size-3.5" />工作日
                </Button>
              </div>
              <Select
                value={autoScheduleModeOverride}
                onChange={(event) => void changeAutoScheduleMode(event.target.value as ResourceScheduleModeOverride)}
                className="app-control-selected h-8 w-[156px] text-xs"
                disabled={!canEditPlanning || savingScheduleAnchor}
                aria-label="全局排期方式"
                title="选择后点击“自动排期”生成全项目预览；预览应用前不会写入正式计划"
              >
                <option value="PRESERVE">T0 方式排期</option>
                <option value="DURATION_FORWARD">工期固定 · 正排</option>
                <option value="DURATION_BACKWARD">工期固定 · 倒排</option>
              </Select>
              {autoScheduleModeOverride === "DURATION_FORWARD" && (
                <div className="flex h-8 items-center gap-1 rounded-md border border-border/70 bg-background/35 px-2 text-xs text-muted-foreground" title="正排以项目 T0 为起点；未填写时预览以 T0+N 工作日显示">
                  <span className="whitespace-nowrap">项目 T0</span>
                  <div className="w-[116px]">
                    <GanttDateField
                      value={projectStartDate}
                      onChange={setProjectStartDate}
                      onCommit={(value) => void updateScheduleAnchors({ projectStartDate: value })}
                      disabled={!canEditPlanning || savingScheduleAnchor}
                      ariaLabel="项目 T0 日期"
                    />
                  </div>
                </div>
              )}
              {autoScheduleModeOverride === "DURATION_BACKWARD" && (
                <div className="flex h-8 items-center gap-1 rounded-md border border-border/70 bg-background/35 px-2 text-xs text-muted-foreground" title="倒排以 WBS 完成锚点为终点；未填写时预览以 T0+N 工作日显示">
                  <span className="whitespace-nowrap">WBS 完成</span>
                  <div className="w-[116px]">
                    <GanttDateField
                      value={wbsFinishDate}
                      onChange={setWbsFinishDate}
                      onCommit={(value) => void updateScheduleAnchors({ wbsFinishDate: value })}
                      disabled={!canEditPlanning || savingScheduleAnchor}
                      ariaLabel="WBS 完成日期"
                    />
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
                onClick={() => void openAutomaticSchedule()}
                title={resourceAttentionCount > 0 ? "查看正式自动排期预览、资源冲突和排期约束" : "计算正式自动排期预览"}
              >
                <WandSparkles className="size-3.5" />
                自动排期 {resourceAttentionCount}
              </Button>
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
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={Boolean(exportingFormat)}
                    title="根据当前 WBS 叶子任务和逻辑关系生成可编辑的 Draw.io 网络图"
                  >
                    <Network className="size-3.5" />
                    {exportingFormat?.startsWith("network-") ? "生成中..." : "网络图"}
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent container={fullScreen ? ganttPortalContainer : undefined} align="end" className="w-60">
                  <DropdownMenuLabel>Draw.io 可编辑网络图</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("AON")}>
                    <Network className="size-4" /> 单代号网络图（活动节点）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("AOA")}>
                    <Network className="size-4" /> 双代号网络图（活动箭线）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("TIME_SCALED_NETWORK")}>
                    <Network className="size-4" /> 时标网络图（计划时间与逻辑关系）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("CRITICAL_PATH")}>
                    <Network className="size-4" /> 关键路径网络图
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleNetworkDiagramExport("MILESTONE_TIMELINE")}>
                    <FlagTriangleRight className="size-4" /> 里程碑时间线
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
        </CardHeader>
        <CardContent className={cn("pb-0", fullScreen && "min-h-0 flex-1 overflow-hidden px-3")}>
          {scheduleView === "WBS" ? <GanttTimeline
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
            onClearDuration={handleClearDuration}
            onCreateTask={startCreate}
            onDeleteSelected={handleDeleteSelected}
            onInsertTasks={handleInsertTasks}
            onPasteTasks={handlePasteTasks}
            onActionError={(message) => setOperationError({ title: "甘特任务操作失败", message })}
            onReorderTasks={handleReorderTasks}
            onReassignBranch={handleReassignBranch}
            onUpdateTask={handleUpdateTask}
            projectId={projectId}
            projectStartDate={projectStartDate}
            projectMembers={projectMembers}
            reordering={reordering}
            resourceConflictMessagesByTaskId={resourceConflictMessagesByTaskId}
            resourceCriticalTaskIds={resourceAnalysis?.candidates[0]?.resourceCriticalChainTaskIds ?? []}
            resourceCriticalChainLinks={resourceAnalysis?.candidates[0]?.resourceCriticalChainLinks ?? []}
            savingTaskId={savingTaskId}
            tasks={tasks}
          /> : scheduleView === "RESOURCE" ? (
            <ResourceSwimlaneView tasks={tasks} calendarMode={calendarMode} />
          ) : (
            <ScheduleCalendarView tasks={tasks} />
          )}
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
              基线发布前可自由调整计划。发布后任务结构、计划日期、工期、负责人、依赖关系以及项目排期锚点将锁定；实际工时、实际日期和进度仍可持续更新。
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
              {baselineOverview.project.ganttBaselineVersion === 0 && (
                <section className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-xs leading-5 text-blue-700 dark:text-blue-300">
                  当前项目尚未发布首次基线。首次基线发布后，系统才会开放“创建变更草案”和“发布变更基线”流程；首次发布前仍按普通基线发布处理。
                </section>
              )}
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
              {baselineBusy && (
                <section
                  className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5 text-xs leading-5 text-blue-700 dark:text-blue-300"
                  role="status"
                  aria-live="polite"
                >
                  {baselinePendingAction === "PUBLISH"
                    ? "正在发布基线并固化当前 WBS，任务较多时可能需要数秒，请勿重复操作。"
                    : baselinePendingAction === "VALIDATE"
                      ? "正在重新计算关键路径、资源冲突和发布条件。"
                      : baselinePendingAction === "BEGIN_CHANGE"
                        ? "正在创建变更基线草案。"
                        : "正在发起基线发布审批。"}
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
              {baselinePendingAction === "VALIDATE" ? "校验中..." : "重新校验"}
            </Button>
            {baselineOverview?.permissions.canPrepareDraft && baselineState === "PUBLISHED" && (
              <Button
                type="button"
                variant="outline"
                disabled={baselineBusy}
                onClick={() => void performBaselineAction("BEGIN_CHANGE")}
              >
                {baselinePendingAction === "BEGIN_CHANGE" ? "创建中..." : "创建变更草案"}
              </Button>
            )}
            {baselineOverview && !baselineOverview.permissions.canPublish && can("project-gantt:baseline-request") && (
              <Button
                type="button"
                variant="outline"
                disabled={baselineBusy}
                onClick={() => void performBaselineAction("REQUEST_APPROVAL")}
              >
                {baselinePendingAction === "REQUEST_APPROVAL" ? "申请中..." : "申请发布审批"}
              </Button>
            )}
            {baselineOverview?.permissions.canPublish && baselineState !== "PUBLISHED" && (
              <Button
                type="button"
                disabled={baselineBusy || baselineBlockers.length > 0}
                onClick={() => void performBaselineAction("PUBLISH")}
              >
                {baselinePendingAction === "PUBLISH"
                  ? "发布中..."
                  : baselineState === "CHANGE_DRAFT" ? "发布变更基线" : "发布基线"}
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
              所选范围只决定哪些子任务会批量覆盖排期方式、接收建议工期。正式求解始终评估项目内全部可移动的叶子任务，确保跨分支 FS 紧前关系和同一负责人容量不会漏算。
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
            <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              正式计算始终统一求解项目内全部未开始的自动末级任务，避免跨父级 FS 关系和共享负责人被遗漏。上方选择仅用于标注本次从哪些父级发起预览；日期固定、已开始和已完成任务保持不变。
            </div>
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
            <DialogTitle>正式自动排期预览</DialogTitle>
            <DialogDescription>
              排期方式覆盖范围：{resourceScheduleRequest.scopeLabel}。未填写项目 T0 时，系统以 T0 为第 0 个工作日输出相对工期；填写 T0 后，系统按项目日历、FS 紧前关系和硬边界换算为具体日期。正式求解会统一评估项目内全部未开始的自动叶子任务；日期固定、进行中和已完成任务保持不动。预览确认后才会写入。
            </DialogDescription>
          </DialogHeader>
          {resourceAnalysisLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">正在计算正式自动排期...</div>
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
                      <div className="min-w-0 flex-1">
                        <div>{issue.message}</div>
                        <div className="mt-0.5 text-muted-foreground">{issue.suggestion}</div>
                        {renderLockedBoundaryActions(issue)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {(resourceAnalysis?.durationSuggestions?.length ?? 0) > 0 && (
                <section className="border-y border-border/70 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">系统建议工期</div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        对唯一负责人且父任务有可用窗口的未定工期叶子任务生成。FS 关系只决定任务先后顺序，不会阻止建议生成。点击下方“应用正式排期”时会连同日期一并写入；也可在此单独确认建议工期。
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setSelectedDurationSuggestionIds(resourceAnalysis?.durationSuggestions.map((suggestion) => suggestion.taskId) ?? [])}
                      >
                        全选
                      </button>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setSelectedDurationSuggestionIds([])}
                      >
                        清空
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={selectedDurationSuggestionIds.length === 0 || durationSuggestionsApplying || !canEditPlanning}
                        onClick={() => void applyDurationSuggestions()}
                      >
                        {durationSuggestionsApplying ? "正在写入正式工期..." : `确认选中建议 ${selectedDurationSuggestionIds.length}`}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {resourceAnalysis?.durationSuggestions.map((suggestion) => {
                      const suggestionTask = taskById.get(suggestion.taskId);
                      return (
                        <label key={suggestion.taskId} className="flex cursor-pointer items-start gap-2 border border-border/60 px-3 py-2 text-xs hover:bg-muted/20">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 accent-primary"
                            checked={selectedDurationSuggestionIds.includes(suggestion.taskId)}
                            onChange={() => setSelectedDurationSuggestionIds((current) => current.includes(suggestion.taskId)
                              ? current.filter((taskId) => taskId !== suggestion.taskId)
                              : [...current, suggestion.taskId])}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium" title={`${suggestionTask?.taskCode || ""} · ${suggestionTask?.taskName || suggestion.taskId}`}>
                              {suggestionTask?.taskCode || "任务"} · {suggestionTask?.taskName || "未命名任务"}
                            </span>
                            <span className="mt-0.5 block text-muted-foreground">建议 {suggestion.suggestedDurationDays} 天 · {suggestion.reason}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              )}
              {(resourceAnalysis?.durationSuggestionIssues?.length ?? 0) > 0 && (
                <details className="border-b border-border/70 pb-3 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">未能生成建议工期 {resourceAnalysis?.durationSuggestionIssues.length ?? 0} 项</summary>
                  <div className="mt-2 space-y-1.5">
                    {resourceAnalysis?.durationSuggestionIssues.slice(0, 8).map((issue) => <div key={issue.id}>{issue.message}</div>)}
                  </div>
                </details>
              )}
              <div className="grid gap-3">
                {(resourceAnalysis?.candidates ?? []).map((candidate) => (
                  <section key={candidate.kind} className="flex min-h-[220px] max-w-2xl flex-col rounded-md border border-border/70 p-4">
                    <div className="text-sm font-semibold">{candidate.title}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{candidate.explanation}</p>
                    <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <dt className="text-muted-foreground">调整任务</dt>
                      <dd className="text-right font-medium">{candidate.metrics.movedTaskCount}</dd>
                      <dt className="text-muted-foreground">累计移动</dt>
                      <dd className="text-right font-medium">{candidate.metrics.totalShiftDays} 天</dd>
                      <dt className="text-muted-foreground">预计完成</dt>
                      <dd className="text-right font-medium">
                        {candidate.relativeSchedule
                          ? formatGanttRelativeOffset(candidate.metrics.relativeCompletionOffsetDays)
                          : candidate.metrics.completionDate || "-"}
                      </dd>
                      <dt className="text-muted-foreground">剩余冲突</dt>
                      <dd className="text-right font-medium text-destructive">{candidate.remainingConflicts.length}</dd>
                      <dt className="text-muted-foreground">资源等待任务</dt>
                      <dd className="text-right font-medium">{candidate.resourceConstrainedTaskIds.length}</dd>
                      <dt className="text-muted-foreground">资源关键链</dt>
                      <dd className="text-right font-medium text-sky-500">{candidate.resourceCriticalChainTaskIds.length}</dd>
                      <dt className="text-muted-foreground">最终关键任务</dt>
                      <dd className="text-right font-medium">{candidate.criticalTaskIds.length}</dd>
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
                              <span className="text-muted-foreground">
                                → {candidate.relativeSchedule
                                  ? `${formatGanttRelativeOffset(change.relativeStartOffsetDays)} 至 ${formatGanttRelativeOffset(change.relativeFinishOffsetDays)}`
                                  : `${change.startDate} 至 ${change.finishDate}`}
                                {typeof change.durationDays === "number" ? ` · 工期 ${change.durationDays} 天` : ""}
                              </span>
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
                        {candidate.issues.map((issue) => <div key={issue.id}>{renderLockedBoundaryActions(issue)}</div>)}
                      </div>
                    )}
                    {candidate.taskExplanations.length > 0 && (
                      <details className="mt-3 border-t border-border/60 pt-3 text-[11px] leading-4">
                        <summary className="cursor-pointer font-medium text-muted-foreground">查看排期依据</summary>
                        <div className="mt-2 max-h-36 space-y-2 overflow-y-auto pr-1">
                          {candidate.taskExplanations.slice(0, 8).map((explanation) => (
                            <div key={explanation.taskId} className="border-l-2 border-primary/40 pl-2">
                              <div>{explanation.summary}</div>
                              {explanation.details.map((detail) => <div key={detail} className="text-muted-foreground">{detail}</div>)}
                            </div>
                          ))}
                          {candidate.taskExplanations.length > 8 && <div className="text-muted-foreground">另有 {candidate.taskExplanations.length - 8} 项排期依据</div>}
                        </div>
                      </details>
                    )}
                    {!candidate.applicable && (
                      <p className="mt-3 text-xs leading-5 text-amber-500">
                        {candidate.issues.some((issue) => issue.severity === "ERROR")
                          ? "存在阻断性约束，系统不会生成部分写入结果。请先按上方提示补齐或修复条件。"
                          : "当前计划无需日期调整；如需重新安排，请补充或修改项目 T0、工期、负责人、紧前关系或硬边界。"}
                      </p>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      className="mt-auto w-full"
                      disabled={!candidate.applicable || Boolean(resourceApplyingKind) || !canEditPlanning}
                      onClick={() => void applyResourceScheduleCandidate(candidate)}
                    >
                      {resourceApplyingKind === candidate.kind ? "应用中..." : "应用正式排期"}
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
