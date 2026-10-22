# pi-bernard

Unofficial [Pi](https://github.com/earendil-works/pi) provider for Swisscom's Bernard web service. **Not affiliated with or endorsed by Swisscom.** Requires authorized access to Bernard.

> Bernard's `/v1/agents/run` is **not** an OpenAI-compatible API. This extension translates Pi conversations, including Pi's tool calls, to Bernard's resource-upload and run/SSE protocols.

## Install

```sh
pi install git:github.com/mac-110/pi-bernard
```

Restart Pi, then choose a model with `/model` (search for `bernard`). You can also list models with `pi --list-models bernard` and run `pi --model bernard/claude-sonnet-4-6`. Run `pi update git:github.com/mac-110/pi-bernard` to update the extension.

If you already have a manually installed `~/.pi/agent/extensions/bernard/`, remove it before installing the git package; otherwise both copies would register the same provider.

## Sign in

### Safari on macOS

1. In Safari, enable **Settings → Advanced → Show features for web developers**, then **Develop → Allow JavaScript from Apple Events** (exact names depend on Safari version).
2. Permit macOS Automation access for the app running Pi when prompted.
3. Sign in to `https://bernard.swisscom.com/` in Safari. Run `/bernard-login` to import the session immediately.

When the JWT expires, a model request can open Safari, wait up to two minutes for you to sign in, and securely read **only** `bernard.access_token` from a tab at `https://bernard.swisscom.com/`. The token comes from the site's browser storage, **not** the `/v1/me` response. No credentials are read from other sites. The cached token is kept in `~/.pi/agent/bernard-session.json` (file mode `0600`), or under `PI_CODING_AGENT_DIR` if set. Do not commit or share it. If Safari automation is disabled, Pi returns an actionable error instead of silently scraping anything.

At interactive startup, when no valid token is available and a Bernard model is active (or none is selected), Pi opens Safari for sign-in in the background and refreshes the model list as soon as the token has been imported. `/bernard-login` also refreshes the model list. Print and JSON runs never open the login page; when signed out they use a fallback model.

### Without Safari

Provide a valid Bernard JWT in `BERNARD_TOKEN` (for example in the environment launching Pi). This is suitable for non-macOS systems but you must refresh it yourself. Previously stored credentials in Pi's `auth.json` also work; do not put a token in the repository. Avoid passing credentials via shell arguments or committing them to dotfiles.

## Features and limitations

- Fetches available models from Bernard's authenticated `/v1/models` endpoint; `/model` refreshes the list. Includes reasoning-capable models and maps Pi thinking levels onto Bernard's `thinkingMode` (`adaptive` or `low`/`medium`/`high` where supported).
- Streams text and available reasoning events from `/v1/agents/run`. It persists Bernard's server-side `threadId` in the Pi session and, after initial synchronization, sends only what Bernard has not seen yet: new user turns, tool results, and prompt or tool changes. Each run is attached to Bernard's previous reply (`parentMessageId`), which keeps tool loops on one linear thread branch. The same Bernard thread survives Pi restarts/resume. Branch navigation, returning from another provider, a different base system prompt, and successful compaction start a fresh synchronized thread; compaction's own summary request uses a temporary thread.
- Bernard limits each individual run's `message` field to 50,000 characters, but this is no longer the conversation limit: subsequent turns accumulate in the server-side thread up to the selected model's context window. When adopting an already-long Pi session into a new Bernard thread, the one-time synchronization preserves system instructions, tool declarations, and newest turns within that transport limit. Oversized tool results are shortened in the middle with a note, so the model can re-read a smaller range (for example with `read`'s `offset`/`limit`).
- Supports up to five PNG, JPEG, or WebP images per run for vision-capable catalog models, both on user turns and in tool results (for example images opened with `read`). Images use Bernard's `/v1/resources` presigned-upload flow and temporary resources are deleted after the response. Historical images are represented by text placeholders rather than uploaded again on every turn; text-only models get a placeholder instead of tool-result images.
- Reasoning effort can be selected with `/thinking`; `adaptive` and explicit `low`/`medium`/`high` modes are mapped from the live catalog. Bernard does not publish pricing, actual token usage, or output limits. The extension reports zero cost, estimates token counts (so Pi auto-compaction can trigger), and uses an estimated 8192-token output limit.
- The browser automation path is macOS/Safari-only and needs explicit Safari/macOS permission. Token expiry is checked locally and unauthorized requests are retried once after reauthentication.

## Tool use

Pi's active tools (`read`, `bash`, `edit`, `write`, and extension tools) are available with every Bernard model. Bernard's run API has no field for client-side tool definitions or tool results, and its request schema rejects unknown fields, so the extension uses a text protocol inside the same Bernard thread:

1. The first run of a thread tells the model that Pi relays the conversation and declares every active Pi tool with its name, description, and JSON Schema parameters.
2. The model calls a tool by writing a JSON block (`{"name": …, "arguments": …}`) between tags that carry a per-thread nonce, so quoted documentation or file contents cannot trigger a call. Several blocks in one reply become several tool calls in one Pi assistant message.
3. The extension turns completed blocks into regular Pi tool calls while streaming (the reply ends with stop reason `toolUse`). Pi then validates the arguments against the tool's schema and runs the tools exactly as for any other provider, including `tool_call` hooks such as permission extensions.
4. Tool results, including errors, are sent as the next message in the **same Bernard thread**. Tool set changes (for example from `pi.setActiveTools()`) are declared in place with the complete new tool list.

Text written after the last tool call is not shown. If the model starts inventing tool results itself, the extension keeps only the calls written before that point and stops Bernard's generation (`/v1/threads/{id}/stop`). `toolChoice: "none"` requests ask the model not to call tools and do not parse tool calls. Bernard's own cloud features stay off: web search and code mode are disabled for every run, so Pi's local tools do not compete with Bernard's sandbox.

The protocol depends on the model following instructions. Claude Sonnet 4.6, Claude Haiku 4.5, and GPT-5.6 Luna completed multi-step `read`/`write`/`edit`/`bash` tasks in testing; other models may ignore tools, batch dependent calls, or produce invalid arguments. Pi reports invalid arguments back to the model as tool errors.

## Security

Review this extension before use. It runs with the same local privileges as Pi, reads a Bernard token from Safari after you grant automation access, and sends conversations to the Bernard endpoint. The extension never logs tokens or sends them to a third-party host. No secrets, user profiles, or real browser sessions are included in this repository.

With tool use, Bernard models can trigger local actions through Pi's tools with the same permissions as any other Pi model, and tool output (file contents, command output, images) is sent to Bernard and stored in its threads. Restrict tools with `--tools`, `--exclude-tools`, or `--no-tools` where appropriate, and do not let the model read data that must not reach Bernard.

## Development

```sh
pi --no-extensions -e ./extensions/bernard/index.ts --list-models bernard
pi --no-extensions -e ./extensions/bernard/index.ts -p --model bernard/claude-sonnet-4-6 "Say OK"
npm test               # unit and provider tests against a mocked Bernard API
tests/smoke.sh         # installs the package; with BERNARD_TOKEN also runs a real tool call
```

The tests need Node 22 and an installed Pi: they load the TypeScript sources through Pi's bundled `jiti` with the same module aliases as Pi's extension loader (set `PI_PACKAGE_DIR` if `pi` is not on `PATH`). They use a temporary agent directory and a fake token, so they never read your Bernard session or open Safari.

MIT licensed. Community-maintained; endpoint behavior may change.
