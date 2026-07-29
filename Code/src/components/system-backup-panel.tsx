"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Cloud, CloudUpload, DatabaseBackup, Download, Folder, FolderOpen, HardDrive, Save, Search, ShieldCheck } from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface BackupSettings {
  automaticBackupEnabled: boolean;
  intervalHours: number;
  localDirectory: string;
  localLimitBytes: number;
  cloudLimitBytes: number;
  cloudEnabled: boolean;
  cloudProvider: string;
  cloudBaseUrl: string;
  cloudUsername: string;
  cloudPasswordConfigured: boolean;
  cloudDirectory: string;
  documentCloudEnabled: boolean;
  documentCloudBaseUrl: string;
  documentCloudUsername: string;
  documentCloudPasswordConfigured: boolean;
  documentCloudDirectory: string;
  lastAutomaticBackupAt: string | null;
  nextAutomaticBackupAt: string | null;
  lastBackupStatus: string;
  lastBackupMessage: string;
}

interface BackupRecord {
  id: string;
  createdAt: string;
  completedAt: string | null;
  triggerMode: string;
  status: string;
  sizeBytes: number;
  cloudStatus: string;
  operator: string;
  databaseFileName: string;
  documentArchiveFileName: string;
  errorMessage: string;
}

interface BackupData {
  settings: BackupSettings;
  records: BackupRecord[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  localUsageBytes: number;
}

interface BackupDraft extends BackupSettings {
  cloudPassword: string;
  documentCloudPassword: string;
}

interface BackupDirectoryData {
  currentPath: string;
  parentPath: string | null;
  roots: Array<{ name: string; path: string }>;
  breadcrumbs: Array<{ name: string; path: string }>;
  directories: Array<{ name: string; path: string }>;
}

const formatDateTime = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "-";
const formatBytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const statusLabel: Record<string, string> = {
  RUNNING: "执行中",
  COMPLETED: "已完成",
  PARTIAL: "本地完成，云盘失败",
  FAILED: "失败",
  SKIPPED: "未启用",
  PRUNED: "已按容量清理",
};

export function SystemBackupPanel() {
  const confirm = useConfirm();
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<BackupData | null>(null);
  const [draft, setDraft] = useState<BackupDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [testingCloud, setTestingCloud] = useState(false);
  const [testingDocumentCloud, setTestingDocumentCloud] = useState(false);
  const [syncingCloud, setSyncingCloud] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryData, setDirectoryData] = useState<BackupDirectoryData | null>(null);
  const [directoryColumns, setDirectoryColumns] = useState<BackupDirectoryData[]>([]);
  const [directoryHistory, setDirectoryHistory] = useState<string[]>([]);
  const [directoryHistoryIndex, setDirectoryHistoryIndex] = useState(-1);
  const [directorySearch, setDirectorySearch] = useState("");
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const directoryRequestId = useRef(0);

  const fetchData = useCallback(async (targetPage: number, targetPageSize: number, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await api.get<BackupData>(`/api/admin/system-data/backups?page=${targetPage}&pageSize=${targetPageSize}`);
      setData(result);
      setDraft((current) => ({
        ...result.settings,
        cloudPassword: current?.cloudPassword ?? "",
        documentCloudPassword: current?.documentCloudPassword ?? "",
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "备份信息加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData(page, pageSize);
    const refresh = () => void fetchData(page, pageSize, true);
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [fetchData, page, pageSize]);

  const saveSettings = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage("");
    try {
      const settings = await api.put<BackupSettings>("/api/admin/system-data/backups", draft);
      setData((current) => current ? { ...current, settings } : current);
      setDraft({ ...settings, cloudPassword: "", documentCloudPassword: "" });
      setMessage("备份设置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "备份设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const createBackup = async () => {
    setBackingUp(true);
    setMessage("");
    try {
      await api.post("/api/admin/system-data/backups");
      setMessage(draft?.cloudEnabled ? "本地备份已创建并同步到公司云盘" : "本地完整备份已创建");
      await fetchData(page, pageSize, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "备份失败");
    } finally {
      setBackingUp(false);
    }
  };

  const syncLatestBackupToCloud = async () => {
    setSyncingCloud(true);
    setMessage("");
    try {
      const result = await api.post<{ message: string }>("/api/admin/system-data/backups/sync-cloud");
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "公司云盘备份失败");
    } finally {
      await fetchData(page, pageSize, true);
      setSyncingCloud(false);
    }
  };

  const testCloud = async (target: "BACKUP" | "DOCUMENT") => {
    if (!draft) return;
    if (target === "BACKUP") setTestingCloud(true);
    else setTestingDocumentCloud(true);
    setMessage("");
    try {
      const result = await api.post<{ message: string }>("/api/admin/system-data/backups/test-cloud", { ...draft, target });
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "公司云盘连接失败");
    } finally {
      if (target === "BACKUP") setTestingCloud(false);
      else setTestingDocumentCloud(false);
    }
  };

  const fetchDirectories = async (targetPath = "") => {
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
    return api.get<BackupDirectoryData>(`/api/admin/system-data/backups/directories${query}`);
  };

  const loadDirectories = async (targetPath = "", recordHistory: boolean | "reset" = true) => {
    const requestId = directoryRequestId.current + 1;
    directoryRequestId.current = requestId;
    setDirectoryLoading(true);
    setMessage("");
    try {
      const current = await fetchDirectories(targetPath);
      const columns = await Promise.all(current.breadcrumbs.map((item) => (
        item.path === current.currentPath ? Promise.resolve(current) : fetchDirectories(item.path)
      )));
      if (directoryRequestId.current !== requestId) return;
      setDirectoryData(current);
      setDirectoryColumns(columns);
      setDirectorySearch("");
      if (recordHistory === "reset") {
        setDirectoryHistory([current.currentPath]);
        setDirectoryHistoryIndex(0);
      } else if (recordHistory) {
        setDirectoryHistory((previous) => {
          const next = previous.slice(0, directoryHistoryIndex + 1);
          if (next.at(-1) !== current.currentPath) next.push(current.currentPath);
          setDirectoryHistoryIndex(next.length - 1);
          return next;
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务器目录读取失败");
    } finally {
      if (directoryRequestId.current === requestId) setDirectoryLoading(false);
    }
  };

  const openDirectoryPicker = async () => {
    setDirectoryData(null);
    setDirectoryColumns([]);
    setDirectoryHistory([]);
    setDirectoryHistoryIndex(-1);
    setDirectorySearch("");
    setDirectoryPickerOpen(true);
    await loadDirectories(draft?.localDirectory || "", "reset");
  };

  const navigateDirectoryHistory = (offset: -1 | 1) => {
    const nextIndex = directoryHistoryIndex + offset;
    const targetPath = directoryHistory[nextIndex];
    if (!targetPath || nextIndex < 0 || nextIndex >= directoryHistory.length) return;
    setDirectoryHistoryIndex(nextIndex);
    void loadDirectories(targetPath, false);
  };

  const downloadBackup = async (record: BackupRecord, type: "database" | "documents") => {
    try {
      const blob = await api.download(`/api/admin/system-data/backups/${record.id}/download?type=${type}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = type === "database" ? record.databaseFileName : record.documentArchiveFileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "备份文件下载失败");
    }
  };

  const restoreDatabase = async (file?: File) => {
    if (!file) return;
    const accepted = await confirm("恢复数据库将覆盖当前系统数据。系统会先自动创建一份恢复前备份，确认继续吗？");
    if (!accepted) {
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      return;
    }
    setRestoring(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("confirmText", "恢复数据库");
      const result = await api.upload<{ message: string }>("/api/admin/system-data/backups/restore", formData);
      alert(result.message);
      window.location.href = "/login";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "数据库恢复失败");
    } finally {
      setRestoring(false);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm"><DatabaseBackup className="size-4 text-primary" />数据备份与恢复</CardTitle>
            <CardDescription className="text-xs">完整备份包含 PostgreSQL 数据库与项目上传文档；自动备份固定每 6 小时执行一次。</CardDescription>
          </div>
          <Button type="button" size="sm" className="h-8 text-xs" onClick={() => void createBackup()} disabled={loading || backingUp || syncingCloud}>
            <DatabaseBackup className="size-3.5" /> {backingUp ? "备份中..." : "立即完整备份"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {draft && (
          <div className="space-y-4 border-t border-border pt-4">
            <div className="grid gap-3 lg:grid-cols-4">
              <label className="flex min-h-9 items-center justify-between rounded-md border border-border bg-background/35 px-3 text-xs lg:col-span-1">
                <span>自动备份</span>
                <input type="checkbox" checked={draft.automaticBackupEnabled} onChange={(event) => setDraft({ ...draft, automaticBackupEnabled: event.target.checked })} className="size-4 accent-primary" />
              </label>
              <Field label="执行周期">
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/20 px-3 text-xs">每 {draft.intervalHours} 小时</div>
              </Field>
              <Field label="本地备份空间">
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/20 px-3 text-xs tabular-nums">
                  {formatBytes(data?.localUsageBytes ?? 0)} / {formatBytes(draft.localLimitBytes)}
                </div>
              </Field>
              <Field label="下次自动备份">
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/20 px-3 text-xs">{draft.automaticBackupEnabled ? formatDateTime(draft.nextAutomaticBackupAt) : "已关闭"}</div>
              </Field>
            </div>

            <Field label="服务器备份目录">
              <div className="flex gap-2">
                <Input className="min-w-0 flex-1" value={draft.localDirectory} onChange={(event) => setDraft({ ...draft, localDirectory: event.target.value })} />
                <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 px-3 text-xs" onClick={() => void openDirectoryPicker()} title="浏览服务器或 Docker 已挂载的目录">
                  <FolderOpen className="size-3.5" /> 浏览目录
                </Button>
              </div>
            </Field>

            <div className="space-y-3 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={draft.cloudEnabled} onChange={(event) => setDraft({ ...draft, cloudEnabled: event.target.checked })} className="size-4 accent-primary" />
                <Cloud className="size-4 text-primary" /> 系统备份云盘（WebDAV）
              </label>
              <div className="text-[11px] leading-5 text-muted-foreground">
                启用后，每 6 小时自动备份和“立即完整备份”都会同步云盘；云端目录最多使用 {formatBytes(draft.cloudLimitBytes)}，超出后自动删除最旧备份。
              </div>
              {draft.cloudEnabled && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="备份 WebDAV 地址"><Input value={draft.cloudBaseUrl} onChange={(event) => setDraft({ ...draft, cloudBaseUrl: event.target.value })} placeholder="https://cloud.example.com/dav/" /></Field>
                  <Field label="备份云盘目录"><Input value={draft.cloudDirectory} onChange={(event) => setDraft({ ...draft, cloudDirectory: event.target.value })} /></Field>
                  <Field label="登录账号"><Input value={draft.cloudUsername} onChange={(event) => setDraft({ ...draft, cloudUsername: event.target.value })} /></Field>
                  <Field label="密码或应用密码"><Input type="password" value={draft.cloudPassword} onChange={(event) => setDraft({ ...draft, cloudPassword: event.target.value })} placeholder={draft.cloudPasswordConfigured ? "已配置，留空保持不变" : "请输入密码或应用密码"} /></Field>
                </div>
              )}
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={draft.documentCloudEnabled} onChange={(event) => setDraft({ ...draft, documentCloudEnabled: event.target.checked })} className="size-4 accent-primary" />
                <CloudUpload className="size-4 text-primary" /> 项目文档云盘（WebDAV）
              </label>
              <div className="text-[11px] leading-5 text-muted-foreground">
                该配置仅用于文档清单管理的云盘上传、下载和删除，与系统备份云盘完全独立。
              </div>
              {draft.documentCloudEnabled && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="文档 WebDAV 地址"><Input value={draft.documentCloudBaseUrl} onChange={(event) => setDraft({ ...draft, documentCloudBaseUrl: event.target.value })} placeholder="https://documents.example.com/dav/" /></Field>
                  <Field label="文档云盘目录"><Input value={draft.documentCloudDirectory} onChange={(event) => setDraft({ ...draft, documentCloudDirectory: event.target.value })} /></Field>
                  <Field label="文档云盘账号"><Input value={draft.documentCloudUsername} onChange={(event) => setDraft({ ...draft, documentCloudUsername: event.target.value })} /></Field>
                  <Field label="文档云盘密码或应用密码"><Input type="password" value={draft.documentCloudPassword} onChange={(event) => setDraft({ ...draft, documentCloudPassword: event.target.value })} placeholder={draft.documentCloudPasswordConfigured ? "已配置，留空保持不变" : "请输入密码或应用密码"} /></Field>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 break-all text-xs text-muted-foreground">
                上次自动备份：{formatDateTime(draft.lastAutomaticBackupAt)}
                {draft.lastBackupMessage ? ` · ${draft.lastBackupMessage}` : ""}
              </div>
              <div className="flex items-center gap-2">
                {draft.cloudEnabled && (
                  <>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void syncLatestBackupToCloud()} disabled={syncingCloud || backingUp || saving}>
                      <CloudUpload className="size-3.5" /> {syncingCloud ? "同步中..." : "同步最新备份"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void testCloud("BACKUP")} disabled={testingCloud || saving || syncingCloud}>
                      <ShieldCheck className="size-3.5" /> {testingCloud ? "检测中..." : "测试备份云盘"}
                    </Button>
                  </>
                )}
                {draft.documentCloudEnabled && (
                  <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void testCloud("DOCUMENT")} disabled={testingDocumentCloud || saving}>
                    <ShieldCheck className="size-3.5" /> {testingDocumentCloud ? "检测中..." : "测试文档云盘"}
                  </Button>
                )}
                <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void saveSettings()} disabled={saving}>
                  <Save className="size-3.5" /> {saving ? "保存中..." : "保存设置"}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <div className="text-xs font-medium">数据库文件导入</div>
            <div className="mt-1 text-[11px] text-muted-foreground">仅支持本系统导出的 PostgreSQL `.dump` 文件；恢复前自动创建保护备份。</div>
          </div>
          <input ref={restoreInputRef} type="file" accept=".dump,application/octet-stream" className="hidden" onChange={(event) => void restoreDatabase(event.target.files?.[0])} />
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => restoreInputRef.current?.click()} disabled={restoring || backingUp}>
            <Download className="size-3.5" /> {restoring ? "恢复中..." : "导入数据库备份"}
          </Button>
        </div>

        {message && <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">{message}</div>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-medium">备份历史</div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>每页</span>
            <Select
              value={String(pageSize)}
              className="h-8 w-20 text-xs"
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              <option value="5">5 条</option>
              <option value="10">10 条</option>
              <option value="20">20 条</option>
            </Select>
            <span>共 {data?.pagination.total ?? 0} 条</span>
          </div>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2">备份时间</th><th className="px-3 py-2">方式</th><th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">大小</th><th className="px-3 py-2">云盘</th><th className="px-3 py-2">操作人</th><th className="px-3 py-2 text-right">文件</th>
              </tr>
            </thead>
            <tbody>
              {data?.records.map((record) => (
                <tr key={record.id} className="border-t border-border odd:bg-background even:bg-muted/10">
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(record.createdAt)}</td>
                  <td className="px-3 py-2">{record.triggerMode === "AUTOMATIC" ? "自动" : "手动"}</td>
                  <td className={cn("px-3 py-2", record.status === "FAILED" && "text-destructive", record.status === "PARTIAL" && "text-amber-500")}>{statusLabel[record.status] || record.status}</td>
                  <td className="px-3 py-2 tabular-nums">{formatBytes(record.sizeBytes)}</td>
                  <td className="px-3 py-2">{statusLabel[record.cloudStatus] || record.cloudStatus}</td>
                  <td className="px-3 py-2">{record.operator || "系统"}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={!record.databaseFileName} onClick={() => void downloadBackup(record, "database")}><Download className="size-3" />数据库</Button>
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={!record.documentArchiveFileName} onClick={() => void downloadBackup(record, "documents")}><Download className="size-3" />文档</Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && data?.records.length === 0 && <tr><td colSpan={7} className="h-20 text-center text-muted-foreground">暂无备份记录</td></tr>}
            </tbody>
          </table>
        </div>
        {(data?.pagination.totalPages ?? 1) > 1 && (
          <div className="flex items-center justify-end gap-2 text-xs">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</Button>
            <span className="min-w-16 text-center text-muted-foreground">{page} / {data?.pagination.totalPages ?? 1}</span>
            <Button type="button" size="sm" variant="outline" disabled={page >= (data?.pagination.totalPages ?? 1) || loading} onClick={() => setPage((current) => current + 1)}>下一页</Button>
          </div>
        )}
      </CardContent>
      <Dialog open={directoryPickerOpen} onOpenChange={setDirectoryPickerOpen}>
        <DialogContent className="w-[min(1040px,calc(100vw-32px))] max-w-none overflow-hidden">
          <DialogHeader>
            <DialogTitle>选择服务器备份目录</DialogTitle>
            <DialogDescription>
              自动备份由服务器执行，这里仅显示服务器或 Docker 已挂载且可写的目录。
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 overflow-hidden rounded-md border border-border bg-background/55">
            <div className="flex min-h-[460px] max-h-[68vh] min-w-0">
              <aside className="w-52 shrink-0 overflow-hidden border-r border-border bg-muted/15 p-2">
                <div className="px-2 pb-2 pt-1 text-[10px] font-medium uppercase text-muted-foreground">存储位置</div>
                <div className="space-y-1">
                  {directoryData?.roots.map((root) => {
                    const active = directoryData.currentPath === root.path || directoryData.currentPath.startsWith(`${root.path}/`);
                    return (
                      <button
                        key={root.path}
                        type="button"
                        className={cn(
                          "flex h-10 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-xs transition-colors",
                          active ? "bg-primary/12 text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                        )}
                        onClick={() => void loadDirectories(root.path)}
                      >
                        <HardDrive className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                        <span className="min-w-0 flex-1 overflow-hidden">
                          <span className="block truncate font-medium">{root.name}</span>
                          <span className="block truncate text-[9px] text-muted-foreground/75" title={root.path}>{root.path}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" variant="ghost" size="icon" className="size-8" disabled={directoryHistoryIndex <= 0 || directoryLoading} onClick={() => navigateDirectoryHistory(-1)} title="后退">
                      <ChevronLeft className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="size-8" disabled={directoryHistoryIndex < 0 || directoryHistoryIndex >= directoryHistory.length - 1 || directoryLoading} onClick={() => navigateDirectoryHistory(1)} title="前进">
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                  <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-md border border-border bg-background/70 px-2 py-1.5 scrollbar-none">
                    <FolderOpen className="size-3.5 shrink-0 text-primary" />
                    {directoryData?.breadcrumbs.map((item, index) => (
                      <span key={item.path} className="flex shrink-0 items-center gap-1">
                        {index > 0 && <ChevronRight className="size-3 text-muted-foreground/50" />}
                        <button type="button" className={cn("rounded px-1 py-0.5 text-[11px] hover:bg-muted", index === directoryData.breadcrumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground")} onClick={() => void loadDirectories(item.path)}>
                          {item.name}
                        </button>
                      </span>
                    ))}
                    {!directoryData && <span className="text-[11px] text-muted-foreground">正在读取目录...</span>}
                  </div>
                  <label className="relative w-48 shrink-0">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={directorySearch} onChange={(event) => setDirectorySearch(event.target.value)} placeholder="筛选当前目录" className="h-8 pl-8 text-xs" />
                  </label>
                </div>

                <div className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-background/35">
                  {directoryColumns.map((column, columnIndex) => {
                    const selectedChildPath = directoryColumns[columnIndex + 1]?.currentPath;
                    const isLastColumn = columnIndex === directoryColumns.length - 1;
                    const query = directorySearch.trim().toLocaleLowerCase("zh-CN");
                    const directories = isLastColumn && query
                      ? column.directories.filter((directory) => directory.name.toLocaleLowerCase("zh-CN").includes(query))
                      : column.directories;
                    return (
                      <div key={column.currentPath} className="flex w-60 shrink-0 flex-col border-r border-border last:border-r-0">
                        <div className="truncate border-b border-border/70 bg-muted/15 px-3 py-2 text-[10px] font-medium text-muted-foreground" title={column.currentPath}>
                          {column.breadcrumbs.at(-1)?.name || column.currentPath}
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                          {directories.map((directory) => {
                            const selected = selectedChildPath === directory.path;
                            return (
                              <button
                                key={directory.path}
                                type="button"
                                className={cn(
                                  "flex h-9 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-xs transition-colors",
                                  selected ? "bg-primary/15 text-foreground" : "hover:bg-muted/70",
                                )}
                                onClick={() => void loadDirectories(directory.path)}
                                title={directory.name}
                              >
                                <Folder className="size-4 shrink-0 text-amber-500" />
                                <span className="truncate">{directory.name}</span>
                                <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground/60" />
                              </button>
                            );
                          })}
                          {!directoryLoading && directories.length === 0 && (
                            <div className="flex h-24 items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
                              {query ? "没有匹配的子目录" : "当前目录没有子目录"}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {directoryLoading && directoryColumns.length === 0 && (
                    <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">正在读取服务器目录...</div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2 border-t border-border bg-muted/15 px-3 py-2 text-[11px] text-muted-foreground">
              <FolderOpen className="size-3.5 shrink-0" />
              <span className="shrink-0">当前选择</span>
              <span className="truncate font-mono text-foreground/80" title={directoryData?.currentPath}>{directoryData?.currentPath || "-"}</span>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDirectoryPickerOpen(false)}>取消</Button>
            <Button type="button" disabled={!directoryData?.currentPath} onClick={() => {
              if (draft && directoryData?.currentPath) setDraft({ ...draft, localDirectory: directoryData.currentPath });
              setDirectoryPickerOpen(false);
            }}>选择当前目录</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>{children}</label>;
}
