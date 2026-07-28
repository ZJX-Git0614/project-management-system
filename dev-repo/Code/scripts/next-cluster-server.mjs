import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import http from "node:http";

import next from "next";

const requestedWorkers = Number.parseInt(process.env.PMS_WEB_WORKERS || "", 10);
const workerCount = Number.isFinite(requestedWorkers) && requestedWorkers > 0
  ? Math.min(requestedWorkers, 8)
  : Math.min(Math.max(1, availableParallelism()), 4);
const port = Number.parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";

if (cluster.isPrimary && workerCount > 1) {
  let shuttingDown = false;
  const workerSlots = new Map();
  const startWorker = (index) => {
    const worker = cluster.fork({
      ...process.env,
      PMS_PRIMARY_WORKER: index === 0 ? "1" : "0",
      PMS_CLUSTER_SLOT: String(index),
    });
    workerSlots.set(worker.id, index);
    return worker;
  };

  for (let index = 0; index < workerCount; index += 1) startWorker(index);

  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    const slot = workerSlots.get(worker.id) ?? 1;
    workerSlots.delete(worker.id);
    console.error(`[cluster] worker ${worker.process.pid} exited (${code ?? signal}); restarting slot ${slot}`);
    startWorker(slot);
  });

  const stop = () => {
    shuttingDown = true;
    for (const worker of Object.values(cluster.workers)) worker?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`[cluster] starting ${workerCount} Ceastar PMS workers on ${hostname}:${port}`);
} else {
  process.env.PMS_PRIMARY_WORKER ??= "1";
  const app = next({ dev: false, dir: process.cwd(), hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = http.createServer((request, response) => handle(request, response));
  server.listen(port, hostname, () => {
    console.log(`[cluster] worker ${process.pid} ready on ${hostname}:${port}`);
  });
}
