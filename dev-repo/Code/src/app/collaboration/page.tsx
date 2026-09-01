"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, FileUp, MessageSquarePlus, MessagesSquare, Paperclip, Search, Send, Users, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSystemFeedback } from "@/components/system-feedback-provider";
import { useCurrentProject } from "@/contexts/current-project-context";
import type { ProjectMember } from "@/domain/models";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { usePermission } from "@/lib/use-permission";

interface CollaborationAttachmentView {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

interface CollaborationMessageView {
  id: string;
  threadId: string;
  senderAccountId: string;
  senderName: string;
  messageType: string;
  content: string;
  createdAt: string;
  attachments: CollaborationAttachmentView[];
  mentions: Array<{ accountId: string; displayName: string }>;
}

interface CollaborationParticipantView {
  accountId: string;
  displayName: string;
  participantRole: string;
  lastReadAt: string | null;
}

interface CollaborationThreadView {
  id: string;
  projectId: string;
  title: string;
  kind: string;
  lastMessageAt: string;
  closedAt: string | null;
  project: { id: string; name: string; code: string };
  participants: CollaborationParticipantView[];
  messages: CollaborationMessageView[];
}

interface ProjectOption {
  id: string;
  name: string;
  code: string;
}

const formatDateTime = (value: string) => new Date(value).toLocaleString("zh-CN");
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function CollaborationPage() {
  const searchParams = useSearchParams();
  const { currentProjectId } = useCurrentProject();
  const { can } = usePermission();
  const { notify } = useSystemFeedback();
  const [threads, setThreads] = useState<CollaborationThreadView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedThread, setSelectedThread] = useState<CollaborationThreadView | null>(null);
  const [keyword, setKeyword] = useState("");
  const [message, setMessage] = useState("");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [createParticipantIds, setCreateParticipantIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const data = await api.get<CollaborationThreadView[]>("/api/collaboration/threads");
      setThreads(data);
      const requestedId = searchParams.get("threadId");
      setSelectedId((current) => data.some((item) => item.id === current)
        ? current
        : data.find((item) => item.id === requestedId)?.id ?? data[0]?.id ?? "");
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同会话加载失败", "error");
    }
  }, [notify, searchParams]);

  const loadThread = useCallback(async (threadId: string, scroll = false) => {
    if (!threadId) {
      setSelectedThread(null);
      return;
    }
    try {
      const data = await api.get<CollaborationThreadView>(`/api/collaboration/threads/${threadId}`);
      setSelectedThread(data);
      await api.post(`/api/collaboration/threads/${threadId}/read`, {}).catch(() => undefined);
      if (scroll) requestAnimationFrame(() => messageEndRef.current?.scrollIntoView({ behavior: "smooth" }));
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同消息加载失败", "error");
    }
  }, [notify]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);
  useEffect(() => { void loadThread(selectedId, true); }, [loadThread, selectedId]);

  useEffect(() => {
    const token = api.getToken();
    if (!token) return;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (threadId?: string) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void loadThreads();
        if (threadId && threadId === selectedId) void loadThread(threadId, true);
      }, 150);
    };
    void fetch(`/api/collaboration/events?since=${encodeURIComponent(new Date().toISOString())}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.startsWith("event: message")) continue;
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(6)) as { threadId?: string };
            refresh(payload.threadId);
          } catch {
            // Ignore malformed stream events and keep the connection alive.
          }
        }
      }
    }).catch(() => undefined);
    return () => {
      controller.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [loadThread, loadThreads, selectedId]);

  useEffect(() => {
    if (!createOpen) return;
    api.get<ProjectOption[]>("/api/projects").then((data) => {
      setProjects(data);
      setCreateProjectId((current) => current || (currentProjectId && data.some((project) => project.id === currentProjectId) ? currentProjectId : data[0]?.id ?? ""));
    }).catch((error) => notify(error instanceof Error ? error.message : "项目列表加载失败", "error"));
  }, [createOpen, currentProjectId, notify]);

  useEffect(() => {
    if (!createProjectId) {
      setMembers([]);
      return;
    }
    api.get<ProjectMember[]>(`/api/projects/${createProjectId}/members`).then(setMembers).catch(() => setMembers([]));
    setCreateParticipantIds([]);
  }, [createProjectId]);

  const filteredThreads = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return threads;
    return threads.filter((thread) => [thread.title, thread.project.name, thread.project.code]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [keyword, threads]);

  const sendMessage = async () => {
    if (!selectedId || !message.trim()) return;
    setSending(true);
    try {
      await api.post(`/api/collaboration/threads/${selectedId}/messages`, { content: message, mentionAccountIds: mentionIds });
      setMessage("");
      setMentionIds([]);
      await loadThread(selectedId, true);
      await loadThreads();
    } catch (error) {
      notify(error instanceof Error ? error.message : "消息发送失败", "error");
    } finally {
      setSending(false);
    }
  };

  const uploadAttachment = async (file?: File) => {
    if (!file || !selectedId) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api.upload(`/api/collaboration/threads/${selectedId}/attachments`, form);
      notify("附件已上传", "success");
      await loadThread(selectedId, true);
      await loadThreads();
    } catch (error) {
      notify(error instanceof Error ? error.message : "附件上传失败", "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const downloadAttachment = async (attachment: CollaborationAttachmentView) => {
    try {
      const result = await api.downloadFile(`/api/collaboration/attachments/${attachment.id}`);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName || attachment.originalName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : "附件下载失败", "error");
    }
  };

  const createThread = async () => {
    if (!createProjectId || !createTitle.trim()) return notify("请选择项目并填写会话名称", "warning");
    setCreating(true);
    try {
      const created = await api.post<CollaborationThreadView>("/api/collaboration/threads", {
        projectId: createProjectId,
        title: createTitle,
        participantAccountIds: createParticipantIds,
      });
      setCreateOpen(false);
      setCreateTitle("");
      setCreateParticipantIds([]);
      await loadThreads();
      setSelectedId(created.id);
      notify("协同会话已创建", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同会话创建失败", "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm"><MessagesSquare className="size-4 text-primary" />协同沟通</CardTitle>
              <CardDescription className="mt-1 text-xs">围绕项目或审批实例集中沟通，消息、提及与附件均留存在系统中。</CardDescription>
            </div>
            {can("collaboration-center:create") && <Button size="sm" className="h-8 text-xs" onClick={() => setCreateOpen(true)}><MessageSquarePlus className="size-3.5" />新建会话</Button>}
          </div>
        </CardHeader>
      </Card>

      <div className="grid min-h-[660px] gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} className="h-8 pl-8 text-xs" placeholder="搜索会话或项目" />
            </div>
          </CardHeader>
          <CardContent className="max-h-[720px] overflow-y-auto p-0">
            {filteredThreads.map((thread) => (
              <button type="button" key={thread.id} onClick={() => setSelectedId(thread.id)} className={cn("block w-full border-b border-border px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40", selectedId === thread.id && "bg-primary/10")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 truncate text-sm font-medium">{thread.title}</div>
                  {thread.kind === "APPROVAL" && <Badge variant="secondary" className="shrink-0 text-[10px]">审批</Badge>}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{thread.project.code} · {thread.project.name}</div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground/70">{thread.messages[0]?.content || "暂无消息"}</div>
              </button>
            ))}
            {filteredThreads.length === 0 && <div className="px-4 py-12 text-center text-xs text-muted-foreground">暂无协同会话</div>}
          </CardContent>
        </Card>

        <Card className="flex min-h-[660px] flex-col overflow-hidden">
          {!selectedThread ? (
            <CardContent className="flex flex-1 items-center justify-center text-sm text-muted-foreground">选择会话开始沟通</CardContent>
          ) : (
            <>
              <CardHeader className="border-b border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm">{selectedThread.title}</CardTitle>
                    <CardDescription className="mt-1 text-xs">{selectedThread.project.code} · {selectedThread.project.name}</CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="size-3.5" />{selectedThread.participants.length} 人</div>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-0 flex-1 flex-col p-0">
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                  {selectedThread.messages.map((item) => (
                    <div key={item.id} className={cn("max-w-[82%] rounded-md border px-3 py-2 text-xs", item.messageType === "SYSTEM" || item.messageType === "APPROVAL_EVENT" || item.messageType === "APPROVAL_ROUTED" ? "mx-auto max-w-[92%] border-border bg-muted/30 text-muted-foreground" : "border-border bg-card") }>
                      <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground"><span>{item.senderName}</span><span>{formatDateTime(item.createdAt)}</span></div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-foreground">{item.content}</div>
                      {item.attachments.map((attachment) => (
                        <button type="button" key={attachment.id} onClick={() => void downloadAttachment(attachment)} className="mt-2 flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left transition-colors hover:bg-muted/50">
                          <span className="flex min-w-0 items-center gap-2"><Paperclip className="size-3.5 shrink-0 text-primary" /><span className="truncate">{attachment.originalName}</span></span>
                          <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">{formatSize(attachment.sizeBytes)}<Download className="size-3" /></span>
                        </button>
                      ))}
                    </div>
                  ))}
                  <div ref={messageEndRef} />
                </div>
                {can("collaboration-center:message") && !selectedThread.closedAt && (
                  <div className="border-t border-border p-3">
                    {mentionIds.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {mentionIds.map((accountId) => {
                          const participant = selectedThread.participants.find((item) => item.accountId === accountId);
                          return <Badge key={accountId} variant="secondary" className="gap-1 text-[10px]">@{participant?.displayName || accountId}<button type="button" onClick={() => setMentionIds((current) => current.filter((id) => id !== accountId))}><X className="size-2.5" /></button></Badge>;
                        })}
                      </div>
                    )}
                    <Textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
                    }} className="min-h-20 resize-none text-xs" placeholder="输入消息，Enter 发送，Shift+Enter 换行" />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => void uploadAttachment(event.target.files?.[0])} />
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={uploading} onClick={() => fileInputRef.current?.click()}><FileUp className="size-3.5" />{uploading ? "上传中..." : "附件"}</Button>
                      <Select value="" onChange={(event) => {
                        const accountId = event.target.value;
                        if (accountId) setMentionIds((current) => current.includes(accountId) ? current : [...current, accountId]);
                      }} className="h-8 w-36 text-xs">
                        <option value="">@ 提及成员</option>
                        {selectedThread.participants.map((participant) => <option key={participant.accountId} value={participant.accountId}>{participant.displayName}</option>)}
                      </Select>
                      <Button size="icon" className="ml-auto size-8" disabled={sending || !message.trim()} onClick={() => void sendMessage()} aria-label="发送消息"><Send className="size-3.5" /></Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </>
          )}
        </Card>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => !creating && setCreateOpen(open)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>新建协同会话</DialogTitle><DialogDescription>选择项目成员参与，会话创建后可发送消息、提及与附件。</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><div className="text-xs font-medium">项目</div><Select value={createProjectId} onChange={(event) => setCreateProjectId(event.target.value)} className="w-full"><option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.code} · {project.name}</option>)}</Select></div>
            <div className="space-y-1.5"><div className="text-xs font-medium">会话名称</div><Input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="例如：交付风险协调" /></div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium">参与成员</div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border p-2">
                {members.map((member) => member.accountId && (
                  <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-muted/40">
                    <input type="checkbox" checked={createParticipantIds.includes(member.accountId)} onChange={(event) => setCreateParticipantIds((current) => event.target.checked ? [...current, member.accountId!] : current.filter((id) => id !== member.accountId))} />
                    <span className="font-medium">{member.personName}</span><span className="text-muted-foreground">{member.roleNames?.join("、") || member.roleName}</span>
                  </label>
                ))}
                {members.length === 0 && <div className="py-6 text-center text-xs text-muted-foreground">当前项目没有可选成员</div>}
              </div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={creating} onClick={() => void createThread()}>{creating ? "创建中..." : "创建会话"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
