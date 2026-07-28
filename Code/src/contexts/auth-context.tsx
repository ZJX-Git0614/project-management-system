"use client"

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react"
import { api } from "@/lib/api-client"

interface AuthUser {
  id: string
  username: string
  displayName: string
  assignedRoleNames: string[]
  passwordResetRequired: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  login: (username: string, password: string) => Promise<AuthUser>
  logout: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const userData = await api.get<AuthUser>("/api/auth/me")
      setUser(userData)
    } catch {
      api.clearAuth()
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const token = api.getToken()
    if (!token) {
      setLoading(false)
      return
    }
    // Validate stored token with the server
    refresh()
  }, [refresh])

  const login = useCallback(async (username: string, password: string) => {
    const userData = await api.login(username, password)
    setUser(userData)
    return userData
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    api.logout()
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
