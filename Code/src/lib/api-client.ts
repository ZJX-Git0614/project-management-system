const TOKEN_KEY = "pms-auth-token"
const USER_KEY = "pms-auth-user"

interface StoredUser {
  id: string
  username: string
  displayName: string
  assignedRoleNames: string[]
  passwordResetRequired: boolean
}

function getToken(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(TOKEN_KEY)
}

function getStoredUser(): StoredUser | null {
  if (typeof window === "undefined") return null
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveAuth(token: string, user: StoredUser) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export interface ApiError {
  success: false
  error: string
  status: number
  code?: string
}

let redirectingToLogin = false
function redirectToLogin() {
  if (typeof window === "undefined") return
  if (redirectingToLogin) return
  redirectingToLogin = true
  clearAuth()
  if (window.location.pathname !== "/login" && window.location.pathname !== "/force-change-password") {
    const current = window.location.pathname + window.location.search
    const target = `/login?return=${encodeURIComponent(current)}`
    window.location.href = target
  }
  setTimeout(() => { redirectingToLogin = false }, 5000)
}

let refreshingPromise: Promise<string | null> | null = null

async function refreshToken(): Promise<string | null> {
  if (refreshingPromise) return refreshingPromise
  const currentToken = getToken()
  if (!currentToken) return null
  refreshingPromise = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${currentToken}`,
        },
      })
      if (!res.ok) return null
      const body = await res.json()
      if (body?.success && body.data?.token && body.data?.user) {
        saveAuth(body.data.token, body.data.user)
        return body.data.token as string
      }
      return null
    } catch {
      return null
    } finally {
      refreshingPromise = null
    }
  })()
  return refreshingPromise
}

async function request<T>(
  url: string,
  options: RequestInit = {},
  retryOnExpired = true
): Promise<T> {
  const token = getToken()
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers as Record<string, string>),
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }

  const res = await fetch(url, { ...options, headers })

  if (!res.ok) {
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}))
      const code = body?.code as string | undefined

      if (retryOnExpired && (code === "TOKEN_EXPIRED" || code === "UNAUTHORIZED" || code === undefined)) {
        const newToken = await refreshToken()
        if (newToken) {
          return request<T>(url, options, false)
        }
      }

      if (code === "FORCED_RESET") {
        clearAuth()
        if (typeof window !== "undefined" && window.location.pathname !== "/force-change-password") {
          window.location.href = "/force-change-password"
        }
        throw Object.assign(new Error("账号需要重置密码"), { status: 401, code }) as Error & { status: number; code?: string }
      }

      redirectToLogin()
      throw Object.assign(new Error(body?.error || "请重新登录"), { status: 401, code }) as Error & { status: number; code?: string }
    }
    const body = await res.json().catch(() => ({ error: "请求失败" }))
    throw Object.assign(new Error(body.error || "请求失败"), {
      status: res.status,
    }) as Error & { status: number }
  }

  const body = await res.json()
  return body.data as T
}

const cleanDownloadFileName = (value: string) => {
  const name = value
    .replace(/^['"]|['"]$/g, "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  return name || undefined
}

export const parseDownloadFileName = (contentDisposition: string | null) => {
  if (!contentDisposition) return undefined
  const encoded = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return cleanDownloadFileName(decodeURIComponent(encoded.replace(/^['"]|['"]$/g, "")))
    } catch {
      // Fall through to the legacy filename parameter.
    }
  }
  const plain = contentDisposition.match(/filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i)?.[1]
  if (!plain) return undefined
  return cleanDownloadFileName(plain.replace(/\\"/g, "\"").trim())
}

export type DownloadResponse = {
  blob: Blob
  fileName?: string
}

async function requestDownload(url: string, retryOnExpired = true): Promise<DownloadResponse> {
  const token = getToken()
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })

  if (!res.ok) {
    if (res.status === 401 && retryOnExpired) {
      const newToken = await refreshToken()
      if (newToken) return requestDownload(url, false)
    }
    const body = await res.json().catch(() => ({ error: "下载失败" }))
    if (res.status === 401) redirectToLogin()
    throw new Error(body.error || "下载失败")
  }

  return {
    blob: await res.blob(),
    fileName: parseDownloadFileName(res.headers.get("Content-Disposition")),
  }
}

async function requestBlob(url: string): Promise<Blob> {
  return (await requestDownload(url)).blob
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(url: string) => request<T>(url, { method: "DELETE" }),
  upload: <T>(url: string, data: FormData) =>
    request<T>(url, { method: "POST", body: data }),
  download: (url: string) => requestBlob(url),
  downloadFile: (url: string) => requestDownload(url),
  getToken,
  getStoredUser,
  saveAuth,
  clearAuth,
  login: async (username: string, password: string) => {
    const result = await request<{
      token: string
      user: StoredUser
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    })
    saveAuth(result.token, result.user)
    return result.user
  },
  logout: () => {
    redirectingToLogin = true
    clearAuth()
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      const current = window.location.pathname + window.location.search
      const target = `/login?return=${encodeURIComponent(current)}`
      window.location.href = target
    }
    setTimeout(() => { redirectingToLogin = false }, 5000)
  },
}
