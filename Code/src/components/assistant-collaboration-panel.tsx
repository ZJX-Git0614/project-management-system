"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUpRight, LoaderCircle, MessageCircleMore, MessagesSquare, Plus, Send, UsersRound } from "lucide-react"

import { useSystemFeedback } from "@/components/system-feedback-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/contexts/auth-context"
import type { ProjectMember } from "@/domain/models"
import { api } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { usePermission } from "@/lib/use-permission"

type CollaborationMessage = {
  id: string
  senderAccountId: string
  senderName: string
  messageType: string
  content: string
  createdAt: string
}

type CollaborationThread = {
  id: string
  projectId: string
  title: string
  kind: string
  lastMessageAt: string
  closedAt: string | null
  project: { id: string; name: string; code: string }
  participants: Array<{ accountId: string; displayName: string; participantRole: string }>
  messages: CollaborationMessage[]
}

type AssistantCollaborationPanelProps = {
  active: boolean
  currentProjectId: string | null
  fullScreen: boolean
}

const formatTime = (value: string) => new Date(value).toLocaleString("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

export function AssistantCollaborationPanel({ active, currentProjectId, fullScreen }: AssistantCollaborationPanelProps) {
  const { notify } = useSystemFeedback()
  const { can } = usePermission()
  const { user } = useAuth()
  const [threads, setThreads] = useState<CollaborationThread[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [selectedThread, setSelectedThread] = useState<CollaborationThread | null>(null)
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState("")
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [participantIds, setParticipantIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const messageEndRef = useRef<HTMLDivElement>(null)

  const loadThread = useCallback(async (threadId: string) => {
    if (!threadId) {
      setSelectedThread(null)
      return
    }
    try {
      const thread = await api.get<CollaborationThread>(`/api/collaboration/threads/${threadId}`)
      setSelectedThread(thread)
      void api.post(`/api/collaboration/threads/${threadId}/read`, {}).catch(() => undefined)
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同消息加载失败", "error")
    }
  }, [notify])

  const loadThreads = useCallback(async (preferredId?: string) => {
    if (!active || !can("collaboration-center:view")) return
    setLoading(true)
    try {
      const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : ""
      const data = await api.get<CollaborationThread[]>(`/api/collaboration/threads${query}`)
      setThreads(data)
      setSelectedId((current) => {
        const candidate = preferredId || current
        return data.some((thread) => thread.id === candidate) ? candidate : data[0]?.id ?? ""
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同会话加载失败", "error")
    } finally {
      setLoading(false)
    }
  }, [active, can, currentProjectId, notify])

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    void loadThread(selectedId)
  }, [loadThread, selectedId])

  useEffect(() => {
    if (!selectedThread) return
    const frame = window.requestAnimationFrame(() => messageEndRef.current?.scrollIntoView({ block: "end" }))
    return () => window.cancelAnimationFrame(frame)
  }, [selectedThread])

  const sendMessage = async () => {
    const content = message.trim()
    if (!content || !selectedThread || sending) return
    setSending(true)
    try {
      await api.post(`/api/collaboration/threads/${selectedThread.id}/messages`, { content })
      setMessage("")
      await Promise.all([loadThread(selectedThread.id), loadThreads()])
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同消息发送失败", "error")
    } finally {
      setSending(false)
    }
  }

  const loadMembers = useCallback(async () => {
    if (!currentProjectId) {
      setMembers([])
      return
    }
    setMembersLoading(true)
    try {
      const data = await api.get<ProjectMember[]>(`/api/projects/${currentProjectId}/members`)
      setMembers(data.filter((member) => Boolean(member.accountId) && member.accountId !== user?.id))
    } catch (error) {
      setMembers([])
      notify(error instanceof Error ? error.message : "项目成员加载失败", "error")
    } finally {
      setMembersLoading(false)
    }
  }, [currentProjectId, notify, user?.id])

  const beginCreate = () => {
    if (!currentProjectId) {
      notify("请先进入具体项目后再创建协同会话", "warning")
      return
    }
    setCreateTitle("")
    setParticipantIds([])
    setCreateOpen(true)
    void loadMembers()
  }

  const createThread = async () => {
    if (!currentProjectId || !createTitle.trim()) {
      notify("请填写会话名称", "warning")
      return
    }
    if (participantIds.length === 0) {
      notify("请至少选择一位项目成员参与协同", "warning")
      return
    }

    setCreating(true)
    try {
      const created = await api.post<CollaborationThread>("/api/collaboration/threads", {
        projectId: currentProjectId,
        title: createTitle.trim(),
        participantAccountIds: participantIds,
      })
      setCreateOpen(false)
      setCreateTitle("")
      setParticipantIds([])
      await loadThreads(created.id)
      await loadThread(created.id)
      notify("协同会话已创建", "success")
    } catch (error) {
      notify(error instanceof Error ? error.message : "协同会话创建失败", "error")
    } finally {
      setCreating(false)
    }
  }

  const openCollaborationCenter = () => {
    const query = selectedId ? `?threadId=${encodeURIComponent(selectedId)}` : ""
    window.location.assign(`/collaboration${query}`)
  }

  if (!can("collaboration-center:view")) {
    return (
      <div className="flex min-h-0 items-center justify-center px-5 text-center text-xs text-muted-foreground">
        当前账号没有协同沟通查看权限。
      </div>
    )
  }

  return (
    <div className={cn("grid min-h-0 flex-1", fullScreen ? "grid-cols-[minmax(240px,320px)_minmax(0,1fr)]" : "grid-cols-[154px_minmax(0,1fr)]")}>
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-border bg-background/30">
        <div className="flex h-11 items-center justify-between gap-2 border-b border-border px-2.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
            <MessagesSquare className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">协同沟通</span>
          </div>
          <div className="flex shrink-0 items-center">
            {can("collaboration-center:create") && <Button type="button" variant="ghost" size="icon" className="size-7" title="新建协同会话" onClick={beginCreate}>
              <Plus className="size-3.5" />
            </Button>}
            <Button type="button" variant="ghost" size="icon" className="size-7" title="打开协同管理页" onClick={openCollaborationCenter}>
              <ArrowUpRight className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {loading && <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">正在加载会话...</div>}
          {!loading && threads.length === 0 && (
            <div className="px-2 py-5 text-center text-[11px] leading-5 text-muted-foreground">
              {currentProjectId ? "当前项目暂无你参与的协同会话" : "暂无你参与的协同会话"}
              {can("collaboration-center:create") && <Button type="button" variant="link" size="sm" className="mt-1 h-6 px-1 text-[11px]" onClick={beginCreate}>新建会话</Button>}
            </div>
          )}
          {threads.map((thread) => {
            const lastMessage = thread.messages[0]
            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => setSelectedId(thread.id)}
                className={cn(
                  "mb-1 block w-full rounded-md border px-2 py-2 text-left transition-colors",
                  selectedId === thread.id ? "border-primary/40 bg-primary/10" : "border-transparent hover:border-border hover:bg-muted/45",
                )}
              >
                <div className="truncate text-[11px] font-medium">{thread.title}</div>
                <div className="mt-1 truncate text-[10px] text-muted-foreground">{lastMessage?.content || `${thread.participants.length} 位参与人`}</div>
                <div className="mt-1 text-[9px] text-muted-foreground/75">{formatTime(thread.lastMessageAt)}</div>
              </button>
            )
          })}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col bg-card/25">
        {createOpen ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              void createThread()
            }}
          >
            <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">新建协同会话</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">仅邀请当前项目中的其他有效成员</div>
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              <div className="space-y-1.5">
                <label htmlFor="assistant-collaboration-title" className="text-[11px] font-medium">会话名称</label>
                <Input
                  id="assistant-collaboration-title"
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.target.value)}
                  placeholder="例如：交付风险协调"
                  maxLength={200}
                  autoFocus
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium">参与成员</span>
                  <span className="text-[10px] text-muted-foreground">已选 {participantIds.length} 人</span>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-md border border-border bg-background/35 p-1.5">
                  {membersLoading && <div className="flex items-center justify-center gap-1.5 py-6 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />加载项目成员...</div>}
                  {!membersLoading && members.map((member) => {
                    const accountId = member.accountId!
                    const checked = participantIds.includes(accountId)
                    return (
                      <label key={member.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-[11px] hover:bg-muted/50">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => setParticipantIds((current) => event.target.checked
                            ? [...current, accountId]
                            : current.filter((id) => id !== accountId))}
                          className="size-3.5 accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{member.personName}</span>
                        <span className="max-w-[42%] truncate text-[10px] text-muted-foreground">{member.roleNames?.join("、") || member.roleName}</span>
                      </label>
                    )
                  })}
                  {!membersLoading && members.length === 0 && <div className="px-2 py-6 text-center text-[11px] leading-5 text-muted-foreground">当前项目没有可邀请的有效成员，请先在项目组成员中添加后台账号。</div>}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border p-2.5">
              <Button type="button" variant="outline" size="sm" disabled={creating} onClick={() => setCreateOpen(false)}>取消</Button>
              <Button type="submit" size="sm" disabled={creating || !createTitle.trim() || participantIds.length === 0}>{creating ? <><LoaderCircle className="size-3.5 animate-spin" />创建中</> : <><Plus className="size-3.5" />创建会话</>}</Button>
            </div>
          </form>
        ) : selectedThread ? (
          <>
            <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3">
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{selectedThread.title}</div>
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <UsersRound className="size-3" /> {selectedThread.participants.length} 位参与人
                  {selectedThread.closedAt && <span className="ml-1 text-amber-500">已关闭</span>}
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" title="在协同中心查看完整信息" onClick={openCollaborationCenter}>
                <ArrowUpRight className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
              {selectedThread.messages.map((item) => (
                <div key={item.id} className="flex gap-2">
                  <div className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border text-[10px]", item.senderAccountId === "system" ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground")}>
                    {item.senderAccountId === "system" ? <MessageCircleMore className="size-3" /> : item.senderName.slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground"><span className="font-medium text-foreground">{item.senderName}</span><span>{formatTime(item.createdAt)}</span></div>
                    <div className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-background/50 px-2.5 py-2 text-[11px] leading-5">{item.content}</div>
                  </div>
                </div>
              ))}
              <div ref={messageEndRef} />
            </div>
            <div className="border-t border-border p-2.5">
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void sendMessage()
                  }
                }}
                placeholder={selectedThread.closedAt ? "会话已关闭" : "输入协同消息，Enter 发送"}
                disabled={sending || Boolean(selectedThread.closedAt) || !can("collaboration-center:message")}
                className="min-h-[48px] max-h-24 resize-none text-xs"
              />
              <div className="mt-1.5 flex justify-end">
                <Button type="button" size="icon" className="size-7" title="发送协同消息" disabled={!message.trim() || sending || Boolean(selectedThread.closedAt) || !can("collaboration-center:message")} onClick={() => void sendMessage()}>
                  <Send className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center text-xs text-muted-foreground">
            <MessagesSquare className="mb-2 size-6 text-muted-foreground/60" />
            选择左侧会话即可在佳佳中协同沟通
            {can("collaboration-center:create") && <Button type="button" variant="link" size="sm" className="mt-2 h-7 text-xs" onClick={beginCreate}>新建协同会话</Button>}
            <Button type="button" variant="link" size="sm" className="h-7 text-xs" onClick={openCollaborationCenter}>打开协同管理页</Button>
          </div>
        )}
      </section>
    </div>
  )
}
