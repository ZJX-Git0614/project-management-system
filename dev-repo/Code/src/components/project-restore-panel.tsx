"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DatabaseZap, RotateCcw, Search, ShieldCheck } from "lucide-react";

import { useConfirm } from "@/components/confirm-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Table, TableActionButton, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api-client";

type RestorePreview = {
  sessionId: string;
  expiresAt: string;
  projects: Array<{
    id: string;
    name: string;
    code: string;
    status: string;
    action: "ADD" | "REPLACE";
    counts: Record<string, number>;
  }>;
  accountIssues: Array<{
    id: string;
    username: string;
    displayName: string;
    affectedProjectIds: string[];
    candidates: Array<{ id: string; username: string; displayName: string; enabled: boolean }>;
  }>;
  documentCheck: { supplied: boolean; requiredCount: number; missingFiles: string[] };
};

type RestoreBatch = {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  operatorName: string;
  projectNames: string[];
  canRollback: boolean;
  errorMessage: string;
};

export function ProjectRestorePanel() {
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [databaseFile, setDatabaseFile] = useState<File | null>(null);
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [accountChoices, setAccountChoices] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [rollingBackId, setRollingBackId] = useState("");
  const [batches, setBatches] = useState<RestoreBatch[]>([]);
  const [message, setMessage] = useState("");

  const loadBatches = useCallback(async () => {
    try {
      setBatches(await api.get<RestoreBatch[]>("/api/admin/system-data/backups/project-restore"));
    } catch {
      // 主数据管理页仍可继续使用其他功能。
    }
  }, []);
  useEffect(() => { void loadBatches(); }, [loadBatches]);

  const selectedAccountIssues = useMemo(() => preview?.accountIssues.filter((issue) => (
    issue.affectedProjectIds.some((projectId) => selectedProjectIds.includes(projectId))
  )) ?? [], [preview?.accountIssues, selectedProjectIds]);
  const selectedMissingDocumentCount = preview?.documentCheck.missingFiles.filter((file) => (
    selectedProjectIds.some((projectId) => file.startsWith(`${projectId}/`))
  )).length ?? 0;

  const runPreview = async () => {
    if (!databaseFile) return;
    setPreviewing(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("databaseFile", databaseFile);
      if (documentFile) form.append("documentFile", documentFile);
      const result = await api.upload<RestorePreview>("/api/admin/system-data/backups/project-restore/preview", form);
      setPreview(result);
      setSelectedProjectIds(result.projects.map((project) => project.id));
      setAccountChoices(Object.fromEntries(result.accountIssues.map((issue) => [
        issue.id,
        issue.candidates.length === 1 ? `MAP:${issue.candidates[0].id}` : "",
      ])));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目恢复预检失败");
    } finally {
      setPreviewing(false);
    }
  };

  const executeRestore = async () => {
    if (!preview || selectedProjectIds.length === 0) return;
    if (selectedMissingDocumentCount > 0) {
      setMessage(`所选项目缺少 ${selectedMissingDocumentCount} 个文档文件，不能恢复`);
      return;
    }
    if (selectedAccountIssues.some((issue) => !accountChoices[issue.id])) {
      setMessage("请先处理所选项目中的全部历史账号关联");
      return;
    }
    if (!(await confirm(`确认完整恢复 ${selectedProjectIds.length} 个项目吗？同 ID 项目将被替换，全部项目会一次成功或一次失败。恢复前状态保留 30 天。`))) return;
    setRestoring(true);
    setMessage("");
    try {
      const resolutions = selectedAccountIssues.map((issue) => {
        const choice = accountChoices[issue.id];
        if (choice.startsWith("MAP:")) return { sourceAccountId: issue.id, action: "MAP", targetAccountId: choice.slice(4) };
        return { sourceAccountId: issue.id, action: choice };
      });
      const result = await api.post<{ message: string; historicalAccounts: Array<{ displayName: string; username: string }> }>(
        "/api/admin/system-data/backups/project-restore/execute",
        { sessionId: preview.sessionId, projectIds: selectedProjectIds, resolutions, confirmText: "恢复所选项目" },
      );
      setMessage(result.message);
      setDialogOpen(false);
      setPreview(null);
      setDatabaseFile(null);
      setDocumentFile(null);
      await loadBatches();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目恢复失败");
    } finally {
      setRestoring(false);
    }
  };

  const rollback = async (batch: RestoreBatch) => {
    if (!(await confirm(`确认将「${batch.projectNames.join("、")}」回滚到本次恢复前的状态吗？`))) return;
    setRollingBackId(batch.id);
    setMessage("");
    try {
      const result = await api.post<{ message: string }>("/api/admin/system-data/backups/project-restore/rollback", { batchId: batch.id, confirmText: "回滚项目恢复" });
      setMessage(result.message);
      await loadBatches();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setRollingBackId("");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm"><DatabaseZap className="size-4 text-primary" />按项目恢复</CardTitle>
            <CardDescription className="text-xs">从完整系统备份中选择一个或多个项目；同 ID 替换，不同 ID 新增，批次内全部成功或全部回退。</CardDescription>
          </div>
          <Button size="sm" className="h-8 text-xs" onClick={() => setDialogOpen(true)}><Search className="size-3.5" />选择备份并预检</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border border-border bg-muted/15 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
          数据库与项目文档会共同预检。历史账号可映射到现有账号、设为未分配，或恢复为默认停用的曾用账号。恢复成功后保留 30 天保护快照。
        </div>
        {message && <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">{message}</div>}
        {batches.length > 0 && <Table className="min-w-[760px]"><TableHeader><TableRow><TableHead>恢复时间</TableHead><TableHead>项目</TableHead><TableHead>状态</TableHead><TableHead>保护截止</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{batches.map((batch) => <TableRow key={batch.id}><TableCell>{new Date(batch.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell>{batch.projectNames.join("、")}</TableCell><TableCell>{batch.status}</TableCell><TableCell>{new Date(batch.expiresAt).toLocaleString("zh-CN")}</TableCell><TableCell className="text-right"><TableActionButton disabled={!batch.canRollback || rollingBackId === batch.id} onClick={() => void rollback(batch)}><RotateCcw className="size-3" />{rollingBackId === batch.id ? "回滚中..." : "回滚"}</TableActionButton></TableCell></TableRow>)}</TableBody></Table>}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!restoring && !previewing) setDialogOpen(open); }}>
        <DialogContent className="max-h-[85vh] w-[min(980px,calc(100vw-32px))] max-w-none overflow-y-auto">
          <DialogHeader><DialogTitle>项目恢复预检</DialogTitle><DialogDescription>先读取备份结构和关联关系，预检不会修改正式数据。</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs"><span className="font-medium">数据库备份（database.dump）</span><input type="file" accept=".dump,application/octet-stream" className="block w-full rounded-md border border-border p-2" onChange={(event) => { setDatabaseFile(event.target.files?.[0] ?? null); setPreview(null); }} /></label>
              <label className="space-y-1 text-xs"><span className="font-medium">项目文档（project-documents.tar.gz）</span><input type="file" accept=".tar.gz,application/gzip" className="block w-full rounded-md border border-border p-2" onChange={(event) => { setDocumentFile(event.target.files?.[0] ?? null); setPreview(null); }} /></label>
            </div>
            <Button variant="outline" size="sm" disabled={!databaseFile || previewing || restoring} onClick={() => void runPreview()}><ShieldCheck className="size-3.5" />{previewing ? "正在隔离解析..." : "开始预检"}</Button>
            {preview && <>
              <div className="space-y-2"><div className="text-xs font-medium">选择项目</div>{preview.projects.map((project) => <label key={project.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2 text-xs"><input type="checkbox" className="mt-0.5 size-4" checked={selectedProjectIds.includes(project.id)} onChange={(event) => setSelectedProjectIds((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} /><span className="min-w-0 flex-1"><span className="font-medium">{project.name}（{project.code || "无编号"}）</span><span className="ml-2 text-muted-foreground">{project.action === "REPLACE" ? "同 ID，替换当前项目" : "新增项目"}</span><span className="mt-1 block text-[11px] text-muted-foreground">WBS {project.counts.ProjectGanttTask ?? 0} · 事项 {project.counts.WeeklyItem ?? 0} · 风险 {project.counts.RiskRegisterItem ?? 0} · 文档 {project.counts.ProjectDocumentFile ?? 0}</span></span></label>)}</div>
              {selectedAccountIssues.length > 0 && <div className="space-y-2"><div className="text-xs font-medium">历史账号处置</div>{selectedAccountIssues.map((issue) => <div key={issue.id} className="grid gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs md:grid-cols-[1fr_320px]"><div><div className="font-medium">{issue.displayName}（{issue.username}）</div><div className="text-[11px] text-muted-foreground">当前数据库没有相同账号 ID；恢复曾用账号时默认停用，不恢复旧密码和旧权限。</div></div><Select value={accountChoices[issue.id] ?? ""} onChange={(event) => setAccountChoices((current) => ({ ...current, [issue.id]: event.target.value }))}><option value="">请选择处理方式</option>{issue.candidates.map((candidate) => <option key={candidate.id} value={`MAP:${candidate.id}`}>映射：{candidate.displayName}（{candidate.username}）</option>)}<option value="UNASSIGNED">设为未分配</option><option value="RESTORE_DISABLED">恢复曾用账号（停用）</option></Select></div>)}</div>}
              <div className={selectedMissingDocumentCount > 0 ? "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" : "rounded-md border border-border bg-muted/15 px-3 py-2 text-xs text-muted-foreground"}>文档预检：备份记录 {preview.documentCheck.requiredCount} 个文件；所选项目缺失 {selectedMissingDocumentCount} 个。{preview.documentCheck.requiredCount > 0 && !preview.documentCheck.supplied ? " 请同时选择文档归档。" : ""}</div>
            </>}
          </div>
          <DialogFooter><Button variant="outline" disabled={restoring || previewing} onClick={() => setDialogOpen(false)}>取消</Button><Button disabled={!preview || selectedProjectIds.length === 0 || selectedMissingDocumentCount > 0 || restoring || previewing} onClick={() => void executeRestore()}>{restoring ? "正在恢复..." : "恢复所选项目"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
