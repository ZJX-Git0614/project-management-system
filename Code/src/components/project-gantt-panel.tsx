"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BriefcaseBusiness, CalendarDays, ChevronDown, Download, FileSpreadsheet, FileType2, Maximize2, Minimize2, Redo2, Undo2, Upload } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import {
  changeGanttTaskHierarchy,
  synchronizeGanttTaskCategories,
  type GanttHierarchyDirection,
} from "@/lib/gantt-hierarchy";
import { cn } from "@/lib/utils";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectGanttDeletionBatch, ProjectGanttTask, ProjectMember } from "@/domain/models";

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
  clearedPredecessorCount?: number;
  expiresAt?: string;
}

interface GanttRestoreResult {
  message: string;
  restoredTaskCount: number;
  warnings?: string[];
}

type ScheduleImportPreview = {
  file: File;
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
  const [deletionBatches, setDeletionBatches] = useState<ProjectGanttDeletionBatch[]>([]);
  const [restoringBatchId, setRestoringBatchId] = useState<string | null>(null);
  const [redoDeletionBatchId, setRedoDeletionBatchId] = useState<string | null>(null);
  const [redoingBatchId, setRedoingBatchId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<{ title: string; message: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const ganttCardRef = useRef<HTMLDivElement>(null);
  const [ganttPortalContainer, setGanttPortalContainer] = useState<HTMLElement | null>(null);
  const setGanttCardElement = useCallback((element: HTMLDivElement | null) => {
    ganttCardRef.current = element;
    setGanttPortalContainer(element);
  }, []);
  const confirm = useConfirm();
  const { can } = usePermission();

  const readOnly = projectStatus === ProjectStatus.COMPLETED || projectStatus === ProjectStatus.VOIDED;
  const canCreate = can("project-gantt:create") && !readOnly;
  const canEdit = can("project-gantt:edit") && !readOnly;
  const canDelete = can("project-gantt:delete") && !readOnly;

  const fetchTasks = useCallback(async ({ showLoading = false, clearOnError = false }: FetchTasksOptions = {}) => {
    if (showLoading) {
      setLoading(true);
    }

    try {
      const data = await api.get<ProjectGanttTask[]>(`/api/projects/${projectId}/gantt-tasks`);
      setTasks(data);
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
  }, [projectId]);

  const fetchDeletionBatches = useCallback(async () => {
    if (!canDelete) {
      setDeletionBatches([]);
      return [];
    }
    try {
      const data = await api.get<ProjectGanttDeletionBatch[]>("/api/projects/" + projectId + "/gantt-tasks/deletions");
      setDeletionBatches(data);
      return data;
    } catch {
      setDeletionBatches([]);
      return [];
    }
  }, [canDelete, projectId]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchTasks({ showLoading: true, clearOnError: true }));
  }, [fetchTasks]);

  useEffect(() => {
    void fetchDeletionBatches();
  }, [fetchDeletionBatches]);

  useEffect(() => {
    setRedoDeletionBatchId(null);
  }, [projectId]);

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

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("mode", "PREVIEW");
      const response = await fetch(`/api/projects/${projectId}/gantt-tasks/import`, {
        method: "POST",
        headers: api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {},
        body: formData,
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "导入失败");
      setImportPreview({ file, ...body.data });
    } catch (error) {
      setOperationError({ title: "计划文件解析失败", message: error instanceof Error ? error.message : "导入失败" });
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const applyImport = async (mode: "APPEND" | "MERGE") => {
    if (!importPreview) return;
    setRedoDeletionBatchId(null);
    setImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", importPreview.file);
      formData.append("mode", mode);
      const response = await fetch(`/api/projects/${projectId}/gantt-tasks/import`, {
        method: "POST",
        headers: api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {},
        body: formData,
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "导入失败");
      await fetchTasks();
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
    setRedoDeletionBatchId(null);
    setCreatingParentId(parentId ?? "root");
    try {
      const startDate = parentTask?.startDate || new Date().toISOString().slice(0, 10);
      await api.post(`/api/projects/${projectId}/gantt-tasks`, {
        parentId,
        taskCategory: parentTask?.taskCategory ?? "",
        taskName: "",
        taskDescription: "",
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
    } catch (error) {
      alert(error instanceof Error ? error.message : "新建失败");
    } finally {
      setCreatingParentId(null);
    }
  };

  const handleUpdateTask = async (task: ProjectGanttTask, draft: GanttTaskDraft) => {
    if (!draft.startDate || !isValidGanttDurationDays(draft.durationDays)) {
      alert("请填写计划开始时间，工期留空或按 0.5 天为单位填写");
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
    setRedoDeletionBatchId(null);
    setSavingTaskId(task.id);
    try {
      await api.put<ProjectGanttTask>(`/api/projects/${projectId}/gantt-tasks/${task.id}`, draft);
      await fetchTasks();
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
    setRedoDeletionBatchId(null);

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
      const results: GanttDeleteResult[] = [];
      for (const task of deleteRoots) {
        results.push(await api.delete<GanttDeleteResult>("/api/projects/" + projectId + "/gantt-tasks/" + task.id));
      }
      const deletedTaskCount = results.reduce((sum, item) => sum + (item.deletedTaskCount ?? 0), 0);
      const detachedWeeklyItemCount = results.reduce((sum, item) => sum + (item.detachedWeeklyItemCount ?? 0), 0);
      const detachedRiskCount = results.reduce((sum, item) => sum + (item.detachedRiskCount ?? 0), 0);
      if (deletedTaskCount > 0 && (detachedWeeklyItemCount > 0 || detachedRiskCount > 0)) {
        alert("已删除 " + deletedTaskCount + " 条甘特任务，并解除 " + detachedWeeklyItemCount + " 条事项、" + detachedRiskCount + " 条风险关联；可在最近删除中撤销。");
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    } finally {
      await Promise.all([fetchTasks(), fetchDeletionBatches()]);
      setDeletingSelected(false);
    }
  };

  const handleRestoreDeletion = async (batchId: string) => {
    setRestoringBatchId(batchId);
    try {
      const result = await api.post<GanttRestoreResult>("/api/projects/" + projectId + "/gantt-tasks/deletions/" + batchId + "/restore");
      await Promise.all([fetchTasks(), fetchDeletionBatches()]);
      setRedoDeletionBatchId(batchId);
      if (result.warnings?.length) {
        alert(result.message + "\n\n注意：\n" + result.warnings.join("\n"));
      }
    } catch (error) {
      setOperationError({ title: "撤销删除失败", message: error instanceof Error ? error.message : "恢复失败" });
      await fetchDeletionBatches();
    } finally {
      setRestoringBatchId(null);
    }
  };

  const handleRedoDeletion = async (batchId: string) => {
    setRedoingBatchId(batchId);
    try {
      await api.post<GanttDeleteResult>("/api/projects/" + projectId + "/gantt-tasks/deletions/" + batchId + "/redo");
      setRedoDeletionBatchId(null);
      await Promise.all([fetchTasks(), fetchDeletionBatches()]);
    } catch (error) {
      setRedoDeletionBatchId(null);
      setOperationError({ title: "取消撤销失败", message: error instanceof Error ? error.message : "重新删除失败" });
      await Promise.all([fetchTasks(), fetchDeletionBatches()]);
    } finally {
      setRedoingBatchId(null);
    }
  };

  const handleReorderTasks = async (taskIds: string[]) => {
    setRedoDeletionBatchId(null);
    setTasks((prev) => {
      const taskById = new Map(prev.map((task) => [task.id, task]));
      return renumberGanttTaskCodes(
        taskIds.map((taskId, index) => ({ ...taskById.get(taskId)!, sortOrder: index + 1 }))
      );
    });
    setReordering(true);
    try {
      await api.put(`/api/projects/${projectId}/gantt-tasks/reorder`, { taskIds });
      await fetchTasks();
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
    setRedoDeletionBatchId(null);
    setTasks(renumberGanttTaskCodes(synchronizeGanttTaskCategories(optimistic.tasks, optimistic.movedTaskIds)));
    setHierarchyChanging(true);
    try {
      const result = await api.put<{ tasks: ProjectGanttTask[]; movedTaskIds: string[]; message: string }>(
        `/api/projects/${projectId}/gantt-tasks/hierarchy`,
        { taskIds, direction },
      );
      setTasks(result.tasks);
    } catch (error) {
      alert(error instanceof Error ? error.message : "任务层级调整失败");
      await fetchTasks();
    } finally {
      setHierarchyChanging(false);
    }
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
    setRedoDeletionBatchId(null);
    setSavingCalendarMode(true);
    try {
      const settings = await api.put<GanttSettings>(`/api/projects/${projectId}/gantt-settings`, {
        calendarMode: nextMode,
      });
      setCalendarMode(settings.calendarMode);
      await fetchTasks();
    } catch (error) {
      alert(error instanceof Error ? error.message : "工期计算方式保存失败");
    } finally {
      setSavingCalendarMode(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  const range = getGanttDateRange(tasks);
  const criticalCount = buildGanttRows(tasks).filter((row) => row.isCritical).length;
  const latestDeletionBatch = deletionBatches[0];

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
              <CardTitle className="text-sm">项目进度管理</CardTitle>
              <CardDescription className="text-xs">
                左侧维护任务信息，右侧按时间轴展示排期、紧前关系和关键路径
              </CardDescription>
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
              {canDelete && (
                <div className="flex items-center gap-2" role="group" aria-label="撤销与取消撤销">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={!latestDeletionBatch || Boolean(restoringBatchId) || Boolean(redoingBatchId)}
                    onClick={() => latestDeletionBatch && void handleRestoreDeletion(latestDeletionBatch.id)}
                    title="撤销删除"
                    aria-label="撤销删除"
                  >
                    <Undo2 className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={!redoDeletionBatchId || Boolean(restoringBatchId) || Boolean(redoingBatchId)}
                    onClick={() => redoDeletionBatchId && void handleRedoDeletion(redoDeletionBatchId)}
                    title="取消撤销"
                    aria-label="取消撤销"
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
                    accept=".mpp,.xml,.xlsx"
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
            onChangeHierarchy={handleChangeHierarchy}
            onCreateTask={startCreate}
            onDeleteSelected={handleDeleteSelected}
            onReorderTasks={handleReorderTasks}
            onUpdateTask={handleUpdateTask}
            projectMembers={projectMembers}
            reordering={reordering}
            savingTaskId={savingTaskId}
            tasks={tasks}
          />
        </CardContent>
      </Card>
      <Dialog open={Boolean(importPreview)} onOpenChange={(open) => !open && !importing && setImportPreview(null)}>
        <DialogContent container={fullScreen ? ganttPortalContainer : undefined} className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>计划导入预览</DialogTitle>
            <DialogDescription>
              已分析 {importPreview?.file.name}，当前计划尚未修改。系统导出的 Excel 包含隐藏数据库键，修改日期、名称等字段后可使用“合并更新”增量导入。
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
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                {importPreview.analysis.issues.length === 0 ? (
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
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={importing} onClick={() => setImportPreview(null)}>取消</Button>
            <Button variant="outline" disabled={importing} onClick={() => void applyImport("APPEND")}>追加为新任务</Button>
            <Button disabled={importing || Boolean(importPreview?.analysis.summary.errors)} onClick={() => void applyImport("MERGE")}>
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
