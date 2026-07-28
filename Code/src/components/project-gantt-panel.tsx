"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileSpreadsheet, FileType2, Maximize2, Minimize2, Upload } from "lucide-react";

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
import { renumberGanttTaskCodes } from "@/lib/gantt-task-codes";
import { changeGanttTaskHierarchy, type GanttHierarchyDirection } from "@/lib/gantt-hierarchy";
import { cn } from "@/lib/utils";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectGanttTask } from "@/domain/models";

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
  const [operationError, setOperationError] = useState<{ title: string; message: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const ganttCardRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    void Promise.resolve().then(() => fetchTasks({ showLoading: true, clearOnError: true }));
  }, [fetchTasks]);

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
    setCreatingParentId(parentId ?? "root");
    try {
      const startDate = parentTask?.startDate || new Date().toISOString().slice(0, 10);
      await api.post(`/api/projects/${projectId}/gantt-tasks`, {
        parentId,
        taskCategory: parentTask?.taskCategory ?? "",
        taskName: "",
        startDate,
        durationDays: 1,
        actualStartDate: "",
        actualEndDate: "",
        estimatedWorkHours: 0,
        actualWorkHours: 0,
        progress: 0,
        predecessorTaskIds: [],
      });
      await fetchTasks();
    } catch (error) {
      alert(error instanceof Error ? error.message : "新建失败");
    } finally {
      setCreatingParentId(null);
    }
  };

  const handleUpdateTask = async (task: ProjectGanttTask, draft: GanttTaskDraft) => {
    if (!draft.startDate || draft.durationDays < 1) {
      alert("请填写计划开始时间，且任务周期 ≥ 1 天");
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
      const updated = await api.put<ProjectGanttTask>(`/api/projects/${projectId}/gantt-tasks/${task.id}`, draft);
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updated : item)));
      if (task.taskCategory !== draft.taskCategory) {
        await fetchTasks();
      }
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
    if (!(await confirm(`确认删除选中的 ${selectedTasks.length} 个甘特任务？`))) return;

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
      for (const task of deleteRoots) {
        await api.delete(`/api/projects/${projectId}/gantt-tasks/${task.id}`);
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    } finally {
      await fetchTasks();
      setDeletingSelected(false);
    }
  };

  const handleReorderTasks = async (taskIds: string[]) => {
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
    setTasks(renumberGanttTaskCodes(optimistic.tasks));
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

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  const range = getGanttDateRange(tasks);
  const criticalCount = buildGanttRows(tasks).filter((row) => row.isCritical).length;

  return (
    <div className="space-y-4">
      <Card
        ref={ganttCardRef}
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
                    <div className="font-semibold">{range.totalDays} 天</div>
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
                <DropdownMenuContent align="end" className="w-56">
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
        <CardContent className={cn(fullScreen && "min-h-0 flex-1 overflow-hidden px-3 pb-3")}>
          <GanttTimeline
            canCreate={canCreate}
            canDelete={canDelete}
            canEdit={canEdit}
            creatingParentId={creatingParentId}
            deletingSelected={deletingSelected}
            fullScreen={fullScreen}
            hierarchyChanging={hierarchyChanging}
            onChangeHierarchy={handleChangeHierarchy}
            onCreateTask={startCreate}
            onDeleteSelected={handleDeleteSelected}
            onReorderTasks={handleReorderTasks}
            onUpdateTask={handleUpdateTask}
            reordering={reordering}
            savingTaskId={savingTaskId}
            tasks={tasks}
          />
        </CardContent>
      </Card>
      <Dialog open={Boolean(importPreview)} onOpenChange={(open) => !open && !importing && setImportPreview(null)}>
        <DialogContent className="max-w-3xl">
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
        onOpenChange={(open) => !open && setOperationError(null)}
      />
    </div>
  );
};
