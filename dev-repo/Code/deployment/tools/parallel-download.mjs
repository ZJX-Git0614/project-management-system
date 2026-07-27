import { createReadStream } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const [url, outputPath, sizeValue, segmentValue = "64", parallelValue = "4"] = process.argv.slice(2);
const totalSize = Number(sizeValue);
const segmentCount = Number(segmentValue);
const parallelCount = Number(parallelValue);

if (!url || !outputPath || !Number.isSafeInteger(totalSize) || totalSize <= 0) {
  throw new Error("Usage: node parallel-download.mjs URL OUTPUT SIZE [SEGMENTS] [PARALLEL]");
}

if (!Number.isInteger(segmentCount) || segmentCount < 1 || segmentCount > 512) {
  throw new Error("SEGMENTS must be an integer between 1 and 512");
}

if (!Number.isInteger(parallelCount) || parallelCount < 1 || parallelCount > 16) {
  throw new Error("PARALLEL must be an integer between 1 and 16");
}

await mkdir(dirname(outputPath), { recursive: true });

const segmentSize = Math.ceil(totalSize / segmentCount);
const segments = Array.from({ length: segmentCount }, (_, index) => {
  const start = index * segmentSize;
  const end = Math.min(totalSize - 1, start + segmentSize - 1);
  return {
    index,
    start,
    end,
    size: end - start + 1,
    path: `${outputPath}.part-${String(index).padStart(2, "0")}`,
  };
}).filter((segment) => segment.start < totalSize);

const segmentIsComplete = async (segment) => {
  try {
    const details = await stat(segment.path);
    if (details.size === segment.size) {
      return true;
    }
    await unlink(segment.path);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return false;
};

const runCurl = (segment) => new Promise((resolve, reject) => {
  const child = spawn("curl", [
    "--http1.1",
    "--location",
    "--fail",
    "--silent",
    "--show-error",
    "--retry", "20",
    "--retry-delay", "2",
    "--retry-all-errors",
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "--referer", "https://docs.docker.com/desktop/setup/install/windows-install/",
    "--range", `${segment.start}-${segment.end}`,
    "--output", segment.path,
    url,
  ], { stdio: ["ignore", "inherit", "inherit"] });

  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0) {
      process.stdout.write(`segment ${segment.index + 1}/${segments.length} downloaded\n`);
      resolve();
      return;
    }
    reject(new Error(`curl failed for segment ${segment.index + 1} with exit code ${code}`));
  });
});

let nextSegment = 0;
const downloadWorker = async () => {
  while (nextSegment < segments.length) {
    const segment = segments[nextSegment];
    nextSegment += 1;
    if (await segmentIsComplete(segment)) {
      process.stdout.write(`segment ${segment.index + 1}/${segments.length} already complete\n`);
      continue;
    }
    await runCurl(segment);
  }
};

await Promise.all(
  Array.from({ length: Math.min(parallelCount, segments.length) }, downloadWorker),
);

for (const segment of segments) {
  const details = await stat(segment.path);
  if (details.size !== segment.size) {
    throw new Error(
      `Segment ${segment.index + 1} has ${details.size} bytes; expected ${segment.size}. The server may not support ranges.`,
    );
  }
}

const output = await open(outputPath, "w");
try {
  await output.truncate(totalSize);
  for (const segment of segments) {
    let position = segment.start;
    for await (const chunk of createReadStream(segment.path)) {
      await output.write(chunk, 0, chunk.length, position);
      position += chunk.length;
    }
  }
} finally {
  await output.close();
}

for (const segment of segments) {
  await unlink(segment.path);
}

const completed = await stat(outputPath);
if (completed.size !== totalSize) {
  throw new Error(`Completed file has ${completed.size} bytes; expected ${totalSize}`);
}

process.stdout.write(`completed ${outputPath} (${completed.size} bytes)\n`);
