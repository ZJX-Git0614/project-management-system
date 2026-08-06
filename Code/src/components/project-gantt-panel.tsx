"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BriefcaseBusiness, CalendarDays, ChevronDown, Download, FileSpreadsheet, FileType2, FlagTriangleRight, Maximize2, Minimize2, Redo2, TriangleAlert, Undo2, Upload, WandSparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  kind: "MINIMAL_CHANGE" | "EARLIEST_FINISH" | "ON_TIME";
  title: string;
  explanation: string;
  applicable: boolean;
  changes: Array<{
    taskId: string;
    startDate: string;
    finishDate: string;
    task: ResourceConflictTask | null;
  }>;
  remainingConflicts: ResourceConflictView[];
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
  candidates: ResourceScheduleCandidateView[];
};

export const ProjectGanttPanel = ({ projectId, projectStatus }: ProjectGanttPanelProps) => {
  const [tasks, setTasks] = useState<ProjectGanttTask[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [calendarMode, setCalendarMode] = useState<GanttCalendarMode>("CALENDAR_DAYS");
  const [savingCalendarMode, setSavingCalendarMode] = useState(false);
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
  const canCreate = can("project-gantt:create") && !readOnly;
  const canEdit = can("project-gantt:edit") && !readOnly;
  const canDelete = can("project-gantt:delete") && !readOnly;
  const canViewBaselineControl = can("project-gantt:baseline-request");

  const fetchResourceAnalysis = useCallback(async (includeCandidates = false) => {
    try {
      const data = await api.get<ResourceScheduleAnalysisView>(
        `/api/projects/${projectId}/gantt-tasks/resource-schedule${includeCandidates ? "?includeCandidates=1" : ""}`,
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
      api.get<GanttSettings>(`/api/projects/${projectId}/gantt-settings`).then((settings) => setCalendarMode(settings.calendarMode)),
    ]).catch(() => {
      setProjectMembers([]);
      setCalendarMode("CALENDAR_DAYS");
    });
  }, [projectId]);

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
    return Object.fromEntries(
      Array.from(messagesByTaskId.entries()).map(([taskId, messages]) => [taskId, Array.from(messages)]),
    );
  }, [projectMembers, resourceAnalysis?.conflicts, tasks]);
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

  const openResourceScheduleDialog = async () => {
    setResourceDialogOpen(true);
    setResourceAnalysisLoading(true);
    const analysis = await fetchResourceAnalysis(true);
    setResourceAnalysisLoading(false);
    if (!analysis) {
      setResourceDialogOpen(false);
      setOperationError({ title: "资源排期分析失败", message: "无法读取当前资源冲突，请稍后重试" });
    }
  };

  const applyResourceScheduleCandidate = async (candidate: ResourceScheduleCandidateView) => {
    if (!resourceAnalysis || resourceApplyingKind) return;
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
      await fetchResourceAnalysis(true);
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

  const startCreate = async (parentTask?: ProjectGanttTask) => {
    const parentId = parentTask?.id ?? null;
    setCreatingParentId(parentId ?? "root");
    try {
      const startDate = parentTask?.startDate || new Date().toISOString().slice(0, 10);
      await runWithSnapshotHistory("新增任务", { taskIds: [], anchorTaskId: parentTask?.id }, async () => {
        const created = await api.post<ProjectGanttTask>(`/api/projects/${projectId}/gantt-tasks`, {
          parentId,
          taskName: "",
          taskDescription: "无",
          startDate,
          durationDays: 0,
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

  const handleUpdateTask = async (task: ProjectGanttTask, draft: GanttTaskDraft, columnKey?: string) => {
    if (!isValidGanttDurationDays(draft.durationDays) || (!draft.startDate && draft.durationDays > 0)) {
      alert("工期留空或按 0.5 天为单位填写；填写工期时需要计划开始时间");
      return;
    }
    if (draft.progress < 0 || draft.progress > 100) {
      alert("当前进度必须在 0-100 之间");
      return;
    }
    if (draft.estimatedWorkHours < 0 || draft.actualWorkHours < 0) {
      alert("预计工时和实际工时不能小于 0");
      return;
    }
    setSavingTaskId(task.id);
    try {
      await runWithSnapshotHistory("编辑任务字段", { taskIds: [task.id], columnKey }, async () => {
        await api.put<ProjectGanttTask>(`/api/projects/${projectId}/gantt-tasks/${task.id}`, draft);
        await fetchTasks();
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
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
                  (resourceAnalysis?.conflicts?.length ?? 0) > 0 && "text-destructive hover:bg-destructive/8 hover:text-destructive",
                )}
                disabled={resourceAnalysisLoading || (resourceAnalysis?.conflicts?.length ?? 0) === 0}
                onClick={() => void openResourceScheduleDialog()}
                title={(resourceAnalysis?.conflicts?.length ?? 0) > 0 ? "查看资源冲突并选择优化排期方案" : "当前没有资源冲突"}
              >
                <WandSparkles className="size-3.5" />
                资源优化 {resourceAnalysis?.conflicts?.length ?? 0}
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
                  disabled
                  title="发布基线功能暂未启用"
                >
                  <FlagTriangleRight className="size-3.5" /> 发布基线
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
            creatingParentId={creatingParentId}
            deletingSelected={deletingSelected}
            fullScreen={fullScreen}
            portalContainer={fullScreen ? ganttPortalContainer : undefined}
            calendarMode={calendarMode}
            hierarchyChanging={hierarchyChanging}
            historyFocusRequest={historyFocusRequest}
            onChangeHierarchy={handleChangeHierarchy}
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
      <Dialog open={resourceDialogOpen} onOpenChange={(open) => !resourceApplyingKind && setResourceDialogOpen(open)}>
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>资源冲突与优化排期</DialogTitle>
            <DialogDescription>
              系统只调整当前项目未开始的可排程叶子任务，不修改负责人、手工排程任务、进行中或已完成任务，也不会移动其他项目任务。历史升级保护的固定任务仅在你选择方案后调整日期，并继续保持固定；应用后可通过 WBS 顶部撤销按钮恢复。
            </DialogDescription>
          </DialogHeader>
          {resourceAnalysisLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">正在计算候选方案...</div>
          ) : (
            <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
              <div className="flex items-center gap-2 border-b border-border/70 pb-3 text-sm">
                <TriangleAlert className="size-4 text-destructive" />
                <span>检测到 {resourceAnalysis?.conflicts?.length ?? 0} 组资源冲突</span>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
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
                    {!candidate.applicable && (
                      <p className="mt-3 text-xs leading-5 text-amber-500">
                        手工排程、进行中任务或其他项目占用使此方案无法减少冲突，请先调整这些约束。
                      </p>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      className="mt-auto w-full"
                      disabled={!candidate.applicable || Boolean(resourceApplyingKind)}
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
