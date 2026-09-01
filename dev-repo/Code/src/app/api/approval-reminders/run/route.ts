import { NextRequest } from "next/server";

import { forbidden, ok, unauthorizedFromRequest } from "@/lib/api-utils";
import { runApprovalReminders } from "@/lib/approval-scheduler";
import { getAuthenticatedUser, userHasPermission } from "@/lib/server-auth";

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedFromRequest(req);
  if (!await userHasPermission(user, "approval-workflow-config:remind")) return forbidden();
  const reminded = await runApprovalReminders();
  return ok({ reminded });
}
