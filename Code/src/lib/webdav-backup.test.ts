import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadFileFromWebDav,
  listWebDavBackupDirectories,
  pruneWebDavBackups,
  testWebDavConnection,
  uploadBufferToWebDav,
} from "@/lib/webdav-backup";

const config = {
  baseUrl: "https://cloud.example.test/dav/",
  username: "backup-user",
  password: "backup-password",
  directory: "ceastar-backups",
};

const multistatus = (responses: string[]) => `<?xml version="1.0" encoding="utf-8"?>
  <d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`;

const directoryResponse = (href: string, modified: string) => `
  <d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>${modified}</d:getlastmodified>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const fileResponse = (href: string, size: number, modified: string) => `
  <d:response><d:href>${href}</d:href><d:propstat><d:prop>
    <d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>${modified}</d:getlastmodified>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const installWebDavMock = () => {
  const deleted: string[] = [];
  const root = "/dav/ceastar-backups/";
  const first = `${root}ceastar-pms-20260724T000000Z/`;
  const second = `${root}ceastar-pms-20260724T060000Z/`;
  const modified1 = "Fri, 24 Jul 2026 00:00:00 GMT";
  const modified2 = "Fri, 24 Jul 2026 06:00:00 GMT";

  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://cloud.example.test/dav/") {
      return new Response(multistatus([directoryResponse("/dav/", modified2)]), { status: 207 });
    }
    if (init?.method === "DELETE") {
      deleted.push(url);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/ceastar-backups")) {
      return new Response(multistatus([
        directoryResponse(root, modified2),
        directoryResponse(first, modified1),
        directoryResponse(second, modified2),
      ]), { status: 207 });
    }
    if (url.endsWith("ceastar-pms-20260724T000000Z")) {
      return new Response(multistatus([
        directoryResponse(first, modified1),
        fileResponse(`${first}database.dump`, 3_000, modified1),
      ]), { status: 207 });
    }
    if (url.endsWith("ceastar-pms-20260724T060000Z")) {
      return new Response(multistatus([
        directoryResponse(second, modified2),
        fileResponse(`${second}database.dump`, 3_000, modified2),
      ]), { status: 207 });
    }
    return new Response(null, { status: 404 });
  }));
  return deleted;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebDAV backup retention", () => {
  it("reads backup directories and sums their contained files", async () => {
    installWebDavMock();

    await expect(listWebDavBackupDirectories(config)).resolves.toMatchObject([
      { name: "ceastar-pms-20260724T000000Z", sizeBytes: 3_000 },
      { name: "ceastar-pms-20260724T060000Z", sizeBytes: 3_000 },
    ]);
  });

  it("deletes the oldest cloud backup when the byte limit is exceeded", async () => {
    const deleted = installWebDavMock();

    await expect(pruneWebDavBackups(config, 5_000)).resolves.toEqual({
      totalBytes: 3_000,
      removed: ["ceastar-pms-20260724T000000Z"],
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("ceastar-pms-20260724T000000Z");
  });

  it("rejects an address that answers but does not expose WebDAV methods", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    })));

    await expect(testWebDavConnection({ ...config, baseUrl: "https://readonly.example.test/" }))
      .rejects.toThrow("未提供可写 WebDAV 服务");
  });

  it("verifies that the configured location supports upload and cleanup", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || "GET";
      methods.push(method);
      const url = String(input);
      if (url === "https://writeable.example.test/dav/") {
        return new Response(multistatus([directoryResponse("/dav/", new Date().toUTCString())]), { status: 207 });
      }
      if (method === "MKCOL") return new Response(null, { status: 201 });
      if (method === "PUT") return new Response(null, { status: 201 });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    }));

    await expect(testWebDavConnection({ ...config, baseUrl: "https://writeable.example.test/dav/" }))
      .resolves.toMatchObject({ writable: true });
    expect(methods).toEqual(expect.arrayContaining(["PROPFIND", "MKCOL", "PUT", "DELETE"]));
  });

  it("rejects cloud path traversal and cross-origin stored file URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://secure.example.test/dav/") {
        return new Response(multistatus([directoryResponse("/dav/", new Date().toUTCString())]), { status: 207 });
      }
      return new Response(null, { status: 404 });
    }));
    const secureConfig = { ...config, baseUrl: "https://secure.example.test/dav/" };

    await expect(uploadBufferToWebDav({ ...secureConfig, directory: "../outside" }, ["file.txt"], Buffer.from("x")))
      .rejects.toThrow("不能包含 . 或 ..");
    await expect(downloadFileFromWebDav(secureConfig, "https://attacker.example.test/file.txt"))
      .rejects.toThrow("与当前 WebDAV 服务不一致");
  });
});
