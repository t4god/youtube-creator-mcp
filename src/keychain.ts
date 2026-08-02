import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpUserError } from "./errors.js";

const ACCOUNT = os.userInfo().username;
const HELPER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/youtube-mcp-keychain");

function runHelper(operation: "set" | "get" | "delete", service: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(HELPER_PATH, [operation, service, ACCOUNT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Keychain helper is missing. Run npm run build in the YouTube MCP directory.`));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else if (code === 44) resolve("");
      else reject(new Error(stderr.trim() || `Keychain helper exited with code ${code}`));
    });
    child.stdin.end(stdin ?? "");
  });
}

export async function setSecret(service: string, value: unknown): Promise<void> {
  await runHelper("set", service, JSON.stringify(value));
}

export async function getSecret<T>(service: string): Promise<T | null> {
  try {
    const raw = await runHelper("get", service);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpUserError(`Could not read macOS Keychain item ${service}: ${message}`, "keychain_error");
  }
}

export async function deleteSecret(service: string): Promise<void> {
  try {
    await runHelper("delete", service);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpUserError(`Could not delete macOS Keychain item ${service}: ${message}`, "keychain_error");
  }
}
