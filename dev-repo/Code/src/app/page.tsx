"use client";

import { useEffect } from "react";

export default function HomePage() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.location.replace("/login");
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex min-h-[56vh] items-center justify-center px-6">
      <div className="rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Project Management Platform</div>
        <h1 className="mt-3 text-2xl font-semibold text-slate-900">Ceastar项目管理系统</h1>
        <p className="mt-3 text-sm text-slate-500">正在跳转登录页...</p>
      </div>
    </div>
  );
}
