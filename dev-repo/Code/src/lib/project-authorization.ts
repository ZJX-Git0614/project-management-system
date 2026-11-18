import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { forbidden, unauthorizedFromRequest } from "@/lib/api-utils";
import { hasProjectAccess } from "@/lib/project-access";
import {
  getAuthenticatedUser,
  userHasPermission,
  type AuthenticatedUser,
} from "@/lib/server-auth";

export type ProjectAuthorizationResult = AuthenticatedUser | NextResponse;

const permissionKeys = (permission: string | readonly string[]) => (
  Array.isArray(permission) ? permission : [permission]
);

export const authorizeProjectAccess = async (
  user: AuthenticatedUser,
  projectId: string,
): Promise<NextResponse | null> => (
  await hasProjectAccess(user, projectId) ? null : forbidden()
);

/**
 * Authorizes a project-scoped request in one place.
 *
 * A global permission is not sufficient to access a project. Callers must use
 * this guard before reading or mutating any project-scoped resource so that
 * project membership cannot be accidentally omitted by a route handler.
 */
export const requireProjectPermission = async (
  req: NextRequest,
  projectId: string,
  permission: string | readonly string[],
): Promise<ProjectAuthorizationResult> => {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);

  const permitted = await Promise.all(
    permissionKeys(permission).map((permissionKey) => userHasPermission(user, permissionKey)),
  );
  if (permitted.some((allowed) => !allowed)) return forbidden();
  const accessError = await authorizeProjectAccess(user, projectId);
  if (accessError) return accessError;
  return user;
};

export const requireProjectAccess = async (
  req: NextRequest,
  projectId: string,
): Promise<ProjectAuthorizationResult> => {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  const accessError = await authorizeProjectAccess(user, projectId);
  if (accessError) return accessError;
  return user;
};

export const isProjectAuthorizationResponse = (
  value: ProjectAuthorizationResult,
): value is NextResponse => value instanceof Response;
