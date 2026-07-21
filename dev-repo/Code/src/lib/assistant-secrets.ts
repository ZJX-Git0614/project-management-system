import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const VERSION = "v1";

const encryptionKey = () => {
  const source = process.env.ASSISTANT_CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!source && process.env.NODE_ENV === "production") {
    throw new Error("ASSISTANT_CONFIG_ENCRYPTION_KEY must be configured in production");
  }
  return createHash("sha256").update(source || "pms-local-assistant-secret").digest();
};

export const encryptAssistantSecret = (value: string) => {
  const plainText = value.trim();
  if (!plainText) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
};

export const decryptAssistantSecret = (value?: string | null) => {
  if (!value) return "";
  const [version, iv, tag, encrypted] = value.split(":");
  if (version !== VERSION || !iv || !tag || !encrypted) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
};
