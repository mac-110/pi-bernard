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
