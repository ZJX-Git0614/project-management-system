"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmptyState, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

type ProcurementItem = {
  id: string;
  name: string;
  specification: string;
  plannedQuantity: number;
  orderedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  unit: string;
  unitPrice: number;
  plannedAmount: number;
  status: string;
  statusCode: string;
  supplierName: string;
  orderNo: string;
};

type ManualDraft = {
  name: string;
  specification: string;
  plannedQuantity: number;
  unit: string;
  unitPrice: number;
};

const statusOptions = [
  ["DRAFT", "草稿"], ["PENDING_PURCHASE", "待采购"], ["SOURCING", "寻源中"],
  ["ORDERED", "已下单"], ["PARTIALLY_RECEIVED", "部分到货"], ["RECEIVED", "已到货"],
  ["INSPECTING", "检验中"], ["ACCEPTED", "验收通过"], ["REJECTED", "验收退回"],
  ["CLOSED", "已关闭"], ["ON_HOLD", "已挂起"], ["CANCELLED", "已取消"],
] as const;

const badgeVariant = (status: string): "success" | "warning" | "secondary" | "destructive" => (
  ["验收通过", "已关闭"].includes(status) ? "success"
    : ["验收退回", "已取消"].includes(status) ? "destructive"
      : ["检验中"].includes(status) ? "warning"
        : "secondary"
);

export function ProjectProcurementProcessPanel({ projectId }: { projectId: string }) {
  const { can } = usePermission();
  const canCreate = can("project-procurement:create");
  const canEdit = can("project-procurement:edit");
  const [items, setItems] = useState<ProcurementItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [statusCode, setStatusCode] = useState("DRAFT");
  const [orderNo, setOrderNo] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [orderedQuantity, setOrderedQuantity] = useState(0);
  const [receivedQuantity, setReceivedQuantity] = useState(0);
  const [acceptedQuantity, setAcceptedQuantity] = useState(0);
  const [unitPrice, setUnitPrice] = useState(0);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const reload = useCallback(async () => {
    try {
      setItems(await api.get<ProcurementItem[]>(`/api/projects/${projectId}/procurement-items`));
    } catch (error) {
      setItems([]);
      window.alert(error instanceof Error ? error.message : "加载采购条目失败");
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const choose = (item: ProcurementItem) => {
    setSelectedId(item.id);
    setStatusCode(item.statusCode);
    setOrderNo(item.orderNo);
    setSupplierName(item.supplierName);
    setOrderedQuantity(item.orderedQuantity);
    setReceivedQuantity(item.receivedQuantity);
    setAcceptedQuantity(item.acceptedQuantity);
    setUnitPrice(item.unitPrice);
  };

  const createManual = async () => {
    if (!manualDraft) return;
    if (!manualDraft.name.trim() || !manualDraft.unit.trim() || manualDraft.plannedQuantity <= 0 || manualDraft.unitPrice < 0) {
      window.alert("请填写物料名称、单位、正数计划数量和非负单价。");
      return;
    }
    try {
      const created = await api.post<ProcurementItem>(`/api/projects/${projectId}/procurement-items`, manualDraft);
      setItems((current) => [created, ...current]);
      setManualDraft(null);
      choose(created);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "新增采购条目失败");
    }
  };

  const saveProgress = async () => {
    if (!selected) return;
    try {
      const saved = await api.put<ProcurementItem>(`/api/projects/${projectId}/procurement-items/${selected.id}/status`, {
        status: statusCode,
        orderNo,
        supplierName,
        orderedQuantity,
        receivedQuantity,
        acceptedQuantity,
        unitPrice,
      });
      setItems((current) => current.map((item) => item.id === saved.id ? saved : item));
      choose(saved);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存采购过程失败");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>采购过程状态管理</CardTitle>
        <CardDescription>手工采购可在此新增；每次状态变更都会写入状态日志和项目操作历史，已下单后的 BOM 同步不会覆盖原采购事实。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canCreate && <div className="flex justify-end"><Button size="sm" onClick={() => setManualDraft({ name: "", specification: "", plannedQuantity: 1, unit: "件", unitPrice: 0 })}><Plus className="mr-1 size-3.5" />新增手工采购</Button></div>}
        {manualDraft && <div className="grid gap-2 rounded-md bg-muted/40 p-3 md:grid-cols-3"><Input placeholder="物料名称" value={manualDraft.name} onChange={(event) => setManualDraft({ ...manualDraft, name: event.target.value })} /><Input placeholder="规格" value={manualDraft.specification} onChange={(event) => setManualDraft({ ...manualDraft, specification: event.target.value })} /><Input placeholder="单位" value={manualDraft.unit} onChange={(event) => setManualDraft({ ...manualDraft, unit: event.target.value })} /><Input type="number" min={0.0001} placeholder="计划数量" value={manualDraft.plannedQuantity} onChange={(event) => setManualDraft({ ...manualDraft, plannedQuantity: Number(event.target.value) })} /><Input type="number" min={0} placeholder="单价（CNY）" value={manualDraft.unitPrice} onChange={(event) => setManualDraft({ ...manualDraft, unitPrice: Number(event.target.value) })} /><div className="flex gap-2"><Button size="sm" onClick={() => void createManual()}><Save className="mr-1 size-3.5" />保存</Button><Button size="sm" variant="ghost" onClick={() => setManualDraft(null)}>取消</Button></div></div>}
        <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>物料</TableHead><TableHead>计划</TableHead><TableHead>下单</TableHead><TableHead>到货</TableHead><TableHead>验收</TableHead><TableHead>状态</TableHead><TableHead>订单号</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{items.length === 0 ? <TableEmptyState colSpan={8}>暂无采购条目；可从已发布物料版本同步，或新增手工采购。</TableEmptyState> : items.map((item) => <TableRow key={item.id}><TableCell>{item.name}<span className="ml-1 text-xs text-muted-foreground">{item.specification}</span></TableCell><TableCell>{item.plannedQuantity}{item.unit}</TableCell><TableCell>{item.orderedQuantity}</TableCell><TableCell>{item.receivedQuantity}</TableCell><TableCell>{item.acceptedQuantity}</TableCell><TableCell><Badge variant={badgeVariant(item.status)}>{item.status}</Badge></TableCell><TableCell>{item.orderNo || "-"}</TableCell><TableCell>{canEdit && <Button size="sm" variant="ghost" onClick={() => choose(item)}>更新</Button>}</TableCell></TableRow>)}</TableBody></Table></div>
        {selected && canEdit && <div className="grid gap-2 rounded-md border border-border/70 p-3 md:grid-cols-3"><div className="text-sm font-semibold md:col-span-3">更新采购过程：{selected.name}</div><Select value={statusCode} onChange={(event) => setStatusCode(event.target.value)}>{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><Input placeholder="订单号（下单必填）" value={orderNo} onChange={(event) => setOrderNo(event.target.value)} /><Input placeholder="供应商" value={supplierName} onChange={(event) => setSupplierName(event.target.value)} /><Input type="number" min={0} placeholder="已下单数量" value={orderedQuantity} onChange={(event) => setOrderedQuantity(Number(event.target.value))} /><Input type="number" min={0} placeholder="已到货数量" value={receivedQuantity} onChange={(event) => setReceivedQuantity(Number(event.target.value))} /><Input type="number" min={0} placeholder="验收数量" value={acceptedQuantity} onChange={(event) => setAcceptedQuantity(Number(event.target.value))} /><Input type="number" min={0} placeholder="实际单价" value={unitPrice} onChange={(event) => setUnitPrice(Number(event.target.value))} /><div className="md:col-span-2"><Button size="sm" onClick={() => void saveProgress()}><Save className="mr-1 size-3.5" />保存状态变更</Button></div></div>}
      </CardContent>
    </Card>
  );
}
