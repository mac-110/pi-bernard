import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { catalog, loadExtension } from "./helpers.mjs";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (offsetSeconds) => `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + offsetSeconds })}.test`;

// Fake osascript/open: the login path must never touch the real Safari.
const bin = mkdtempSync(join(tmpdir(), "pi-bernard-bin-"));
writeFileSync(join(bin, "osascript"), "#!/bin/sh\nprintf '%s' \"$FAKE_SAFARI_TOKEN\"\n");
writeFileSync(join(bin, "open"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "osascript"), 0o755);
chmodSync(join(bin, "open"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
Object.defineProperty(process, "platform", { value: "darwin" });
process.env.BERNARD_TOKEN = jwt(-3600);
process.env.FAKE_SAFARI_TOKEN = "";

/** Extension context whose model registry behaves like Pi's: a forced refresh calls refreshModels with network. */
function context(bernard, model = { provider: "bernard", id: "claude-sonnet-4-6" }) {
  const notes = [];
  const refreshes = [];
  const ctx = {
    hasUI: true,
    model,
    sessionManager: { getBranch: () => [] },
    ui: { notify: (message, level) => notes.push({ message, level }) },
    modelRegistry: {
      refresh: async (options) => {
        refreshes.push(options);
        await bernard.provider.refreshModels({ allowNetwork: options.allowNetwork, force: options.force, signal: options.signal ?? new AbortController().signal });
        return { aborted: false, errors: new Map() };
      },
    },
  };
  return { ctx, notes, refreshes };
}

async function until(condition, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await delay(10);
  }
}

test("startup with expired token signs in and refreshes the model list", async () => {
  const bernard = await loadExtension();
  assert.equal(bernard.provider.models.length, 1, "signed out: fallback model");
  process.env.FAKE_SAFARI_TOKEN = jwt(3600);
  const { ctx, notes, refreshes } = context(bernard);
  for (const handler of bernard.handlers.session_start) handler({ reason: "startup" }, ctx);
  await until(() => notes.some((note) => note.message.includes("Modelle geladen")));
  assert.equal(notes[0].level, "info");
  assert.match(notes[0].message, /Safari-Login/);
  assert.deepEqual({ ...refreshes[0], signal: undefined }, { providers: ["bernard"], force: true, allowNetwork: true, signal: undefined });
  const offline = await bernard.provider.refreshModels({ allowNetwork: false, signal: new AbortController().signal });
  assert.equal(offline.length, catalog.length, "offline refresh keeps the loaded catalog");
});

test("startup with valid token does not open the login", async () => {
  const bernard = await loadExtension();
  assert.equal(bernard.provider.models.length, catalog.length);
  const { ctx, notes, refreshes } = context(bernard);
  for (const handler of bernard.handlers.session_start) handler({ reason: "startup" }, ctx);
  await delay(100);
  assert.deepEqual(notes, []);
  assert.deepEqual(refreshes, []);
});

test("/bernard-login refreshes the model list", async () => {
  const bernard = await loadExtension();
  const { ctx, notes, refreshes } = context(bernard);
  await bernard.commands["bernard-login"].handler("", ctx);
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].force, true);
  assert.deepEqual(notes, [{ message: `Bernard-Sitzung übernommen, ${catalog.length} Modelle geladen.`, level: "info" }]);
});
