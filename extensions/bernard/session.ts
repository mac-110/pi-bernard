import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const sessionFile = join(agentDir, "bernard-session.json");
const authFile = join(agentDir, "auth.json");
const safariScript = `tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t) starts with "https://bernard.swisscom.com/" then
        return do JavaScript "localStorage.getItem('bernard.access_token') || ''" in t
      end if
    end repeat
  end repeat
end tell
return ""`;

function isValid(token: unknown): token is string {
  if (typeof token !== "string") return false;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

async function savedToken(supplied?: string): Promise<string | undefined> {
  // Environment overrides browser state; an older Pi auth.json key must not override a refreshed Safari session.
  if (isValid(process.env.BERNARD_TOKEN)) return process.env.BERNARD_TOKEN;
  try {
    const data = JSON.parse(await readFile(sessionFile, "utf8"));
    if (isValid(data.token)) return data.token;
  } catch { /* no cached session */ }
  if (isValid(supplied)) return supplied;
  // Allow existing personal Pi credentials, without requiring them from new installers.
  try {
    const data = JSON.parse(await readFile(authFile, "utf8"));
    const token = data.bernard?.type === "api_key" ? data.bernard.key : data.bernard?.access;
    if (isValid(token)) return token;
  } catch { /* no stored credential */ }
}

async function saveToken(token: string): Promise<void> {
  const temp = `${sessionFile}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ token }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, sessionFile);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temp, { force: true });
    throw error;
  }
}

async function readSafari(signal?: AbortSignal): Promise<string | undefined> {
  const { stdout } = await exec("osascript", ["-e", safariScript], { timeout: 7000, signal });
  return isValid(stdout.trim()) ? stdout.trim() : undefined;
}

function safariError(error: unknown): Error | undefined {
  if (String(error).includes("Allow JavaScript from Apple Events")) {
    return new Error("Safari: Einstellungen → Entwickler → 'JavaScript von Apple Events erlauben' aktivieren und Pi die macOS-Automationsfreigabe erteilen.");
  }
}

let pending: Promise<string> | undefined;
async function fromSafari(signal?: AbortSignal, allowBrowserLogin = true): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Automatischer Browser-Login benötigt macOS/Safari. Alternativ BERNARD_TOKEN setzen.");
  try {
    const token = await readSafari(signal);
    if (token) { await saveToken(token); return token; }
  } catch (error) {
    if (safariError(error)) throw safariError(error);
    if (signal?.aborted) throw error;
  }
  if (!allowBrowserLogin) throw new Error("Kein gültiger Bernard-Token verfügbar. /bernard-login ausführen.");
  await exec("open", ["-a", "Safari", "https://bernard.swisscom.com/"], { timeout: 7000, signal });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Bernard-Login abgebrochen.");
    try {
      const token = await readSafari(signal);
      if (token) { await saveToken(token); return token; }
    } catch (error) {
      if (safariError(error)) throw safariError(error);
    }
    await delay(2500, undefined, { signal });
  }
  throw new Error("Bernard-Login nach zwei Minuten abgebrochen. In Safari anmelden und /bernard-login erneut ausführen.");
}

/** Whether a valid token is available without opening the browser. */
export async function hasBernardToken(supplied?: string): Promise<boolean> {
  return (await savedToken(supplied)) !== undefined;
}

export async function bernardToken(options: {
  signal?: AbortSignal;
  supplied?: string;
  force?: boolean;
  allowBrowserLogin?: boolean;
} = {}): Promise<string> {
  if (!options.force) {
    const token = await savedToken(options.supplied);
    if (token) return token;
  }
  // A model refresh and a request can share the same browser login.
  pending ??= fromSafari(options.signal, options.allowBrowserLogin ?? true).finally(() => { pending = undefined; });
  return pending;
}
