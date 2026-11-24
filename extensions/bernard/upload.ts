// Image bytes go to Bernard's S3 bucket through a presigned URL. Swisscom's corporate network (corproot) refuses
// direct connections to S3, and Node's fetch ignores the system proxy configuration (PAC file), so an upload that
// cannot reach the host is retried once through a proxy. Only this PUT does that: Bernard's API has to stay direct,
// a corporate proxy answers it with 403.
import https from "node:https";
import net from "node:net";

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
// A local proxy such as Alpaca, which forwards to the corporate proxy.
const LOCAL_PROXY = { host: "localhost", port: 3128 };
const CORPORATE_PROXY = "http://aproxy.corproot.net:8080";
const PROXY_IDLE_TIMEOUT_MS = 30_000;

export interface UploadOptions {
  env?: Record<string, string | undefined>;
  portOpen?: (host: string, port: number) => Promise<boolean>;
  nodeVersion?: string;
}

/** The network error code when a request failed because the host could not be reached at all. */
export function unreachableCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | undefined)?.cause ?? error;
  // With several addresses (IPv4 and IPv6), Node reports an AggregateError with one error per address.
  const candidates = [cause, ...((cause as { errors?: unknown[] } | undefined)?.errors ?? [])];
  return candidates
    .map((item) => (item as { code?: unknown } | undefined)?.code)
    .find((code): code is string => typeof code === "string" && UNREACHABLE.has(code));
}

/** https.Agent reads `proxyEnv` from Node 22.21 and 24.5; older versions ignore it and connect directly. */
export function supportsProxyEnv(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

/** HTTPS_PROXY if set, otherwise a local proxy on port 3128 if one listens, otherwise the corporate proxy. */
export async function uploadProxy({ env = process.env, portOpen = isPortOpen }: UploadOptions = {}): Promise<string> {
  const configured = env.HTTPS_PROXY || env.https_proxy;
  if (configured) return configured.includes("://") ? configured : `http://${configured}`;
  if (await portOpen(LOCAL_PROXY.host, LOCAL_PROXY.port)) return `http://${LOCAL_PROXY.host}:${LOCAL_PROXY.port}`;
  return CORPORATE_PROXY;
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Host and port only: a proxy URL can carry credentials. */
function proxyName(proxy: string): string {
  try { return new URL(proxy).host; } catch { return "Proxy"; }
}

function putThroughProxy(url: string, headers: Record<string, string>, body: Buffer, proxy: string, signal?: AbortSignal): Promise<number> {
  // Only HTTPS_PROXY is passed: a NO_PROXY from the environment would send the retry directly again.
  const agent = new https.Agent({ proxyEnv: { HTTPS_PROXY: proxy } } as https.AgentOptions);
  return new Promise<number>((resolve, reject) => {
    const request = https.request(url, {
      method: "PUT",
      // S3 rejects presigned uploads with chunked transfer encoding.
      headers: { ...headers, "Content-Length": String(body.length) },
      agent,
      signal,
      timeout: PROXY_IDLE_TIMEOUT_MS,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", reject);
    });
    request.once("timeout", () => request.destroy(Object.assign(new Error("no response from the proxy"), { code: "ETIMEDOUT" })));
    request.once("error", reject);
    request.end(body);
  }).finally(() => agent.destroy());
}

/** Uploads to a presigned URL and returns the HTTP status. */
export async function putUpload(url: string, mimeType: string, body: Buffer, signal?: AbortSignal, options: UploadOptions = {}): Promise<number> {
  const headers = { "Content-Type": mimeType };
  try {
    return (await fetch(url, { method: "PUT", headers, body, signal })).status;
  } catch (error) {
    const code = unreachableCode(error);
    if (!code || signal?.aborted) throw error;
    // The presigned URL carries credentials in its query, so errors name only the host.
    const host = new URL(url).host;
    const version = options.nodeVersion ?? process.versions.node;
    if (!supportsProxyEnv(version)) {
      throw new Error(`Bernard Bild-Upload: ${host} ist direkt nicht erreichbar (${code}). Den Umweg über einen Proxy kann Pi erst ab Node 22.21 oder 24.5 nehmen, es läuft mit Node ${version}.`, { cause: error });
    }
    const proxy = await uploadProxy(options);
    try {
      return await putThroughProxy(url, headers, body, proxy, signal);
    } catch (proxyError) {
      if (signal?.aborted) throw proxyError;
      const reason = String((proxyError as Error).message ?? proxyError).replace(/\/\/[^/@\s]*@/g, "//");
      throw new Error(`Bernard Bild-Upload: ${host} ist direkt nicht erreichbar (${code}) und über den Proxy ${proxyName(proxy)} ebenfalls nicht (${reason}).`, { cause: proxyError });
    }
  }
}
