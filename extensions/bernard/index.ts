import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { bernardToken } from "./session.js";

const URL = "https://api.bernard.swisscom.com/v1/agents/run";
const BASE = "https://api.bernard.swisscom.com/v1";
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const fallback: ProviderModelConfig[] = [
  { id: "claude-sonnet-4-6", name: "Bernard Sonnet 4.6 (Text)", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: zeroCost },
];
const modes = new Map<string, string[]>();
function mapModel(item: { _id: string; displayName?: string; contextWindow?: number; capabilities?: string[]; thinking?: { modes?: string[] } }): ProviderModelConfig {
  const supported = item.thinking?.modes ?? [];
  modes.set(item._id, supported);
  return {
    id: item._id, name: `Bernard ${item.displayName ?? item._id} (Text)`,
    reasoning: supported.some((mode) => mode !== "off"),
    input: ["text"], contextWindow: item.contextWindow ?? 128000,
    // Bernard does not publish an output-token limit or pricing; keep these conservative.
    maxTokens: 8192, cost: zeroCost,
  };
}
function thinkingMode(modelId: string, level?: string): string | undefined {
  if (!level || level === "off") return undefined;
  const supported = modes.get(modelId) ?? ["off", "adaptive"];
  if (supported.includes("adaptive")) return "adaptive";
  const choice = level === "minimal" || level === "low" ? "low" : level === "medium" ? "medium" : "high";
  if (supported.includes(choice)) return choice;
  return supported.filter((m) => m !== "off").at(-1);
}
const zeroUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

// Bernard's run endpoint takes one user message, not OpenAI messages or tool definitions.
// Replay the transcript as text in a new Bernard thread for every request.
function transcriptToText(context: TranscriptContext): string {
  return context.messages.map((message) => {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : message.content.map((p) => p.text).join("\n");
      return `[SYSTEM]\n${text}\n${Object.values(message.sections ?? {}).filter(Boolean).join("\n")}`;
    }
    if (message.role === "toolResult") {
      return `[TOOL RESULT: ${message.toolName}]\n${message.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")}`;
    }
    const text = typeof message.content === "string" ? message.content : message.content.map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "toolCall") return `[Tool call ${p.name}: ${JSON.stringify(p.arguments)}]`;
      return "";
    }).join("\n");
    return `[${message.role.toUpperCase()}]\n${text}`;
  }).join("\n\n") + "\n\nReply to the last USER message, respecting the SYSTEM instructions above.";
}

function streamBernard(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  const result: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], usage: zeroUsage(), stopReason: "pending", timestamp: Date.now(),
  };
  (async () => {
    let ended = false;
    try {
      const token = await bernardToken({ signal: options?.signal, supplied: options?.apiKey });
      if (context.messages.some((m) => m.role !== "system" && m.content instanceof Array && m.content.some((p) => p.type === "image"))) {
        throw new Error("Bernard-Integration unterstützt noch keine Bilder.");
      }
      const payload = { message: transcriptToText(context), threadId: crypto.randomUUID(),
        userMessageId: crypto.randomUUID(), modelId: model.id, webSearchMode: false,
        ...thinkingMode(model.id, options?.reasoning) ? { thinkingMode: thinkingMode(model.id, options?.reasoning) } : {} };
      const body = await options?.onPayload?.(payload, model) ?? payload;
      const request = (key: string) => fetch(URL, {
        method: "POST", signal: options?.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
          Accept: "text/event-stream", "x-bernard-client": "web", "x-workspace-id": "swisscom", ...options?.headers },
        body: JSON.stringify(body),
      });
      let response = await request(token);
      if (response.status === 401) response = await request(await bernardToken({ signal: options?.signal, force: true }));
      await options?.onResponse?.(response, model);
      if (!response.ok) throw new Error(`Bernard HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      if (!response.body) throw new Error("Bernard hat keinen Stream zurückgegeben.");
      stream.push({ type: "start", partial: result });
      let buffer = "";
      const decoder = new TextDecoder();
      let textStarted = false;
      const handle = (raw: string) => {
        const lines = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"));
        if (!lines.length) return;
        const data = lines.map((line) => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") return;
        const event = JSON.parse(data) as { type?: string; delta?: string; error?: string | { message?: string }; finishReason?: string };
        if (event.type === "error") throw new Error(typeof event.error === "string" ? event.error : event.error?.message ?? "Bernard stream error");
        if (event.type === "text-delta" && event.delta) {
          if (!textStarted) { result.content.push({ type: "text", text: "" }); stream.push({ type: "text_start", contentIndex: 0, partial: result }); textStarted = true; }
          const block = result.content[0];
          if (block.type === "text") block.text += event.delta;
          stream.push({ type: "text_delta", contentIndex: 0, delta: event.delta, partial: result });
        }
        if (event.type === "finish") {
          if (event.finishReason === "error") throw new Error("Bernard hat die Antwort mit einem Fehler beendet.");
          if (event.finishReason === "length") result.stopReason = "length";
          ended = true;
        }
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let pos: number;
        while ((pos = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const match = buffer.slice(pos).match(/^\r?\n\r?\n/)!;
          handle(buffer.slice(0, pos));
          buffer = buffer.slice(pos + match[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handle(buffer);
      if (!ended) throw new Error("Bernard-Stream ohne finish-Event beendet.");
      if (textStarted && result.content[0].type === "text") stream.push({ type: "text_end", contentIndex: 0, content: result.content[0].text, partial: result });
      result.stopReason = result.stopReason === "length" ? "length" : "stop";
      stream.push({ type: "done", reason: result.stopReason, message: result });
    } catch (error) {
      result.stopReason = options?.signal?.aborted ? "aborted" : "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: result.stopReason, error: result });
    } finally { stream.end(); }
  })();
  return stream;
}

async function loadModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const token = await bernardToken({ signal, allowBrowserLogin: false });
  const response = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) throw new Error(`Bernard Modellliste HTTP ${response.status}`);
  const data = await response.json() as { items?: Parameters<typeof mapModel>[0][] };
  if (!Array.isArray(data.items) || !data.items.length) throw new Error("Bernard Modellliste leer");
  return data.items.map(mapModel);
}

export default async function (pi: ExtensionAPI) {
  // Populate the picker at startup, not only when /model manually refreshes.
  let initialModels = fallback;
  try { initialModels = await loadModels(); } catch { /* Offline or not logged in: retain the fallback model. */ }
  pi.registerProvider("bernard", {
    api: "bernard-run", baseUrl: BASE, apiKey: "bernard-browser-session",
    models: initialModels,
    async refreshModels(context) {
      if (!context.allowNetwork) return initialModels;
      return loadModels(context.signal);
    },
    streamSimple: streamBernard,
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
  // Bernard cannot execute Pi's local tool calls. Restore the user's selection after switching away.
  let previousTools: string[] | undefined;
  const disableTools = () => {
    if (!previousTools) previousTools = pi.getActiveTools();
    pi.setActiveTools([]);
  };
  pi.on("model_select", (event) => {
    if (event.model.provider === "bernard") disableTools();
    else if (previousTools) { pi.setActiveTools(previousTools); previousTools = undefined; }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider === "bernard") disableTools();
  });
}
