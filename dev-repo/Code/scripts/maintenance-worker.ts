import { runApprovalMaintenance } from "@/lib/approval-scheduler";
import { runSystemBackupMaintenance } from "@/lib/system-backup-scheduler";

const configuredInterval = Number.parseInt(process.env.PMS_MAINTENANCE_INTERVAL_MS || "", 10);
const intervalMs = Number.isFinite(configuredInterval)
  ? Math.max(10_000, configuredInterval)
  : 5 * 60 * 1000;

let running = false;

const runMaintenance = async () => {
  if (running) return;
  running = true;
  try {
    await Promise.all([
      runSystemBackupMaintenance(),
      runApprovalMaintenance(),
    ]);
  } finally {
    running = false;
  }
};

await runMaintenance();

if (process.env.PMS_MAINTENANCE_RUN_ONCE !== "1") {
  const interval = setInterval(() => void runMaintenance(), intervalMs);
  const stop = () => {
    clearInterval(interval);
    process.exitCode = 0;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
