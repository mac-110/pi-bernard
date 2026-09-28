# pi-bernard

Unofficial [Pi](https://github.com/earendil-works/pi) provider for Swisscom's Bernard web service. **Not affiliated with or endorsed by Swisscom.** Requires authorized access to Bernard.

> Bernard's `/v1/agents/run` is **not** an OpenAI-compatible API. This extension translates Pi conversations to Bernard's resource-upload and run/SSE protocols.

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

Model discovery at startup does **not** open the login page: when signed out it shows a fallback model. Sign in and open `/model` to refresh, or restart Pi.

### Without Safari

Provide a valid Bernard JWT in `BERNARD_TOKEN` (for example in the environment launching Pi). This is suitable for non-macOS systems but you must refresh it yourself. Previously stored credentials in Pi's `auth.json` also work; do not put a token in the repository. Avoid passing credentials via shell arguments or committing them to dotfiles.

## Features and limitations

- Fetches available models from Bernard's authenticated `/v1/models` endpoint; `/model` refreshes the list. Includes reasoning-capable models and maps Pi thinking levels onto Bernard's `thinkingMode` (`adaptive` or `low`/`medium`/`high` where supported).
- Streams text and available reasoning events from `/v1/agents/run`. It persists Bernard's server-side `threadId` in the Pi session and sends only the newest user turn after initial synchronization. The same Bernard thread survives Pi restarts/resume. Branch navigation, returning from another provider, system-prompt changes, and successful compaction start a fresh synchronized thread; compaction's own summary request uses a temporary thread.
- Bernard limits each individual run's `message` field to 50,000 characters, but this is no longer the conversation limit: subsequent turns accumulate in the server-side thread up to the selected model's context window. When adopting an already-long Pi session into a new Bernard thread, the one-time synchronization preserves system instructions and newest turns within that transport limit.
- Supports up to five PNG, JPEG, or WebP images on the latest user turn for vision-capable catalog models. Images use Bernard's `/v1/resources` presigned-upload flow and temporary resources are deleted after the response. Historical images are represented by text placeholders rather than uploaded again on every turn.
- Pi's local coding tools cannot be invoked by Bernard. Tool declarations are omitted from the Bernard transcript, but the extension does not globally disable tools, so switching providers keeps the user's tool selection intact. Use a native coding model when local file access is required.
- Reasoning effort can be selected with `/thinking`; `adaptive` and explicit `low`/`medium`/`high` modes are mapped from the live catalog. Bernard does not publish pricing, actual token usage, or output limits. The extension reports zero cost, estimates token counts (so Pi auto-compaction can trigger), and uses an estimated 8192-token output limit.
- The browser automation path is macOS/Safari-only and needs explicit Safari/macOS permission. Token expiry is checked locally and unauthorized requests are retried once after reauthentication.

## Security

Review this extension before use. It runs with the same local privileges as Pi, reads a Bernard token from Safari after you grant automation access, and sends text conversations to the Bernard endpoint. The extension never logs tokens or sends them to a third-party host. No secrets, user profiles, or real browser sessions are included in this repository.

## Development

```sh
pi --no-extensions -e ./extensions/bernard/index.ts --list-models bernard
pi --no-extensions -e ./extensions/bernard/index.ts -p --model bernard/claude-sonnet-4-6 "Say OK"
```

MIT licensed. Community-maintained; endpoint behavior may change.
