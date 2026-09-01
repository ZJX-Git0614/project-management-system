import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const prismaExecutable = resolve(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

const runPrisma = (args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(prismaExecutable, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", rejectRun);
  child.once("exit", (code) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`Prisma 命令执行失败，退出码 ${code ?? "未知"}`));
  });
});

const applySqlDirectory = async (relativeDirectory) => {
  const directory = resolve(repositoryRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const migration of migrations) {
    console.log(`>>> 执行迁移: ${migration}`);
    await runPrisma([
      "db",
      "execute",
      "--file",
      resolve(directory, migration),
      "--schema",
      resolve(repositoryRoot, "prisma", "schema.prisma"),
    ]);
  }
};

console.log(">>> 执行结构同步前的数据保护迁移...");
await applySqlDirectory("prisma/pre-schema-migrations");
console.log(">>> 同步 Prisma 数据库结构...");
await runPrisma(["db", "push", "--skip-generate"]);
console.log(">>> 执行增量数据修复脚本...");
await applySqlDirectory("prisma/manual-migrations");
