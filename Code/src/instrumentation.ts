export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NODE_ENV !== "production") return;
    if (process.env.PMS_PRIMARY_WORKER === "0") return;
    const { startSystemBackupScheduler } = await import("@/lib/system-backup-scheduler");
    startSystemBackupScheduler();
  }
}
