import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { bernardToken } from "./session.js";

const BASE = "https://api.bernard.swisscom.com/v1";
const RUN_URL = `${BASE}/agents/run`;
const MAX_IMAGES = 5;
// /v1/agents/run validates `message` at 50,000 characters, independently of the model context window.
const MAX_MESSAGE_CHARS = 48_000;
const MAX_SYSTEM_CHARS = 16_000;
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const imageResize = { maxWidth: 2000, maxHeight: 2000, maxBytes: 10 * 1024 * 1024, jpegQuality: 80 };
const modes = new Map<string, string[]>();

interface BernardModelItem {
  _id: string;
  displayName?: string;
  contextWindow?: number;
  capabilities?: string[];
  inputModalities?: string[];
  thinking?: { modes?: string[] };
}

interface AuthState { token: string }
interface BernardResource { _id: string; mimeType: string; status?: string; failureCode?: string }
interface StoredThreadState { threadId?: string; estimatedTokens?: number; systemSignature?: string }
interface ThreadLease {
  threadId: string;
  bootstrap: boolean;
  estimatedTokens: number;
  systemSignature: string;
  temporary: boolean;
}
interface ThreadCoordinator {
  acquire(systemSignature: string): ThreadLease;
  commit(lease: ThreadLease, estimatedTokens: number): void;
}

const fallback: ProviderModelConfig[] = [{
  id: "claude-sonnet-4-6",
  name: "Bernard Sonnet 4.6",
  reasoning: true,
  input: ["text", "image"],
  inputLimits: { images: { resize: imageResize, maxPerMessage: MAX_IMAGES, maxPerRequest: MAX_IMAGES } },
  contextWindow: 200000,
  maxTokens: 8192,
  cost: zeroCost,
}];

function thinkingLevelMap(supported: string[]): ThinkingLevelMap | undefined {
  if (!supported.some((mode) => mode !== "off")) return undefined;
  if (supported.includes("adaptive")) {
    return { off: "off", minimal: "adaptive", low: "adaptive", medium: "adaptive", high: "adaptive", xhigh: "adaptive", max: "adaptive" };
  }
  return {
    off: supported.includes("off") ? "off" : null,
    minimal: supported.includes("low") ? "low" : null,
    low: supported.includes("low") ? "low" : null,
    medium: supported.includes("medium") ? "medium" : null,
    high: supported.includes("high") ? "high" : null,
    xhigh: null,
    max: null,
  };
}

function mapModel(item: BernardModelItem): ProviderModelConfig {
  const supported = item.thinking?.modes ?? [];
  const vision = item.inputModalities?.includes("image") || item.capabilities?.includes("vision") || false;
  modes.set(item._id, supported);
  return {
    id: item._id,
    name: `Bernard ${item.displayName ?? item._id}`,
    reasoning: supported.some((mode) => mode !== "off"),
    thinkingLevelMap: thinkingLevelMap(supported),
    input: vision ? ["text", "image"] : ["text"],
    ...(vision ? { inputLimits: { images: { resize: imageResize, maxPerMessage: MAX_IMAGES, maxPerRequest: MAX_IMAGES } } } : {}),
    contextWindow: item.contextWindow ?? 128000,
    // Bernard currently publishes neither output limits nor pricing.
    maxTokens: 8192,
    cost: zeroCost,
  };
}

function thinkingMode(modelId: string, level?: string): string | undefined {
  if (!level || level === "off") return undefined;
  const supported = modes.get(modelId) ?? ["off", "adaptive"];
  if (supported.includes("adaptive")) return "adaptive";
  const choice = level === "minimal" || level === "low" ? "low" : level === "medium" ? "medium" : "high";
  if (supported.includes(choice)) return choice;
  return supported.filter((mode) => mode !== "off").at(-1);
}

function clipMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n[… content omitted to fit Bernard's 50,000-character transport limit …]\n";
  const available = Math.max(0, limit - marker.length);
  const start = Math.ceil(available * 0.6);
  return value.slice(0, start) + marker + value.slice(value.length - (available - start));
}

function renderMessage(message: TranscriptContext["messages"][number]): string {
  if (message.role === "system") {
    const text = typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("\n");
    const sections = Object.entries(message.sections ?? {})
      .filter(([name, value]) => name !== "tools" && Boolean(value))
      .map(([, value]) => value)
      .join("\n");
    return `[SYSTEM]\n${text}\n${sections}`;
  }
  if (message.role === "toolResult") {
    return `[TOOL RESULT: ${message.toolName}]\n${message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")}`;
  }
  const text = typeof message.content === "string" ? message.content : message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image") return "[Image attached to this turn]";
    if (part.type === "toolCall") return `[Tool call ${part.name}: ${JSON.stringify(part.arguments)}]`;
    return "";
  }).join("\n");
  return `[${message.role.toUpperCase()}]\n${text}`;
}

function transcriptToText(context: TranscriptContext): { text: string; sourceTokens: number } {
  const rendered = context.messages.map(renderMessage);
  const trailer = "Reply to the last USER message, respecting the SYSTEM instructions above.";
  const full = rendered.join("\n\n") + `\n\n${trailer}`;
  const sourceTokens = Math.ceil(full.length / 4);
  if (full.length <= MAX_MESSAGE_CHARS) return { text: full, sourceTokens };

  const systemIndex = context.messages.findIndex((message) => message.role === "system");
  const system = systemIndex >= 0 ? clipMiddle(rendered[systemIndex], MAX_SYSTEM_CHARS) : "";
  const omission = "[Earlier conversation omitted because Bernard limits each run message to 50,000 characters.]";
  const fixedLength = system.length + trailer.length + omission.length + 8;
  let remaining = Math.max(0, MAX_MESSAGE_CHARS - fixedLength);
  const recent: string[] = [];
  for (let index = rendered.length - 1; index >= 0 && remaining > 0; index--) {
    if (index === systemIndex) continue;
    const separator = recent.length ? 2 : 0;
    if (rendered[index].length + separator <= remaining) {
      recent.unshift(rendered[index]);
      remaining -= rendered[index].length + separator;
    } else {
      // Always preserve both the beginning and end of the newest oversized turn.
      if (!recent.length) recent.unshift(clipMiddle(rendered[index], remaining));
      break;
    }
  }
  const parts = [system, omission, ...recent, trailer].filter(Boolean);
  return { text: parts.join("\n\n").slice(0, MAX_MESSAGE_CHARS), sourceTokens };
}

function latestUserMessage(context: TranscriptContext) {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    if (context.messages[index].role === "user") return context.messages[index];
  }
}

function latestUserImages(context: TranscriptContext): ImageContent[] {
  const message = latestUserMessage(context);
  return message && Array.isArray(message.content)
    ? message.content.filter((part): part is ImageContent => part.type === "image")
    : [];
}

function latestUserText(context: TranscriptContext): string {
  const message = latestUserMessage(context);
  return message ? renderMessage(message) : "[USER]\nContinue.";
}

function currentSystemSignature(context: TranscriptContext): string {
  const system = context.messages.filter((message) => message.role === "system").map(renderMessage).join("\n\n");
  return createHash("sha256").update(system).digest("hex");
}

function authHeaders(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-bernard-client": "web",
    "x-workspace-id": "swisscom",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function authenticatedFetch(
  url: string,
  init: RequestInit,
  auth: AuthState,
  signal?: AbortSignal,
): Promise<Response> {
  const send = () => fetch(url, { ...init, signal, headers: { ...init.headers, ...authHeaders(auth.token) } });
  let response = await send();
  if (response.status === 401) {
    auth.token = await bernardToken({ signal, force: true });
    response = await send();
  }
  return response;
}

async function errorText(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}

function imageBytes(image: ImageContent): { bytes: Buffer; extension: string } {
  const mime = image.mimeType.toLowerCase();
  const extension = mime === "image/png" ? "png" : mime === "image/jpeg" || mime === "image/jpg" ? "jpg" : mime === "image/webp" ? "webp" : undefined;
  if (!extension) throw new Error(`Bernard unterstützt in Pi derzeit PNG, JPEG und WebP, nicht ${image.mimeType}.`);
  const encoded = image.data.includes(",") ? image.data.slice(image.data.indexOf(",") + 1) : image.data;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new Error("Leere Bilddaten können nicht zu Bernard hochgeladen werden.");
  return { bytes, extension };
}

async function uploadImage(
  image: ImageContent,
  index: number,
  threadId: string,
  auth: AuthState,
  signal?: AbortSignal,
): Promise<string> {
  const { bytes, extension } = imageBytes(image);
  const create = await authenticatedFetch(`${BASE}/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, name: `pi-image-${index + 1}.${extension}`, sizeBytes: bytes.length }),
  }, auth, signal);
  if (!create.ok) throw new Error(`Bernard Bildregistrierung HTTP ${create.status}: ${await errorText(create)}`);
  const created = await create.json() as { presignedPutUrl: string; resource: BernardResource };
  try {
    const upload = await fetch(created.presignedPutUrl, {
      method: "PUT",
      headers: { "Content-Type": created.resource.mimeType },
      body: bytes,
      signal,
    });
    if (!upload.ok) throw new Error(`Bernard Bild-Upload HTTP ${upload.status}`);
    const confirm = await authenticatedFetch(`${BASE}/resources/${created.resource._id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, auth, signal);
    if (!confirm.ok) throw new Error(`Bernard Bildbestätigung HTTP ${confirm.status}: ${await errorText(confirm)}`);
    let resource = (await confirm.json() as { resource: BernardResource }).resource;
    for (let attempt = 0; resource.status !== "ready" && attempt < 30; attempt++) {
      if (resource.status === "failed") throw new Error(`Bernard konnte das Bild nicht verarbeiten: ${resource.failureCode ?? "unbekannter Fehler"}`);
      await delay(500, undefined, { signal });
      const lookup = await authenticatedFetch(`${BASE}/resources/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [resource._id] }),
      }, auth, signal);
      if (!lookup.ok) throw new Error(`Bernard Bildstatus HTTP ${lookup.status}: ${await errorText(lookup)}`);
      resource = (await lookup.json() as { items: BernardResource[] }).items[0] ?? resource;
    }
    if (resource.status !== "ready") throw new Error("Bernard-Bildverarbeitung hat das Zeitlimit überschritten.");
    return resource._id;
  } catch (error) {
    try { await authenticatedFetch(`${BASE}/resources/${created.resource._id}`, { method: "DELETE" }, auth); } catch { /* best effort */ }
    throw error;
  }
}

async function deleteResources(ids: string[], auth: AuthState, signal?: AbortSignal): Promise<void> {
  await Promise.all(ids.map(async (id) => {
    try { await authenticatedFetch(`${BASE}/resources/${id}`, { method: "DELETE" }, auth, signal); }
    catch { /* Best-effort cleanup; never hide a model response. */ }
  }));
}

function estimatedUsage(inputTokens: number, outputText: string, imageCount: number) {
  const input = inputTokens + imageCount * 1600;
  const output = Math.ceil(outputText.length / 4);
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function streamBernard(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  threads: ThreadCoordinator,
) {
  const stream = createAssistantMessageEventStream();
  const result: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], usage: estimatedUsage(0, "", 0), stopReason: "pending", timestamp: Date.now(),
  };
  void (async () => {
    const auth: AuthState = { token: "" };
    const resourceIds: string[] = [];
    let ended = false;
    let textIndex: number | undefined;
    let thinkingIndex: number | undefined;
    try {
      auth.token = await bernardToken({ signal: options?.signal, supplied: options?.apiKey });
      const images = latestUserImages(context);
      if (images.length > MAX_IMAGES) throw new Error(`Bernard unterstützt höchstens ${MAX_IMAGES} Bilder pro Nachricht.`);
      if (images.length && !model.input.includes("image")) throw new Error(`${model.name} unterstützt laut Bernard-Katalog keine Bilder.`);
      const lease = threads.acquire(currentSystemSignature(context));
      for (let index = 0; index < images.length; index++) {
        resourceIds.push(await uploadImage(images[index], index, lease.threadId, auth, options?.signal));
      }
      const transcript = lease.bootstrap ? transcriptToText(context) : undefined;
      const inputText = transcript?.text ?? latestUserText(context);
      const requestTokens = transcript?.sourceTokens ?? Math.ceil(inputText.length / 4);
      const contextInputTokens = (lease.bootstrap ? 0 : lease.estimatedTokens) + requestTokens + images.length * 1600;
      const mode = thinkingMode(model.id, options?.reasoning);
      const payload = {
        message: inputText,
        threadId: lease.threadId,
        userMessageId: crypto.randomUUID(),
        modelId: model.id,
        webSearchMode: false,
        ...(resourceIds.length ? { attachmentIds: resourceIds } : {}),
        ...(mode ? { thinkingMode: mode } : {}),
      };
      const body = await options?.onPayload?.(payload, model) ?? payload;
      const response = await authenticatedFetch(RUN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...options?.headers },
        body: JSON.stringify(body),
      }, auth, options?.signal);
      await options?.onResponse?.(response, model);
      if (!response.ok) {
        const details = await errorText(response);
        if (response.status === 422 && details.includes("too_big")) throw new Error("context_length_exceeded: Bernard run message exceeds 50,000 characters.");
        throw new Error(`Bernard HTTP ${response.status}: ${details}`);
      }
      if (!response.body) throw new Error("Bernard hat keinen Stream zurückgegeben.");
      stream.push({ type: "start", partial: result });
      let buffer = "";
      const decoder = new TextDecoder();
      const handle = (raw: string) => {
        const lines = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"));
        if (!lines.length) return;
        const data = lines.map((line) => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") return;
        const event = JSON.parse(data) as { type?: string; delta?: string; error?: string | { message?: string }; finishReason?: string };
        if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : event.error?.message ?? "Bernard stream error");
        if (event.type === "reasoning-start" && thinkingIndex === undefined) {
          thinkingIndex = result.content.length;
          result.content.push({ type: "thinking", thinking: "" });
          stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: result });
        }
        if (event.type === "reasoning-delta" && event.delta) {
          if (thinkingIndex === undefined) {
            thinkingIndex = result.content.length;
            result.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: result });
          }
          const block = result.content[thinkingIndex];
          if (block.type === "thinking") block.thinking += event.delta;
          stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: event.delta, partial: result });
        }
        if (event.type === "reasoning-end" && thinkingIndex !== undefined) {
          const block = result.content[thinkingIndex];
          if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: result });
        }
        if (event.type === "text-delta" && event.delta) {
          if (textIndex === undefined) {
            textIndex = result.content.length;
            result.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: textIndex, partial: result });
          }
          const block = result.content[textIndex];
          if (block.type === "text") block.text += event.delta;
          stream.push({ type: "text_delta", contentIndex: textIndex, delta: event.delta, partial: result });
        }
        if (event.type === "finish") {
          if (event.finishReason === "error") throw new Error("Bernard hat die Antwort mit einem Fehler beendet.");
          if (event.finishReason === "length") result.stopReason = "length";
          ended = true;
        }
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let position: number;
        while ((position = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const separator = buffer.slice(position).match(/^\r?\n\r?\n/)![0];
          handle(buffer.slice(0, position));
          buffer = buffer.slice(position + separator.length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handle(buffer);
      if (!ended) throw new Error("Bernard-Stream ohne finish-Event beendet.");
      if (textIndex !== undefined) {
        const block = result.content[textIndex];
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: result });
      }
      const outputText = result.content.map((block) => block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "").join("");
      result.usage = estimatedUsage(contextInputTokens, outputText, 0);
      threads.commit(lease, result.usage.totalTokens);
      result.stopReason = result.stopReason === "length" ? "length" : "stop";
      stream.push({ type: "done", reason: result.stopReason, message: result });
    } catch (error) {
      result.stopReason = options?.signal?.aborted ? "aborted" : "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: result.stopReason, error: result });
    } finally {
      if (auth.token && resourceIds.length) await deleteResources(resourceIds, auth);
      stream.end();
    }
  })();
  return stream;
}

async function loadModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const token = await bernardToken({ signal, allowBrowserLogin: false });
  const response = await fetch(`${BASE}/models`, { headers: authHeaders(token), signal });
  if (!response.ok) throw new Error(`Bernard Modellliste HTTP ${response.status}`);
  const data = await response.json() as { items?: BernardModelItem[] };
  if (!Array.isArray(data.items) || !data.items.length) throw new Error("Bernard Modellliste leer");
  return data.items.map(mapModel);
}

export default async function (pi: ExtensionAPI) {
  let activeThread: (StoredThreadState & { synced: boolean }) | undefined;
  let temporaryThread: (StoredThreadState & { synced: boolean }) | undefined;
  let compacting = false;

  const resetThread = (persist: boolean) => {
    activeThread = undefined;
    temporaryThread = undefined;
    if (persist) pi.appendEntry<StoredThreadState>("bernard-thread", {});
  };
  const restoreThread = (branch: SessionEntry[]) => {
    activeThread = undefined;
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== "bernard-thread") continue;
      const data = entry.data as StoredThreadState | undefined;
      activeThread = data?.threadId
        ? { threadId: data.threadId, estimatedTokens: data.estimatedTokens ?? 0, systemSignature: data.systemSignature, synced: true }
        : undefined;
    }
  };
  const threads: ThreadCoordinator = {
    acquire(systemSignature) {
      if (compacting) {
        if (!temporaryThread || temporaryThread.systemSignature !== systemSignature) {
          temporaryThread = { threadId: crypto.randomUUID(), estimatedTokens: 0, systemSignature, synced: false };
        }
        return { threadId: temporaryThread.threadId!, bootstrap: !temporaryThread.synced,
          estimatedTokens: temporaryThread.estimatedTokens ?? 0, systemSignature, temporary: true };
      }
      if (!activeThread || activeThread.systemSignature !== systemSignature) {
        activeThread = { threadId: crypto.randomUUID(), estimatedTokens: 0, systemSignature, synced: false };
      }
      return { threadId: activeThread.threadId!, bootstrap: !activeThread.synced,
        estimatedTokens: activeThread.estimatedTokens ?? 0, systemSignature, temporary: false };
    },
    commit(lease, estimatedTokens) {
      const target = lease.temporary ? temporaryThread : activeThread;
      if (!target || target.threadId !== lease.threadId) return;
      target.synced = true;
      target.estimatedTokens = estimatedTokens;
      target.systemSignature = lease.systemSignature;
      if (!lease.temporary) {
        pi.appendEntry<StoredThreadState>("bernard-thread", {
          threadId: target.threadId,
          estimatedTokens,
          systemSignature: target.systemSignature,
        });
      }
    },
  };

  let initialModels = fallback;
  try { initialModels = await loadModels(); } catch { /* Offline or signed out: retain fallback. */ }
  pi.registerProvider("bernard", {
    api: "bernard-run",
    baseUrl: BASE,
    apiKey: "bernard-browser-session",
    models: initialModels,
    async refreshModels(context) {
      if (!context.allowNetwork) return initialModels;
      return loadModels(context.signal);
    },
    streamSimple: (model, context, options) => streamBernard(model, context, options, threads),
  });
  pi.registerCommand("bernard-login", {
    description: "Bernard-Sitzung aus Safari übernehmen (bei Bedarf Browser-Login öffnen)",
    handler: async (_args, ctx) => {
      try {
        await bernardToken({ force: true });
        ctx.ui.notify("Bernard-Sitzung übernommen. /model aktualisiert die Modellliste.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "fork") resetThread(true);
    else if (event.reason === "new") resetThread(false);
    else restoreThread(ctx.sessionManager.getBranch());
  });
  pi.on("session_tree", () => resetThread(true));
  pi.on("model_select", (event) => {
    if (event.model.provider === "bernard" && event.previousModel && event.previousModel.provider !== "bernard") resetThread(true);
  });
  pi.on("session_before_compact", () => {
    compacting = true;
    temporaryThread = undefined;
  });
  pi.on("session_compact", () => {
    compacting = false;
    resetThread(true);
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
    temporaryThread = undefined;
  });
  // Do not mutate Pi's active tools. Bernard receives no tool declarations and cannot emit Pi tool calls.
}
