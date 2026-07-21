"use client";

import { X } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";

type ModalDialogSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<ModalDialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-5xl",
};

interface ModalDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: ModalDialogSize;
}

export function ModalDialog({ open, title, children, footer, onClose, size = "md" }: ModalDialogProps) {
  const [shouldRender, setShouldRender] = useState(open);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      return;
    }
    if (!shouldRender) return;
    const timer = window.setTimeout(() => setShouldRender(false), 160);
    return () => window.clearTimeout(timer);
  }, [open, shouldRender]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!shouldRender) return null;

  const state = open ? "open" : "closing";

  return (
    <div
      data-slot="modal-overlay"
      data-state={state}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        data-slot="modal-content"
        data-state={state}
        className={`flex w-full ${SIZE_CLASS[size]} flex-col overflow-hidden rounded-lg border border-border/90 bg-card text-card-foreground shadow-[var(--app-shadow-dialog)]`}
      >
        <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border bg-card/95 px-4 py-3">
          <div className="min-w-0 text-base font-semibold text-foreground">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-8 min-h-8 shrink-0 place-items-center rounded-md border border-transparent bg-transparent p-0 text-muted-foreground transition-[color,background-color,border-color,transform] duration-150 hover:border-primary/25 hover:bg-primary/10 hover:text-foreground active:scale-95"
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-[78vh] overflow-auto px-4 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-background/20 px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
