/**
 * 权限检查 hook — 从 PermissionContext 读取动态的权限树数据（首次加载时从 API 同步）。
 * 管理员（assignedRoleNames 包含 ADMIN_ROLE_NAME）拥有所有权限。
 */
import { usePermissionContext } from "@/contexts/permission-context"

export const usePermission = () => {
  const { can, canAny } = usePermissionContext()
  return { can, canAny }
}
