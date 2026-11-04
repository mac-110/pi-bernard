import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { catalog, loadExtension, session } from "./helpers.mjs";

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

test("a token lookup without browser login does not fail a login in progress", async () => {
  const token = jwt(3600);
  const quick = session.bernardToken({ allowBrowserLogin: false });
  const login = session.bernardToken();
  await assert.rejects(quick, /Kein gültiger Bernard-Token/);
  process.env.FAKE_SAFARI_TOKEN = token;
  assert.equal(await login, token);
});

test("one caller aborting does not abort the shared login of the others", async () => {
  const token = jwt(7200);
  process.env.FAKE_SAFARI_TOKEN = "";
  const controller = new AbortController();
  const first = session.bernardToken({ force: true, signal: controller.signal });
  const second = session.bernardToken({ force: true });
  await delay(50);
  controller.abort();
  await assert.rejects(first, /abgebrochen/);
  process.env.FAKE_SAFARI_TOKEN = token;
  assert.equal(await second, token);
});

test("the model list renews a rejected token from Safari", async () => {
  const old = jwt(5400);
  const fresh = jwt(9000);
  process.env.BERNARD_TOKEN = old;
  process.env.FAKE_SAFARI_TOKEN = fresh;
  const bernard = await loadExtension(undefined, {
    onModels: (init) => init.headers.Authorization === `Bearer ${fresh}`
      ? new Response(JSON.stringify({ items: catalog }), { headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 401 }),
  });
  assert.equal(bernard.provider.models.length, catalog.length);
  assert.equal(bernard.requests.filter((request) => request.url.endsWith("/v1/models")).length, 2);
});
