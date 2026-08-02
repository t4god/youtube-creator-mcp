import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  process.stdout.write("Skipping macOS Keychain helper build on this platform.\n");
  process.exit(0);
}

mkdirSync("bin", { recursive: true });
const result = spawnSync(
  "xcrun",
  ["swiftc", "native/keychain-helper.swift", "-framework", "Security", "-o", "bin/youtube-mcp-keychain"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
