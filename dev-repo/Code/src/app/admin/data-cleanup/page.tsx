"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
}

export default function DataCleanupPage() {
  const { user } = useAuth();
  const isAdmin = user?.assignedRoleNames.includes(ADMIN_ROLE_NAME) ?? false;
  const [data, setData] = useState<CleanupData | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [confirmText, setConfirmText] = useState("");
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

  const fetchData = async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.get<CleanupData>("/api/admin/data-cleanup");
      setData(result);
      setProjectId((prev) => prev || result.projects[0]?.id || "");
      setModuleId((prev) => prev || result.modules[0]?.id || "");
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
    setDeleting(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/data-cleanup", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {}),
        },
        body: JSON.stringify({ projectId, moduleId, confirmText }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) {
        throw new Error(body.error || "清理失败");
      }
      const result = body.data as { deletedCount: number; message: string };
      setMessage(`${result.message}，删除 ${result.deletedCount} 条。`);
      setConfirmText("");
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
        <CardContent className="py-4 text-sm text-destructive">仅超级管理员可访问数据清理。</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>模块数据删除</CardTitle>
              <CardDescription className="text-xs">
                仅超级管理员可用。清理操作会写入项目操作日志；账号、权限、项目主档和操作日志不会被清理。
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void fetchData()} disabled={loading || deleting}>
              <RefreshCw className="size-3" /> 刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px_120px]">
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
            <div>
              <div className="mb-1 text-xs text-muted-foreground">确认文本</div>
              <Input
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                disabled={deleting}
                placeholder="输入清空"
                className="h-9"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <div className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                将删除「{selectedProject?.name || "-"}」的「{selectedModule?.label || "-"}」数据。此操作不可恢复。
                {selectedModule?.description ? ` ${selectedModule.description}` : ""}
              </span>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleDelete()}
              disabled={deleting || loading || !projectId || !moduleId || confirmText !== "清空"}
            >
              <Trash2 className="size-3" /> {deleting ? "删除中..." : "删除模块数据"}
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
    </div>
  );
}
