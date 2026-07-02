"use client";

import { ReactNode } from "react";

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
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={`flex w-full ${SIZE_CLASS[size]} flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="text-lg font-semibold text-slate-900">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700"
          >
            关闭
          </button>
        </div>
        <div className="max-h-[78vh] overflow-auto px-4 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
