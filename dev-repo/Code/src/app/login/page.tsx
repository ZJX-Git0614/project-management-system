"use client"

import { FormEvent, Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/contexts/auth-context"

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const { login } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const returnTo = searchParams.get("return") || ""
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError("")
    setSubmitting(true)
    try {
      const user = await login(username, password)
      if (user.passwordResetRequired) {
        const dest = returnTo ? `/force-change-password?return=${encodeURIComponent(returnTo)}` : "/force-change-password"
        router.replace(dest)
      } else {
        // 登录成功一律落「项目列表」作为入口；若用户原本停留在某个具体项目页，
        // 详情页内部会通过 router.replace 重新引导到列表（避免越权访问/项目不存在等）
        router.replace("/projects")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm"
      >
        <div className="mb-8 text-center">
          <div className="inline-flex size-3 rounded-full bg-primary shadow-[0_0_10px_var(--color-primary)]" />
          <div className="mt-4 text-lg font-semibold text-foreground">Ceastar项目管理系统</div>
          <div className="mt-1 text-xs text-muted-foreground">后台账号登录</div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-5">
          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">账号</label>
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="登录账号"
              required
              autoFocus
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">密码</label>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="登录密码"
              required
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div className="flex justify-center pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="h-9 w-44 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? "登录中..." : "登录"}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
