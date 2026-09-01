import { createSystemBackup, getSystemBackupSettings, isAutomaticBackupDue } from "@/lib/system-backup";
import { cleanupSystemEventLogs, recordSystemEvent } from "@/lib/system-event-log";
import { cleanupExpiredProjectRestoreFiles } from "@/lib/project-restore";

const globalScheduler = globalThis as typeof globalThis & {
  ceastarBackupSchedulerStarted?: boolean;
};

const checkAndRun = async () => {
  try {
    await cleanupSystemEventLogs();
    await cleanupExpiredProjectRestoreFiles();
    const settings = await getSystemBackupSettings();
    if (isAutomaticBackupDue(settings)) {
      await createSystemBackup({ triggerMode: "AUTOMATIC", operator: "系统自动备份" });
    }
  } catch (error) {
    console.error("[system-backup] automatic backup check failed", error);
    await recordSystemEvent({
      level: "ERROR",
      category: "ERROR",
      module: "system-backup",
      eventType: "SCHEDULED_MAINTENANCE_FAILED",
      message: error instanceof Error ? error.message : "自动备份或日志清理失败",
    });
  }
};

export const startSystemBackupScheduler = () => {
  if (globalScheduler.ceastarBackupSchedulerStarted) return;
  globalScheduler.ceastarBackupSchedulerStarted = true;

  const initialTimer = setTimeout(() => void checkAndRun(), 30_000);
  const interval = setInterval(() => void checkAndRun(), 5 * 60 * 1000);
  initialTimer.unref();
  interval.unref();
};
