import { readFile, stat } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

export interface WebDavBackupConfig {
  baseUrl: string;
  username: string;
  password: string;
  directory: string;
}

const authorizationHeader = (config: WebDavBackupConfig) => (
  `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`
);

const validatePathSegments = (segments: string[]) => {
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("云盘目录不能包含 . 或 .. 路径段");
  }
  return segments;
};

const pathSegments = (directory: string) => validatePathSegments(
  directory.split(/[\\/]+/).map((part) => part.trim()).filter(Boolean),
);

const appendUrlPath = (baseUrl: string, segments: string[]) => {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(validatePathSegments(segments).map(encodeURIComponent).join("/"), normalized).toString();
};

const remoteUrlWithinBase = (baseUrl: string, remoteUrl: string) => {
  const base = new URL(baseUrl);
  const remote = new URL(remoteUrl, base);
  if (remote.origin !== base.origin) throw new Error("云盘文件地址与当前 WebDAV 服务不一致");
  return remote.toString();
};

const asArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const textValue = (value: unknown) => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return String((value as { "#text"?: unknown })["#text"] ?? "");
  }
  return "";
};

const normalizedPathname = (value: string, baseUrl: string) => {
  try {
    return decodeURIComponent(new URL(value, baseUrl).pathname).replace(/\/+$/, "") || "/";
  } catch {
    return decodeURIComponent(value).replace(/\/+$/, "") || "/";
  }
};

const request = async (config: WebDavBackupConfig, url: string, init: RequestInit & { duplex?: "half" }) => {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: authorizationHeader(config),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  } as RequestInit);
  return response;
};

const resolvedBaseUrlCache = new Map<string, { baseUrl: string; expiresAt: number }>();

const candidateBaseUrls = (baseUrl: string) => {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const parsed = new URL(normalized);
  if (parsed.pathname !== "/") return [normalized];
  return [...new Set([normalized, new URL("webdav/", normalized).toString(), new URL("dav/", normalized).toString()])];
};

const responseErrorDetail = (response: Response, url: string) => {
  const allow = response.headers.get("allow");
  return `HTTP ${response.status}${allow ? `，服务器允许方法：${allow}` : ""}，地址：${url}`;
};

const resolveWebDavConfig = async (config: WebDavBackupConfig) => {
  if (!config.baseUrl || !config.username || !config.password) {
    throw new Error("请填写云盘 WebDAV 地址、账号和密码或应用密码");
  }
  const cacheKey = `${config.baseUrl}|${config.username}`;
  const cached = resolvedBaseUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...config, baseUrl: cached.baseUrl };

  let lastResponse: { response: Response; url: string } | null = null;
  for (const baseUrl of candidateBaseUrls(config.baseUrl)) {
    const response = await request(config, baseUrl, {
      method: "PROPFIND",
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>`,
    });
    if ([200, 207].includes(response.status)) {
      resolvedBaseUrlCache.set(cacheKey, { baseUrl, expiresAt: Date.now() + 5 * 60_000 });
      return { ...config, baseUrl };
    }
    if ([401, 403].includes(response.status)) throw new Error(`云盘认证失败，${responseErrorDetail(response, baseUrl)}`);
    lastResponse = { response, url: baseUrl };
  }
  if (lastResponse) {
    throw new Error(`当前地址未提供可写 WebDAV 服务，${responseErrorDetail(lastResponse.response, lastResponse.url)}。请确认已启用 WebDAV Server，且反向代理允许 PROPFIND、MKCOL、PUT 和 DELETE。`);
  }
  throw new Error("无法连接 WebDAV 服务");
};

export const testWebDavConnection = async (config: WebDavBackupConfig) => {
  const resolved = await resolveWebDavConfig(config);
  const probeDirectory = `.ceastar-write-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const directoryUrl = await ensureWebDavDirectory(
    { ...resolved, directory: config.directory },
    [probeDirectory],
  );
  const fileUrl = appendUrlPath(directoryUrl, ["probe.txt"]);
  let operationError: unknown = null;
  try {
    const uploadResponse = await request(resolved, fileUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": "2" },
      body: new Uint8Array(Buffer.from("ok")),
    });
    if (![200, 201, 204].includes(uploadResponse.status)) {
      throw new Error(`云盘写入测试失败，${responseErrorDetail(uploadResponse, fileUrl)}${uploadResponse.status === 405 ? "。当前地址或反向代理不允许 WebDAV PUT 上传" : ""}`);
    }
    const deleteFileResponse = await request(resolved, fileUrl, { method: "DELETE" });
    if (![200, 204, 404].includes(deleteFileResponse.status)) {
      throw new Error(`云盘清理测试文件失败，${responseErrorDetail(deleteFileResponse, fileUrl)}`);
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const deleteDirectoryResponse = await request(resolved, directoryUrl, { method: "DELETE" }).catch(() => null);
    if (!operationError && deleteDirectoryResponse && ![200, 204, 404].includes(deleteDirectoryResponse.status)) {
      throw new Error(`云盘清理测试目录失败，${responseErrorDetail(deleteDirectoryResponse, directoryUrl)}`);
    }
  }
  return { baseUrl: resolved.baseUrl, writable: true };
};

export const ensureWebDavDirectory = async (config: WebDavBackupConfig, extraSegments: string[] = []) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const segments = [...pathSegments(resolvedConfig.directory), ...extraSegments];
  for (let index = 0; index < segments.length; index += 1) {
    const url = appendUrlPath(resolvedConfig.baseUrl, segments.slice(0, index + 1));
    const response = await request(resolvedConfig, url, { method: "MKCOL" });
    if ([201, 204].includes(response.status)) continue;
    if (response.status === 405) {
      const exists = await request(resolvedConfig, url, { method: "PROPFIND", headers: { Depth: "0" } });
      if ([200, 207].includes(exists.status)) continue;
    }
    throw new Error(`无法创建云盘备份目录，${responseErrorDetail(response, url)}`);
  }
  return appendUrlPath(resolvedConfig.baseUrl, segments);
};

export const uploadFileToWebDav = async (
  config: WebDavBackupConfig,
  remoteSegments: string[],
  localFilePath: string,
) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const file = await stat(localFilePath);
  const content = await readFile(localFilePath);
  const url = appendUrlPath(resolvedConfig.baseUrl, [...pathSegments(resolvedConfig.directory), ...remoteSegments]);
  const response = await request(resolvedConfig, url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
    },
    body: new Uint8Array(content),
  });
  if (![200, 201, 204].includes(response.status)) {
    throw new Error(`云盘上传失败，${responseErrorDetail(response, url)}${response.status === 405 ? "。当前地址或反向代理不允许 WebDAV PUT 上传" : ""}`);
  }
  return url;
};

export const uploadBufferToWebDav = async (
  config: WebDavBackupConfig,
  remoteSegments: string[],
  content: Buffer,
  contentType = "application/octet-stream",
) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const parentSegments = remoteSegments.slice(0, -1);
  await ensureWebDavDirectory({ ...resolvedConfig, directory: config.directory }, parentSegments);
  const url = appendUrlPath(resolvedConfig.baseUrl, [...pathSegments(resolvedConfig.directory), ...remoteSegments]);
  const response = await request(resolvedConfig, url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(content.length) },
    body: new Uint8Array(content),
  });
  if (![200, 201, 204].includes(response.status)) {
    throw new Error(`云盘上传失败，${responseErrorDetail(response, url)}`);
  }
  return url;
};

export const downloadFileFromWebDav = async (config: WebDavBackupConfig, remoteUrl: string) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const safeRemoteUrl = remoteUrlWithinBase(resolvedConfig.baseUrl, remoteUrl);
  const response = await request(resolvedConfig, safeRemoteUrl, { method: "GET" });
  if (!response.ok) throw new Error(`云盘文件下载失败，${responseErrorDetail(response, safeRemoteUrl)}`);
  return Buffer.from(await response.arrayBuffer());
};

export const deleteFileFromWebDav = async (config: WebDavBackupConfig, remoteUrl: string) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const safeRemoteUrl = remoteUrlWithinBase(resolvedConfig.baseUrl, remoteUrl);
  const response = await request(resolvedConfig, safeRemoteUrl, { method: "DELETE" });
  if (![200, 204, 404].includes(response.status)) {
    throw new Error(`云盘文件删除失败，${responseErrorDetail(response, safeRemoteUrl)}`);
  }
};

export interface WebDavBackupDirectory {
  name: string;
  sizeBytes: number;
  lastModifiedAt: number;
}

const listWebDavEntries = async (config: WebDavBackupConfig, extraSegments: string[]) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const url = appendUrlPath(resolvedConfig.baseUrl, [...pathSegments(resolvedConfig.directory), ...extraSegments]);
  const response = await request(resolvedConfig, url, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: `<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>`,
  });
  if (![200, 207].includes(response.status)) {
    throw new Error(`无法读取云盘备份目录，WebDAV 返回 ${response.status}`);
  }

  const xml = await response.text();
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true }).parse(xml) as {
    multistatus?: { response?: unknown | unknown[] };
  };
  const targetPath = normalizedPathname(url, resolvedConfig.baseUrl);
  return asArray(parsed.multistatus?.response).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const responseItem = item as { href?: unknown; propstat?: unknown | unknown[] };
    const href = textValue(responseItem.href);
    const itemPath = normalizedPathname(href, resolvedConfig.baseUrl);
    if (!href || itemPath === targetPath) return [];
    const propstat = asArray(responseItem.propstat).find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      return textValue((entry as { status?: unknown }).status).includes(" 200 ");
    }) as { prop?: Record<string, unknown> } | undefined;
    const prop = propstat?.prop ?? {};
    const resourceType = prop.resourcetype;
    const isDirectory = Boolean(resourceType && typeof resourceType === "object" && "collection" in resourceType);
    const name = itemPath.split("/").filter(Boolean).at(-1) || "";
    if (!name) return [];
    return [{
      name,
      isDirectory,
      sizeBytes: Math.max(0, Number(textValue(prop.getcontentlength)) || 0),
      lastModifiedAt: Date.parse(textValue(prop.getlastmodified)) || 0,
    }];
  });
};

export const listWebDavBackupDirectories = async (config: WebDavBackupConfig): Promise<WebDavBackupDirectory[]> => {
  const directories = (await listWebDavEntries(config, [])).filter((entry) => entry.isDirectory);
  return Promise.all(directories.map(async (directory) => {
    const files = await listWebDavEntries(config, [directory.name]);
    return {
      name: directory.name,
      sizeBytes: files.reduce((sum, file) => sum + (file.isDirectory ? 0 : file.sizeBytes), 0),
      lastModifiedAt: Math.max(directory.lastModifiedAt, ...files.map((file) => file.lastModifiedAt), 0),
    };
  }));
};

export const deleteWebDavBackupDirectory = async (config: WebDavBackupConfig, directoryName: string) => {
  const resolvedConfig = await resolveWebDavConfig(config);
  const url = appendUrlPath(resolvedConfig.baseUrl, [...pathSegments(resolvedConfig.directory), directoryName]);
  const response = await request(resolvedConfig, url, { method: "DELETE" });
  if (![200, 204, 404].includes(response.status)) {
    throw new Error(`无法清理云盘旧备份，WebDAV 返回 ${response.status}`);
  }
};

export const pruneWebDavBackups = async (config: WebDavBackupConfig, maxBytes: number) => {
  const directories = await listWebDavBackupDirectories(config);
  let totalBytes = directories.reduce((sum, directory) => sum + directory.sizeBytes, 0);
  const removed: string[] = [];
  for (const directory of [...directories].sort((a, b) => a.lastModifiedAt - b.lastModifiedAt || a.name.localeCompare(b.name))) {
    if (totalBytes <= maxBytes) break;
    await deleteWebDavBackupDirectory(config, directory.name);
    totalBytes -= directory.sizeBytes;
    removed.push(directory.name);
  }
  return { totalBytes: Math.max(0, totalBytes), removed };
};
