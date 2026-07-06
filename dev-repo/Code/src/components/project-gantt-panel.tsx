"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GanttTimeline, type GanttTaskDraft } from "@/components/gantt-timeline";
import { useConfirm } from "@/components/confirm-provider";
import { usePermission } from "@/lib/use-permission";
import { api } from "@/lib/api-client";
import { buildGanttRows, getGanttDateRange } from "@/lib/gantt";
import { ProjectStatus } from "@/domain/enums";
import type { ProjectGanttTask } from "@/domain/models";

interface ProjectGanttPanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
}

export const ProjectGanttPanel = ({ projectId, projectStatus }: ProjectGanttPanelProps) => {
  const [tasks, setTasks] = useState<ProjectGanttTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingParentId, setCreatingParentId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [reordering, setReordering] = useState(false);
  const confirm = useConfirm();
  const { can } = usePermission();

  const readOnly = projectStatus === ProjectStatus.COMPLETED || projectStatus === ProjectStatus.VOIDED;
  const canCreate = can("project-gantt:create") && !readOnly;
  const canEdit = can("project-gantt:edit") && !readOnly;
  const canDelete = can("project-gantt:delete") && !readOnly;

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<ProjectGanttTask[]>(`/api/projects/${projectId}/gantt-tasks`);
      setTasks(data);
      return data;
    } catch {
      setTasks([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(fetchTasks);
  }, [fetchTasks]);

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
        predecessorTask: "",
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
      alert("请填写开始时间，且任务周期 ≥ 1 天");
      return;
    }
    setSavingTaskId(task.id);
    try {
      const updated = await api.put<ProjectGanttTask>(`/api/projects/${projectId}/gantt-tasks/${task.id}`, draft);
      setTasks((prev) => prev.map((item) => (item.id === task.id ? updated : item)));
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
    setDeletingSelected(true);
    try {
      await Promise.all(selectedTasks.map((task) => api.delete(`/api/projects/${projectId}/gantt-tasks/${task.id}`)));
      await fetchTasks();
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeletingSelected(false);
    }
  };

  const handleReorderTasks = async (taskIds: string[]) => {
    setTasks((prev) => {
      const taskById = new Map(prev.map((task) => [task.id, task]));
      return taskIds.map((taskId, index) => ({ ...taskById.get(taskId)!, sortOrder: index + 1 }));
    });
    setReordering(true);
    try {
      await api.put(`/api/projects/${projectId}/gantt-tasks/reorder`, { taskIds });
    } catch (error) {
      alert(error instanceof Error ? error.message : "排序保存失败");
      await fetchTasks();
    } finally {
      setReordering(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  const range = getGanttDateRange(tasks);
  const criticalCount = buildGanttRows(tasks).filter((row) => row.isCritical).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">项目进度管理</CardTitle>
              <CardDescription className="text-xs">
                左侧维护任务信息，右侧按时间轴展示排期、紧前关系和关键路径
              </CardDescription>
            </div>
            {range && (
              <div className="grid grid-cols-3 gap-2 text-right text-xs">
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
          </div>
        </CardHeader>
        <CardContent>
          <GanttTimeline
            canCreate={canCreate}
            canDelete={canDelete}
            canEdit={canEdit}
            creatingParentId={creatingParentId}
            deletingSelected={deletingSelected}
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
    </div>
  );
};
