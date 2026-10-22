// Loads the extension's TypeScript through Pi's own jiti and module aliases, like Pi's extension loader.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function piRoot() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  let dir = dirname(realpathSync(execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim()));
  for (; dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
  }
  throw new Error("Pi installation not found. Install Pi or set PI_PACKAGE_DIR.");
}

function packageDir(root, name) {
  for (const candidate of [join(root, "node_modules", name), join(root, "..", "..", name)]) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${name} not found next to Pi at ${root}`);
}

// session.ts reads these at import time: never touch the real agent directory, Safari, or a real token.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-bernard-test-"));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
process.env.BERNARD_TOKEN = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.test`;

const root = piRoot();
const piAi = packageDir(root, "@earendil-works/pi-ai");
const require = createRequire(join(root, "package.json"));
const { createJiti } = require("jiti");
const compat = join(piAi, "dist", "compat.js");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai/compat": compat,
    "@earendil-works/pi-ai": compat,
    "@earendil-works/pi-coding-agent": join(root, "dist", "index.js"),
  },
});

export const ai = await jiti.import("@earendil-works/pi-ai/compat");
export const tools = await jiti.import(join(repo, "extensions/bernard/tools.ts"));

export const catalog = [
  { _id: "claude-sonnet-4-6", displayName: "Sonnet 4.6", contextWindow: 200000, capabilities: ["functionCalling", "vision"], inputModalities: ["text", "image"], thinking: { modes: ["off", "adaptive"] } },
  { _id: "text-only", displayName: "Text only", contextWindow: 100000, capabilities: ["functionCalling"], inputModalities: ["text"] },
];

const encoder = new TextEncoder();

/** An SSE response from raw chunks. Byte chunks may split UTF-8 characters and events. */
export function sse(chunks, signal) {
  return new Response(new ReadableStream({
    async start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason ?? new Error("aborted")), { once: true });
      for (const chunk of chunks) {
        if (typeof chunk === "function") await chunk();
        else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      if (!signal?.aborted) controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

export const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

/** Bernard's AI SDK event sequence for a reply made of text deltas. `ricoId` is Bernard's stored message id. */
export function reply(deltas, finishReason = "stop", ricoId = crypto.randomUUID()) {
  return [
    event({ type: "start", messageId: "m1" }),
    event({ type: "message-metadata", messageMetadata: { modelId: "claude-sonnet-4-6", ricoId } }),
    event({ type: "start-step" }),
    event({ type: "text-start", id: "t1" }),
    ...deltas.map((delta) => event({ type: "text-delta", id: "t1", delta })),
    event({ type: "text-end", id: "t1" }),
    event({ type: "finish-step" }),
    event({ type: "finish", finishReason }),
    "data: [DONE]\n\n",
  ];
}

/**
 * Loads the extension with a mocked Bernard API. `onRun(body, init)` returns the SSE response for
 * each /v1/agents/run request. Every request is recorded in `requests`.
 */
export async function loadExtension(onRun) {
  const requests = [];
  const resources = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : init.body;
    requests.push({ url, method, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/v1/models")) return json({ items: catalog });
    if (url.endsWith("/v1/agents/run")) return onRun(body, init);
    if (url.endsWith("/v1/resources") && method === "POST") {
      const resource = { _id: `res-${resources.size + 1}`, mimeType: "image/png", status: "pending" };
      resources.set(resource._id, resource);
      return json({ presignedPutUrl: `https://upload.test/${resource._id}`, resource });
    }
    if (url.startsWith("https://upload.test/")) return new Response(null, { status: 200 });
    const confirm = /\/v1\/resources\/([^/]+)\/confirm$/.exec(url);
    if (confirm) return json({ resource: { ...resources.get(confirm[1]), status: "ready" } });
    if (/\/v1\/resources\/[^/]+$/.test(url) && method === "DELETE") return new Response(null, { status: 204 });
    if (/\/v1\/threads\/[^/]+\/stop$/.test(url) && method === "POST") return new Response(null, { status: 200 });
    return json({ error: { code: "not_found" } }, 404);
  };

  let provider;
  const entries = [];
  const handlers = {};
  const commands = {};
  const pi = {
    registerProvider: (_name, config) => { provider = config; },
    registerCommand: (name, command) => { commands[name] = command; },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  const factory = await jiti.import(join(repo, "extensions/bernard/index.ts"), { default: true });
  await factory(pi);
  const model = (id = "claude-sonnet-4-6") => ({ ...provider.models.find((item) => item.id === id), api: provider.api, provider: "bernard", baseUrl: provider.baseUrl });

  /** Runs one provider request and collects its events and final message. */
  async function run(context, options = {}, modelId) {
    const stream = provider.streamSimple(model(modelId), context, options);
    const events = [];
    for await (const item of stream) events.push(item);
    return { events, message: await stream.result() };
  }

  const runs = () => requests.filter((request) => request.url.endsWith("/v1/agents/run"));
  return { provider, entries, handlers, commands, requests, runs, run, model };
}

export const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

export const user = (content) => ({ role: "user", content, timestamp: Date.now() });

export function toolResult(call, content, isError = false) {
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError, timestamp: Date.now() };
}
