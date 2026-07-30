"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type FeedbackTone = "success" | "warning" | "error" | "info";

type FeedbackItem = {
  id: number;
  message: string;
  tone: FeedbackTone;
  closing?: boolean;
};

type PromptOptions = {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  required?: boolean;
};

type PromptState = PromptOptions & {
  resolve: (value: string | null) => void;
};

type SystemFeedbackContextValue = {
  notify: (message: string, tone?: FeedbackTone) => void;
  requestText: (options: PromptOptions) => Promise<string | null>;
};

const SystemFeedbackContext = createContext<SystemFeedbackContextValue | null>(null);

const inferTone = (message: string): FeedbackTone => {
  if (/失败|错误|不存在|不能|无权限|不可|异常/.test(message)) return "error";
  if (/请|必须|确认|注意|尚未|暂无/.test(message)) return "warning";
  if (/成功|完成|已接收|已退回|已删除|已保存|已推送|已更新/.test(message)) return "success";
  return "info";
};

const toneClass: Record<FeedbackTone, string> = {
  success: "border-emerald-500/35 bg-emerald-950/95 text-emerald-50",
  warning: "border-amber-500/35 bg-amber-950/95 text-amber-50",
  error: "border-red-500/35 bg-red-950/95 text-red-50",
  info: "border-blue-500/35 bg-slate-950/95 text-blue-50",
};

const FeedbackIcon = ({ tone }: { tone: FeedbackTone }) => {
  if (tone === "success") return <CheckCircle2 className="size-4 text-emerald-300" />;
  if (tone === "error") return <AlertCircle className="size-4 text-red-300" />;
  if (tone === "warning") return <AlertCircle className="size-4 text-amber-300" />;
  return <Info className="size-4 text-blue-300" />;
};

export function SystemFeedbackProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.map((item) => (
      item.id === id ? { ...item, closing: true } : item
    )));
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 150);
  }, []);

  const notify = useCallback((rawMessage: string, tone?: FeedbackTone) => {
    const message = String(rawMessage || "操作已完成").trim();
    const id = nextId.current++;
    setItems((current) => [
      ...current.slice(-3),
      { id, message, tone: tone ?? inferTone(message) },
    ]);
    window.setTimeout(() => dismiss(id), 2000);
  }, [dismiss]);

  const requestText = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => {
    setPromptValue(options.initialValue ?? "");
    setPromptState({ ...options, resolve });
  }), []);

  const closePrompt = useCallback((value: string | null) => {
    setPromptState((current) => {
      current?.resolve(value);
      return null;
    });
    setPromptValue("");
  }, []);

  useEffect(() => {
    const nativeAlert = window.alert;
    window.alert = (message?: unknown) => notify(String(message ?? ""));
    return () => {
      window.alert = nativeAlert;
    };
  }, [notify]);

  return (
    <SystemFeedbackContext.Provider value={{ notify, requestText }}>
      {children}

      <div
        className="pointer-events-none fixed right-4 top-14 z-[120] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
      >
        {items.map((item) => (
          <div
            key={item.id}
            data-slot="feedback-toast"
            data-state={item.closing ? "closing" : "open"}
            className={`app-feedback-toast pointer-events-auto flex items-start gap-3 rounded-md border px-3 py-3 shadow-[var(--app-shadow-popover)] backdrop-blur-md ${toneClass[item.tone]}`}
          >
            <span className="mt-0.5 shrink-0"><FeedbackIcon tone={item.tone} /></span>
            <span className="min-w-0 flex-1 text-sm leading-5">{item.message}</span>
            <button
              type="button"
              title="关闭提示"
              aria-label="关闭提示"
              className="shrink-0 rounded p-0.5 opacity-70 transition hover:bg-white/10 hover:opacity-100 active:scale-90"
              onClick={() => dismiss(item.id)}
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>

      {promptState && (
        <div
          className="app-feedback-prompt-overlay fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={promptState.title}
        >
          <div className="app-feedback-prompt-content w-full max-w-md rounded-md border border-border bg-card p-4 shadow-[var(--app-shadow-dialog)]">
            <div className="text-base font-semibold">{promptState.title}</div>
            {promptState.message && (
              <div className="mt-2 text-sm leading-5 text-muted-foreground">{promptState.message}</div>
            )}
            <Input
              className="mt-4"
              autoFocus
              value={promptValue}
              placeholder={promptState.placeholder}
              onChange={(event) => setPromptValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") closePrompt(null);
                if (event.key === "Enter" && (!promptState.required || promptValue.trim())) {
                  closePrompt(promptValue.trim());
                }
              }}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => closePrompt(null)}>取消</Button>
              <Button
                disabled={promptState.required && !promptValue.trim()}
                onClick={() => closePrompt(promptValue.trim())}
              >
                {promptState.confirmText || "确定"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </SystemFeedbackContext.Provider>
  );
}

export function useSystemFeedback(): SystemFeedbackContextValue {
  const context = useContext(SystemFeedbackContext);
  if (context) return context;
  if (process.env.NODE_ENV === "test") {
    return {
      notify: () => {},
      requestText: async () => null,
    };
  }
  throw new Error("useSystemFeedback must be used within SystemFeedbackProvider");
}
