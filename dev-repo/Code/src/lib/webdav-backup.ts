import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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

const pathSegments = (directory: string) => directory.split(/[\\/]+/).map((part) => part.trim()).filter(Boolean);

const appendUrlPath = (baseUrl: string, segments: string[]) => {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(segments.map(encodeURIComponent).join("/"), normalized).toString();
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

export const testWebDavConnection = async (config: WebDavBackupConfig) => {
  if (!config.baseUrl || !config.username || !config.password) {
    throw new Error("请填写云盘 WebDAV 地址、账号和密码或应用密码");
  }
  const response = await request(config, config.baseUrl, {
    method: "PROPFIND",
    headers: { Depth: "0" },
  });
  if (![200, 207, 301, 302, 405].includes(response.status)) {
    throw new Error(`云盘认证失败，WebDAV 返回 ${response.status}`);
  }
};

export const ensureWebDavDirectory = async (config: WebDavBackupConfig, extraSegments: string[] = []) => {
  const segments = [...pathSegments(config.directory), ...extraSegments];
  for (let index = 0; index < segments.length; index += 1) {
    const url = appendUrlPath(config.baseUrl, segments.slice(0, index + 1));
    const response = await request(config, url, { method: "MKCOL" });
    if (![201, 204, 301, 302, 405].includes(response.status)) {
      throw new Error(`无法创建云盘备份目录，WebDAV 返回 ${response.status}`);
    }
  }
  return appendUrlPath(config.baseUrl, segments);
};

export const uploadFileToWebDav = async (
  config: WebDavBackupConfig,
  remoteSegments: string[],
  localFilePath: string,
) => {
  const file = await stat(localFilePath);
  const url = appendUrlPath(config.baseUrl, [...pathSegments(config.directory), ...remoteSegments]);
  const response = await request(config, url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
    },
    body: createReadStream(localFilePath) as unknown as BodyInit,
    duplex: "half",
  });
  if (![200, 201, 204].includes(response.status)) {
    throw new Error(`云盘上传失败，WebDAV 返回 ${response.status}`);
  }
  return url;
};

export interface WebDavBackupDirectory {
  name: string;
  sizeBytes: number;
  lastModifiedAt: number;
}

const listWebDavEntries = async (config: WebDavBackupConfig, extraSegments: string[]) => {
  const url = appendUrlPath(config.baseUrl, [...pathSegments(config.directory), ...extraSegments]);
  const response = await request(config, url, {
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
  const targetPath = normalizedPathname(url, config.baseUrl);
  return asArray(parsed.multistatus?.response).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const responseItem = item as { href?: unknown; propstat?: unknown | unknown[] };
    const href = textValue(responseItem.href);
    const itemPath = normalizedPathname(href, config.baseUrl);
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
  const url = appendUrlPath(config.baseUrl, [...pathSegments(config.directory), directoryName]);
  const response = await request(config, url, { method: "DELETE" });
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
