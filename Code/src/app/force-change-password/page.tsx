"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api-client";

export default function ForceChangePasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForceChangePasswordPageInner />
    </Suspense>
  )
}

function ForceChangePasswordPageInner() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("return") || "";
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      const dest = returnTo ? `/login?return=${encodeURIComponent(returnTo)}` : "/login";
      router.replace(dest);
    }
  }, [authLoading, user, router, returnTo]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (newPassword.length < 6) {
      setError("密码至少 6 位");
      return;
    }

    setSubmitting(true);
    try {
      await api.put("/api/auth/me", {
        newPassword,
        passwordResetRequired: true,
      });
      alert("密码修改成功，请重新登录");
      logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "密码修改失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 p-6">
        <div className="text-sm text-slate-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl"
      >
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold text-slate-900">首次登录 — 修改密码</div>
          <div className="mt-1 text-sm text-slate-500">请设置您的新密码</div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs text-slate-500">新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="至少 6 位"
              required
              minLength={6}
              autoFocus
              className="w-full"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码"
              required
              className="w-full"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-slate-800 px-4 py-2.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {submitting ? "修改中..." : "确认修改"}
          </button>
        </div>
      </form>
    </div>
  );
}
