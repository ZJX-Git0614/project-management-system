"use client"

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react"
import {
  DEFAULT_PERMISSION_TREE,
  hasPermission,
  ADMIN_ROLE_NAME,
  normalizePermissionTree,
  type PermissionTreeState,
} from "@/lib/permissions"
import { api } from "@/lib/api-client"
import { useAuth } from "@/contexts/auth-context"

interface PermissionContextValue {
  /** 检查当前用户任意项目角色是否拥有某个权限节点 */
  can: (...nodeKeys: string[]) => boolean
  canAny: (nodeKeys: string[]) => boolean
  /** 原始的权限树数据（供角色管理页使用） */
  rawTree: PermissionTreeState
  /** 刷新权限树 */
  refreshPermissionTree: () => Promise<void>
}

const PermissionContext = createContext<PermissionContextValue | undefined>(undefined)

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const roleNames = useMemo(() => user?.assignedRoleNames ?? [], [user?.assignedRoleNames])
  const isAdmin = roleNames.includes(ADMIN_ROLE_NAME)

  const [rawTree, setRawTree] = useState<PermissionTreeState>(() =>
    JSON.parse(JSON.stringify(DEFAULT_PERMISSION_TREE)),
  )
  const fetchedRef = useRef(false)

  const refreshPermissionTree = useCallback(async () => {
    try {
      const result = await api.get<{ data: PermissionTreeState }>("/api/permission-tree")
      if (result?.data && Object.keys(result.data).length > 0) {
        setRawTree(normalizePermissionTree(result.data))
      }
    } catch {
      // fallback to DEFAULT_PERMISSION_TREE
    }
  }, [])

  // 首次加载时从 API 获取权限树
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    refreshPermissionTree()
  }, [refreshPermissionTree])

  const can = useCallback(
    (...nodeKeys: string[]) => {
      if (isAdmin) return true
      if (roleNames.length === 0) return false
      return nodeKeys.every((nodeKey) =>
        roleNames.some((roleName) => hasPermission(rawTree, roleName, nodeKey)),
      )
    },
    [isAdmin, roleNames, rawTree],
  )

  const canAny = useCallback(
    (nodeKeys: string[]) => {
      if (isAdmin) return true
      if (roleNames.length === 0) return false
      return nodeKeys.some((nodeKey) =>
        roleNames.some((roleName) => hasPermission(rawTree, roleName, nodeKey)),
      )
    },
    [isAdmin, roleNames, rawTree],
  )

  return (
    <PermissionContext.Provider value={{ can, canAny, rawTree, refreshPermissionTree }}>
      {children}
    </PermissionContext.Provider>
  )
}

export function usePermissionContext(): PermissionContextValue {
  const ctx = useContext(PermissionContext)
  if (!ctx) throw new Error("usePermissionContext must be used within PermissionProvider")
  return ctx
}
