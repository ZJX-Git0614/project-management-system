"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  Bot,
  Check,
  ChevronDown,
  Database,
  Download,
  FileSearch,
  Hand,
  Maximize2,
  Minimize2,
  Paperclip,
  Send,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Square,
  Timer,
  UserRound,
  X,
} from "lucide-react"

import { AssistantMessageContent } from "@/components/assistant-message-content"
import { OperationErrorDialog } from "@/components/operation-error-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api-client"
import {
  ASSISTANT_ACCESS_MODE_LABELS,
  type AssistantAccessMode,
} from "@/lib/assistant-access"
import { ASSISTANT_SETTINGS_CHANGED_EVENT } from "@/lib/assistant-events"
import { TODO_CHANGED_EVENT } from "@/lib/todo-events"
import { cn } from "@/lib/utils"
import { useSystemFeedback } from "@/components/system-feedback-provider"

type AssistantSource = "DATABASE" | "MODEL" | "RAG" | "MODEL_RAG" | "AGENT" | "SYSTEM"

type AssistantAction = {
  id: string
  toolId: string
  title: string
  description: string
  riskLevel: string
  status: string
  expiresAt: string
  result?: { message?: string; downloadUrl?: string; navigateUrl?: string; navigateLabel?: string }
  plan?: {
    id: string
    title: string
    goal: string
    status: string
    currentStepIndex: number
    steps: Array<{
      id: string
      stepIndex: number
      toolId: string
      title: string
      status: string
      riskLevel: string
      errorMessage?: string
    }>
  }
}

type AssistantAttachment = {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  status?: string
  diagnostics?: Array<{ code: string; severity: string; message: string }>
}

type AssistantBlock =
  | { type: "action-proposal" | "action-result"; action: AssistantAction }
  | { type: "attachment"; attachment: AssistantAttachment }

type AssistantRuntime = {
  enabled: boolean
  assistantName: string
  welcomeMessage: string
  personaPreset: string
  avatarPalette: string
  avatarStyle: string
  modelConfigured: boolean
  retrievalConfigured: boolean
  agentEnabled: boolean
  assistantAccessMode: AssistantAccessMode
}

type AssistantTrace = {
  intent?: string
  steps?: string[]
  evidence?: Array<{ source?: string; detail?: string }>
  provider?: string | null
  model?: string | null
  retrieved?: Array<{ title?: string; category?: string }>
  dataCounts?: {
    tasks?: number
    weeklyItems?: number
    risks?: number
    documents?: number
  }
  durationMs?: number
}

type ChatMessage = {
  id?: string
  role: "user" | "assistant"
  content: string
  source?: AssistantSource
  createdAt?: string
  trace?: AssistantTrace
  blocks?: AssistantBlock[]
}

type Point = { x: number; y: number }

type ProjectAssistantProps = {
  currentProjectId: string | null
  currentProjectName?: string | null
}

const LAUNCHER_SIZE = 58
const VIEWPORT_MARGIN = 12
const POSITION_STORAGE_KEY = "pms.project-assistant-position"

const accessModeDescription: Record<AssistantAccessMode, string> = {
  REQUEST_APPROVAL: "每项操作都由你确认后执行",
  AUTO_APPROVE: "低、中风险操作自动执行，高风险仍需确认",
  FULL_ACCESS: "白名单操作自动执行，仍受账号权限限制",
}

const sourceLabel: Record<AssistantSource, string> = {
  DATABASE: "实时数据库",
  MODEL: "智能模型 + 实时数据库",
  RAG: "项目知识库",
  MODEL_RAG: "智能模型 + 项目知识库",
  AGENT: "Agent 工具",
  SYSTEM: "助手能力",
}

const clampPosition = (position: Point): Point => ({
  x: Math.min(
    Math.max(position.x, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - LAUNCHER_SIZE),
  ),
  y: Math.min(
    Math.max(position.y, 56),
    Math.max(56, window.innerHeight - VIEWPORT_MARGIN - LAUNCHER_SIZE),
  ),
})

const defaultPosition = (): Point => clampPosition({
  x: window.innerWidth - 24 - LAUNCHER_SIZE,
  y: window.innerHeight - 24 - LAUNCHER_SIZE,
})

const formatMessageTime = (value?: string) => {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const formatDuration = (value?: number) => {
  if (!value || value < 0) return "0.0 秒"
  return `${(value / 1000).toFixed(1)} 秒`
}

const AssistantTraceDetails = ({ trace }: { trace?: AssistantTrace }) => {
  if (!trace) return null
  const counts = trace.dataCounts
  const retrieved = Array.isArray(trace.retrieved) ? trace.retrieved : []
  const steps = Array.isArray(trace.steps) ? trace.steps : []
  const evidence = Array.isArray(trace.evidence) ? trace.evidence : []
  const hasDetails = Boolean(trace.intent || trace.provider || trace.model || counts || retrieved.length || steps.length || evidence.length || trace.durationMs)
  if (!hasDetails) return null

  return (
    <details className="group mt-1.5 rounded-md border border-border/70 bg-background/30 text-[10px] text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-primary/[0.06] hover:text-foreground active:bg-primary/10">
        <FileSearch className="size-3" />
        <span>思考与数据依据{trace.durationMs ? ` · ${formatDuration(trace.durationMs)}` : ""}</span>
        <ChevronDown className="ml-auto size-3 transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="space-y-1.5 border-t border-border/60 px-2 py-2 leading-4">
        {trace.intent && <div>问题范围：{trace.intent}</div>}
        {(trace.provider || trace.model) && (
          <div>模型：{[trace.provider, trace.model].filter(Boolean).join(" / ")}</div>
        )}
        {counts && (
          <div>
            数据：任务 {counts.tasks ?? 0} · 事项 {counts.weeklyItems ?? 0} · 风险 {counts.risks ?? 0} · 文档 {counts.documents ?? 0}
          </div>
        )}
        {retrieved.length > 0 && (
          <div className="space-y-1">
            {retrieved.map((item, index) => (
              <div key={`${item.title || "知识库片段"}-${index}`} className="truncate">
                知识库：{item.title || "知识库片段"}{item.category ? ` · ${item.category}` : ""}
              </div>
            ))}
          </div>
        )}
        {steps.length > 0 && (
          <div className="space-y-0.5">
            {steps.map((step, index) => <div key={`${step}-${index}`}>{index + 1}. {step}</div>)}
          </div>
        )}
        {evidence.map((item, index) => (
          <div key={`${item.source || "数据来源"}-${index}`}>
            来源：{item.source || "数据来源"}{item.detail ? ` · ${item.detail}` : ""}
          </div>
        ))}
      </div>
    </details>
  )
}

const DEFAULT_RUNTIME: AssistantRuntime = {
  enabled: true,
  assistantName: "佳佳",
  welcomeMessage: "",
  personaPreset: "PROFESSIONAL",
  avatarPalette: "ICE",
  avatarStyle: "ROUNDED",
  modelConfigured: false,
  retrievalConfigured: false,
  agentEnabled: true,
  assistantAccessMode: "REQUEST_APPROVAL",
}

const avatarPaletteClass: Record<string, string> = {
  ICE: "border-cyan-300/45 bg-gradient-to-br from-blue-600 to-cyan-600 text-white shadow-blue-500/25",
  VIOLET: "border-violet-300/45 bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-violet-500/25",
  MINT: "border-emerald-300/45 bg-gradient-to-br from-teal-600 to-emerald-600 text-white shadow-emerald-500/25",
  AMBER: "border-amber-300/45 bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-amber-500/25",
  ROSE: "border-rose-300/45 bg-gradient-to-br from-rose-500 to-pink-600 text-white shadow-rose-500/25",
}

const avatarShapeClass: Record<string, string> = {
  ROUNDED: "rounded-full",
  CABIN: "rounded-md",
  MINIMAL: "rounded-[42%]",
}

const assistantWelcomeText = (runtime: AssistantRuntime) => {
  if (runtime.welcomeMessage.trim()) return runtime.welcomeMessage.trim()
  const actionText = runtime.assistantAccessMode === "REQUEST_APPROVAL"
    ? "并在你确认后执行已授权操作"
    : runtime.assistantAccessMode === "AUTO_APPROVE"
      ? "并按当前授权自动执行低、中风险操作"
      : "并在账号权限范围内自动执行白名单操作"
  return `你好，我是${runtime.assistantName}。我可以帮你查询项目数据，${actionText}。`
}

const launcherWelcomeText = (runtime: AssistantRuntime) => (
  assistantWelcomeText(runtime).replace(/\*\*/g, "").replace(/\s+/g, " ").trim()
)

const welcomeMessage = (runtime: AssistantRuntime): ChatMessage => ({
  id: "assistant-welcome",
  role: "assistant",
  content: assistantWelcomeText(runtime),
  source: "DATABASE",
})

export function ProjectAssistant({
  currentProjectId,
  currentProjectName,
}: ProjectAssistantProps) {
  const { notify } = useSystemFeedback()
  const [open, setOpen] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [modelConfigured, setModelConfigured] = useState(false)
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null)
  const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0)
  const [operationError, setOperationError] = useState<{ title: string; message: string } | null>(null)
  const [runtime, setRuntime] = useState<AssistantRuntime>(DEFAULT_RUNTIME)
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage(DEFAULT_RUNTIME)])
  const [position, setPosition] = useState<Point | null>(null)
  const [dragging, setDragging] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: Point
    moved: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    let initial = defaultPosition()
    try {
      const saved = JSON.parse(window.localStorage.getItem(POSITION_STORAGE_KEY) || "null") as Partial<Point> | null
      if (typeof saved?.x === "number" && typeof saved?.y === "number") {
        initial = clampPosition({ x: saved.x, y: saved.y })
      }
    } catch {
      // Invalid browser-local position falls back to the default.
    }
    setPosition(initial)

    const handleResize = () => setPosition((current) => current ? clampPosition(current) : defaultPosition())
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadHistory = async () => {
      setLoadingHistory(true)
      try {
        const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : ""
        const result = await api.get<{ messages: ChatMessage[]; runtime: AssistantRuntime; suggestions?: string[] }>(`/api/assistant/chat${query}`)
        if (cancelled) return
        setRuntime(result.runtime)
        setMessages(result.messages.length > 0 ? result.messages : [welcomeMessage(result.runtime)])
        setSuggestions(Array.isArray(result.suggestions) ? result.suggestions : [])
        setModelConfigured(result.runtime.modelConfigured)
      } catch {
        if (!cancelled) setMessages([welcomeMessage(DEFAULT_RUNTIME)])
      } finally {
        if (!cancelled) setLoadingHistory(false)
      }
    }
    void loadHistory()
    window.addEventListener(ASSISTANT_SETTINGS_CHANGED_EVENT, loadHistory)
    return () => {
      cancelled = true
      window.removeEventListener(ASSISTANT_SETTINGS_CHANGED_EVENT, loadHistory)
    }
  }, [currentProjectId, currentProjectName])

  useEffect(() => {
    if (!sending || thinkingStartedAt === null) return
    const updateElapsed = () => setThinkingElapsedMs(Date.now() - thinkingStartedAt)
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 100)
    return () => window.clearInterval(timer)
  }, [sending, thinkingStartedAt])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      const container = messagesRef.current
      if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, open, sending, loadingHistory])

  useEffect(() => {
    if (!open) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (
        !target
        || panelRef.current?.contains(target)
        || launcherRef.current?.contains(target)
        || (target instanceof Element && target.closest("[data-assistant-access-menu]"))
      ) return
      setOpen(false)
    }
    window.addEventListener("keydown", handleEscape)
    document.addEventListener("pointerdown", handleOutside)
    return () => {
      window.removeEventListener("keydown", handleEscape)
      document.removeEventListener("pointerdown", handleOutside)
    }
  }, [open])

  const persistPosition = useCallback((next: Point) => {
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Position persistence is optional.
    }
  }, [])

  const moveLauncher = useCallback((next: Point, persist = false) => {
    const clamped = clampPosition(next)
    setPosition(clamped)
    if (persist) persistPosition(clamped)
  }, [persistPosition])

  const updateDrag = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    const deltaX = clientX - drag.startX
    const deltaY = clientY - drag.startY
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return
    drag.moved = true
    moveLauncher({ x: drag.origin.x + deltaX, y: drag.origin.y + deltaY })
  }, [moveLauncher])

  const completeDrag = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    if (drag.moved) {
      const next = clampPosition({
        x: drag.origin.x + clientX - drag.startX,
        y: drag.origin.y + clientY - drag.startY,
      })
      suppressClickRef.current = true
      setPosition(next)
      persistPosition(next)
    }
    dragRef.current = null
    setDragging(false)
  }, [persistPosition])

  useEffect(() => {
    if (!dragging) return
    const handlePointerMove = (event: PointerEvent) => updateDrag(event.pointerId, event.clientX, event.clientY)
    const handlePointerEnd = (event: PointerEvent) => completeDrag(event.pointerId, event.clientX, event.clientY)
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerEnd)
    window.addEventListener("pointercancel", handlePointerEnd)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerEnd)
      window.removeEventListener("pointercancel", handlePointerEnd)
    }
  }, [completeDrag, dragging, updateDrag])

  const handleLauncherPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !position) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      moved: false,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handleLauncherClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setOpen((current) => !current)
  }

  const sendMessage = async (rawMessage?: string) => {
    const message = (rawMessage ?? input).trim()
    if (!message || sending || abortRef.current) return
    const tempUserId = `pending-${Date.now()}`
    setMessages((current) => [...current, {
      id: tempUserId,
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
      blocks: attachments.map((attachment) => ({ type: "attachment", attachment })),
    }])
    setInput("")
    setSending(true)
    setSuggestions([])
    setThinkingStartedAt(Date.now())
    setThinkingElapsedMs(0)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const token = api.getToken()
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          message,
          projectId: currentProjectId,
          history: messages
            .filter((item) => item.id !== "assistant-welcome")
            .slice(-8)
            .map((item) => ({ role: item.role, content: item.content })),
          attachmentIds: attachments.map((attachment) => attachment.id),
        }),
      })
      const payload = await response.json().catch(() => ({})) as {
        error?: string
        data?: {
          userMessage?: ChatMessage
          assistantMessage?: ChatMessage
          answer?: string
          source?: AssistantSource
          runtime?: AssistantRuntime
          suggestions?: string[]
        }
      }
      if (!response.ok || !payload.data) throw new Error(payload.error || "助手暂时无法响应")
      const result = payload.data
      if (result.runtime) {
        setRuntime(result.runtime)
        setModelConfigured(result.runtime.modelConfigured)
      }
      setMessages((current) => [
        ...current.map((item) => item.id === tempUserId ? result.userMessage || item : item),
        result.assistantMessage || {
          role: "assistant",
          content: result.answer || "未获得有效回答。",
          source: result.source,
          createdAt: new Date().toISOString(),
        },
      ])
      setSuggestions(Array.isArray(result.suggestions) ? result.suggestions : [])
      setAttachments([])
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      setMessages((current) => [...current, {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: error instanceof Error ? error.message : "助手暂时无法响应，请稍后再试。",
        createdAt: new Date().toISOString(),
      }])
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setSending(false)
        setThinkingStartedAt(null)
      }
    }
  }

  const uploadAttachment = async (file?: File) => {
    if (!file || !currentProjectId || uploadingAttachment) return
    setUploadingAttachment(true)
    try {
      const formData = new FormData()
      formData.append("projectId", currentProjectId)
      formData.append("scope", "CHAT")
      formData.append("file", file)
      const token = api.getToken()
      const response = await fetch("/api/assistant/attachments", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; data?: AssistantAttachment }
      if (!response.ok || !payload.data) throw new Error(payload.error || "附件上传失败")
      setAttachments((current) => [...current.filter((item) => item.id !== payload.data!.id), payload.data!].slice(-5))
      const errors = payload.data.diagnostics?.filter((item) => item.severity === "ERROR") ?? []
      if (errors.length > 0) {
        setOperationError({
          title: "附件解析未完成",
          message: errors.map((item) => `[${item.code}] ${item.message}`).join("\n"),
        })
      } else {
        notify(`已解析 ${payload.data.name}`, "success")
      }
    } catch (error) {
      setOperationError({
        title: "附件上传或解析失败",
        message: error instanceof Error ? error.message : "附件上传失败",
      })
    } finally {
      setUploadingAttachment(false)
      if (attachmentInputRef.current) attachmentInputRef.current.value = ""
    }
  }

  const stopMessage = () => {
    const controller = abortRef.current
    if (!controller) return
    controller.abort()
    abortRef.current = null
    setSending(false)
    setThinkingStartedAt(null)
    setThinkingElapsedMs(0)
    notify("已停止本次处理", "info")
  }

  const updateActionBlock = (action: AssistantAction, nextAction?: AssistantAction) => {
    setMessages((current) => current.map((message) => ({
      ...message,
      blocks: (() => {
        const updated = message.blocks?.map((block) => block.type !== "attachment" && block.action.id === action.id
        ? { ...block, type: action.status === "PROPOSED" ? "action-proposal" : "action-result", action }
        : block) as AssistantBlock[] | undefined
        if (!updated || !nextAction || !updated.some((block) => block.type !== "attachment" && block.action.id === action.id)) return updated
        if (!updated.some((block) => block.type !== "attachment" && block.action.id === nextAction.id)) {
          updated.push({ type: nextAction.status === "PROPOSED" ? "action-proposal" : "action-result", action: nextAction })
        }
        return updated
      })(),
    })))
  }

  const downloadActionResult = async (downloadUrl: string) => {
    const blob = await api.download(downloadUrl)
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = ""
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleAction = async (action: AssistantAction, command: "confirm" | "cancel") => {
    try {
      const result = await api.post<{ action: AssistantAction; nextAction?: AssistantAction; plan?: AssistantAction["plan"] }>(`/api/assistant/actions/${action.id}/${command}`)
      const completedAction = result.plan ? { ...result.action, plan: result.plan } : result.action
      const nextAction = result.nextAction && result.plan ? { ...result.nextAction, plan: result.plan } : result.nextAction
      updateActionBlock(completedAction, nextAction)
      const message = result.action.result?.message || (command === "cancel" ? "操作已取消" : "操作已执行")
      notify(message, command === "cancel" ? "info" : "success")
      if (["todo.create", "todo.create.batch", "todo.complete"].includes(result.action.toolId) && result.action.status === "SUCCEEDED") {
        window.dispatchEvent(new Event(TODO_CHANGED_EVENT))
      }
      if (result.action.result?.downloadUrl) {
        await downloadActionResult(result.action.result.downloadUrl)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Agent 操作失败", "error")
    }
  }

  const updateAccessMode = async (assistantAccessMode: AssistantAccessMode) => {
    if (assistantAccessMode === runtime.assistantAccessMode) return
    try {
      const result = await api.put<{ assistantAccessMode: AssistantAccessMode }>("/api/assistant/preferences", {
        assistantAccessMode,
      })
      setRuntime((current) => ({ ...current, assistantAccessMode: result.assistantAccessMode }))
      notify(`佳佳已切换为“${ASSISTANT_ACCESS_MODE_LABELS[result.assistantAccessMode]}”`, "success")
    } catch (error) {
      notify(error instanceof Error ? error.message : "授权模式保存失败", "error")
    }
  }

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void sendMessage()
  }

  if (!position || !runtime.enabled) return null

  const bubbleOnLeft = position.x > 310

  return (
    <>
      {!open && !dragging && (
        <div
          className="pointer-events-none fixed z-[78] hidden max-w-[250px] rounded-md border border-primary/25 bg-card/95 px-3 py-2 text-left text-xs text-muted-foreground shadow-[var(--app-shadow-popover)] backdrop-blur-md lg:block"
          style={{
            left: bubbleOnLeft ? position.x - 262 : position.x + LAUNCHER_SIZE + 10,
            top: position.y + 7,
          }}
          aria-hidden="true"
        >
          <span className="line-clamp-2 leading-5">{launcherWelcomeText(runtime)}</span>
        </div>
      )}

      {!open && (
        <button
          ref={launcherRef}
          type="button"
          aria-label={`打开或移动${runtime.assistantName}`}
          title={runtime.assistantName}
          data-thinking={sending ? "true" : "false"}
          className={cn(
            "app-assistant-launcher fixed z-[80] flex size-[58px] cursor-grab touch-none items-center justify-center border shadow-[0_10px_28px_currentColor,inset_0_1px_0_rgba(255,255,255,.28)] outline-none transition-[box-shadow,filter,transform] hover:scale-[1.04] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary/60 active:cursor-grabbing active:scale-[.98]",
            avatarPaletteClass[runtime.avatarPalette] || avatarPaletteClass.ICE,
            avatarShapeClass[runtime.avatarStyle] || avatarShapeClass.ROUNDED,
            dragging && "cursor-grabbing shadow-[0_14px_34px_rgba(37,99,235,.42)]",
          )}
          style={{ left: position.x, top: position.y }}
          onPointerDown={handleLauncherPointerDown}
          onPointerMove={(event) => updateDrag(event.pointerId, event.clientX, event.clientY)}
          onPointerUp={(event) => {
            completeDrag(event.pointerId, event.clientX, event.clientY)
            event.currentTarget.releasePointerCapture?.(event.pointerId)
          }}
          onPointerCancel={(event) => completeDrag(event.pointerId, event.clientX, event.clientY)}
          onClick={handleLauncherClick}
        >
          <Bot className="size-7" strokeWidth={1.8} />
          <span className="absolute right-1 top-1 size-2 rounded-full border border-white/80 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]" />
        </button>
      )}

      {open && (
        <aside
          ref={panelRef}
          aria-label={runtime.assistantName}
          className={cn(
            "app-assistant-panel fixed z-[79] isolate box-border flex min-h-0 max-w-[calc(100vw-24px)] overflow-hidden rounded-lg border border-border bg-card/98 text-card-foreground shadow-[var(--app-shadow-dialog)] backdrop-blur-xl",
            fullScreen
              ? "inset-x-3 bottom-3 top-14"
              : "bottom-3 right-3 top-14 w-[min(440px,calc(100vw-24px))]",
          )}
        >
          <div className="grid h-full w-full min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto]">
            <header className="flex h-14 items-center gap-3 border-b border-border px-3">
              <div className={cn("flex size-9 shrink-0 items-center justify-center border shadow-md", avatarPaletteClass[runtime.avatarPalette] || avatarPaletteClass.ICE, avatarShapeClass[runtime.avatarStyle] || avatarShapeClass.ROUNDED)}>
                <Bot className={cn("size-5", sending && "animate-pulse")} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{runtime.assistantName}</h2>
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    {runtime.retrievalConfigured ? "知识增强" : modelConfigured ? "模型增强" : "数据库模式"}
                  </Badge>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {launcherWelcomeText(runtime)}
                </p>
              </div>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setFullScreen((current) => !current)} title={fullScreen ? "退出全屏" : "展开助手"}>
                {fullScreen ? <Minimize2 /> : <Maximize2 />}
              </Button>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => setOpen(false)} title="关闭助手">
                <X />
              </Button>
            </header>

            <div ref={messagesRef} className="min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-4">
              <div className={cn("mx-auto w-full min-w-0 space-y-4", fullScreen ? "max-w-[1680px]" : "max-w-none")}>
                {loadingHistory && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles className="size-3.5 animate-pulse text-primary" /> 正在加载会话记录...
                  </div>
                )}
                {messages.map((message, index) => (
                  <div
                    key={message.id || `${message.role}-${index}`}
                    className={cn("flex w-full min-w-0 max-w-full gap-2.5", message.role === "user" && "flex-row-reverse")}
                  >
                    <div className={cn(
                      "flex size-7 shrink-0 items-center justify-center border",
                      message.role === "assistant"
                        ? cn(avatarPaletteClass[runtime.avatarPalette] || avatarPaletteClass.ICE, avatarShapeClass[runtime.avatarStyle] || avatarShapeClass.ROUNDED)
                        : "border-border bg-muted text-muted-foreground",
                    )}>
                      {message.role === "assistant" ? <Bot className="size-4" /> : <UserRound className="size-4" />}
                    </div>
                    <div className={cn(
                      "min-w-0",
                      message.role === "assistant"
                        ? "max-w-full flex-1"
                        : "w-fit max-w-[88%]",
                    )}>
                      <div className={cn(
                        "max-w-full overflow-hidden rounded-md border px-3 py-2.5 text-xs leading-5",
                        message.role === "assistant" && "w-full",
                        message.role === "assistant"
                          ? "border-border bg-background/55 text-foreground"
                          : "border-primary/35 bg-primary/15 text-foreground",
                      )}>
                        <AssistantMessageContent content={message.content} />
                      </div>
                      {message.blocks?.map((block) => (
                        block.type === "attachment" ? (
                          <div key={block.attachment.id} className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background/45 px-2.5 py-2 text-[11px]">
                            <FileSearch className="size-3.5 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 truncate">{block.attachment.name}</span>
                            <span className="shrink-0 text-muted-foreground">{Math.max(1, Math.ceil(block.attachment.sizeBytes / 1024))} KB</span>
                          </div>
                        ) : <div key={block.action.id} className="mt-2 rounded-md border border-primary/25 bg-primary/[0.06] p-3 shadow-[var(--app-shadow-soft)]">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold">{block.action.title}</div>
                              <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{block.action.description}</div>
                            </div>
                            <Badge variant={block.action.riskLevel === "LOW" ? "secondary" : "warning"}>{block.action.riskLevel === "LOW" ? "低风险" : "需确认"}</Badge>
                          </div>
                          {block.action.plan && (
                            <div className="mt-3 border-t border-border/70 pt-2.5">
                              <div className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="font-medium">{block.action.plan.title}</span>
                                <span className="text-muted-foreground">{block.action.plan.steps.filter((step) => step.status === "SUCCEEDED").length}/{block.action.plan.steps.length}</span>
                              </div>
                              <div className="mt-2 grid gap-1.5">
                                {block.action.plan.steps.map((step) => (
                                  <div key={step.id} className="flex min-w-0 items-center gap-2 text-[11px]">
                                    <span className={cn(
                                      "flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]",
                                      step.status === "SUCCEEDED" && "border-emerald-500/60 bg-emerald-500/10 text-emerald-400",
                                      ["PROPOSED", "EXECUTING"].includes(step.status) && "border-primary/60 bg-primary/10 text-primary",
                                      ["FAILED", "BLOCKED"].includes(step.status) && "border-destructive/60 bg-destructive/10 text-destructive",
                                    )}>
                                      {step.status === "SUCCEEDED" ? <Check className="size-2.5" /> : step.stepIndex + 1}
                                    </span>
                                    <span className={cn("min-w-0 flex-1 truncate", step.status === "PENDING" && "text-muted-foreground")}>{step.title}</span>
                                    <span className="shrink-0 text-[10px] text-muted-foreground">{{
                                      PENDING: "待执行",
                                      PROPOSED: "待确认",
                                      EXECUTING: "执行中",
                                      SUCCEEDED: "已完成",
                                      FAILED: "失败",
                                      BLOCKED: "待补充",
                                      CANCELLED: "已取消",
                                    }[step.status] || step.status}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {block.action.status === "PROPOSED" ? (
                            <div className="mt-3 flex justify-end gap-2">
                              <Button variant="ghost" size="sm" onClick={() => void handleAction(block.action, "cancel")}>取消</Button>
                              <Button size="sm" onClick={() => void handleAction(block.action, "confirm")}><Check className="size-3.5" />确认执行</Button>
                            </div>
                          ) : (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                              <span className={cn("text-[11px] font-medium", block.action.status === "SUCCEEDED" ? "text-emerald-400" : "text-muted-foreground")}>
                                {block.action.result?.message || ({ CANCELLED: "已取消", EXPIRED: "已过期", FAILED: "执行失败" }[block.action.status] || block.action.status)}
                              </span>
                              {block.action.status === "SUCCEEDED" && (block.action.result?.downloadUrl || block.action.result?.navigateUrl) && (
                                <span className="flex items-center gap-2">
                                  {block.action.result.downloadUrl && (
                                    <button
                                      type="button"
                                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/[0.08] hover:text-foreground"
                                      onClick={() => void downloadActionResult(block.action.result!.downloadUrl!)}
                                    >
                                      <Download className="size-3" />下载文件
                                    </button>
                                  )}
                                  {block.action.result.navigateUrl && (
                                    <button
                                      type="button"
                                      className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/35 hover:bg-primary/[0.08] hover:text-foreground"
                                      onClick={() => window.location.assign(block.action.result!.navigateUrl!)}
                                    >
                                      {block.action.result.navigateLabel || "查看结果"}
                                    </button>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      <div className={cn("mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/70", message.role === "user" && "justify-end")}>
                        {message.source && (
                          <span className="inline-flex items-center gap-1">
                            <Database className="size-2.5" /> {sourceLabel[message.source]}
                          </span>
                        )}
                        {formatMessageTime(message.createdAt) && <span>{formatMessageTime(message.createdAt)}</span>}
                      </div>
                      {message.role === "assistant" && <AssistantTraceDetails trace={message.trace} />}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary">
                      <Bot className="size-4 animate-pulse" />
                    </div>
                    <div className="min-w-0 flex-1 rounded-md border border-primary/25 bg-primary/[0.05] px-3 py-2.5 text-xs">
                      <div className="flex items-center gap-2 font-medium text-foreground">
                        <Sparkles className="size-3.5 animate-pulse text-primary" />
                        正在处理
                        <span className="ml-auto inline-flex items-center gap-1 tabular-nums text-muted-foreground">
                          <Timer className="size-3" />{formatDuration(thinkingElapsedMs)}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                        {["分析问题与会话上下文", "读取授权的项目数据", "检索附件与项目知识库", "组织可核验的回答"].map((step, index) => {
                          const reached = thinkingElapsedMs >= index * 650
                          return (
                            <div key={step} className={cn("flex items-center gap-1.5", reached && "text-foreground")}>
                              <span className={cn("size-1.5 rounded-full bg-muted-foreground/35", reached && "bg-primary shadow-[0_0_6px_hsl(var(--primary))]")} />
                              {step}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
                {!sending && suggestions.length > 0 && (
                  <div className="ml-9 rounded-md border border-border/70 bg-background/35 px-3 py-2.5">
                    <div className="mb-2 text-[10px] font-medium text-muted-foreground">接下来可以继续查看</div>
                    <div className="flex flex-wrap gap-1.5">
                      {suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          className="rounded-md border border-border bg-card/60 px-2 py-1 text-[11px] text-muted-foreground transition-[color,background-color,border-color,transform] hover:border-primary/35 hover:bg-primary/[0.08] hover:text-foreground active:scale-[.98]"
                          onClick={() => void sendMessage(suggestion)}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <footer className="w-full min-w-0 shrink-0 overflow-x-hidden border-t border-border bg-background/25 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className={cn("mx-auto w-full min-w-0", fullScreen ? "max-w-[1680px]" : "max-w-none")}>
                <div className="rounded-md border border-border bg-card/70 p-2 shadow-[var(--app-shadow-soft)] transition-colors focus-within:border-primary/45 focus-within:bg-card">
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    accept=".docx,.xlsx,.csv,.pdf,.txt,.md,.mpp,.xml"
                    className="hidden"
                    onChange={(event) => void uploadAttachment(event.target.files?.[0])}
                  />
                  {attachments.length > 0 && (
                    <div className="mb-1.5 flex max-h-16 flex-wrap gap-1.5 overflow-y-auto border-b border-border/60 pb-2">
                      {attachments.map((attachment) => (
                        <div key={attachment.id} className="flex max-w-full items-center gap-1.5 rounded-md bg-muted/45 px-2 py-1 text-[11px]">
                          <FileSearch className="size-3 shrink-0 text-primary" />
                          <span className="max-w-56 truncate">{attachment.name}</span>
                          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} title="移除附件">
                            <X className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <Textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="输入项目问题，Enter 发送，Shift+Enter 换行"
                    className="min-h-[54px] max-h-32 resize-none border-0 bg-transparent px-1 py-1 text-xs shadow-none focus-visible:ring-0"
                    maxLength={1000}
                    disabled={sending}
                  />
                  <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                    <div className="flex min-w-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground"
                        onClick={() => attachmentInputRef.current?.click()}
                        disabled={!currentProjectId || sending || uploadingAttachment || attachments.length >= 5}
                        title={currentProjectId ? "添加文档或进度文件" : "请先选择项目"}
                      >
                        {uploadingAttachment ? <Sparkles className="size-3.5 animate-pulse" /> : <Paperclip className="size-3.5" />}
                        {uploadingAttachment ? "解析中" : "附件"}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 min-w-0 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                            title={`Agent 授权：${ASSISTANT_ACCESS_MODE_LABELS[runtime.assistantAccessMode]}`}
                            aria-label={`Agent 授权：${ASSISTANT_ACCESS_MODE_LABELS[runtime.assistantAccessMode]}`}
                          >
                            {runtime.assistantAccessMode === "REQUEST_APPROVAL" ? <Hand className="size-3.5 shrink-0" /> : runtime.assistantAccessMode === "AUTO_APPROVE" ? <ShieldCheck className="size-3.5 shrink-0" /> : <ShieldAlert className="size-3.5 shrink-0 text-primary" />}
                            <span className="truncate">{ASSISTANT_ACCESS_MODE_LABELS[runtime.assistantAccessMode]}</span>
                            <ChevronDown className="size-3 shrink-0 opacity-70" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="top" align="start" className="w-[min(340px,calc(100vw-32px))] p-1.5" data-assistant-access-menu>
                          <DropdownMenuLabel className="px-2 py-1.5 text-[11px] text-muted-foreground">佳佳应如何执行操作？</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {(Object.keys(ASSISTANT_ACCESS_MODE_LABELS) as AssistantAccessMode[]).map((mode) => (
                            <DropdownMenuItem
                              key={mode}
                              className={cn(
                                "my-0.5 items-start gap-2.5 rounded-md px-2.5 py-2.5",
                                runtime.assistantAccessMode === mode && "bg-accent",
                              )}
                              onSelect={() => void updateAccessMode(mode)}
                            >
                              {mode === "REQUEST_APPROVAL" ? <Hand className="mt-0.5 size-4 shrink-0" /> : mode === "AUTO_APPROVE" ? <ShieldCheck className="mt-0.5 size-4 shrink-0" /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-primary" />}
                              <span className="min-w-0 flex-1">
                                <span className={cn("block text-xs font-medium", mode === "FULL_ACCESS" && "text-primary")}>{ASSISTANT_ACCESS_MODE_LABELS[mode]}</span>
                                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{accessModeDescription[mode]}</span>
                              </span>
                              <Check className={cn("mt-0.5 size-4 shrink-0 text-primary", runtime.assistantAccessMode !== mode && "invisible")} />
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {sending ? (
                      <Button variant="destructive" size="icon" className="size-8 shrink-0" onClick={stopMessage} title="停止回答" aria-label="停止回答">
                        <Square className="size-3.5 fill-current" />
                      </Button>
                    ) : (
                      <Button size="icon" className="size-8 shrink-0" onClick={() => void sendMessage()} disabled={!input.trim()} title="发送">
                        <Send className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </footer>
          </div>
        </aside>
      )}
      <OperationErrorDialog
        open={Boolean(operationError)}
        title={operationError?.title || "操作失败"}
        message={operationError?.message || "未知错误"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setOperationError(null)
        }}
      />
    </>
  )
}
