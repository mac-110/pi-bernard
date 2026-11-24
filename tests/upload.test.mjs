// The image PUT to Bernard's S3 bucket falls back to a proxy when the host cannot be reached directly.
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { upload } from "./helpers.mjs";

const { putUpload, supportsProxyEnv, unreachableCode, uploadProxy } = upload;
const url = "https://upload.test/res-1?X-Amz-Credential=key&X-Amz-Signature=signature";
const bytes = Buffer.from("image bytes");
const supported = "22.22.0";
const networkError = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
const noPort = async () => assert.fail("must not probe a local proxy");

/** A proxy that records CONNECT requests and refuses every tunnel. */
async function refusingProxy() {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      requests.push(data.toString().split("\r\n")[0]);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("connection errors that mean the host is unreachable are recognized", () => {
  assert.equal(unreachableCode(networkError("ECONNREFUSED")), "ECONNREFUSED");
  assert.equal(unreachableCode(networkError("ENOTFOUND")), "ENOTFOUND");
  assert.equal(unreachableCode(networkError("UND_ERR_CONNECT_TIMEOUT")), "UND_ERR_CONNECT_TIMEOUT");
  const both = new AggregateError([Object.assign(new Error("v6"), { code: "ETIMEDOUT" }), Object.assign(new Error("v4"), { code: "ETIMEDOUT" })]);
  assert.equal(unreachableCode(new TypeError("fetch failed", { cause: both })), "ETIMEDOUT");
  assert.equal(unreachableCode(networkError("ECONNRESET")), undefined);
  assert.equal(unreachableCode(new Error("other")), undefined);
});

test("proxyEnv needs Node 22.21 or 24.5", () => {
  assert.deepEqual(["22.19.0", "22.20.9", "22.21.0", "23.11.0", "24.4.1", "24.5.0", "25.0.0"].map(supportsProxyEnv),
    [false, false, true, false, false, true, true]);
});

test("the proxy is HTTPS_PROXY, otherwise a local proxy on port 3128, otherwise the corporate proxy", async () => {
  assert.equal(await uploadProxy({ env: { HTTPS_PROXY: "http://proxy.example:8080" }, portOpen: noPort }), "http://proxy.example:8080");
  assert.equal(await uploadProxy({ env: { https_proxy: "proxy.example:8080" }, portOpen: noPort }), "http://proxy.example:8080");
  const probed = [];
  const open = (result) => async (host, port) => { probed.push(`${host}:${port}`); return result; };
  assert.equal(await uploadProxy({ env: {}, portOpen: open(true) }), "http://localhost:3128");
  assert.equal(await uploadProxy({ env: {}, portOpen: open(false) }), "http://aproxy.corproot.net:8080");
  assert.deepEqual(probed, ["localhost:3128", "localhost:3128"]);
});

test("an unreachable upload host is retried once through the proxy, ignoring NO_PROXY", async (t) => {
  const proxy = await refusingProxy();
  t.after(proxy.close);
  const direct = [];
  globalThis.fetch = async (input) => { direct.push(String(input)); throw networkError("ECONNREFUSED"); };
  const env = { HTTPS_PROXY: `http://user:secret@127.0.0.1:${proxy.port}`, NO_PROXY: "*" };

  const error = await putUpload(url, "image/png", bytes, undefined, { env, portOpen: noPort, nodeVersion: supported }).then(() => assert.fail("resolved"), (caught) => caught);
  assert.deepEqual(direct, [url]);
  assert.deepEqual(proxy.requests, ["CONNECT upload.test:443 HTTP/1.1"]);
  assert.match(error.message, new RegExp(`^Bernard Bild-Upload: upload\\.test ist direkt nicht erreichbar \\(ECONNREFUSED\\) und über den Proxy 127\\.0\\.0\\.1:${proxy.port} ebenfalls nicht \\(.*502`));
  for (const secret of ["secret", "signature", "X-Amz"]) assert.ok(!error.message.includes(secret), secret);
});

test("HTTP errors, aborts, other network errors, and old Node versions are not retried through a proxy", async () => {
  const options = { env: {}, portOpen: noPort, nodeVersion: supported };
  globalThis.fetch = async () => new Response(null, { status: 403 });
  assert.equal(await putUpload(url, "image/png", bytes, undefined, options), 403);

  globalThis.fetch = async () => { throw networkError("ECONNRESET"); };
  await assert.rejects(putUpload(url, "image/png", bytes, undefined, options), /fetch failed/);

  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => { throw networkError("ECONNREFUSED"); };
  await assert.rejects(putUpload(url, "image/png", bytes, controller.signal, options), /fetch failed/);

  await assert.rejects(putUpload(url, "image/png", bytes, undefined, { ...options, nodeVersion: "22.20.0" }),
    /^Error: Bernard Bild-Upload: upload\.test ist direkt nicht erreichbar \(ECONNREFUSED\)\. Den Umweg über einen Proxy kann Pi erst ab Node 22\.21 oder 24\.5 nehmen, es läuft mit Node 22\.20\.0\.$/);
});
