import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  renderSystemMessageUpdate,
  toToolDeclaration,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevelMap,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { bernardToken } from "./session.js";
import {
  neutralizeTags,
  renderToolCall,
  renderToolInstructions,
  renderToolResult,
  renderToolsUpdate,
  ToolCallParser,
  toolTags,
  type ToolSegment,
  type ToolTags,
} from "./tools.js";

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
// `messageId` is Bernard's id of the last committed reply; later runs attach to it as parent.
interface StoredThreadState { threadId?: string; estimatedTokens?: number; systemSignature?: string; messageId?: string }
interface ThreadLease {
  threadId: string;
  bootstrap: boolean;
  estimatedTokens: number;
  systemSignature: string;
  temporary: boolean;
  parentMessageId?: string;
}
interface ThreadCoordinator {
  acquire(systemSignature: string): ThreadLease;
  commit(lease: ThreadLease, estimatedTokens: number, messageId?: string): void;
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

type TranscriptMessage = TranscriptContext["messages"][number];

interface RenderContext {
  tags: ToolTags;
  /** Notes for images in the messages sent with this run; older images are only mentioned. */
  imageNotes: Map<ImageContent, string>;
  /** 1-based position of each tool call within its assistant message. */
  callNumbers: Map<string, number>;
}

/** Slice without splitting a UTF-16 surrogate pair. */
function safeSlice(value: string, start: number, end = value.length): string {
  const low = (index: number) => index > 0 && index < value.length && /[\uDC00-\uDFFF]/.test(value[index]);
  if (low(start)) start++;
  if (low(end)) end--;
  return value.slice(start, Math.max(start, end));
}

function clipMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n[… ${value.length - limit} characters omitted to fit Bernard's 50,000-character message limit; request a smaller range if you need them …]\n`;
  const available = Math.max(0, limit - marker.length);
  const start = Math.ceil(available * 0.6);
  return safeSlice(value, 0, start) + marker + safeSlice(value, value.length - (available - start));
}

function joinedLength(parts: string[]): number {
  return parts.reduce((total, part) => total + part.length, 0) + Math.max(0, parts.length - 1) * 2;
}

/** Clip parts so they fit `budget` together; short parts stay whole and long ones share the rest. */
function fitParts(parts: string[], budget: number): string[] {
  let remaining = Math.max(0, budget - Math.max(0, parts.length - 1) * 2);
  const limits: number[] = [];
  const order = parts.map((_, index) => index).sort((left, right) => parts[left].length - parts[right].length);
  order.forEach((index, position) => {
    limits[index] = Math.min(parts[index].length, Math.floor(remaining / (order.length - position)));
    remaining -= limits[index];
  });
  return parts.map((part, index) => clipMiddle(part, limits[index]));
}

function imageNote(image: ImageContent, render: RenderContext): string {
  return render.imageNotes.get(image) ?? "[Image from an earlier turn; not attached again]";
}

function renderMessage(message: TranscriptMessage, render: RenderContext): string {
  if (message.role === "system") {
    const update = renderSystemMessageUpdate(message);
    return update ? `[PI INSTRUCTIONS UPDATE]\n${update}` : "";
  }
  if (message.role === "toolResult") {
    const body = message.content.map((part) => part.type === "text" ? part.text : imageNote(part, render)).join("\n");
    const call = render.callNumbers.get(message.toolCallId);
    return renderToolResult({ name: message.toolName, call, isError: message.isError }, body, render.tags);
  }
  const text = typeof message.content === "string" ? message.content : message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image") return imageNote(part, render);
    if (part.type === "toolCall") return renderToolCall(part.name, part.arguments, render.tags);
    return "";
  }).filter(Boolean).join("\n");
  return `[${message.role.toUpperCase()}]\n${message.role === "user" ? neutralizeTags(text, render.tags) : text}`;
}

/** Index of the first message Bernard has not seen: everything after its latest reply. */
function pendingStart(messages: TranscriptMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") return index + 1;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return messages.length;
}

function callNumbers(messages: TranscriptMessage[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    message.content.filter((part): part is ToolCall => part.type === "toolCall").forEach((part, index) => numbers.set(part.id, index + 1));
  }
  return numbers;
}

/** Images in the unsent messages, in order. Tool-result images are marked so they never block the tool loop. */
function pendingImages(messages: TranscriptMessage[]): { image: ImageContent; fromTool: boolean }[] {
  return messages.flatMap((message) => {
    if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return [];
    return message.content
      .filter((part): part is ImageContent => part.type === "image")
      .map((image) => ({ image, fromTool: message.role === "toolResult" }));
  });
}

const BOOTSTRAP_INTRO = "I'm using you through Pi, an open-source coding agent that I run on my own computer via the pi-bernard extension. Pi relays this conversation: it passes on my messages, the operating instructions I configured for it, and the results of the tools it runs on my computer when you call them. Please follow the Pi instructions and tool protocol below for the rest of this conversation.";

const RESULTS_NOTE = "[PI] Results of the tool calls in your previous reply. Pi ignored anything written after your last tool call.";

/** The first run of a thread synchronizes the prompt, the tool protocol, and as much history as fits. */
function bootstrapText(context: TranscriptContext, start: number, render: RenderContext, notes: string[]): { text: string; sourceTokens: number } {
  const system = getCurrentSystemMessage(context.messages);
  const prompt = system ? getSystemMessageText(system) : "";
  const tools = getCurrentTools(context.messages);
  const toolBlock = tools.length ? renderToolInstructions(tools, render.tags) : "";
  const conversation = (messages: TranscriptMessage[]) => messages
    .filter((message) => message.role !== "system")
    .map((message) => renderMessage(message, render))
    .filter(Boolean);
  const history = conversation(context.messages.slice(0, start));
  const pending = conversation(context.messages.slice(start));
  const trailer = [...notes, "Please reply to my latest message, or continue the task after the latest tool results."].join("\n");
  // Bernard's models treat a fake "[SYSTEM]" block in a user message as prompt injection and then
  // refuse Pi's tools, so the message says truthfully that the user's own Pi relays it.
  const head = (systemText: string) => [
    BOOTSTRAP_INTRO,
    systemText ? `<pi_instructions>\n${systemText}\n</pi_instructions>` : "",
    toolBlock,
    "The conversation so far follows. [USER] marks my messages and [ASSISTANT] marks earlier replies.",
  ].filter(Boolean);
  const full = [...head(prompt), ...history, ...pending, trailer].join("\n\n");
  const sourceTokens = Math.ceil(full.length / 4);
  if (full.length <= MAX_MESSAGE_CHARS) return { text: full, sourceTokens };

  // Keep the prompt and tool declarations whole, fit the newest messages, then add recent history.
  const omission = "[Earlier conversation omitted because Bernard limits each run message to 50,000 characters.]";
  const clippedHead = head(clipMiddle(prompt, MAX_SYSTEM_CHARS));
  let remaining = MAX_MESSAGE_CHARS - joinedLength([...clippedHead, omission, trailer]) - 4;
  if (remaining <= 0) throw new Error("Pi-Systemprompt und Tooldefinitionen überschreiten Bernards 50.000-Zeichen-Limit pro Nachricht.");
  const fitted = fitParts(pending, Math.min(joinedLength(pending), history.length ? Math.floor(remaining * 0.6) : remaining));
  remaining -= joinedLength(fitted);
  const recent: string[] = [];
  for (let index = history.length - 1; index >= 0 && history[index].length + 2 <= remaining; index--) {
    recent.unshift(history[index]);
    remaining -= history[index].length + 2;
  }
  const parts = [...clippedHead, ...(recent.length < history.length ? [omission] : []), ...recent, ...fitted, trailer];
  return { text: safeSlice(parts.join("\n\n"), 0, MAX_MESSAGE_CHARS), sourceTokens };
}

/** Later runs send only what Bernard has not seen: tool results, new user turns, and prompt or tool changes. */
function deltaText(context: TranscriptContext, start: number, render: RenderContext, notes: string[]): string {
  const pending = context.messages.slice(start);
  const updates = pending.filter((message) => message.role === "system").map((message) => renderMessage(message, render)).filter(Boolean);
  if (pending.some((message) => message.role === "system" && (message.toolsAdded?.length || message.toolsRemoved?.length))) {
    updates.push(renderToolsUpdate(getCurrentTools(context.messages), render.tags));
  }
  // The model may have kept writing after its calls; that text was never shown and is not an answer.
  if (pending.some((message) => message.role === "toolResult")) updates.push(RESULTS_NOTE);
  const body = pending.filter((message) => message.role !== "system").map((message) => renderMessage(message, render)).filter(Boolean);
  if (!body.length && !updates.length) body.push("[USER]\nContinue.");
  const budget = MAX_MESSAGE_CHARS - joinedLength([...updates, ...notes]) - 4;
  if (budget <= 0) throw new Error("Pi-Systemprompt und Tooldefinitionen überschreiten Bernards 50.000-Zeichen-Limit pro Nachricht.");
  return safeSlice([...updates, ...fitParts(body, budget), ...notes].join("\n\n"), 0, MAX_MESSAGE_CHARS);
}

/** Only the leading prompt identifies a thread; later prompt and tool changes are sent in place. */
function currentSystemSignature(context: TranscriptContext): string {
  const system = getInitialSystemMessage(context.messages);
  const state = system ? { prompt: getSystemMessageText(system), tools: (system.toolsAdded ?? []).map(toToolDeclaration) } : {};
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
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
    const closeText = () => {
      if (textIndex === undefined) return;
      const block = result.content[textIndex];
      if (block.type === "text") stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: result });
      textIndex = undefined;
    };
    const closeThinking = () => {
      if (thinkingIndex === undefined) return;
      const block = result.content[thinkingIndex];
      if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: result });
      thinkingIndex = undefined;
    };
    const appendText = (delta: string) => {
      closeThinking();
      if (textIndex === undefined) {
        textIndex = result.content.length;
        result.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: textIndex, partial: result });
      }
      const block = result.content[textIndex];
      if (block.type === "text") block.text += delta;
      stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: result });
    };
    const appendThinking = (delta: string) => {
      closeText();
      if (thinkingIndex === undefined) {
        thinkingIndex = result.content.length;
        result.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: result });
      }
      const block = result.content[thinkingIndex];
      if (block.type === "thinking") block.thinking += delta;
      if (delta) stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: result });
    };
    // A parsed call is complete, so its start, arguments, and end are emitted together.
    const addToolCall = (name: string, args: JsonObject) => {
      closeText();
      closeThinking();
      const contentIndex = result.content.length;
      const call: ToolCall = { type: "toolCall", id: `call_${crypto.randomUUID().replaceAll("-", "")}`, name, arguments: {} };
      result.content.push(call);
      stream.push({ type: "toolcall_start", contentIndex, partial: result });
      call.arguments = args;
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: result });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: result });
    };
    const apply = (segments: ToolSegment[]) => {
      for (const segment of segments) {
        if (segment.type === "text") appendText(segment.text);
        else addToolCall(segment.name, segment.arguments);
      }
    };
    try {
      auth.token = await bernardToken({ signal: options?.signal, supplied: options?.apiKey });
      // Like Pi's built-in providers, skip failed replies. Runs attach to the last successful reply,
      // so the messages after it (including the failed turn's user message) are sent again.
      const replay = { ...context, messages: context.messages.filter((message) =>
        message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted")) };
      const start = pendingStart(replay.messages);
      const images = pendingImages(replay.messages.slice(start));
      const userImages = images.filter((image) => !image.fromTool).length;
      const vision = model.input.includes("image");
      if (userImages > MAX_IMAGES) throw new Error(`Bernard unterstützt höchstens ${MAX_IMAGES} Bilder pro Nachricht.`);
      if (userImages && !vision) throw new Error(`${model.name} unterstützt laut Bernard-Katalog keine Bilder.`);
      const lease = threads.acquire(currentSystemSignature(replay));
      const tags = toolTags(lease.threadId);
      const tools = getCurrentTools(replay.messages);
      const toolsEnabled = tools.length > 0 && options?.toolChoice !== "none";
      const notes = tools.length && !toolsEnabled ? ["[PI] Do not call any Pi tools in this reply."] : [];

      const imageNotes = new Map<ImageContent, string>();
      const uploads: ImageContent[] = [];
      for (const { image } of images) {
        if (!vision) imageNotes.set(image, `[Image omitted: ${model.name} cannot read images]`);
        else if (uploads.length >= MAX_IMAGES) imageNotes.set(image, `[Image omitted: Bernard accepts at most ${MAX_IMAGES} images per message]`);
        else {
          uploads.push(image);
          imageNotes.set(image, `[Image ${uploads.length} attached to this message]`);
        }
      }
      for (let index = 0; index < uploads.length; index++) {
        resourceIds.push(await uploadImage(uploads[index], index, lease.threadId, auth, options?.signal));
      }
      const render: RenderContext = { tags, imageNotes, callNumbers: callNumbers(replay.messages) };
      const transcript = lease.bootstrap ? bootstrapText(replay, start, render, notes) : undefined;
      const inputText = transcript?.text ?? deltaText(replay, start, render, notes);
      const requestTokens = transcript?.sourceTokens ?? Math.ceil(inputText.length / 4);
      const contextInputTokens = (lease.bootstrap ? 0 : lease.estimatedTokens) + requestTokens + uploads.length * 1600;
      const mode = thinkingMode(model.id, options?.reasoning);
      const payload = {
        message: inputText,
        threadId: lease.threadId,
        userMessageId: crypto.randomUUID(),
        modelId: model.id,
        // Attach to Bernard's last reply explicitly, like Bernard's web client does when editing:
        // without a parent, a tool result sent right after a reply was stored as that reply's sibling.
        ...(!lease.bootstrap && lease.parentMessageId ? { parentMessageId: lease.parentMessageId } : {}),
        webSearchMode: false,
        // Pi executes code locally; Bernard's cloud sandbox would compete with Pi's tools.
        codeMode: false,
        ...(resourceIds.length ? { attachmentIds: resourceIds } : {}),
        ...(mode ? { thinkingMode: mode } : {}),
      };
      const body = await options?.onPayload?.(payload, model) ?? payload;
      const response = await authenticatedFetch(RUN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...options?.headers },
        body: JSON.stringify(body),
      }, auth, options?.signal);
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok) {
        const details = await errorText(response);
        if (response.status === 422 && details.includes("too_big")) throw new Error("context_length_exceeded: Bernard run message exceeds 50,000 characters.");
        throw new Error(`Bernard HTTP ${response.status}: ${details}`);
      }
      if (!response.body) throw new Error("Bernard hat keinen Stream zurückgegeben.");
      stream.push({ type: "start", partial: result });
      const parser = toolsEnabled ? new ToolCallParser(tags) : undefined;
      let messageId: string | undefined;
      let buffer = "";
      const decoder = new TextDecoder();
      const handle = (raw: string) => {
        const lines = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"));
        if (!lines.length) return;
        const data = lines.map((line) => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") return;
        const event = JSON.parse(data) as {
          type?: string; delta?: string; error?: string | { message?: string }; finishReason?: string; messageMetadata?: { ricoId?: string };
        };
        if (event.type === "message-metadata" && event.messageMetadata?.ricoId) messageId = event.messageMetadata.ricoId;
        if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : event.error?.message ?? "Bernard stream error");
        if (event.type === "reasoning-start") appendThinking("");
        if (event.type === "reasoning-delta" && event.delta) appendThinking(event.delta);
        if (event.type === "reasoning-end") closeThinking();
        if (event.type === "text-delta" && event.delta) apply(parser ? parser.push(event.delta) : [{ type: "text", text: event.delta }]);
        if (event.type === "finish") {
          if (event.finishReason === "error") throw new Error("Bernard hat die Antwort mit einem Fehler beendet.");
          if (event.finishReason === "length") result.stopReason = "length";
          ended = true;
        }
      };
      read: for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let position: number;
        while ((position = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const separator = buffer.slice(position).match(/^\r?\n\r?\n/)![0];
          handle(buffer.slice(0, position));
          buffer = buffer.slice(position + separator.length);
          // The model began inventing tool results: keep its calls and stop the generation, so
          // Bernard's thread does not continue with a made-up answer.
          if (parser?.fabricated) break read;
        }
      }
      if (parser?.fabricated) {
        ended = true;
        try { await authenticatedFetch(`${BASE}/threads/${lease.threadId}/stop`, { method: "POST" }, auth, options?.signal); }
        catch { /* Best effort: the calls are already complete. */ }
      } else {
        buffer += decoder.decode();
        if (buffer.trim()) handle(buffer);
      }
      if (!ended) throw new Error("Bernard-Stream ohne finish-Event beendet.");
      if (parser) apply(parser.finish());
      closeText();
      closeThinking();
      const outputText = result.content.map((block) => block.type === "text" ? block.text
        : block.type === "thinking" ? block.thinking : JSON.stringify(block.arguments)).join("");
      result.usage = estimatedUsage(contextInputTokens, outputText, 0);
      threads.commit(lease, result.usage.totalTokens, messageId);
      const called = result.content.some((block) => block.type === "toolCall");
      result.stopReason = result.stopReason === "length" ? "length" : called ? "toolUse" : "stop";
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
        ? { threadId: data.threadId, estimatedTokens: data.estimatedTokens ?? 0, systemSignature: data.systemSignature, messageId: data.messageId, synced: true }
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
          estimatedTokens: temporaryThread.estimatedTokens ?? 0, systemSignature, temporary: true, parentMessageId: temporaryThread.messageId };
      }
      if (!activeThread || activeThread.systemSignature !== systemSignature) {
        activeThread = { threadId: crypto.randomUUID(), estimatedTokens: 0, systemSignature, synced: false };
      }
      return { threadId: activeThread.threadId!, bootstrap: !activeThread.synced,
        estimatedTokens: activeThread.estimatedTokens ?? 0, systemSignature, temporary: false, parentMessageId: activeThread.messageId };
    },
    commit(lease, estimatedTokens, messageId) {
      const target = lease.temporary ? temporaryThread : activeThread;
      if (!target || target.threadId !== lease.threadId) return;
      target.synced = true;
      target.estimatedTokens = estimatedTokens;
      target.systemSignature = lease.systemSignature;
      target.messageId = messageId;
      if (!lease.temporary) {
        pi.appendEntry<StoredThreadState>("bernard-thread", {
          threadId: target.threadId,
          estimatedTokens,
          systemSignature: target.systemSignature,
          messageId,
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
  // Pi's active tools are never changed here: their declarations travel in the run message (see tools.ts).
}
