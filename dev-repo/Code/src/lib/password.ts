const SALT = "rpms-salt";

/**
 * 简化的密码哈希：base64(pwd + salt)，仅用于本地演示环境。
 */
export function hashPassword(pwd: string): string {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(pwd + SALT);
  }
  return Buffer.from(pwd + SALT).toString("base64");
}

export function verifyPassword(pwd: string, hash: string): boolean {
  return hashPassword(pwd) === hash;
}
