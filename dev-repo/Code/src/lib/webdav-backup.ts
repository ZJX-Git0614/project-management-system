import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

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
