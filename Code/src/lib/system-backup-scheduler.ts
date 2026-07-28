import { createSystemBackup, getSystemBackupSettings, isAutomaticBackupDue } from "@/lib/system-backup";

const globalScheduler = globalThis as typeof globalThis & {
  ceastarBackupSchedulerStarted?: boolean;
};

const checkAndRun = async () => {
  try {
    const settings = await getSystemBackupSettings();
    if (isAutomaticBackupDue(settings)) {
      await createSystemBackup({ triggerMode: "AUTOMATIC", operator: "系统自动备份" });
    }
  } catch (error) {
    console.error("[system-backup] automatic backup check failed", error);
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
