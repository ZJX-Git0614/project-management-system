"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function OperationErrorDialog({
  open,
  title,
  message,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  message: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copyDetails = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>错误信息会保留在此处，便于复制后排查。</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[50vh] select-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-destructive/[0.06] p-3 text-xs leading-5 text-foreground">
          {message}
        </pre>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void copyDetails()}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "已复制" : "复制错误详情"}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
