"use client";

import { type ReactNode } from "react";
import { ModalDialog } from "./modal-dialog";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title = "请确认操作",
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ModalDialog
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700"
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="whitespace-pre-line text-sm leading-6 text-slate-700">{message}</p>
    </ModalDialog>
  );
}
