"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, CircleX, Clock3, MessagesSquare, RotateCcw, Search, SendToBack, Workflow } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSystemFeedback } from "@/components/system-feedback-provider";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api-client";
import { APPROVAL_INSTANCE_STATUS_LABEL, APPROVAL_NODE_STATUS_LABEL } from "@/lib/approval-workflow";
import { cn } from "@/lib/utils";
import { usePermission } from "@/lib/use-permission";

interface ApprovalAssignmentView {
  id: string;
  accountId: string;
  displayNameSnapshot: string;
  roleNameSnapshot: string;
  status: string;
  comment: string;
  processedAt: string | null;
}

interface ApprovalNodeView {
  id: string;
  nodeName: string;
  nodeOrder: number;
  status: string;
  requiredApprovals: number;
  assignments: ApprovalAssignmentView[];
}

interface ApprovalInstanceView {
  id: string;
  title: string;
  summary: string;
  status: string;
  requesterAccountId: string;
  requesterName: string;
  requestedAt: string;
  completedAt: string | null;
  resultComment: string;
  lastError: string;
  project: { id: string; name: string; code: string };
  nodes: ApprovalNodeView[];
  collaborationThread: { id: string } | null;
}

const STATUS_OPTIONS = ["", "PENDING", "APPROVED", "REJECTED", "RETURNED", "CANCELED", "COMPLETION_FAILED"];

const statusTone = (status: string) => status === "APPROVED"
  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
  : status === "PENDING"
    ? "border-primary/30 bg-primary/10 text-primary"
    : status === "COMPLETION_FAILED" || status === "REJECTED"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-border bg-muted/40 text-muted-foreground";

const formatDateTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "--";

export default function ApprovalCenterPage() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { can } = usePermission();
  const { notify } = useSystemFeedback();
  const [items, setItems] = useState<ApprovalInstanceView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const isAdmin = user?.assignedRoleNames?.includes("管理员") ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (status) query.set("status", status);
      query.set("scope", scope);
      const data = await api.get<ApprovalInstanceView[]>(`/api/approval-instances?${query}`);
      setItems(data);
      const requestedId = searchParams.get("instanceId");
      setSelectedId((current) => data.some((item) => item.id === current)
        ? current
        : data.find((item) => item.id === requestedId)?.id ?? data[0]?.id ?? "");
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批列表加载失败", "error");
    } finally {
      setLoading(false);
    }
  }, [notify, scope, searchParams, status]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => [item.title, item.summary, item.project.code, item.project.name, item.requesterName]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [items, keyword]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const currentNode = selected?.nodes.find((node) => node.status === "PENDING") ?? null;
  const myAssignment = currentNode?.assignments.find((assignment) => assignment.accountId === user?.id && assignment.status === "PENDING");

  const process = async (action: "approve" | "reject" | "return") => {
    if (!selected) return;
    if (action !== "approve" && !comment.trim()) {
      notify("退回或拒绝时必须填写处理意见", "warning");
      return;
    }
    setProcessing(true);
    try {
      await api.post(`/api/approval-instances/${selected.id}/actions`, { action, comment });
      setComment("");
      notify(action === "approve" ? "审批已同意" : action === "reject" ? "审批已拒绝" : "审批已退回", "success");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批处理失败", "error");
    } finally {
      setProcessing(false);
    }
  };

  const cancel = async () => {
    if (!selected) return;
    if (!comment.trim()) return notify("撤销审批时必须填写原因", "warning");
    setProcessing(true);
    try {
      await api.delete(`/api/approval-instances/${selected.id}`, { reason: comment });
      setComment("");
      notify("审批已撤销", "success");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "审批撤销失败", "error");
    } finally {
      setProcessing(false);
    }
  };

  const retry = async () => {
    if (!selected) return;
    setProcessing(true);
    try {
      await api.post(`/api/approval-instances/${selected.id}/retry`, {});
      notify("业务执行重试已完成", "success");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "重试失败", "error");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm"><Workflow className="size-4 text-primary" />审批中心</CardTitle>
          <CardDescription className="text-xs">统一处理项目状态、WBS 基线及后续业务审批，审批结果由系统执行并留痕。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} className="h-8 pl-8 text-xs" placeholder="搜索审批标题、项目或发起人" />
          </div>
          <Select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-36 text-xs">
            {STATUS_OPTIONS.map((value) => <option key={value || "all"} value={value}>{value ? APPROVAL_INSTANCE_STATUS_LABEL[value] ?? value : "全部状态"}</option>)}
          </Select>
          <Select value={scope} onChange={(event) => setScope(event.target.value as "mine" | "all")} className="h-8 w-32 text-xs">
            <option value="mine">与我相关</option>
            {isAdmin && <option value="all">全部审批</option>}
          </Select>
        </CardContent>
      </Card>

      <div className="grid min-h-[620px] gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardContent className="max-h-[720px] overflow-y-auto p-0">
            {loading && <div className="px-4 py-10 text-center text-xs text-muted-foreground">正在加载...</div>}
            {!loading && filtered.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => { setSelectedId(item.id); setComment(""); }}
                className={cn("block w-full border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40", selectedId === item.id && "bg-primary/10")}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 font-medium text-sm text-foreground">{item.title}</div>
                  <Badge className={cn("shrink-0 text-[10px]", statusTone(item.status))}>{APPROVAL_INSTANCE_STATUS_LABEL[item.status] ?? item.status}</Badge>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{item.project.code} · {item.requesterName}</div>
                <div className="mt-1 text-[11px] text-muted-foreground/70">{formatDateTime(item.requestedAt)}</div>
              </button>
            ))}
            {!loading && filtered.length === 0 && <div className="px-4 py-12 text-center text-xs text-muted-foreground">没有符合条件的审批</div>}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          {!selected ? (
            <CardContent className="flex h-full min-h-[420px] items-center justify-center text-sm text-muted-foreground">选择一条审批查看详情</CardContent>
          ) : (
            <>
              <CardHeader className="border-b border-border pb-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{selected.title}</CardTitle>
                    <CardDescription className="mt-1 text-xs">{selected.summary}</CardDescription>
                  </div>
                  <Badge className={cn(statusTone(selected.status))}>{APPROVAL_INSTANCE_STATUS_LABEL[selected.status] ?? selected.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-5 pt-4">
                <div className="grid gap-3 text-xs md:grid-cols-4">
                  <div><div className="text-muted-foreground">项目</div><div className="mt-1 font-medium">{selected.project.code} · {selected.project.name}</div></div>
                  <div><div className="text-muted-foreground">发起人</div><div className="mt-1 font-medium">{selected.requesterName}</div></div>
                  <div><div className="text-muted-foreground">发起时间</div><div className="mt-1 font-medium">{formatDateTime(selected.requestedAt)}</div></div>
                  <div><div className="text-muted-foreground">完成时间</div><div className="mt-1 font-medium">{formatDateTime(selected.completedAt)}</div></div>
                </div>

                <section className="space-y-2">
                  <h2 className="text-xs font-semibold">流程节点</h2>
                  <div className="overflow-hidden rounded-md border border-border">
                    {selected.nodes.map((node) => (
                      <div key={node.id} className="grid gap-2 border-b border-border px-3 py-3 text-xs last:border-b-0 md:grid-cols-[32px_160px_100px_minmax(0,1fr)]">
                        <div className="flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{node.nodeOrder}</div>
                        <div className="font-medium">{node.nodeName}</div>
                        <div className="text-muted-foreground">{APPROVAL_NODE_STATUS_LABEL[node.status] ?? node.status}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {node.assignments.map((assignment) => (
                            <Badge key={assignment.id} variant="secondary" title={assignment.comment || undefined} className="text-[10px]">
                              {assignment.displayNameSnapshot}{assignment.roleNameSnapshot ? ` · ${assignment.roleNameSnapshot}` : ""} · {APPROVAL_NODE_STATUS_LABEL[assignment.status] ?? assignment.status}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {(selected.resultComment || selected.lastError) && (
                  <div className={cn("rounded-md border px-3 py-2 text-xs", selected.lastError ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-border bg-muted/30 text-muted-foreground")}>
                    {selected.lastError || selected.resultComment}
                  </div>
                )}

                {(selected.status === "PENDING" || selected.status === "COMPLETION_FAILED") && (
                  <section className="space-y-2 border-t border-border pt-4">
                    <Textarea value={comment} onChange={(event) => setComment(event.target.value)} className="min-h-20 text-xs" placeholder="处理意见；退回、拒绝或撤销时必填" />
                    <div className="flex flex-wrap items-center gap-2">
                      {myAssignment && can("approval-center:process") && selected.status === "PENDING" && (
                        <>
                          <Button size="sm" className="h-8 text-xs" disabled={processing} onClick={() => void process("approve")}><Check className="size-3.5" />同意</Button>
                          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={processing} onClick={() => void process("return")}><SendToBack className="size-3.5" />退回</Button>
                          <Button size="sm" variant="destructive" className="h-8 text-xs" disabled={processing} onClick={() => void process("reject")}><CircleX className="size-3.5" />拒绝</Button>
                        </>
                      )}
                      {selected.requesterAccountId === user?.id && can("approval-center:cancel") && selected.status === "PENDING" && (
                        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={processing} onClick={() => void cancel()}><Clock3 className="size-3.5" />撤销</Button>
                      )}
                      {selected.status === "COMPLETION_FAILED" && can("approval-center:retry") && (
                        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={processing} onClick={() => void retry()}><RotateCcw className="size-3.5" />重试业务执行</Button>
                      )}
                      {selected.collaborationThread && (
                        <Button asChild size="sm" variant="ghost" className="h-8 text-xs"><Link href={`/collaboration?threadId=${selected.collaborationThread.id}`}><MessagesSquare className="size-3.5" />查看协同记录</Link></Button>
                      )}
                    </div>
                  </section>
                )}
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
