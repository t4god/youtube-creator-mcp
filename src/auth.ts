import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { google, type Auth } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import { McpUserError } from "./errors.js";
import { deleteSecret, getSecret, secretStoreStatus, setSecret } from "./secrets.js";

export const KEYCHAIN_CLIENT = "dev.t4god.youtube-creator-mcp.oauth-client";
export const KEYCHAIN_TOKEN = "dev.t4god.youtube-creator-mcp.oauth-token";
const LEGACY_KEYCHAIN_CLIENT = "io.openai.youtube-mcp.oauth-client";
const LEGACY_KEYCHAIN_TOKEN = "io.openai.youtube-mcp.oauth-token";

export type AuthProfile = "readonly" | "monetary" | "manager" | "full" | "partner";

const SCOPES = {
  youtubeReadonly: "https://www.googleapis.com/auth/youtube.readonly",
  analyticsReadonly: "https://www.googleapis.com/auth/yt-analytics.readonly",
  analyticsMonetary: "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
  memberships: "https://www.googleapis.com/auth/youtube.channel-memberships.creator",
  youtubeManage: "https://www.googleapis.com/auth/youtube",
  youtubeForceSsl: "https://www.googleapis.com/auth/youtube.force-ssl",
  youtubeUpload: "https://www.googleapis.com/auth/youtube.upload",
  partner: "https://www.googleapis.com/auth/youtubepartner",
  partnerAudit: "https://www.googleapis.com/auth/youtubepartner-channel-audit",
} as const;

export const PROFILE_SCOPES: Record<AuthProfile, string[]> = {
  readonly: [SCOPES.youtubeReadonly, SCOPES.analyticsReadonly, SCOPES.memberships],
  monetary: [
    SCOPES.youtubeReadonly,
    SCOPES.analyticsReadonly,
    SCOPES.analyticsMonetary,
    SCOPES.memberships,
  ],
  manager: [
    SCOPES.youtubeReadonly,
    SCOPES.analyticsReadonly,
    SCOPES.memberships,
    SCOPES.youtubeManage,
    SCOPES.youtubeForceSsl,
    SCOPES.youtubeUpload,
  ],
  full: [
    SCOPES.youtubeReadonly,
    SCOPES.analyticsReadonly,
    SCOPES.analyticsMonetary,
    SCOPES.memberships,
    SCOPES.youtubeManage,
    SCOPES.youtubeForceSsl,
    SCOPES.youtubeUpload,
  ],
  partner: [
    SCOPES.youtubeReadonly,
    SCOPES.analyticsReadonly,
    SCOPES.analyticsMonetary,
    SCOPES.youtubeManage,
    SCOPES.youtubeForceSsl,
    SCOPES.youtubeUpload,
    SCOPES.partner,
    SCOPES.partnerAudit,
  ],
};

interface OAuthClientRecord {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthTokenRecord {
  tokens: Auth.Credentials;
  scopes: string[];
  profile: AuthProfile;
  authorizedAt: string;
}

interface GoogleClientFile {
  installed?: {
    client_id?: string;
    client_secret?: string;
  };
  web?: {
    client_id?: string;
    client_secret?: string;
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

async function loadClientFile(filePath: string): Promise<OAuthClientRecord> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as GoogleClientFile;
  const source = parsed.installed;
  if (!source?.client_id) {
    throw new McpUserError(
      "OAuth client JSON must contain an installed.client_id (Desktop app credentials are recommended).",
      "invalid_oauth_client",
    );
  }
  return {
    clientId: source.client_id,
    ...(source.client_secret ? { clientSecret: source.client_secret } : {}),
  };
}

async function getCredential<T>(service: string, legacyService: string): Promise<T | null> {
  const current = await getSecret<T>(service);
  if (current) return current;
  const legacy = await getSecret<T>(legacyService);
  if (!legacy) return null;
  await setSecret(service, legacy);
  await deleteSecret(legacyService);
  return legacy;
}

async function createCallbackServer(): Promise<{
  redirectUri: string;
  waitForCode: (expectedState: string) => Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode: ((value: string) => void) | undefined;
  let rejectCode: ((reason: Error) => void) | undefined;
  let expectedState = "";
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const error = requestUrl.searchParams.get("error");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (error) {
      response.end("<h1>YouTube MCP authorization failed</h1><p>You can close this tab.</p>");
      rejectCode?.(new McpUserError(`Google authorization failed: ${error}`, "oauth_denied"));
      return;
    }
    if (!code || state !== expectedState) {
      response.statusCode = 400;
      response.end("<h1>Invalid OAuth callback</h1>");
      rejectCode?.(new McpUserError("OAuth callback state did not match.", "oauth_state_mismatch"));
      return;
    }
    response.end("<h1>YouTube MCP is connected</h1><p>You can close this tab and return to Terminal.</p>");
    resolveCode?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate OAuth callback port.");

  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth2callback`,
    waitForCode: async (state) => {
      expectedState = state;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new McpUserError("OAuth callback timed out after 5 minutes.", "oauth_timeout")),
          300_000,
        );
      });
      try {
        return await Promise.race([codePromise, timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function authorize(clientPath: string, profile: AuthProfile): Promise<OAuthTokenRecord> {
  const client = await loadClientFile(clientPath);
  const callback = await createCallbackServer();
  try {
    const oauth = new google.auth.OAuth2(client.clientId, client.clientSecret, callback.redirectUri);
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const state = crypto.randomBytes(24).toString("hex");
    const scopes = PROFILE_SCOPES[profile];
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    process.stderr.write(`Opening Google authorization in your browser...\n${url}\n`);
    const codePromise = callback.waitForCode(state);
    openBrowser(url);
    const code = await codePromise;
    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: callback.redirectUri });
    if (!tokens.refresh_token) {
      throw new McpUserError(
        "Google did not return a refresh token. Revoke the app grant in your Google Account, then authorize again.",
        "missing_refresh_token",
      );
    }
    const record: OAuthTokenRecord = {
      tokens,
      scopes,
      profile,
      authorizedAt: new Date().toISOString(),
    };
    await setSecret(KEYCHAIN_CLIENT, client);
    await setSecret(KEYCHAIN_TOKEN, record);
    return record;
  } finally {
    await callback.close();
  }
}

export async function getOAuthClient(required = true): Promise<{
  auth: InstanceType<typeof google.auth.OAuth2>;
  record: OAuthTokenRecord;
} | null> {
  const [client, record] = await Promise.all([
    getCredential<OAuthClientRecord>(KEYCHAIN_CLIENT, LEGACY_KEYCHAIN_CLIENT),
    getCredential<OAuthTokenRecord>(KEYCHAIN_TOKEN, LEGACY_KEYCHAIN_TOKEN),
  ]);
  if (!client || !record) {
    if (required) {
      throw new McpUserError(
        "YouTube OAuth is not configured. Run: npm run build && node dist/cli.js auth --client /path/to/client_secret.json --profile readonly",
        "auth_required",
      );
    }
    return null;
  }
  const auth = new google.auth.OAuth2(client.clientId, client.clientSecret);
  auth.setCredentials(record.tokens);
  auth.on("tokens", (tokens) => {
    record.tokens = { ...record.tokens, ...tokens };
    void setSecret(KEYCHAIN_TOKEN, record).catch((error) => {
      process.stderr.write(`Could not persist refreshed YouTube token: ${String(error)}\n`);
    });
  });
  return { auth, record };
}

export async function authStatus(): Promise<Record<string, unknown>> {
  const client = await getCredential<OAuthClientRecord>(KEYCHAIN_CLIENT, LEGACY_KEYCHAIN_CLIENT);
  const token = await getCredential<OAuthTokenRecord>(KEYCHAIN_TOKEN, LEGACY_KEYCHAIN_TOKEN);
  return {
    configured: Boolean(client && token),
    profile: token?.profile ?? null,
    scopes: token?.scopes ?? [],
    authorizedAt: token?.authorizedAt ?? null,
    hasRefreshToken: Boolean(token?.tokens.refresh_token),
    tokenExpiry: token?.tokens.expiry_date ? new Date(token.tokens.expiry_date).toISOString() : null,
    credentialStore: secretStoreStatus(),
  };
}

export async function logout(): Promise<void> {
  await Promise.all([
    deleteSecret(KEYCHAIN_CLIENT),
    deleteSecret(KEYCHAIN_TOKEN),
    deleteSecret(LEGACY_KEYCHAIN_CLIENT),
    deleteSecret(LEGACY_KEYCHAIN_TOKEN),
  ]);
}
