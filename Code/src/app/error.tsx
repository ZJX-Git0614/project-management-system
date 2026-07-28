"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Ceastar项目管理系统 Error Boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <h2 className="text-lg font-semibold text-destructive">页面渲染出错</h2>
      <pre className="max-w-xl text-xs text-muted-foreground bg-secondary/50 rounded-md p-3 overflow-auto">
        {error?.message || "未知错误"}
        {"\n"}
        {error?.digest ? `digest: ${error.digest}` : ""}
      </pre>
      <button
        onClick={() => reset()}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
      >
        重试
      </button>
    </div>
  );
}
