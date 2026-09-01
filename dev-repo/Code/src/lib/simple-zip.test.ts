import { describe, expect, it } from "vitest";

import { createStoreZip } from "@/lib/simple-zip";

describe("simple zip", () => {
  it("writes UTF-8 filenames and a valid central directory", () => {
    const archive = createStoreZip([
      { name: "系统日志.jsonl", data: "{\"ok\":true}\n" },
      { name: "导出说明.txt", data: "说明" },
    ]);

    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.includes(Buffer.from("系统日志.jsonl"))).toBe(true);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(2);
  });
});
