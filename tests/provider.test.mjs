import assert from "node:assert/strict";
import { test } from "node:test";
import { ai, event, loadExtension, readTool, reply, sse, toolResult, tools, user } from "./helpers.mjs";

const { normalizeContext } = ai;
const RESULTS_NOTE = "[PI] Results of the tool calls in your previous reply. Pi ignored anything written after your last tool call.";
const { toolTags } = tools;
const systemPrompt = "You are Pi's test assistant.";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const callBlock = (threadId, name, args) => {
  const { call } = toolTags(threadId);
  return `<${call}>\n${JSON.stringify({ name, arguments: args })}\n</${call}>`;
};

/** Splits a string into byte chunks of `size`, cutting through multibyte characters. */
function byteChunks(text, size) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += size) chunks.push(bytes.slice(index, index + size));
  return chunks;
}

test("declares Pi tools, turns a tagged reply into a Pi tool call, and returns results in the same thread", async () => {
  const bernard = await loadExtension((body) => {
    if (bernard.runs().length === 1) {
      const text = `Ich prüfe das. 🔍\n${callBlock(body.threadId, "read", { path: "notes/ä.txt" })}`;
      // Cut SSE events and UTF-8 characters at arbitrary byte positions.
      return sse(byteChunks(reply([text.slice(0, 20), text.slice(20)]).join(""), 7));
    }
    return sse(reply(["Die Datei enthält: Blue pelican."]));
  });
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Was steht in notes/ä.txt?")] });

  const first = await bernard.run(context);
  const [firstRun] = bernard.runs();
  assert.equal(firstRun.body.codeMode, false);
  assert.ok(firstRun.body.message.includes(`<pi_instructions>\n${systemPrompt}\n</pi_instructions>`));
  assert.ok(!firstRun.body.message.includes("[SYSTEM]"), "a fake system block makes Bernard's models refuse Pi tools");
  assert.ok(firstRun.body.message.includes("<pi_tools>"));
  assert.ok(firstRun.body.message.includes(JSON.stringify(readTool)));
  assert.ok(firstRun.body.message.includes(`<${toolTags(firstRun.body.threadId).call}>`));
  assert.ok(firstRun.body.message.includes("[USER]\nWas steht in notes/ä.txt?"));

  assert.equal(first.message.stopReason, "toolUse");
  assert.deepEqual(first.message.content.map((block) => block.type), ["text", "toolCall"]);
  assert.equal(first.message.content[0].text, "Ich prüfe das. 🔍\n");
  const call = first.message.content[1];
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "notes/ä.txt" });
  assert.match(call.id, /^call_[0-9a-f]{32}$/);
  assert.deepEqual(first.events.map((item) => item.type).filter((type) => type !== "text_delta"),
    ["start", "text_start", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  assert.deepEqual(first.events.find((item) => item.type === "toolcall_end").toolCall, call);
  assert.equal(first.events.at(-1).reason, "toolUse");
  assert.equal(bernard.entries.at(-1).data.threadId, firstRun.body.threadId);

  context.messages.push(first.message, toolResult(call, [{ type: "text", text: "Blue pelican." }]));
  const second = await bernard.run(context);
  const secondRun = bernard.runs()[1];
  const { result } = toolTags(firstRun.body.threadId);
  assert.equal(secondRun.body.threadId, firstRun.body.threadId);
  assert.equal(secondRun.body.message, `${RESULTS_NOTE}\n\n<${result} call="1" name="read" status="ok">\nBlue pelican.\n</${result}>`);
  assert.equal(second.message.stopReason, "stop");
  assert.equal(second.message.content[0].text, "Die Datei enthält: Blue pelican.");
});

test("parallel calls get one result block each, and error results are marked", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([`${callBlock(body.threadId, "read", { path: "a" })}\n${callBlock(body.threadId, "read", { path: "b" })}`]))
    : sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a and b.")] });
  const first = await bernard.run(context);
  const [a, b] = first.message.content;
  assert.deepEqual([a.arguments.path, b.arguments.path], ["a", "b"]);
  assert.notEqual(a.id, b.id);

  context.messages.push(first.message, toolResult(b, [{ type: "text", text: "B" }]), toolResult(a, [{ type: "text", text: "missing" }], true));
  await bernard.run(context);
  const { message, threadId } = bernard.runs()[1].body;
  const { result } = toolTags(threadId);
  assert.equal(message, `${RESULTS_NOTE}\n\n<${result} call="2" name="read" status="ok">\nB\n</${result}>\n\n<${result} call="1" name="read" status="error">\nmissing\n</${result}>`);
});

test("steering messages sent after tool results travel in the same run", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([callBlock(body.threadId, "read", { path: "a" })]))
    : sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a.")] });
  const first = await bernard.run(context);
  context.messages.push(first.message, toolResult(first.message.content[0], [{ type: "text", text: "A" }]), user("Also check b."));
  await bernard.run(context);
  const { message } = bernard.runs()[1].body;
  assert.ok(message.includes("status=\"ok\">\nA\n"));
  assert.ok(message.endsWith("[USER]\nAlso check b."));
  assert.ok(!message.includes("Read a."));
});

test("image tool results are uploaded and attached to the run, then deleted", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([callBlock(body.threadId, "read", { path: "pixel.png" })]))
    : sse(reply(["A single pixel."])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Look at pixel.png")] });
  const first = await bernard.run(context);
  const image = { type: "image", data: png, mimeType: "image/png" };
  context.messages.push(first.message, toolResult(first.message.content[0], [{ type: "text", text: "Read image file [image/png]" }, image]));
  await bernard.run(context);

  const run = bernard.runs()[1];
  assert.deepEqual(run.body.attachmentIds, ["res-1"]);
  assert.ok(run.body.message.includes("Read image file [image/png]\n[Image 1 attached to this message]"));
  const upload = bernard.requests.find((request) => request.url.endsWith("/v1/resources") && request.method === "POST");
  assert.equal(upload.body.threadId, run.body.threadId);
  assert.ok(bernard.requests.some((request) => request.url.endsWith("/v1/resources/res-1") && request.method === "DELETE"));
});

test("image tool results for text-only models become a note instead of an error", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([callBlock(body.threadId, "read", { path: "pixel.png" })]))
    : sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Look at pixel.png")] });
  const first = await bernard.run(context, {}, "text-only");
  context.messages.push(first.message, toolResult(first.message.content[0], [{ type: "image", data: png, mimeType: "image/png" }]));
  const second = await bernard.run(context, {}, "text-only");
  assert.equal(second.message.stopReason, "stop");
  assert.equal(bernard.runs()[1].body.attachmentIds, undefined);
  assert.ok(bernard.runs()[1].body.message.includes("[Image omitted: Bernard Text only cannot read images]"));
});

test("an image format Bernard rejects becomes a note instead of ending the session", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([callBlock(body.threadId, "read", { path: "ticket.png" })]))
    : sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Look at ticket.png")] });
  const first = await bernard.run(context);
  // An attachment named .png whose bytes are a GIF: Pi reports the sniffed type, not the extension.
  context.messages.push(first.message, toolResult(first.message.content[0], [{ type: "image", data: png, mimeType: "image/gif" }]));
  const second = await bernard.run(context);

  assert.equal(second.message.stopReason, "stop", "an unusable image must not fail the run");
  assert.equal(bernard.runs()[1].body.attachmentIds, undefined);
  assert.ok(bernard.runs()[1].body.message.includes("[Image omitted: Bernard unterstützt in Pi derzeit PNG, JPEG und WebP, nicht image/gif]"));
  assert.ok(!bernard.requests.some((request) => request.url.endsWith("/v1/resources") && request.method === "POST"));

  // The run must succeed, or the image stays pending and every later turn fails on it again.
  context.messages.push(second.message, user("something else entirely"));
  assert.equal((await bernard.run(context)).message.stopReason, "stop");
});

test("a skipped image does not shift the numbering of the images around it", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([callBlock(body.threadId, "read", { path: "both" })]))
    : sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Look at both.")] });
  const first = await bernard.run(context);
  context.messages.push(first.message, toolResult(first.message.content[0], [
    { type: "image", data: png, mimeType: "image/gif" },
    { type: "image", data: png, mimeType: "image/png" },
  ]));
  await bernard.run(context);

  const { attachmentIds, message } = bernard.runs()[1].body;
  assert.deepEqual(attachmentIds, ["res-1"]);
  assert.ok(message.includes("nicht image/gif]\n[Image 1 attached to this message]"));
});

test("more images than Bernard accepts are noted instead of failing the run", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const images = Array.from({ length: 7 }, () => ({ type: "image", data: png, mimeType: "image/png" }));
  const context = normalizeContext({ systemPrompt, messages: [user([{ type: "text", text: "Look at these." }, ...images])] });
  const { message } = await bernard.run(context);

  assert.equal(message.stopReason, "stop");
  assert.deepEqual(bernard.runs()[0].body.attachmentIds, ["res-1", "res-2", "res-3", "res-4", "res-5"]);
  assert.ok(bernard.runs()[0].body.message.includes("[Image omitted: Bernard accepts at most 5 images per message]"));
});

test("a user image sent to a text-only model is noted instead of failing the run", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, messages: [user([{ type: "text", text: "Look." }, { type: "image", data: png, mimeType: "image/png" }])] });
  const { message } = await bernard.run(context, {}, "text-only");

  assert.equal(message.stopReason, "stop");
  assert.equal(bernard.runs()[0].body.attachmentIds, undefined);
  assert.ok(bernard.runs()[0].body.message.includes("[Image omitted: Bernard Text only cannot read images]"));
});

test("an image Bernard fails to process is skipped, a failing upload is not", async () => {
  let resourceStatus = "failed";
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (/\/v1\/resources\/[^/]+\/confirm$/.test(url)) {
      await inner(input, init);
      return new Response(JSON.stringify({ resource: { _id: "res-1", mimeType: "image/png", status: resourceStatus, failureCode: "unsupported_content" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/v1/resources") && init.method === "POST" && resourceStatus === "error") {
      await inner(input, init);
      return new Response("boom", { status: 500 });
    }
    return inner(input, init);
  };
  const image = () => user([{ type: "text", text: "Look." }, { type: "image", data: png, mimeType: "image/png" }]);

  const rejected = await bernard.run(normalizeContext({ systemPrompt, messages: [image()] }));
  assert.equal(rejected.message.stopReason, "stop");
  assert.ok(bernard.runs()[0].body.message.includes("[Image omitted: Bernard konnte das Bild nicht verarbeiten: unsupported_content]"));
  assert.ok(bernard.requests.some((request) => request.url.endsWith("/v1/resources/res-1") && request.method === "DELETE"));

  // A transient upload failure must still fail the run, so Pi can retry it.
  resourceStatus = "error";
  const failed = await bernard.run(normalizeContext({ systemPrompt, messages: [image()] }));
  assert.equal(failed.message.stopReason, "error");
  assert.match(failed.message.errorMessage, /Bildregistrierung HTTP 500/);
});

test("an image rejected on the final status lookup is omitted and does not block later turns", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const inner = globalThis.fetch;
  let lookups = 0;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (/\/v1\/resources\/[^/]+\/confirm$/.test(url)) {
      await inner(input, init);
      return json({ resource: { _id: "res-1", status: "pending" } });
    }
    if (url.endsWith("/v1/resources/lookup")) {
      lookups++;
      return json({ items: [{ _id: "res-1", status: lookups === 30 ? "failed" : "pending", failureCode: "unsupported_content" }] });
    }
    return inner(input, init);
  };
  const context = normalizeContext({ systemPrompt, messages: [user([
    { type: "text", text: "Look." }, { type: "image", data: png, mimeType: "image/png" },
  ])] });

  const first = await bernard.run(context);
  assert.equal(lookups, 30);
  assert.equal(first.message.stopReason, "stop", first.message.errorMessage);
  assert.equal(bernard.runs()[0].body.attachmentIds, undefined);
  assert.ok(bernard.runs()[0].body.message.includes("[Image omitted: Bernard konnte das Bild nicht verarbeiten: unsupported_content]"));
  assert.ok(bernard.requests.some((request) => request.url.endsWith("/v1/resources/res-1") && request.method === "DELETE"));

  context.messages.push(first.message, user("Continue without the image."));
  assert.equal((await bernard.run(context)).message.stopReason, "stop");
  assert.equal(lookups, 30, "later turns must not retry the rejected image");
  assert.equal(bernard.requests.filter((request) => request.url.endsWith("/v1/resources") && request.method === "POST").length, 1);
});

test("oversized tool results are clipped to Bernard's per-message limit", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([`${callBlock(body.threadId, "read", { path: "a" })}${callBlock(body.threadId, "read", { path: "b" })}`]))
    : sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read both.")] });
  const first = await bernard.run(context);
  const [a, b] = first.message.content;
  context.messages.push(first.message,
    toolResult(a, [{ type: "text", text: `A-start${"a".repeat(60_000)}😀A-end` }]),
    toolResult(b, [{ type: "text", text: "short result" }]));
  await bernard.run(context);

  const { message, threadId } = bernard.runs()[1].body;
  const { result } = toolTags(threadId);
  assert.ok(message.length <= 48_000, `message has ${message.length} characters`);
  assert.ok(message.includes("A-start") && message.includes("A-end"));
  assert.ok(message.includes("characters omitted to fit Bernard's 50,000-character message limit"));
  assert.ok(message.includes(`<${result} call="2" name="read" status="ok">\nshort result\n</${result}>`));
  assert.equal(message.split(`</${result}>`).length, 3);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(message), "no split surrogate pair");
});

test("a long session adopted into a new thread keeps prompt and tool declarations whole", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const history = [];
  for (let index = 0; index < 30; index++) {
    history.push(user(`question ${index} ${"x".repeat(3000)}`), {
      role: "assistant", api: "other", provider: "other", model: "other", stopReason: "stop", timestamp: Date.now(),
      content: [{ type: "text", text: `answer ${index}` }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
  }
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [...history, user("latest question")] });
  await bernard.run(context);
  const { message } = bernard.runs()[0].body;
  assert.ok(message.length <= 48_000);
  assert.ok(message.includes(systemPrompt) && message.includes(JSON.stringify(readTool)));
  assert.ok(message.includes("[Earlier conversation omitted"));
  assert.ok(message.includes("[USER]\nlatest question"));
  assert.ok(!message.includes("question 0 "));
});

test("tool changes are declared in the existing thread", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("hello")] });
  const first = await bernard.run(context);
  const bash = { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
  context.messages.push(first.message, { role: "system", content: "", toolsAdded: [bash], toolsRemoved: [{ name: "read" }], timestamp: Date.now() }, user("now run ls"));
  await bernard.run(context);
  const [one, two] = bernard.runs();
  assert.equal(two.body.threadId, one.body.threadId);
  assert.ok(two.body.message.startsWith("[PI TOOLS UPDATED]"));
  assert.ok(two.body.message.includes(JSON.stringify(bash)));
  assert.ok(!two.body.message.includes("\"name\":\"read\""));
  assert.ok(two.body.message.endsWith("[USER]\nnow run ls"));
});

test("aborting inside a tool-call block produces no tool call", async () => {
  const controller = new AbortController();
  const bernard = await loadExtension((body, init) => sse([
    event({ type: "start" }),
    event({ type: "text-delta", delta: `Starting.\n<${toolTags(body.threadId).call}>\n{"name":"read","arg` }),
    () => new Promise((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 10)),
  ], init.signal));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a.")] });
  const { message, events } = await bernard.run(context, { signal: controller.signal });
  assert.equal(message.stopReason, "aborted");
  assert.ok(!message.content.some((block) => block.type === "toolCall"));
  assert.ok(!events.some((item) => item.type.startsWith("toolcall")));
  assert.equal(bernard.entries.length, 0, "an aborted run does not mark the thread as synchronized");
});

test("a length stop keeps its reason so Pi rejects possibly truncated calls", async () => {
  const bernard = await loadExtension((body) => sse(reply([callBlock(body.threadId, "read", { path: "a" })], "length")));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a.")] });
  const { message } = await bernard.run(context);
  assert.equal(message.stopReason, "length");
});

test("without tools, or with toolChoice none, tags are plain text", async () => {
  const bernard = await loadExtension((body) => sse(reply([`Text ${callBlock(body.threadId, "read", { path: "a" })}`])));
  const noTools = await bernard.run(normalizeContext({ systemPrompt, messages: [user("hi")] }));
  assert.equal(noTools.message.stopReason, "stop");
  assert.ok(!bernard.runs()[0].body.message.includes("<pi_tools>"));
  assert.ok(noTools.message.content[0].text.includes("\"name\":\"read\""));

  const none = await loadExtension((body) => sse(reply([callBlock(body.threadId, "read", { path: "a" })])));
  const result = await none.run(normalizeContext({ systemPrompt, tools: [readTool], messages: [user("hi")] }), { toolChoice: "none" });
  assert.equal(result.message.stopReason, "stop");
  assert.ok(none.runs()[0].body.message.includes("Do not call any Pi tools in this reply."));
});

test("history from another provider is rendered in the thread's tool protocol", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"])));
  const call = { type: "toolCall", id: "toolu_01", name: "read", arguments: { path: "a" } };
  const assistant = {
    role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude", stopReason: "toolUse", timestamp: Date.now(),
    content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Reading." }, call],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a."), assistant, toolResult(call, [{ type: "text", text: "A" }])] });
  await bernard.run(context);
  const { message, threadId } = bernard.runs()[0].body;
  const tags = toolTags(threadId);
  assert.ok(message.includes(`[ASSISTANT]\nReading.\n<${tags.call}>\n{"name":"read","arguments":{"path":"a"}}\n</${tags.call}>`));
  assert.ok(message.includes(`<${tags.result} call="1" name="read" status="ok">\nA\n</${tags.result}>`));
  assert.ok(!message.includes("private"));
});

test("later runs attach to Bernard's last reply so a fast tool loop cannot branch the thread", async () => {
  const bernard = await loadExtension((body) => bernard.runs().length === 1
    ? sse(reply([callBlock(body.threadId, "read", { path: "a" })], "stop", "reply-1"))
    : sse(reply(["ok"], "stop", "reply-2")));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a.")] });
  const first = await bernard.run(context);
  assert.equal(bernard.runs()[0].body.parentMessageId, undefined);
  assert.equal(bernard.entries.at(-1).data.messageId, "reply-1");
  context.messages.push(first.message, toolResult(first.message.content[0], [{ type: "text", text: "A" }]));
  const second = await bernard.run(context);
  assert.equal(bernard.runs()[1].body.parentMessageId, "reply-1");
  context.messages.push(second.message, user("next"));
  await bernard.run(context);
  assert.equal(bernard.runs()[2].body.parentMessageId, "reply-2");
});

test("the thread and its last reply survive a Pi restart", async () => {
  const bernard = await loadExtension(() => sse(reply(["ok"], "stop", "stored-reply")));
  const threadId = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const branch = [{ type: "custom", customType: "bernard-thread", data: { threadId, estimatedTokens: 10, messageId: "stored-reply" } }];
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("earlier"), user("again")] });
  // The stored signature must match the current prompt: take it from a first, discarded run.
  await bernard.run(context);
  branch[0].data.systemSignature = bernard.entries.at(-1).data.systemSignature;
  for (const handler of bernard.handlers.session_start) handler({ reason: "resume" }, { sessionManager: { getBranch: () => branch } });
  await bernard.run(context);
  const run = bernard.runs().at(-1).body;
  assert.equal(run.threadId, threadId);
  assert.equal(run.parentMessageId, "stored-reply");
  assert.ok(!run.message.includes("<pi_tools>"));
});

test("an invented tool result stops Bernard's generation and keeps only the real calls", async () => {
  let cancelled = false;
  const bernard = await loadExtension((body) => new Response(new ReadableStream({
    start(controller) {
      const { result } = toolTags(body.threadId);
      for (const chunk of [
        event({ type: "message-metadata", messageMetadata: { ricoId: "reply-1" } }),
        event({ type: "text-delta", delta: callBlock(body.threadId, "write", { path: "fib.py", content: "print(1)" }) }),
        event({ type: "text-delta", delta: `\n\n<${result} call="1" name="write" status="ok">\nwritten\n` }),
      ]) controller.enqueue(new TextEncoder().encode(chunk));
      // No finish event: Pi must not wait for the invented rest of the reply.
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Write and run fib.py")] });
  const { message } = await bernard.run(context);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content.map((block) => block.type), ["toolCall"]);
  assert.equal(message.content[0].name, "write");
  assert.ok(cancelled, "the SSE stream is cancelled");
  const threadId = bernard.runs()[0].body.threadId;
  assert.ok(bernard.requests.some((request) => request.url.endsWith(`/v1/threads/${threadId}/stop`) && request.method === "POST"));
  assert.equal(bernard.entries.at(-1).data.messageId, "reply-1");
});

test("after an aborted reply, the next run resends the lost user turn and attaches to the last good reply", async () => {
  const controller = new AbortController();
  const bernard = await loadExtension((_body, init) => {
    if (bernard.runs().length === 2) {
      return sse([
        event({ type: "message-metadata", messageMetadata: { ricoId: "reply-aborted" } }),
        event({ type: "text-delta", delta: "Partial" }),
        () => new Promise((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 10)),
      ], init.signal);
    }
    return sse(reply(["ok"], "stop", `reply-${bernard.runs().length}`));
  });
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("first")] });
  context.messages.push((await bernard.run(context)).message, user("old"));
  const aborted = await bernard.run(context, { signal: controller.signal });
  assert.equal(aborted.message.stopReason, "aborted");
  context.messages.push(aborted.message, user("new"));
  await bernard.run(context);

  const [first, , third] = bernard.runs();
  assert.equal(third.body.threadId, first.body.threadId);
  assert.equal(third.body.parentMessageId, "reply-1");
  assert.equal(third.body.message, "[USER]\nold\n\n[USER]\nnew");
});

test("tool results from a failed run are sent again with the next user turn", async () => {
  const bernard = await loadExtension((body) => {
    const run = bernard.runs().length;
    if (run === 1) return sse(reply([callBlock(body.threadId, "read", { path: "a" })], "stop", "reply-1"));
    if (run === 2) return new Response(JSON.stringify({ error: { code: "unavailable" } }), { status: 503 });
    return sse(reply(["ok"], "stop", "reply-3"));
  });
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a.")] });
  const first = await bernard.run(context);
  context.messages.push(first.message, toolResult(first.message.content[0], [{ type: "text", text: "A" }]));
  const failed = await bernard.run(context);
  assert.equal(failed.message.stopReason, "error");
  context.messages.push(failed.message, user("continue"));
  await bernard.run(context);

  const { message, parentMessageId } = bernard.runs()[2].body;
  assert.equal(parentMessageId, "reply-1");
  assert.ok(message.includes("status=\"ok\">\nA\n"));
  assert.ok(message.endsWith("[USER]\ncontinue"));
});
