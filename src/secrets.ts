import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { deleteSecret as deleteKeychainSecret, getSecret as getKeychainSecret, setSecret as setKeychainSecret } from "./keychain.js";

type SecretBackend = "keychain" | "file";

function backend(): SecretBackend {
  const configured = loadConfig().secretStore;
  if (configured === "keychain") return "keychain";
  if (configured === "file") return "file";
  return process.platform === "darwin" ? "keychain" : "file";
}

function secretPath(service: string): string {
  const digest = crypto.createHash("sha256").update(service).digest("hex");
  return path.join(loadConfig().dataDir, "secrets", `${digest}.json`);
}

async function setFileSecret(service: string, value: unknown): Promise<void> {
  const target = secretPath(service);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

async function getFileSecret<T>(service: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(secretPath(service), "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function deleteFileSecret(service: string): Promise<void> {
  await fs.unlink(secretPath(service)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function secretStoreStatus(): { backend: SecretBackend; encryptedAtRest: boolean } {
  const selected = backend();
  return { backend: selected, encryptedAtRest: selected === "keychain" };
}

export async function setSecret(service: string, value: unknown): Promise<void> {
  if (backend() === "keychain") return setKeychainSecret(service, value);
  return setFileSecret(service, value);
}

export async function getSecret<T>(service: string): Promise<T | null> {
  if (backend() === "keychain") return getKeychainSecret<T>(service);
  return getFileSecret<T>(service);
}

export async function deleteSecret(service: string): Promise<void> {
  if (backend() === "keychain") return deleteKeychainSecret(service);
  return deleteFileSecret(service);
}
