"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FilePlus2, Link2, Pencil, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useConfirm } from "@/components/confirm-provider";
import { escapeSpreadsheetCsvCell } from "@/lib/project-delivery-procurement";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmptyState, TableHead, TableHeader, TableRow, TableToolbar } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type Deliverable = { id: string; name: string; quantity: number; unit: string; type: "软件" | "硬件"; outsourceMode: "否" | "是" | "部分"; lifecycleStatus?: string; remark?: string; gitUrl?: string; gitRef?: string; hasPrototype?: boolean; prototypeQuantity?: number; massProductionQuantity?: number; bomReady?: boolean; cableListReady?: boolean; updatedAt?: string };
type MaterialRevision = { id: string; stage: "PROTOTYPE" | "MASS_PRODUCTION"; listType: "BOM" | "CABLE_LIST"; version: number; status: "DRAFT" | "RELEASED" | "SUPERSEDED"; sourceDocumentFile: { id: string; originalName: string } | null; items: Array<{ id: string; name: string; unit: string; quantityPerUnit: number }> };
type ProjectDocument = { id: string; originalName: string; directoryKey: string };
const statusLabels: Record<string, string> = { DRAFT: "草稿", IN_PROGRESS: "进行中", READY_FOR_REVIEW: "待评审", ACCEPTED: "验收通过", DELIVERED: "已交付", REJECTED: "退回", CANCELLED: "已取消" };
const badgeVariant = (s?: string) => s === "ACCEPTED" || s === "DELIVERED" ? "success" : s === "REJECTED" || s === "CANCELLED" ? "destructive" : s === "READY_FOR_REVIEW" ? "warning" : "secondary";

const useProjectData = <T,>(path: string, fallback: T[]) => {
  const [rows, setRows] = useState<T[]>(fallback); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const fallbackRef = useRef(fallback);
  const reload = useCallback(async () => { setLoading(true); setError(null); try { const data = await api.get<T[]>(path); setRows(Array.isArray(data) ? data : []); } catch (loadError) { setRows((current) => current.length ? current : fallbackRef.current); setError(loadError instanceof Error ? loadError.message : "加载失败"); } finally { setLoading(false); } }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { rows, setRows, loading, error, reload };
};

export function ProjectDeliverableListPanel({ projectId }: { projectId: string }) {
  const { can } = usePermission();
  const confirm = useConfirm();
  const canCreate = can("project-deliverables:create");
  const canEdit = can("project-deliverables:edit");
  const canDelete = can("project-deliverables:delete");
  const canExport = can("project-deliverables:export");
  const data = useProjectData<Deliverable>(`/api/projects/${projectId}/deliverables`, []);
  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [draft, setDraft] = useState<Deliverable | null>(null);
  const filtered = data.rows.filter((r) => (!keyword || `${r.name} ${r.type}`.includes(keyword)) && (typeFilter === "all" || r.type === typeFilter));
  const add = () => setDraft({ id: `draft-${Date.now()}`, name: "", quantity: 1, unit: "套", type: "软件", outsourceMode: "否" });
  const save = async () => {
    if (!draft?.name.trim() || draft.quantity <= 0) return;
    const isNew = draft.id.startsWith("draft-");
    try {
      const saved = isNew
        ? await api.post<Deliverable>(`/api/projects/${projectId}/deliverables`, draft)
        : await api.patch<Deliverable>(`/api/projects/${projectId}/deliverables/${draft.id}`, draft);
      data.setRows((rows) => isNew ? [...rows, saved] : rows.map((row) => row.id === saved.id ? saved : row));
      setDraft(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `${isNew ? "新增" : "更新"}交付物失败`);
    }
  };
  const archive = async (item: Deliverable) => {
    if (!item.updatedAt || !await confirm(`确认归档交付物「${item.name}」？关联的物料版本与采购审计记录会继续保留。`)) return;
    try {
      await api.delete(`/api/projects/${projectId}/deliverables/${item.id}`, { updatedAt: item.updatedAt });
      data.setRows((rows) => rows.filter((row) => row.id !== item.id));
      if (draft?.id === item.id) setDraft(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "归档交付物失败");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>交付物清单</CardTitle>
        <CardDescription>定义项目最终交付范围，状态和采购来源由关联模块持续维护。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.error && <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">交付物加载失败：{data.error}</div>}
        <TableToolbar>
          <div className="flex flex-wrap gap-2">
            <Input className="h-8 w-48 text-xs" placeholder="筛选交付物名称" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            <Select className="h-8 w-28 text-xs" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">全部类型</option><option>软件</option><option>硬件</option>
            </Select>
          </div>
          <div className="flex gap-2">
            {canExport && <Button variant="outline" size="sm" onClick={() => exportCsv(filtered)}><Download className="mr-1 size-3.5" />导出</Button>}
            {canCreate && <Button size="sm" onClick={add}><Plus className="mr-1 size-3.5" />新增交付物</Button>}
          </div>
        </TableToolbar>
        <Table>
          <TableHeader><TableRow><TableHead>序号</TableHead><TableHead>交付物名称</TableHead><TableHead>数量</TableHead><TableHead>单位</TableHead><TableHead>类型</TableHead><TableHead>是否外协</TableHead><TableHead>当前状态</TableHead><TableHead>备注</TableHead></TableRow></TableHeader>
          <TableBody>
            {draft && <TableRow>
              <TableCell>{draft.id.startsWith("draft-") ? "新建" : "编辑"}</TableCell>
              <TableCell><Input autoFocus className="h-7 text-xs" placeholder="必填" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void save()} /></TableCell>
              <TableCell><Input type="number" min={1} className="h-7 w-20 text-xs" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })} /></TableCell>
              <TableCell><Input className="h-7 w-16 text-xs" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></TableCell>
              <TableCell><Select className="h-7 text-xs" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Deliverable["type"] })}><option>软件</option><option>硬件</option></Select></TableCell>
              <TableCell><Select className="h-7 text-xs" value={draft.outsourceMode} onChange={(e) => setDraft({ ...draft, outsourceMode: e.target.value as Deliverable["outsourceMode"] })}><option>否</option><option>是</option><option>部分</option></Select></TableCell>
              <TableCell><Button size="sm" onClick={() => void save()}><Save className="mr-1 size-3" />保存</Button></TableCell>
              <TableCell><Button size="sm" variant="ghost" onClick={() => setDraft(null)}>取消</Button></TableCell>
            </TableRow>}
            {!data.loading && filtered.length === 0
              ? <TableEmptyState colSpan={8}>暂无交付物，请先新增项目交付物。</TableEmptyState>
              : filtered.map((r, i) => <TableRow key={r.id}>
                <TableCell>{i + 1}</TableCell>
                <TableCell className="font-medium"><div className="flex items-center gap-1"><span>{r.name}</span>{canEdit && <Button title="编辑交付物" variant="ghost" size="icon" className="size-7" onClick={() => setDraft({ ...r })}><Pencil className="size-3.5" /></Button>}{canDelete && <Button title="归档交付物" variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => void archive(r)}><Trash2 className="size-3.5" /></Button>}</div></TableCell>
                <TableCell>{r.quantity}</TableCell><TableCell>{r.unit}</TableCell><TableCell>{r.type}</TableCell><TableCell>{r.outsourceMode}</TableCell>
                <TableCell><Badge variant={badgeVariant(r.lifecycleStatus) as "success" | "warning" | "secondary"}>{statusLabels[r.lifecycleStatus ?? "DRAFT"] ?? "草稿"}</Badge></TableCell>
                <TableCell className="max-w-48 truncate text-muted-foreground">{r.remark || "-"}</TableCell>
              </TableRow>)}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function ProjectDeliveryStatusPanel({ projectId }: { projectId: string }) {
  const { can } = usePermission(); const canChangeStatus = can("project-delivery-status:status-change");
  const data = useProjectData<Deliverable>(`/api/projects/${projectId}/deliverables`, []); const [selected, setSelected] = useState<Deliverable | null>(null); const [status, setStatus] = useState("DRAFT");
  const [gitUrl, setGitUrl] = useState(""); const [gitRef, setGitRef] = useState(""); const [hasPrototype, setHasPrototype] = useState(false); const [prototypeQuantity, setPrototypeQuantity] = useState(0); const [massProductionQuantity, setMassProductionQuantity] = useState(0);
  const save = async () => { if (!selected) return; const payload = selected.type === "软件" ? { lifecycleStatus: status, gitUrl, gitRef } : { lifecycleStatus: status, hasPrototype, prototypeQuantity, massProductionQuantity }; try { const saved = await api.put<Deliverable>(`/api/projects/${projectId}/deliverables/${selected.id}/status`, payload); setSelected(saved); data.setRows((rows) => rows.map((r) => r.id === selected.id ? saved : r)); } catch (error) { window.alert(error instanceof Error ? error.message : "保存交付物状态失败"); } };
  return <Card><CardHeader><CardTitle>交付物状态管理</CardTitle><CardDescription>按交付物维护进展、验收准备和软件/硬件专属资料。</CardDescription></CardHeader><CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"><Table><TableHeader><TableRow><TableHead>交付物</TableHead><TableHead>类型</TableHead><TableHead>当前状态</TableHead><TableHead>更新</TableHead></TableRow></TableHeader><TableBody>{data.rows.length === 0 ? <TableEmptyState colSpan={4}>暂无交付物，请先在交付物清单创建记录。</TableEmptyState> : data.rows.map((r) => <TableRow key={r.id}><TableCell>{r.name}</TableCell><TableCell>{r.type}</TableCell><TableCell><Badge variant={badgeVariant(r.lifecycleStatus) as "success" | "warning" | "secondary"}>{statusLabels[r.lifecycleStatus ?? "DRAFT"] ?? "草稿"}</Badge></TableCell><TableCell>{canChangeStatus && <Button variant="ghost" size="sm" onClick={() => { setSelected(r); setStatus(r.lifecycleStatus ?? "DRAFT"); setGitUrl(r.gitUrl ?? ""); setGitRef(r.gitRef ?? ""); setHasPrototype(Boolean(r.hasPrototype)); setPrototypeQuantity(r.prototypeQuantity ?? 0); setMassProductionQuantity(r.massProductionQuantity ?? r.quantity); }}>编辑状态</Button>}</TableCell></TableRow>)}</TableBody></Table>{selected ? <div className="rounded-lg border border-border/70 p-4"><div className="mb-3 text-sm font-semibold">{selected.name} · {selected.type}</div><label className="mb-1 block text-xs text-muted-foreground">当前状态</label><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="DRAFT">草稿</option><option value="IN_PROGRESS">进行中</option><option value="READY_FOR_REVIEW">待评审</option><option value="ACCEPTED">验收通过</option><option value="DELIVERED">已交付</option><option value="REJECTED">退回</option><option value="CANCELLED">已取消</option></Select>{selected.type === "软件" ? <div className="mt-3 space-y-2"><Input placeholder="代码版本 Git 地址（待评审必填）" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} /><Input placeholder="Tag / 分支 / Commit（可选）" value={gitRef} onChange={(e) => setGitRef(e.target.value)} /></div> : <div className="mt-3 space-y-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={hasPrototype} onChange={(e) => setHasPrototype(e.target.checked)} />有样机</label>{hasPrototype && <Input type="number" min={1} placeholder="样机数量" value={prototypeQuantity} onChange={(e) => setPrototypeQuantity(Number(e.target.value))} />}<Input type="number" min={0} placeholder="量产数量" value={massProductionQuantity} onChange={(e) => setMassProductionQuantity(Number(e.target.value))} /><div className="text-xs text-muted-foreground">{selected.bomReady && selected.cableListReady ? "BOM 与线缆清单已就绪" : "待补充有效 BOM 与线缆清单版本"}</div></div>}<Button className="mt-3 w-full" size="sm" onClick={() => void save()}>保存状态</Button><div className="mt-3 text-xs text-muted-foreground">{selected.type === "软件" ? "软件交付物需补充 Git 地址后方可进入待评审。" : "硬件交付物需具备有效 BOM 与线缆清单版本。"}</div></div> : <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-8 text-xs text-muted-foreground">选择交付物查看状态详情</div>}</CardContent></Card>;
}

function exportCsv(rows: Deliverable[]) { const csv = [["交付物名称", "数量", "单位", "类型", "是否外协", "当前状态"], ...rows.map((r) => [r.name, r.quantity, r.unit, r.type, r.outsourceMode, statusLabels[r.lifecycleStatus ?? "DRAFT"]])].map((row) => row.map(escapeSpreadsheetCsvCell).join(",")).join("\n"); const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = "交付物清单.csv"; a.click(); URL.revokeObjectURL(url); }

export function ProjectHardwareMaterialsPanel({ projectId }: { projectId: string }) {
  const { can } = usePermission();
  const confirm = useConfirm();
  const canEdit = can("project-delivery-status:upload-material-list");
  const canPublish = can("project-delivery-status:publish-material-revision");
  const canSync = can("project-procurement:sync-bom");
  const deliverables = useProjectData<Deliverable>(`/api/projects/${projectId}/deliverables`, []);
  const documents = useProjectData<ProjectDocument>(`/api/projects/${projectId}/documents`, []);
  const hardware = deliverables.rows.filter((item) => item.type === "硬件");
  const [selectedId, setSelectedId] = useState("");
  const [revisions, setRevisions] = useState<MaterialRevision[]>([]);
  const [stage, setStage] = useState<MaterialRevision["stage"]>("MASS_PRODUCTION");
  const [listType, setListType] = useState<MaterialRevision["listType"]>("BOM");
  const [revisionStatus, setRevisionStatus] = useState<"DRAFT" | "RELEASED">("DRAFT");
  const [sourceDocumentFileId, setSourceDocumentFileId] = useState("");
  const [itemsText, setItemsText] = useState("");
  const selected = hardware.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && hardware[0]) setSelectedId(hardware[0].id);
  }, [hardware, selectedId]);

  const loadRevisions = useCallback(async () => {
    if (!selectedId) return;
    try {
      setRevisions(await api.get<MaterialRevision[]>(`/api/projects/${projectId}/deliverables/${selectedId}/materials`));
    } catch (error) {
      setRevisions([]);
      window.alert(error instanceof Error ? error.message : "加载物料版本失败");
    }
  }, [projectId, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setRevisions([]);
      return;
    }
    void loadRevisions();
  }, [loadRevisions, selectedId]);

  const importMaterialFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const XLSX = await import("@e965/xlsx");
      const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("文件中没有可读取的工作表");
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
      const valueOf = (row: Record<string, unknown>, aliases: string[]) => {
        const key = Object.keys(row).find((candidate) => aliases.some((alias) => candidate.trim().toLowerCase() === alias.toLowerCase()));
        return key ? String(row[key] ?? "").trim() : "";
      };
      const parsed = rows.map((row) => ({
        materialCode: valueOf(row, ["物料编码", "编码", "materialCode", "code"]),
        name: valueOf(row, ["物料名称", "名称", "name"]),
        specification: valueOf(row, ["规格型号", "规格", "specification", "model"]),
        unit: valueOf(row, ["单位", "unit"]),
        quantity: valueOf(row, ["单台用量", "用量", "数量", "quantityPerUnit", "quantity"]),
      })).filter((row) => row.name || row.materialCode || row.quantity);
      if (!parsed.length) throw new Error("未识别到物料行，请检查表头和数据");
      if (parsed.some((row) => !row.name || !row.unit || !Number.isFinite(Number(row.quantity)) || Number(row.quantity) <= 0)) {
        throw new Error("每条物料必须包含名称、单位和大于 0 的单台用量");
      }
      setItemsText(parsed.map((row) => [row.materialCode, row.name, row.specification, row.unit, row.quantity].join("|")).join("\n"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "导入物料清单失败");
    }
  };

  const createRevision = async () => {
    if (!selected) return;
    const items = itemsText.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const [materialCode = "", name = "", specification = "", unit = "", quantity = ""] = line.split("|").map((value) => value.trim());
      return { materialCode, name, specification, unit, quantityPerUnit: Number(quantity), sortOrder: index };
    });
    if (!items.length) {
      window.alert("请至少录入一条物料；每行格式为：物料编码|名称|规格|单位|单台用量。");
      return;
    }
    try {
      await api.post(`/api/projects/${projectId}/deliverables/${selected.id}/materials`, {
        stage,
        listType,
        status: revisionStatus,
        sourceDocumentFileId,
        items,
      });
      setSourceDocumentFileId("");
      setItemsText("");
      await loadRevisions();
      await deliverables.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存物料版本失败");
    }
  };

  const syncRevision = async (revision: MaterialRevision) => {
    try {
      const preview = await api.get<{ previewToken: string; createdCount: number; updatedCount: number; cancelledCount: number; lockedCount: number; changes: { created: string[]; updated: string[]; cancelled: string[]; locked: string[] } }>(`/api/projects/${projectId}/procurement-items/sync?sourceRevisionId=${encodeURIComponent(revision.id)}`);
      const accepted = await confirm(`BOM 同步差异预览：新增 ${preview.createdCount} 条、更新 ${preview.updatedCount} 条、取消 ${preview.cancelledCount} 条、锁定 ${preview.lockedCount} 条。\n\n锁定条目不会被覆盖。确认按此预览执行同步吗？`);
      if (!accepted) return;
      const result = await api.post<{ createdCount: number; updatedCount: number; cancelledCount: number; locked: string[] }>(`/api/projects/${projectId}/procurement-items/sync`, { sourceRevisionId: revision.id, confirmed: true, previewToken: preview.previewToken });
      window.alert(`同步完成：新增 ${result.createdCount} 条，更新 ${result.updatedCount} 条，取消 ${result.cancelledCount} 条${result.locked.length ? `；${result.locked.length} 条已有采购事实，保持不变。` : "。"}`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "同步采购失败");
    }
  };

  const publishRevision = async (revision: MaterialRevision) => {
    const documentId = revision.sourceDocumentFile?.id ?? sourceDocumentFileId;
    if (!documentId) {
      window.alert("请选择要关联的已上传项目文档后再发布。");
      return;
    }
    try {
      await api.put(`/api/projects/${projectId}/deliverables/${selectedId}/materials/${revision.id}`, { sourceDocumentFileId: documentId });
      await loadRevisions();
      await deliverables.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "发布物料版本失败");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>硬件 BOM / 线缆清单版本</CardTitle>
        <CardDescription>样机和量产机分别登记 BOM、线缆清单；发布后保留版本链，并可将结构化物料同步到项目采购管理。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(deliverables.error || documents.error) && <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">模块数据加载失败：{deliverables.error || documents.error}</div>}
        {hardware.length === 0 ? <div className="rounded border border-dashed p-6 text-sm text-muted-foreground">暂无硬件交付物。请先在“交付物清单”新增硬件记录。</div> : <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs text-muted-foreground"><span>硬件交付物</span><Select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{hardware.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
            <Button variant="outline" size="sm" onClick={() => window.location.assign(`/projects/${projectId}?nav=documents`)}><FilePlus2 className="mr-1 size-3.5" />先上传原始清单</Button>
            <Button variant="outline" size="sm" onClick={() => void loadRevisions()}><RefreshCw className="mr-1 size-3.5" />刷新版本</Button>
          </div>
          {canEdit && <div className="grid gap-2 rounded-md bg-muted/40 p-3 md:grid-cols-2">
            <Select value={stage} onChange={(event) => setStage(event.target.value as MaterialRevision["stage"])}><option value="MASS_PRODUCTION">量产机</option><option value="PROTOTYPE">样机</option></Select>
            <Select value={listType} onChange={(event) => setListType(event.target.value as MaterialRevision["listType"])}><option value="BOM">BOM 清单</option><option value="CABLE_LIST">线缆清单</option></Select>
            <Select value={revisionStatus} onChange={(event) => setRevisionStatus(event.target.value as "DRAFT" | "RELEASED")}><option value="DRAFT">保存草稿</option><option value="RELEASED">发布版本</option></Select>
            <Select value={sourceDocumentFileId} onChange={(event) => setSourceDocumentFileId(event.target.value)}><option value="">关联已上传项目文档（发布必填）</option>{documents.rows.map((document) => <option key={document.id} value={document.id}>{document.originalName} · {document.directoryKey}</option>)}</Select>
            <label className="grid gap-1 text-xs text-muted-foreground md:col-span-2"><span>导入结构化清单（支持 CSV / XLS / XLSX；表头需含名称、单位、单台用量）</span><Input type="file" accept=".csv,.xls,.xlsx" onChange={(event) => { void importMaterialFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
            <Textarea className="min-h-24 md:col-span-2" placeholder={"每行一条：物料编码|名称|规格|单位|单台用量\n例如：PCB-001|控制板|Rev.A|块|1"} value={itemsText} onChange={(event) => setItemsText(event.target.value)} />
            <div className="md:col-span-2"><Button size="sm" onClick={() => void createRevision()}><Save className="mr-1 size-3.5" />保存物料版本</Button></div>
          </div>}
          <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>阶段</TableHead><TableHead>清单类型</TableHead><TableHead>版本</TableHead><TableHead>状态</TableHead><TableHead>关联文档</TableHead><TableHead>物料数</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{revisions.length === 0 ? <TableEmptyState colSpan={7}>暂无版本。上传清单后，在上方登记结构化物料版本。</TableEmptyState> : revisions.map((revision) => <TableRow key={revision.id}><TableCell>{revision.stage === "PROTOTYPE" ? "样机" : "量产"}</TableCell><TableCell>{revision.listType === "BOM" ? "BOM 清单" : "线缆清单"}</TableCell><TableCell>V{revision.version}</TableCell><TableCell><Badge variant={revision.status === "RELEASED" ? "success" : revision.status === "DRAFT" ? "warning" : "secondary"}>{revision.status === "RELEASED" ? "已发布" : revision.status === "DRAFT" ? "草稿" : "已替代"}</Badge></TableCell><TableCell className="max-w-48 truncate">{revision.sourceDocumentFile?.originalName ?? "-"}</TableCell><TableCell>{revision.items.length}</TableCell><TableCell><div className="flex gap-1">{revision.status === "DRAFT" && canPublish && <Button variant="outline" size="sm" onClick={() => void publishRevision(revision)}>发布</Button>}{revision.status === "RELEASED" && canSync && <Button variant="outline" size="sm" onClick={() => void syncRevision(revision)}><Link2 className="mr-1 size-3.5" />同步采购</Button>}</div></TableCell></TableRow>)}</TableBody></Table></div>
        </>}
      </CardContent>
    </Card>
  );
}
