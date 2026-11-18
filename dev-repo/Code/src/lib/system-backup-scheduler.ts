import { createSystemBackup, getSystemBackupSettings, isAutomaticBackupDue } from "@/lib/system-backup";
import { cleanupSystemEventLogs, recordSystemEvent } from "@/lib/system-event-log";
import { cleanupExpiredProjectRestoreFiles } from "@/lib/project-restore";
import { cleanupAssistantHistory } from "@/modules/assistant";
import { runWithMaintenanceLock } from "@/lib/maintenance-lock";

const globalScheduler = globalThis as typeof globalThis & {
  ceastarBackupSchedulerStarted?: boolean;
};

export const runSystemBackupMaintenance = async () => {
  try {
    return await runWithMaintenanceLock("pms:system-backup-maintenance", async () => {
      await cleanupSystemEventLogs();
      await cleanupExpiredProjectRestoreFiles();
      await cleanupAssistantHistory();
      const settings = await getSystemBackupSettings();
      if (isAutomaticBackupDue(settings)) {
        await createSystemBackup({ triggerMode: "AUTOMATIC", operator: "系统自动备份" });
      }
      return true;
    });
  } catch (error) {
    console.error("[system-backup] automatic backup check failed", error);
    await recordSystemEvent({
      level: "ERROR",
      category: "ERROR",
      module: "system-backup",
      eventType: "SCHEDULED_MAINTENANCE_FAILED",
      message: error instanceof Error ? error.message : "自动备份或日志清理失败",
    });
    return { acquired: false };
  }
};

export const startSystemBackupScheduler = () => {
  if (globalScheduler.ceastarBackupSchedulerStarted) return;
  globalScheduler.ceastarBackupSchedulerStarted = true;

  const initialTimer = setTimeout(() => void runSystemBackupMaintenance(), 30_000);
  const interval = setInterval(() => void runSystemBackupMaintenance(), 5 * 60 * 1000);
  initialTimer.unref();
  interval.unref();
};
