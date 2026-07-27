export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const { startSystemBackupScheduler } = await import("@/lib/system-backup-scheduler");
  startSystemBackupScheduler();
}
