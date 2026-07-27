"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, CloudUpload, DatabaseBackup, Download, Save, ShieldCheck } from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
  const [syncingCloud, setSyncingCloud] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);

  const fetchData = useCallback(async (targetPage: number, targetPageSize: number, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await api.get<BackupData>(`/api/admin/system-data/backups?page=${targetPage}&pageSize=${targetPageSize}`);
      setData(result);
      setDraft((current) => ({
        ...result.settings,
        cloudPassword: current?.cloudPassword ?? "",
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
      setDraft({ ...settings, cloudPassword: "" });
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

  const testCloud = async () => {
    if (!draft) return;
    setTestingCloud(true);
    setMessage("");
    try {
      const result = await api.post<{ message: string }>("/api/admin/system-data/backups/test-cloud", draft);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "公司云盘连接失败");
    } finally {
      setTestingCloud(false);
    }
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

            <Field label="服务器本地备份目录">
              <Input value={draft.localDirectory} onChange={(event) => setDraft({ ...draft, localDirectory: event.target.value })} />
            </Field>

            <div className="space-y-3 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={draft.cloudEnabled} onChange={(event) => setDraft({ ...draft, cloudEnabled: event.target.checked })} className="size-4 accent-primary" />
                <Cloud className="size-4 text-primary" /> 公司云盘备份（WebDAV）
              </label>
              <div className="text-[11px] leading-5 text-muted-foreground">
                启用后，每 6 小时自动备份和“立即完整备份”都会同步云盘；云端目录最多使用 {formatBytes(draft.cloudLimitBytes)}，超出后自动删除最旧备份。
              </div>
              {draft.cloudEnabled && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="WebDAV 地址"><Input value={draft.cloudBaseUrl} onChange={(event) => setDraft({ ...draft, cloudBaseUrl: event.target.value })} placeholder="https://cloud.example.com/dav/" /></Field>
                  <Field label="云盘目录"><Input value={draft.cloudDirectory} onChange={(event) => setDraft({ ...draft, cloudDirectory: event.target.value })} /></Field>
                  <Field label="登录账号"><Input value={draft.cloudUsername} onChange={(event) => setDraft({ ...draft, cloudUsername: event.target.value })} /></Field>
                  <Field label="密码或应用密码"><Input type="password" value={draft.cloudPassword} onChange={(event) => setDraft({ ...draft, cloudPassword: event.target.value })} placeholder={draft.cloudPasswordConfigured ? "已配置，留空保持不变" : "请输入密码或应用密码"} /></Field>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                上次自动备份：{formatDateTime(draft.lastAutomaticBackupAt)}
                {draft.lastBackupMessage ? ` · ${draft.lastBackupMessage}` : ""}
              </div>
              <div className="flex items-center gap-2">
                {draft.cloudEnabled && (
                  <>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void syncLatestBackupToCloud()} disabled={syncingCloud || backingUp || saving}>
                      <CloudUpload className="size-3.5" /> {syncingCloud ? "同步中..." : "同步最新备份"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => void testCloud()} disabled={testingCloud || saving || syncingCloud}>
                      <ShieldCheck className="size-3.5" /> {testingCloud ? "检测中..." : "测试云盘登录"}
                    </Button>
                  </>
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
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>{children}</label>;
}
