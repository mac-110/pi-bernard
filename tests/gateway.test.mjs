// Bernard's gateway (nginx, apparently a web application firewall) rejects some runs with an HTML 403
// depending on their content. A rejected message must not be sent again, or every later run fails too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ai, isContextOverflow, isRetryableAssistantError, loadExtension, readTool, reply, sse, toolResult, tools, user } from "./helpers.mjs";

const { normalizeContext } = ai;
const { toolTags } = tools;
const systemPrompt = "You are Pi's test assistant.";
const RESULTS_NOTE = "[PI] Results of the tool calls in your previous reply. Pi ignored anything written after your last tool call.";
const WITHHELD_MESSAGE = "[PI] Bernard's gateway rejected the request that carried this message";
const WITHHELD_RESULT = "[PI] Bernard's gateway rejected the request that carried this result";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Stands in for whatever the gateway blocks; its rules are not known.
const BLOCKED = "BLOCKED-PATTERN";
const nginxPage = "<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
const gateway403 = () => new Response(nginxPage, { status: 403, headers: { "content-type": "text/html" } });

const callBlock = (threadId, name, args) => {
  const { call } = toolTags(threadId);
  return `<${call}>\n${JSON.stringify({ name, arguments: args })}\n</${call}>`;
};

/** A Bernard whose gateway rejects every run containing BLOCKED. Replies are named reply-<run number>. */
async function blockingBernard(answer = () => ["ok"]) {
  let runs = () => [];
  const bernard = await loadExtension((body) => body.message.includes(BLOCKED)
    ? gateway403()
    : sse(reply(answer(body, runs().length), "stop", `reply-${runs().length}`)));
  runs = bernard.runs;
  return bernard;
}

test("a gateway 403 fails the run once, and the next run sends a note instead of the rejected message", async () => {
  const bernard = await blockingBernard();
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("hello")] });
  context.messages.push((await bernard.run(context)).message, user(`please explain ${BLOCKED}`));
  const rejected = await bernard.run(context);

  assert.equal(rejected.message.stopReason, "error");
  assert.match(rejected.message.errorMessage, /^Bernard-Gateway hat die Anfrage abgelehnt \(HTTP 403\)\. Vermutlich blockiert eine Web Application Firewall/);
  assert.ok(!rejected.message.errorMessage.includes("<html>"));
  assert.equal(isRetryableAssistantError(rejected.message), false, "Pi would resend the blocked text");
  assert.equal(isContextOverflow(rejected.message, 200000), false, "Pi would compact, which sends the blocked text too");
  assert.equal(bernard.runs().length, 2, "a rejection is not retried");

  context.messages.push(rejected.message, user("something else"));
  const next = await bernard.run(context);
  assert.equal(next.message.stopReason, "stop", next.message.errorMessage);
  const [first, , third] = bernard.runs();
  assert.equal(third.body.threadId, first.body.threadId);
  assert.equal(third.body.parentMessageId, "reply-1");
  assert.ok(!third.body.message.includes(BLOCKED));
  assert.ok(third.body.message.startsWith(`[USER]\n${WITHHELD_MESSAGE}`));
  assert.ok(third.body.message.endsWith("\n\n[USER]\nsomething else"));

  // The note is part of the Bernard thread now and is not sent again.
  context.messages.push(next.message, user("and now?"));
  await bernard.run(context);
  assert.equal(bernard.runs()[3].body.message, "[USER]\nand now?");
  assert.equal(bernard.runs()[3].body.parentMessageId, "reply-3");
});

test("rejected tool results become error results, so the model can carry on", async () => {
  const bernard = await blockingBernard((body, run) => run === 1
    ? [`${callBlock(body.threadId, "read", { path: "a" })}\n${callBlock(body.threadId, "read", { path: "b" })}`]
    : ["ok"]);
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("Read a and b.")] });
  const first = await bernard.run(context);
  const [a, b] = first.message.content;
  context.messages.push(first.message,
    toolResult(a, [{ type: "text", text: "harmless" }, { type: "image", data: png, mimeType: "image/png" }]),
    toolResult(b, [{ type: "text", text: `config with ${BLOCKED}` }]));
  const rejected = await bernard.run(context);
  assert.equal(rejected.message.stopReason, "error");
  const uploads = () => bernard.requests.filter((request) => request.url.endsWith("/v1/resources") && request.method === "POST").length;
  assert.equal(uploads(), 1);

  context.messages.push(rejected.message, user("continue"));
  const next = await bernard.run(context);
  assert.equal(next.message.stopReason, "stop", next.message.errorMessage);
  const { message, threadId, parentMessageId, attachmentIds } = bernard.runs()[2].body;
  const { result } = toolTags(threadId);
  assert.equal(parentMessageId, "reply-1");
  assert.ok(message.startsWith(RESULTS_NOTE));
  // The gateway refused the request as a whole, so none of its results is sent again.
  assert.ok(!message.includes(BLOCKED) && !message.includes("harmless"));
  assert.ok(message.includes(`<${result} call="1" name="read" status="error">\n${WITHHELD_RESULT}`));
  assert.ok(message.includes(`<${result} call="2" name="read" status="error">\n${WITHHELD_RESULT}`));
  assert.ok(message.endsWith("[USER]\ncontinue"));
  assert.equal(attachmentIds, undefined, "images of rejected results are not uploaded again");
  assert.equal(uploads(), 1);
});

test("a JSON 403 from Bernard's API is still replayed with the next turn", async () => {
  const bernard = await loadExtension(() => bernard.runs().length === 2
    ? new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403, headers: { "content-type": "application/json" } })
    : sse(reply(["ok"], "stop", `reply-${bernard.runs().length}`)));
  const context = normalizeContext({ systemPrompt, messages: [user("hello")] });
  context.messages.push((await bernard.run(context)).message, user("question"));
  const failed = await bernard.run(context);
  assert.match(failed.message.errorMessage, /^Bernard HTTP 403: \{"error"/);

  context.messages.push(failed.message, user("again"));
  await bernard.run(context);
  assert.equal(bernard.runs()[2].body.message, "[USER]\nquestion\n\n[USER]\nagain");
});

test("prompt and tool updates sent with a rejected message are kept", async () => {
  const bernard = await blockingBernard();
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("hello")] });
  const bash = { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
  context.messages.push((await bernard.run(context)).message,
    { role: "system", content: "", toolsAdded: [bash], timestamp: Date.now() },
    user(`run ${BLOCKED}`));
  const rejected = await bernard.run(context);
  assert.equal(rejected.message.stopReason, "error");

  context.messages.push(rejected.message, user("run ls"));
  await bernard.run(context);
  const { message } = bernard.runs()[2].body;
  assert.ok(message.startsWith("[PI TOOLS UPDATED]"));
  assert.ok(message.includes(JSON.stringify(bash)));
  assert.ok(message.includes(WITHHELD_MESSAGE) && !message.includes(BLOCKED));
  assert.ok(message.endsWith("[USER]\nrun ls"));
});

test("a new Bernard thread synchronizes the note, not the rejected message", async () => {
  const bernard = await blockingBernard();
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("hello")] });
  context.messages.push((await bernard.run(context)).message, user(BLOCKED));
  const rejected = await bernard.run(context);
  context.messages.push(rejected.message, user("next"));
  context.messages.push((await bernard.run(context)).message, user("after /tree"));
  // Branch navigation starts a fresh thread, which receives the whole history once.
  for (const handler of bernard.handlers.session_tree) handler();
  const resynced = await bernard.run(context);

  assert.equal(resynced.message.stopReason, "stop", resynced.message.errorMessage);
  const { message, threadId } = bernard.runs()[3].body;
  assert.notEqual(threadId, bernard.runs()[0].body.threadId);
  assert.ok(message.includes("<pi_tools>"));
  assert.ok(message.includes(`[USER]\n${WITHHELD_MESSAGE}`));
  assert.ok(!message.includes(BLOCKED));
});

test("a session blocked by an older version recovers", async () => {
  const bernard = await blockingBernard();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const failed = (errorMessage) => ({ role: "assistant", api: "bernard-run", provider: "bernard", model: "claude-sonnet-4-6",
    content: [], usage, stopReason: "error", errorMessage, timestamp: Date.now() });
  const context = normalizeContext({ systemPrompt, messages: [
    user(BLOCKED), failed(`Bernard HTTP 403: ${nginxPage.slice(0, 500)}`),
    user("something else"), failed(`Bernard HTTP 403: ${nginxPage.slice(0, 500)}`),
    user("third try"),
  ] });
  const { message } = await bernard.run(context);
  assert.equal(message.stopReason, "stop", message.errorMessage);
  const sent = bernard.runs()[0].body.message;
  assert.ok(!sent.includes(BLOCKED) && !sent.includes("something else"));
  assert.ok(sent.includes("[USER]\nthird try"));
});

test("a rejection without the previously rejected content points at instructions or history", async () => {
  const bernard = await loadExtension(() => gateway403());
  const context = normalizeContext({ systemPrompt: `Instructions mentioning ${BLOCKED}`, messages: [user("hi")] });
  const first = await bernard.run(context);
  assert.match(first.message.errorMessage, /^Bernard-Gateway hat die Anfrage abgelehnt \(HTTP 403\)\. /);

  context.messages.push(first.message, user("hello?"));
  const second = await bernard.run(context);
  assert.match(second.message.errorMessage, /^Bernard-Gateway hat die Anfrage abgelehnt \(HTTP 403\), obwohl die zuvor abgelehnten Inhalte nicht mehr mitgesendet wurden\. .*Pi-Anweisungen/);
  assert.equal(isRetryableAssistantError(second.message), false);
  assert.equal(isContextOverflow(second.message, 200000), false);
  assert.ok(!bernard.runs()[1].body.message.includes("[USER]\nhi"));
});

test("compaction with Bernard summarizes the notes, not the rejected messages", async () => {
  const bernard = await blockingBernard();
  const context = normalizeContext({ systemPrompt, tools: [readTool], messages: [user("hello")] });
  context.messages.push((await bernard.run(context)).message, user(BLOCKED));
  const rejected = await bernard.run(context);
  context.messages.push(rejected.message, user("next"));
  context.messages.push((await bernard.run(context)).message);

  const compact = (provider) => {
    const messagesToSummarize = context.messages.slice(1, 4);
    const turnPrefixMessages = context.messages.slice(4);
    const event = { type: "session_before_compact", preparation: { messagesToSummarize, turnPrefixMessages } };
    for (const handler of bernard.handlers.session_before_compact) handler(event, { model: { provider } });
    for (const handler of bernard.handlers.session_compact_failed) handler();
    return [...messagesToSummarize, ...turnPrefixMessages];
  };
  const summarized = compact("bernard");
  assert.equal(summarized.length, 6);
  assert.ok(!JSON.stringify(summarized).includes(BLOCKED));
  // The rejected message is summarized and its failed reply is in the turn prefix: the notes span both parts.
  assert.ok(summarized[2].content.startsWith(WITHHELD_MESSAGE));
  assert.equal(summarized[4].content, "next");
  // Other providers sit behind no such gateway and summarize the original.
  assert.ok(JSON.stringify(compact("anthropic")).includes(BLOCKED));
});

test("/bernard-rejected lists what each rejected request sent, across branches", async () => {
  const bernard = await blockingBernard();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (stopReason, errorMessage) => ({ role: "assistant", api: "bernard-run", provider: "bernard", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "answer" }], usage, stopReason, errorMessage, timestamp: Date.now() });
  const rejection = "Bernard-Gateway hat die Anfrage abgelehnt (HTTP 403). Vermutlich …";
  const call = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } };
  const messages = {
    u1: user("hello"), a1: { ...assistant("toolUse"), content: [call] },
    r1: toolResult(call, [{ type: "text", text: `secret ${BLOCKED}` }, { type: "image", data: png, mimeType: "image/png" }]),
    e1: assistant("error", rejection),
    u2: user("still there?"), e2: assistant("error", `${rejection.slice(0, 52)}, obwohl …`),
    // Another branch from a1: a plain server error is not listed, its message is part of the next rejection.
    b1: { role: "bashExecution", command: "cat config", output: `${BLOCKED} in output`, exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() },
    x1: assistant("error", "Bernard HTTP 500: {}"), u3: user("again"), e3: assistant("error", `Bernard HTTP 403: <html>`),
  };
  const parents = { u1: null, a1: "u1", r1: "a1", e1: "r1", u2: "e1", e2: "u2", b1: "a1", x1: "b1", u3: "x1", e3: "u3" };
  const entries = Object.entries(messages).map(([id, message]) => ({ type: "message", id, parentId: parents[id], timestamp: "", message }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sessionManager = {
    getEntries: () => entries,
    getBranch: (id) => { const path = []; for (let entry = byId.get(id); entry; entry = byId.get(entry.parentId)) path.unshift(entry); return path; },
  };
  let shown;
  const notes = [];
  const ui = { editor: async (title, text) => { shown = { title, text }; return undefined; }, notify: (text) => notes.push(text) };
  await bernard.commands["bernard-rejected"].handler("", { sessionManager, ui, hasUI: true });

  const sections = shown.text.split(/━━ Ablehnung \d+ · /);
  assert.equal(sections.length, 4, shown.text);
  assert.ok(sections[0].startsWith("Bernards Gateway hat in dieser Session 3 Anfragen abgelehnt."));
  assert.ok(sections[1].includes(`── Toolergebnis read ──\nsecret ${BLOCKED}\n[Bild image/png]`));
  assert.ok(!sections[1].includes("hello"), "messages before the last successful reply were not part of the request");
  assert.ok(sections[2].includes("── Nachricht ──\nstill there?"));
  assert.ok(sections[2].includes("Die vorherige Anfrage wurde schon abgelehnt"));
  assert.ok(!sections[2].includes(BLOCKED), "the earlier rejected content was not sent again");
  assert.ok(sections[3].indexOf(`── Shell-Befehl !cat config ──\n${BLOCKED} in output`) < sections[3].indexOf("── Nachricht ──\nagain"));
  assert.equal(notes.length, 0);

  await bernard.commands["bernard-rejected"].handler("", { sessionManager: { getEntries: () => [], getBranch: () => [] }, ui, hasUI: true });
  assert.deepEqual(notes, ["Bernards Gateway hat in dieser Session keine Anfrage abgelehnt."]);
});

test("java.lang.Runtime and java.lang.ProcessBuilder lose their package name before sending", async () => {
  // Rule 944100 of the OWASP Core Rule Set, which most likely rejected a Java stack trace.
  const rule944100 = /java\.lang\.(?:runtime|processbuilder)/i;
  const bernard = await loadExtension((body) => rule944100.test(body.message)
    ? gateway403()
    : sse(reply(["ok"], "stop", `reply-${bernard.runs().length}`)));
  const trace = [
    "Caused by: java.lang.RuntimeException: Write failed",
    "\tat java.base/java.lang.ProcessBuilder.start(ProcessBuilder.java:1143)",
    "\tat Java.Lang.ProcessBuilder.start",
    "\tat java.base/java.lang.NumberFormatException.forInputString(NumberFormatException.java:67)",
    "\tat java.base/java.lang.String.valueOf(String.java:4465)",
  ].join("\n");
  const context = normalizeContext({ systemPrompt: `${systemPrompt} Never call java.lang.Runtime.exec.`, tools: [readTool], messages: [user(trace)] });
  const first = await bernard.run(context);
  assert.equal(first.message.stopReason, "stop", first.message.errorMessage);
  const sent = bernard.runs()[0].body.message;
  assert.ok(sent.includes("Never call Runtime.exec."), "system prompt");
  assert.ok(sent.includes([
    "Caused by: RuntimeException: Write failed",
    "\tat java.base/ProcessBuilder.start(ProcessBuilder.java:1143)",
    "\tat ProcessBuilder.start",
    "\tat java.base/java.lang.NumberFormatException.forInputString(NumberFormatException.java:67)",
    "\tat java.base/java.lang.String.valueOf(String.java:4465)",
  ].join("\n")));

  context.messages.push(first.message, user("Runtime.getRuntime() is java.lang.Runtime, not JAVA.LANG.RUNTIME"));
  const next = await bernard.run(context);
  assert.equal(next.message.stopReason, "stop", next.message.errorMessage);
  assert.equal(bernard.runs()[1].body.parentMessageId, "reply-1");
  assert.equal(bernard.runs()[1].body.message, "[USER]\nRuntime.getRuntime() is Runtime, not RUNTIME");
});
