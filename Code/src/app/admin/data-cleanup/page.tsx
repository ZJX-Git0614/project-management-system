"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { useAuth } from "@/contexts/auth-context";
import { useCurrentProject } from "@/contexts/current-project-context";
import { useConfirm } from "@/components/confirm-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SystemBackupPanel } from "@/components/system-backup-panel";
import { SystemLogPanel } from "@/components/system-log-panel";
import { ProjectRestorePanel } from "@/components/project-restore-panel";

interface CleanupModule {
  id: string;
  label: string;
  description: string;
}

interface CleanupProject {
  id: string;
  name: string;
  code: string;
  status: string;
}

interface CleanupData {
  modules: CleanupModule[];
  projects: CleanupProject[];
  countsByProjectId: Record<string, Record<string, number>>;
  recentAudits: Array<{
    id: string;
    createdAt: string;
    actionType: string;
    operator: string;
    projectId: string;
    projectName: string;
    detail: string;
  }>;
}

export default function DataCleanupPage() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const { currentProjectId, clearCurrentProject, refresh: refreshCurrentProjects } = useCurrentProject();
  const isAdmin = user?.assignedRoleNames.includes(ADMIN_ROLE_NAME) ?? false;
  const [data, setData] = useState<CleanupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [message, setMessage] = useState("");

  const selectedProject = useMemo(
    () => data?.projects.find((project) => project.id === projectId) ?? null,
    [data?.projects, projectId],
  );
  const selectedModule = useMemo(
    () => data?.modules.find((module) => module.id === moduleId) ?? null,
    [data?.modules, moduleId],
  );
  const selectedCount = projectId && moduleId ? data?.countsByProjectId[projectId]?.[moduleId] ?? 0 : 0;
  const deletingProject = selectedModule?.id === "entire-project";

  const fetchData = async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.get<CleanupData>("/api/admin/data-cleanup");
      setData(result);
      setProjectId((prev) => result.projects.some((project) => project.id === prev) ? prev : result.projects[0]?.id || "");
      setModuleId((prev) => result.modules.some((module) => module.id === prev) ? prev : result.modules[0]?.id || "");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const handleDelete = async () => {
    if (!selectedProject || !selectedModule) return;
    const accepted = await confirm(
      deletingProject
        ? `确认删除整个项目「${selectedProject.name}」吗？项目主档及 ${selectedCount - 1} 条关联记录将被永久删除，此操作不可恢复。`
        : `确认删除「${selectedProject.name}」的「${selectedModule.label}」数据吗？当前共 ${selectedCount} 条，此操作不可恢复。`,
    );
    if (!accepted) return;
    setDeleting(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/data-cleanup", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {}),
        },
        body: JSON.stringify({ projectId, moduleId, confirmText: deletingProject ? "删除项目" : "清空" }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error || "清理失败");
      }
      const result = body.data as { deletedCount: number; projectDeleted?: boolean; message: string };
      setMessage(`${result.message}，删除 ${result.deletedCount} 条。`);
      if (result.projectDeleted) {
        if (currentProjectId === projectId) clearCurrentProject();
        await refreshCurrentProjects();
      }
      await fetchData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理失败");
    } finally {
      setDeleting(false);
    }
  };

  if (!isAdmin) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4 text-sm text-destructive">仅超级管理员可访问系统数据管理。</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <SystemBackupPanel />
      <ProjectRestorePanel />
      <SystemLogPanel />
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>业务数据清理</CardTitle>
              <CardDescription className="text-xs">
                仅超级管理员可用。模块清理写入项目日志；删除整个项目时，审计记录会保存在独立管理员日志中。
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void fetchData()} disabled={loading || deleting}>
              <RefreshCw className="size-3" /> 刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px]">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">项目</div>
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={loading || deleting}>
                {data?.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}（{project.code || "无编号"}）
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">模块</div>
              <Select value={moduleId} onChange={(event) => setModuleId(event.target.value)} disabled={loading || deleting}>
                {data?.modules.map((module) => (
                  <option key={module.id} value={module.id}>
                    {module.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">当前数据量</div>
              <div className="flex h-9 items-center rounded-md border border-border bg-muted/20 px-3 text-sm font-semibold tabular-nums">
                {selectedCount}
              </div>
            </div>
          </div>

          <div className={deletingProject
            ? "flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            : "flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive"}
          >
            <div className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {deletingProject
                  ? `将永久删除整个项目「${selectedProject?.name || "-"}」及其全部关联数据。`
                  : `将删除「${selectedProject?.name || "-"}」的「${selectedModule?.label || "-"}」数据。`}
                此操作不可恢复。
                {selectedModule?.description ? ` ${selectedModule.description}` : ""}
              </span>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleDelete()}
              disabled={deleting || loading || !projectId || !moduleId}
            >
              <Trash2 className="size-3" /> {deleting ? "删除中..." : deletingProject ? "删除整个项目" : "删除模块数据"}
            </Button>
          </div>

          {message && <div className="text-xs text-muted-foreground">{message}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>模块数据概览</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">项目</TableHead>
                {data?.modules.map((module) => (
                  <TableHead key={module.id} className="whitespace-nowrap">{module.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.projects.map((project) => (
                <TableRow key={project.id}>
                  <TableCell>
                    <div className="font-medium">{project.name}</div>
                    <div className="text-[10px] text-muted-foreground">{project.code || "-"} · {project.status}</div>
                  </TableCell>
                  {data.modules.map((module) => (
                    <TableCell key={module.id} className="tabular-nums">
                      {data.countsByProjectId[project.id]?.[module.id] ?? 0}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!loading && data?.projects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={(data?.modules.length ?? 0) + 1} className="h-24 text-center text-muted-foreground">
                    暂无项目
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>最近清理记录</CardTitle>
          <CardDescription className="text-xs">独立管理员审计日志不会随项目删除而丢失。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border rounded-md border border-border">
            {data?.recentAudits.map((audit) => (
              <div key={audit.id} className="grid gap-1 px-3 py-2.5 text-xs md:grid-cols-[160px_120px_minmax(0,1fr)]">
                <span className="text-muted-foreground">{new Date(audit.createdAt).toLocaleString("zh-CN")}</span>
                <span className="font-medium">{audit.operator || "系统"}</span>
                <span className="min-w-0 break-words">{audit.detail}</span>
              </div>
            ))}
            {!loading && data?.recentAudits.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">暂无清理记录</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
