export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NODE_ENV !== "production") return;
    if (process.env.PMS_PRIMARY_WORKER === "0") return;
    const { startSystemBackupScheduler } = await import("@/lib/system-backup-scheduler");
    const { startApprovalScheduler } = await import("@/lib/approval-scheduler");
    startSystemBackupScheduler();
    startApprovalScheduler();
  }
}

export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string; headers?: Record<string, string | string[] | undefined> },
  context: { routePath?: string; routeType?: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordSystemEvent } = await import("@/lib/system-event-log");
  await recordSystemEvent({
    level: "ERROR",
    category: "ERROR",
    module: "web",
    eventType: "UNHANDLED_REQUEST_ERROR",
    message: error instanceof Error ? error.message : "未处理的请求错误",
    details: {
      name: error instanceof Error ? error.name : "UnknownError",
      stack: error instanceof Error ? error.stack : undefined,
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
    },
  });
}
