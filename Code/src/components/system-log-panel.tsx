"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmptyState, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api-client";

type LogItem = {
  id: string;
  createdAt: string;
  level: string;
  category: string;
  module: string;
  eventType: string;
  operator: string;
  projectId: string;
  projectName: string;
  message: string;
};

type LogResult = {
  logs: LogItem[];
  total: number;
  retentionDays: number;
  capacityBytes: number;
  sizeBytes: number;
};

const dateInput = (date: Date) => date.toISOString().slice(0, 10);
const formatBytes = (value: number) => value >= 1024 * 1024 * 1024
  ? `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
  : `${(value / 1024 / 1024).toFixed(1)} MB`;

export function SystemLogPanel() {
  const [start, setStart] = useState(() => dateInput(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [end, setEnd] = useState(() => dateInput(new Date()));
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [operator, setOperator] = useState("");
  const [keyword, setKeyword] = useState("");
  const [data, setData] = useState<LogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    if (level) params.set("level", level);
    if (category) params.set("category", category);
    if (moduleName) params.set("module", moduleName);
    if (projectId.trim()) params.set("projectId", projectId.trim());
    if (operator.trim()) params.set("operator", operator.trim());
    if (keyword.trim()) params.set("keyword", keyword.trim());
    return params;
  }, [category, end, keyword, level, moduleName, operator, projectId, start]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      setData(await api.get<LogResult>(`/api/admin/system-data/logs?${query.toString()}`));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

  const exportLogs = async () => {
    setExporting(true);
    setMessage("");
    try {
      const params = new URLSearchParams(query);
      params.set("export", "zip");
      const result = await api.downloadFile(`/api/admin/system-data/logs?${params.toString()}`);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName || `Ceastar-PMS-系统日志-${Date.now()}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "日志导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm"><ScrollText className="size-4 text-primary" />系统日志</CardTitle>
            <CardDescription className="text-xs">
              记录业务、管理、系统与报错事件；固定保留 {data?.retentionDays ?? 180} 天，最大 {formatBytes(data?.capacityBytes ?? 5 * 1024 * 1024 * 1024)}。
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={loading} onClick={() => void loadLogs()}><RefreshCw className="size-3.5" />刷新</Button>
            <Button size="sm" className="h-8 text-xs" disabled={exporting || loading} onClick={() => void exportLogs()}><Download className="size-3.5" />{exporting ? "导出中..." : "导出 ZIP"}</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
          <Input type="date" value={start} onChange={(event) => setStart(event.target.value)} aria-label="开始日期" />
          <Input type="date" value={end} onChange={(event) => setEnd(event.target.value)} aria-label="结束日期" />
          <Select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="日志级别">
            <option value="">全部级别</option><option value="INFO">信息</option><option value="WARN">警告</option><option value="ERROR">错误</option><option value="SECURITY">安全</option>
          </Select>
          <Select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="日志类别">
            <option value="">全部类别</option><option value="BUSINESS">业务</option><option value="ADMIN">管理</option><option value="SYSTEM">系统</option><option value="ERROR">报错</option>
          </Select>
          <Input value={moduleName} onChange={(event) => setModuleName(event.target.value)} placeholder="模块" />
          <Input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="项目 ID" />
          <Input value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="操作人" />
          <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="关键词" />
        </div>
        <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <span>匹配 {data?.total ?? 0} 条（页面显示最近 200 条）</span>
          <span>事件日志占用 {formatBytes(data?.sizeBytes ?? 0)}</span>
          <span>容量不足时依次清理 INFO、WARN、ERROR，安全日志最后清理</span>
        </div>
        {message && <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">{message}</div>}
        <Table className="min-w-[1000px]" wrapperClassName="max-h-80">
          <TableHeader className="sticky top-0 z-10"><TableRow><TableHead>时间</TableHead><TableHead>级别</TableHead><TableHead>类别 / 模块</TableHead><TableHead>操作人</TableHead><TableHead>项目</TableHead><TableHead>事件</TableHead></TableRow></TableHeader>
          <TableBody>
            {data?.logs.map((item) => <TableRow key={`${item.category}-${item.id}`}><TableCell className="whitespace-nowrap tabular-nums">{new Date(item.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell>{item.level}</TableCell><TableCell>{item.category} / {item.module || "-"}</TableCell><TableCell>{item.operator || "系统"}</TableCell><TableCell>{item.projectName || item.projectId || "-"}</TableCell><TableCell className="max-w-xl"><div className="font-medium">{item.eventType}</div><div className="truncate text-muted-foreground" title={item.message}>{item.message}</div></TableCell></TableRow>)}
            {!loading && data?.logs.length === 0 && <TableEmptyState colSpan={6}>当前筛选范围内没有日志</TableEmptyState>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
