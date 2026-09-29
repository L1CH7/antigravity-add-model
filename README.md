# Antigravity Custom Model Enabler

This repository adds external AI models to the **Google Antigravity** standalone desktop agent. Manage providers and Google account pools in Settings, route requests through a local translation proxy, and optionally connect to an authenticated gateway with a web dashboard, fallback routing, request history, and usage estimates.

> **Compatibility:** This patch targets the standalone Electron desktop agent. The separate VS Code-based Antigravity IDE (including macOS 2.1.1) is not supported; the installer now detects it before changing files. See [compatibility and recovery](docs/compatibility.md).

The installer preserves the installed desktop runtime, including the WSL bridge
and certificate handling introduced in newer releases such as 2.17.0. It adds
custom-model hooks instead of replacing the vendor's main process and preload
with older copies. Custom-model routing currently applies to local sessions;
WSL sessions retain their original vendor routing.

## Start using the new features

1. Follow [Installation](#installation), then open the standalone app's **Settings → Models & Usage** (called **Models** in older versions).
2. In **Custom Models**, choose **Add model**, select a provider, enter your endpoint/key and model ID, then save. **Discover models** lists models exposed by the configured provider; **Discover local** checks common local server ports only when clicked.
3. Search models or use the provider groups to enable/disable them together. Each model supports edit, duplicate, connection test, and delete. Disabled models stay saved and disappear from the custom-model picker.
4. Open **Advanced settings** for API format, reasoning effort, thinking budget, output/context limits, timeouts, retries, fallback model names, custom headers/body fields, raw endpoint paths, image support, and circuit-breaker settings.
5. Use **Import** for JSON or base64-encoded JSON configurations. **Export** removes stored API keys, custom headers, access/refresh tokens, and OAuth client secrets; enter credentials again on the receiving machine.

Provider model listing verifies authentication and advertised model IDs; it does not generate a paid completion. Model IDs, protocol support, and access depend on the provider. Use discovery instead of assuming the examples below are still available.

### Optional gateway and web dashboard

The desktop addon works without the gateway. To add provider-priority routing, history, replay, charts, estimated costs, context compaction, and a remote endpoint, install the separate gateway with Node.js **22.13 or newer**:

```sh
npm run gateway:install
npm run gateway:build
npm run gateway -- setup --non-interactive
npm run gateway -- start
```

Setup prints your gateway token and dashboard login locally. Open `http://127.0.0.1:51001`, sign in, configure provider credentials and model aliases, then save. In the desktop **Remote gateway** dialog, enter:

| Setting | Local value |
| --- | --- |
| Gateway URL | `http://127.0.0.1:51000` |
| Gateway token | Token printed by setup |
| Dashboard URL | `http://127.0.0.1:51001` |

Choose **Test connection**, then **Import model aliases**. Imported models appear in the desktop picker and route through the gateway. **Open dashboard** uses the saved dashboard URL. Settings changes in the web dashboard take effect after saving; listener address/port changes require a restart.

```sh
npm run gateway -- status
npm run gateway -- logs
npm run gateway -- stop
```

For another computer, an SSH tunnel can forward both ports while keeping the gateway bound to loopback:

```sh
ssh -N -L 51000:127.0.0.1:51000 -L 51001:127.0.0.1:51001 user@gateway-host
```

Use the same local URLs in the desktop dialog. Explicit network listeners are also supported with `AG_GATEWAY_REMOTE=true` and `AG_GATEWAY_HOST`; see the [gateway setup, remote access, and data guide](gateway/README.md). Remote provider routing is supported; changing the desktop's WSL language-server routing is a separate compatibility boundary.

### Google Cloud Code account pools

Choose **Google Cloud Code account pool** when you want a custom model to use multiple Google accounts that you own or are authorized to use. Enter the Cloud Code model ID and, when required, its Google project. This is separate from the application's existing vendor-managed sign-in.

1. Create your own Google OAuth client with application type **Desktop app**, configure its consent/test users, and enter its client ID and optional client secret in **Google accounts**. The implementation follows Google's [installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app), with PKCE and a temporary loopback callback.
2. Click **Sign in with Google** to open the browser. Sign-in never starts merely by opening Settings or importing a file. You can cancel it from the dialog.
3. Save the model within **10 minutes** after sign-in. Until then, the main process holds credentials only in a temporary in-memory entry and the renderer receives masked fields. An expired unsaved login must be repeated.
4. Alternatively, use **Import account credentials** for your own `authorized_user` JSON, an account object, or an account array. Importing alone makes no network requests. Save the model to encrypt the imported credentials.
5. Use **Test account** to refresh authorization and retrieve the available quota snapshot. **Pool status** shows current account state. Select round robin, least loaded, or remaining quota, and configure per-account concurrency and cooldown.

Access tokens refresh as needed. Account selection can retain a conversation's eligible account, skips disabled/unavailable accounts, and applies authentication/rate-limit cooldown behavior. Remaining-quota selection uses the latest retrieved quota snapshot; quota refresh is explicit. Successful OAuth sign-in does not grant Cloud Code service entitlement, model access, or additional quota. Google may require an eligible account/project or reject a location; this patch does not change those decisions. No third-party OAuth client credentials are bundled.

### Diagnostics and recovery

```sh
npm run doctor
npm run doctor -- --json
npm run doctor -- --resources "/path/to/Antigravity/Resources"
npm run patch:check -- --resources "/path/to/Antigravity/Resources"
```

Doctor checks the built addon, saved model schema/fallback references, and local proxy/gateway health without changing files. With `--resources`, it also runs the installer compatibility preflight. The local proxy exposes `/health` and aggregate request/retry/fallback/circuit counters at `/metrics` on its selected loopback port.

To repair a supported installation, close Antigravity and use `npm run doctor:repair -- --resources PATH` (add `--patch-language-server` only for the recognized Windows binary). To undo this installer's changes, use `npm run patch:restore -- --resources PATH`. Both actions use the existing transactional installer and its version-specific backup. See [compatibility and recovery](docs/compatibility.md) and the [source-based feature comparison](docs/feature-parity.md).

## How It Works

### Architecture

```
Antigravity standalone desktop agent
  └── Language Server (Go binary)
        └── --api_server_url → http://127.0.0.1:50999 (local proxy)
                                  ├── Google models → daily-cloudcode-pa.googleapis.com
                                  └── Custom models → external API (Together, OpenAI, etc.)
```

### Key Components

#### Proxy Core
| File | Role |
|---|---|
| [proxy.ts](src/proxy.ts) | Local HTTP proxy: intercepts Cloud Code API, merges custom models, translates provider formats, wraps responses |
| [registry.ts](src/proxy/registry.ts) | Dispatches explicit OpenAI, Anthropic, and Google wire formats independently of provider branding |
| [shared.ts](src/proxy/shared.ts) | Cross-turn state management with automatic TTL cleanup |
| [modelUtils.ts](src/proxy/modelUtils.ts) | Centralized model capability detection (thinking, DeepSeek, Claude) |

#### Format Translators
| File | Role |
|---|---|
| [openai.ts](src/proxy/translators/openai.ts) | OpenAI ↔ Gemini format translation (request, response, streaming chunks, tool calls) |
| [anthropic.ts](src/proxy/translators/anthropic.ts) | Anthropic ↔ Gemini format translation (Claude tool_use, SSE streaming, thinking support) |
| [google.ts](src/proxy/translators/google.ts) | Google AI Studio passthrough with streaming endpoint routing |
| [ollama.ts](src/proxy/translators/ollama.ts) | Ollama ↔ Gemini format translation (OpenAI-compatible local LLMs) |
| [utils.ts](src/proxy/translators/utils.ts) | Shared translator utilities (tool call mapping, DSML parsing, parameter type fixing) |

#### Security & Data
| File | Role |
|---|---|
| [cryptoStore.ts](src/cryptoStore.ts) | OS-backed secret encryption, with authenticated local AES-256-GCM fallback |
| [modelStore.ts](src/modelStore.ts) | Atomic model edits/imports, masked credential preservation, redacted exports |
| [googleOAuth.ts](src/googleOAuth.ts), [googleAccounts.ts](src/googleAccounts.ts) | Explicit browser sign-in, token refresh, quota snapshots, account-pool selection |
| [schemaValidator.ts](src/schemaValidator.ts) | Runtime schema validation for API responses, custom models, and streaming chunks |

#### UI & App Integration
| File | Role |
|---|---|
| [customPreload.ts](src/customPreload.ts) | Custom Models dashboard, appended to the vendor preload without replacing its APIs |
| [desktop.ts](src/desktop.ts) | Scoped local model-list routing, endpoint protection, and load-error diagnostics |
| [customIpc.ts](src/customIpc.ts) | Custom model CRUD and connectivity test handlers, alongside vendor IPC |
| [runtime-patch.mjs](scripts/runtime-patch.mjs) | Validates and adds startup, language-server endpoint, and preload hooks to the installed runtime |

#### Deployment Scripts
| File | Platform |
|---|---|
| [deploy.ps1](deploy.ps1) | Windows — preflight, transactional ASAR deployment and restore |
| [deploy.sh](deploy.sh) | macOS — standalone ASAR deployment; rejects the separate IDE layout |
| [deploy_linux.sh](deploy_linux.sh) | Linux — auto-detects installation path across standard Electron app directories |
| [repack.ps1](repack.ps1) | Compatibility wrapper for the same transactional installer |

> [!NOTE]
> The codebase was migrated from JavaScript (`dist/`) to **TypeScript** (`src/`) in v2.0.3. Sources compile to `dist/` via `npx tsc`. The installer copies only custom-model modules into `app.asar/dist/modelPatch`; legacy desktop shell sources are retained for reference and are not deployed over vendor files.

### Cloud Code API Reverse Engineering

Antigravity uses Google's **Cloud Code internal API** (`v1internal:*` endpoints) instead of the public Gemini API. The proxy handles these differences:

1. **fetchAvailableModels**: Intercepts and injects custom model definitions. Custom model slugs are added to `agentModelSorts` so they appear in the chat model dropdown. Quota info is omitted for custom models since they use the user's own API key.

2. **streamGenerateContent/generateContent**: Cloud Code wraps the Gemini request inside a `request` field:
   ```json
   {
     "project": "...",
     "requestId": "...",
     "request": { "contents": [...], "systemInstruction": {...}, "generationConfig": {...} },
     "model": "custom-deepseek-ai-deepseek-v4-pro"
   }
   ```
   The proxy extracts `request` before format translation.

3. **systemInstruction**: Cloud Code sends model identity/tool definitions in a separate `systemInstruction` field (not inside `contents`). The proxy maps this to OpenAI's `role: "system"` or Anthropic's `system` parameter.

4. **Response envelope**: Cloud Code wraps responses in `{"response": {...}, "traceId": "...", "metadata": {}}`. The proxy mirrors this format so the IDE accepts the response.

### Request/Response Flow

```
1. User selects custom model and sends message
2. IDE → POST /v1internal:streamGenerateContent?alt=sse → local proxy
3. Proxy detects custom model match (by slug or hash-based MODEL_PLACEHOLDER_* ID)
4. Extracts reqJson.request → maps systemInstruction + contents to provider format
5. POST to external API (e.g. https://api.together.xyz/v1/chat/completions)
6. Maps external response back to Gemini format
7. Wraps in Cloud Code envelope {"response": {...}, "traceId": "", "metadata": {}}
8. Returns SSE: data: {envelope}\n\n → IDE displays response
```

### Streaming Fix (Critical)

The proxy differentiates between **metadata requests** (which need buffering for URL rewriting) and **generation requests** (which must be streamed directly). If the proxy buffers `streamGenerateContent` or `generateContent` responses, the Go language server times out waiting for the stream to end, causing the app to crash with "terminated due to error."

- **Metadata requests** (`v1internal:*` excluding generation): Buffered, decompressed, URL-rewritten to point back to local proxy
- **Generation requests** (`streamGenerateContent`, `generateContent`): Piped directly without buffering, preserving real-time streaming

### SetCloudCodeURL Blocking

The Antigravity frontend periodically attempts to call `SetCloudCodeURL` which would override the local proxy endpoint with the default Google API URL. The `desktop.ts` addon cancels this RPC only on the active local language-server origin while the custom-model proxy is running. Other origins and WSL sessions keep their normal routing.

### DSML Tool Call Parser

DeepSeek models (and some other providers) return tool calls in a custom **DSML** (DeepSeek Markup Language) format embedded in text content:

```xml
<DSML|invoke name="search_web">
  <DSML|parameter name="query" string="true">latest news</DSML|parameter>
</DSML|invoke>
```

The proxy automatically detects DSML blocks, parses them into Gemini-format `functionCall` objects, and strips the XML from the displayed text. Native OpenAI `tool_calls` and Anthropic `tool_use` blocks are also supported.

### Anthropic Tool Calling

Claude models (`anthropic` provider) return tool calls as `tool_use` content blocks. The proxy maps these to Gemini-format `functionCall` parts, sets `finishReason: "TOOL_CALL"`, and stores tool call IDs for later matching with `functionResponse` objects in subsequent turns. Both streaming (SSE `content_block_start`/`content_block_delta`) and non-streaming responses are fully handled.

### Desktop credential storage

Desktop API keys, custom header values, gateway tokens, and Google access/refresh tokens and client secrets are encrypted before persistence. Electron `safeStorage` is used when available. Otherwise, AES-256-GCM uses a generated local key at `~/.gemini/antigravity/.model-credentials-key`; retain that key with any private local backup. Decryption failures require re-entering credentials, not silently sending encrypted text upstream.

Saved secrets are returned to the Settings UI as `********`. Editing or duplicating a model preserves an unchanged masked credential on the main-process side. Export removes API keys, all custom headers, and Google tokens/client secrets rather than exporting their ciphertext. Legacy plaintext and old base64-fallback secrets are migrated when loaded/saved through the addon.

The optional gateway uses its own local profile and credential configuration; it does not use Electron `safeStorage`. Its history deliberately stores prompts, responses, and tool arguments. See [gateway data handling](gateway/README.md#lifecycle-and-data).

### Dynamic Port Management

The local proxy uses **dynamic port allocation** with automatic fallback:

```typescript
// proxy.ts → startProxy()
server.listen(50999, ...);  // Try default port
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    server.listen(0, ...);  // Fallback: let OS pick a free port
  }
});
```

For an unpatched language-server binary, an occupied port `50999` triggers fallback to an available port. The validated language-server hook waits for the listener and passes its actual port through the endpoint arguments. The optional Windows binary patch requires port `50999`; its archive marker disables fallback, and a port conflict stops startup with an actionable error.

### Parallel Request Isolation

Multiple models can now make simultaneous requests without cross-contamination. Previously, global variables like `lastToolCallIds` and `lastReasoningContent` could be overwritten by concurrent requests from different models. These have been migrated to **per-model `Map` structures**:

- `modelToolCallIds` (`Map<modelName, { fnName: toolCallId }>`) keeps tool call ID tracking scoped per model
- `modelReasoningContent` (`Map<modelName, string>`) keeps DeepSeek reasoning state scoped per model
- `activeStreamContexts` (`Map<streamId, context>`) keeps streaming accumulator scoped per stream

### Automatic State Cleanup

Proxy state is automatically cleaned up via a managed garbage collection interval:
- **Stream contexts**: TTL 10 minutes
- **Tool call IDs & reasoning**: TTL 30 minutes
- Interval starts with `startProxy()` and stops with `stopProxy()`, preventing orphaned timers

### Schema Validation

The `schemaValidator.ts` module provides runtime validation to catch malformed API responses before they reach the IDE frontend, preventing cryptic errors. Exported validators include:

| Function | Validates |
|---|---|
| `validateCandidate` | Individual Gemini candidate structure |
| `validateGenerateContentResponse` | Full Gemini response payload |
| `validateCloudCodeEnvelope` | Cloud Code `{ response, traceId, metadata }` wrapper |
| `validateCustomModel` | Single custom model config (provider enum, URL format) |
| `validateCustomModels` | Array of custom model configs |
| `validateGenerateContentRequest` | Request body structure |
| `validateOpenAiChunk` | OpenAI streaming chunk |
| `validateAnthropicEvent` | Anthropic SSE event type |

### Model Connectivity Test

Each ordinary provider model has a **Test connection** action that requests its model-list endpoint with the configured credentials and custom headers. It checks whether the selected model ID is advertised and reports authentication, route, timeout, and TLS errors inline. It does not send a generation request. For a Google Cloud Code account pool, use **Test account** to check account authorization and quota.

### Request Retry & Rate Limiting

The proxy automatically retries failed requests with exponential backoff:

- **Triggers**: Retryable upstream/network failures before any model output is delivered
- **Backoff**: Bounded exponential delays
- **Retry-After**: Respects server-sent `Retry-After` header
- **Configurable**: `maxRetries` field in model config (default: 3)
- **Fallbacks**: Ordered saved model names, with disabled and duplicate entries skipped
- **Circuit breaker**: Configurable failure threshold/cooldown and one recovery probe
- **Streaming**: Idle/empty-stream protection; no retry or model switch after visible output

## Repository Structure

```
antigravity-add-model/
├── src/
│   ├── proxy.ts                   # HTTP proxy + Cloud Code interceptor + format translation
│   ├── proxy/
│   │   ├── registry.ts            # Auto-discovery translator registry
│   │   ├── shared.ts              # Cross-turn state management + TTL cleanup
│   │   ├── modelUtils.ts          # Centralized model capability detection
│   │   └── translators/
│   │       ├── openai.ts          # OpenAI ↔ Gemini translator
│   │       ├── anthropic.ts       # Anthropic ↔ Gemini translator
│   │       ├── google.ts          # Google AI Studio passthrough + stream routing
│   │       └── utils.ts           # Shared translator utilities (DSML, tool calls)
│   ├── desktop.ts                 # Addon lifecycle and local RPC routing
│   ├── customIpc.ts               # Custom model CRUD + connectivity test IPC
│   ├── customPreload.ts           # UI addon appended to vendor preload
│   ├── languageServer.ts          # Legacy desktop runtime reference
│   ├── ipcHandlers.ts             # Legacy desktop IPC reference
│   ├── cryptoStore.ts             # AES-256-GCM API key encryption/decryption
│   ├── schemaValidator.ts         # Runtime schema validation for responses & models
│   ├── preload.ts                 # Legacy desktop preload reference
│   ├── main.ts                    # Legacy desktop lifecycle reference
│   ├── constants.ts               # Port & cert constants
│   ├── paths.ts                   # Path utilities
│   ├── storage.ts                 # StorageManager class
│   ├── menu.ts                    # Application menu
│   ├── tray.ts                    # System tray
│   ├── updater.ts                 # Auto-updater
│   ├── customScheme.ts            # Plugin scheme handler
│   ├── keybindings.ts             # Keyboard shortcuts
│   ├── loadingOverlay.ts          # Loading screen overlay
│   ├── types.ts                   # Type definitions
│   ├── utils.ts                   # Window management & utilities
│   ├── services/
│   │   └── settingsService.ts
│   ├── ideInstall/                # IDE installation wizard
│   ├── __tests__/                  # Unit tests (vitest)
│   │   ├── registry.test.ts
│   │   ├── proxy.test.ts
│   │   ├── modelUtils.test.ts
│   │   ├── anthropic.test.ts
│   │   ├── openai.test.ts
│   │   └── utils.test.ts
│   ├── __mocks__/                 # Test mocks
├── dist/                          # Compiled JavaScript output
├── tsconfig.json                  # TypeScript configuration
├── deploy.ps1                     # Portable PowerShell deploy script
├── repack.ps1                     # ASAR repack script
├── package.json                   # Electron app manifest
└── README.md
```

## Supported Providers

You can configure **multiple models from different providers simultaneously**. All of them will appear together in the model selection dropdown in the Antigravity chat interface, and you can switch between them in real-time.

<p align="center">
  <img src="assets/chat_model_dropdown.png" alt="Model Selection Dropdown" width="600">
</p>

| Preset family | Default protocol | Credentials |
| --- | --- | --- |
| OpenAI, OpenRouter, DeepSeek, Moonshot/Kimi, Fireworks, Groq, Mistral, Codestral, Cerebras, NVIDIA NIM, xAI | OpenAI chat completions | Provider API key |
| Anthropic, MiniMax, Z.AI | Anthropic messages | Provider API key |
| Google Gemini / AI Studio | Google Gemini | Gemini API key |
| Google Cloud Code account pool | Google Cloud Code | User-owned OAuth accounts |
| OpenCode, OpenCode Zen, OpenCode Go | OpenAI chat completions | Provider API key |
| Ollama, LM Studio, llama.cpp, vLLM, LocalAI, TabbyAPI, Text Generation WebUI, LiteLLM, Aphrodite | OpenAI chat completions | None by default; set a key if your server requires one |
| Wafer / Custom endpoint | Anthropic / OpenAI, editable | Supply your endpoint and any required credential |

The exact defaults are in [providers.ts](src/providers.ts). **API format** explicitly selects `openai`, `anthropic`, or `google`, independently of the preset name. Older saved DeepSeek, Kimi, Fireworks, LM Studio, and llama.cpp entries without `apiFormat` retain their historical Anthropic format; changing the protocol is an explicit edit.

Endpoint paths are normalized for the chosen protocol unless **Endpoint path → Use exactly as entered** is selected. Google endpoints select `generateContent` or `streamGenerateContent` for the request. The gateway has additional provider-specific routing, including OpenCode Responses support; see its [provider guide](gateway/README.md#routing-and-dashboard).

---

## Installation

Requires Node.js **22.12.0 or newer**. Build the tracked TypeScript source before deploying:

```sh
npm ci --ignore-scripts
npm run build
node scripts/deploy.mjs --check
```

Quit the standalone Antigravity app and its language server, then run the wrapper for your platform:

| Platform | Command |
| --- | --- |
| Windows, with the recognized language-server endpoint | `.\deploy.ps1 --patch-language-server` |
| macOS standalone app | `bash deploy.sh` |
| Linux | `bash deploy_linux.sh` |

All wrappers accept `--resources PATH`, `--check`, and `--restore`. A Resources directory,
installation root, or macOS `.app` can be supplied explicitly. For example:

```sh
bash deploy.sh --check --resources "/Applications/Antigravity.app"
bash deploy.sh --resources "/Applications/Antigravity.app"
```

The installer reads the **currently installed archive**, preserves unrelated files, backs up
that version, and validates a new archive before replacing it. Failures roll back the files.
It never restores a stale `app.asar.backup` automatically. Reopen Antigravity manually after
success; the scripts no longer force-kill or relaunch applications.

`repatch.bat --patch-language-server` rebuilds and deploys on Windows, stopping on any error. `repack.ps1` uses the
same installer; packing this repository wholesale over the vendor application is not supported.

### Updates and recovery

After an Antigravity update, rebuild and run `--check` again before deployment. To undo a
deployment, close the app and use:

```sh
node scripts/deploy.mjs --restore --resources "/path/to/Resources"
```

Restore uses this installer's version-specific backup and refuses if upstream application
files changed afterwards. Automatic updates remain enabled.

For recognized standalone Windows language-server binaries that bypass API-server flags,
the fixed-length endpoint patch is explicitly available with `--patch-language-server`.
It requires port 50999 and participates in backup/rollback. It is not an IDE or macOS binary
patch. See [the full compatibility and recovery guide](docs/compatibility.md) for limitations,
the black-screen fix, provider 403/404 diagnostics, and validation coverage.

---

## Configuration

Models are stored in your home directory at `~/.gemini/antigravity/custom_models.json`. Use the Settings editor or Import to validate entries and encrypt credentials. Export is the supported way to share configuration without stored credentials; don't distribute the local file or encryption key.

This example shows the input format for several providers. Replace the illustrative model IDs with IDs returned by your provider, and enter your own keys in the UI:

```json
{
  "models": [
    {
      "name": "models/gpt-4o",
      "displayName": "GPT-4o (OpenAI)",
      "description": "OpenAI GPT-4o model via official API",
      "provider": "openai",
      "apiFormat": "openai",
      "apiKey": "sk-proj-...",
      "apiUrl": "https://api.openai.com/v1/chat/completions",
      "externalModelName": "gpt-4o"
    },
    {
      "name": "models/claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet",
      "description": "Anthropic Claude 3.5 Sonnet via official API",
      "provider": "anthropic",
      "apiFormat": "anthropic",
      "apiKey": "sk-ant-...",
      "apiUrl": "https://api.anthropic.com/v1/messages",
      "externalModelName": "claude-3-5-sonnet-latest"
    },
    {
      "name": "models/gemini-1.5-pro",
      "displayName": "Gemini 1.5 Pro (AI Studio)",
      "description": "Gemini 1.5 Pro via Google AI Studio Key",
      "provider": "google",
      "apiFormat": "google",
      "apiKey": "AIzaSy...",
      "apiUrl": "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
      "externalModelName": "gemini-1.5-pro"
    },
    {
      "name": "models/llama3",
      "displayName": "Llama 3 (Local Ollama)",
      "description": "Local Llama 3 model run on Ollama port 11434",
      "provider": "ollama",
      "apiFormat": "openai",
      "apiKey": "",
      "apiUrl": "http://localhost:11434/v1/chat/completions",
      "externalModelName": "llama3"
    },
    {
      "name": "models/deepseek-ai/deepseek-v4-pro",
      "displayName": "DeepSeek V4 Pro (Together)",
      "description": "DeepSeek V4 Pro via Together API",
      "provider": "custom",
      "apiFormat": "openai",
      "apiKey": "YOUR_TOGETHER_API_KEY",
      "apiUrl": "https://api.together.xyz/v1",
      "externalModelName": "deepseek-ai/DeepSeek-V4-Pro",
      "maxRetries": 3
    }
  ]
}
```

### Fields Explanation

| Field | Description |
|---|---|
| `name` | Internal model identifier (e.g. `models/gpt-4o`). Must start with `models/` prefix. |
| `displayName` | The friendly name that will appear in the Antigravity chat model dropdown. |
| `description` | Subtitle/description displayed in the Custom Models list in Settings. |
| `provider` | Preset ID from [providers.ts](src/providers.ts), including `custom` and `google-cloudcode`. |
| `apiFormat` | `openai`, `anthropic`, or `google`; selects request/response translation independently of the provider name. |
| `enabled` | Defaults to `true`. Disabled models remain saved but are not added to the custom-model picker or fallback chain. |
| `apiKey` | The API credential for the provider. Leave empty `""` for local providers like Ollama. |
| `apiUrl` | The target endpoint. This gets automatically pre-filled by the UI dropdown selection. |
| `externalModelName` | The exact model ID expected by the target provider (e.g., `gpt-4o`, `claude-3-5-sonnet-latest`, `llama3`). |
| `allowUnauthorized` | (Optional) Set to `true` to bypass SSL certificate validation. Useful for internal/self-signed endpoints. Default: `false`. |
| `timeout` | (Optional) Request timeout in milliseconds. Default: `120000` (2 minutes). |
| `maxRetries` | (Optional) Maximum retry attempts for rate-limited/failed requests. Default: `3`. |
| `reasoningEffort` / `thinkingBudget` | Optional effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and token budget. Support depends on the model/protocol. |
| `maxOutputTokens` / `contextWindow` | Optional positive token limits. Context limiting preserves supported tool exchanges; provider hard limits still apply. |
| `fallbackModels` | Ordered array of saved internal model names, such as `["models/backup"]`. |
| `customHeaders` / `extraBody` | Additional string HTTP headers and JSON request fields. Header values are encrypted and omitted from export. Do not put credentials in `extraBody`, which is ordinary exported configuration. |
| `rawUrl` / `supportsVision` | Use the exact configured request URL; override advertised image capability. |
| `circuitBreaker` | Optional `{ "enabled": true, "failureThreshold": 3, "cooldownMs": 30000 }`. |
| `googleAccounts` | Cloud Code accounts with stable `id`, optional `label`/`project`, OAuth credentials, `expiresAt`, and `enabled`. Use the account editor for masked updates. |
| `googlePool` / `googleProject` | Account selection strategy, `maxConcurrency`, `cooldownMs`, and default Cloud Code project. |

## UI Features

### Model editor

**Add model**, **Edit**, and **Duplicate** share a validated form with preset URLs, explicit API formats, an optional display name, and advanced request options. **Fetch provider models** displays a selectable list; select the models you want and add them together. Saved keys stay masked when editing, duplicating, or discovering models from an existing group.

For local endpoints, keys are optional. For Google Cloud Code, the account manager replaces the ordinary API key field. Errors stay in the dialog so you can correct a field without re-entering the rest.

The screenshots below show the earlier UI; the current manager adds grouping, discovery, account pools, and gateway controls.

<p align="center">
  <img src="assets/add_custom_model_modal.png" alt="Add Custom AI Model Modal" width="45%">
  <img src="assets/add_custom_model_provider_dropdown.png" alt="API Provider Selection" width="45%">
</p>

### Custom Models Dashboard

The manager attaches to the modern **Models & Usage** content or the older **Models/MCP** settings layout. Provider/endpoint groups contain searchable model rows, enable/disable controls, edit/duplicate/test/delete actions, and discovery. Import, credential-redacted export, local discovery, and the remote gateway dialog are available from its toolbar.

A debounced `MutationObserver` restores the manager if the vendor replaces the settings pane, including replacements without a URL change. The addon appends its own controls without redefining vendor preload globals.

<p align="center">
  <img src="assets/custom_models_dashboard.png" alt="Custom Models Dashboard" width="800">
</p>

### SSL Bypass (Self-Signed / Internal CAs)

For enterprise environments using self-signed certificates or internal Certificate Authorities (e.g., corporate proxy servers, private API endpoints), add `"allowUnauthorized": true` to your model config:

```json
{
  "name": "models/internal-model",
  "displayName": "Internal LLM (Corporate)",
  "description": "Company-hosted model behind self-signed cert",
  "provider": "custom",
  "apiKey": "...",
  "apiUrl": "https://llm.internal.company.com/v1",
  "externalModelName": "llama3",
  "allowUnauthorized": true
}
```

> [!WARNING]
> When `allowUnauthorized` is enabled, a warning is logged to the console. SSL bypass is **only** applied to the specific model, never globally.

---

## Security Considerations

> [!WARNING]
> **Desktop credential storage**: Saved credentials use OS-backed `safeStorage`, or local AES-256-GCM when OS storage is unavailable. Use redacted Export to share model settings; keep local configuration and `.model-credentials-key` private. Gateway configuration and history use a separate local profile.

> [!CAUTION]
> **SSL Verification**: The `allowUnauthorized: true` option disables TLS certificate validation. Only use this for trusted internal/self-signed endpoints. Enabling it for public API connections exposes you to man-in-the-middle attacks.

### Safe Defaults

- **Timeout**: Custom model API requests have a 120-second default timeout (configurable via `timeout` field). Google proxy requests have 30-60 second timeouts.
- **Body Size Limit**: Request bodies are capped at 10MB to prevent memory exhaustion. Exceeding returns `413 Payload Too Large`.
- **Diagnostics**: The desktop proxy does not write raw response dumps. The optional gateway records request history, which can be deleted in its dashboard.
- **Masked Keys**: Persisted credentials returned to the model editor are shown as `********`.
- **Managed State**: Proxy cleanup interval is properly stopped on shutdown, preventing orphaned timers.

---

## Troubleshooting

### Port Conflict
If port `50999` is in use, the proxy auto-falls back to a random port. Check `~/.gemini/antigravity/active_port`.

### Language Server Crashes
Auto-restarts up to 3 times in 60 seconds. Check logs at:
- **Windows**: `%LOCALAPPDATA%\antigravity\logs\`
- **macOS**: `~/Library/Logs/antigravity/`

### SSL/TLS Errors
1. Ensure the provider's certificate is valid
2. As last resort, add `"allowUnauthorized": true` to model config
3. For internal CAs, install the CA certificate in your system trust store

### Model Not Appearing
1. Verify model name starts with `models/`
2. Check `apiUrl` is correct
3. Restart Antigravity after adding models
4. Use the **Test Connection** button to verify endpoint accessibility

### Connection Timeouts
1. Check if the provider's API is reachable (`curl -I <apiUrl>`)
2. Increase `timeout` field in model config (e.g., `"timeout": 180000` for 3 minutes)
3. Verify network/proxy/VPN settings

### Rate Limiting (429)
The proxy automatically retries up to 3 times with exponential backoff. If you still see rate limit errors:
1. Reduce request frequency
2. Increase `maxRetries` in model config
3. Check your API provider's rate limit dashboard

---

## Developer Guide

### Project Setup

```bash
npm install          # Install dependencies
npx tsc              # Compile TypeScript → dist/
npx tsc --watch      # Watch mode for development
```

### Adding a New Provider

1. Create `src/proxy/translators/<provider>.ts` with these exports:
   - `mapGeminiTo<Provider>(geminiBody, modelName)` → provider-format request
   - `map<Provider>ToGemini(providerRes, modelName)` → Gemini-format response
   - `map<Provider>ChunkToGemini(chunk, modelName)` → streaming chunk handler
2. Register a new wire format in `registry.ts` and validation only if existing formats cannot represent it.
3. Add a provider preset to `src/providers.ts`; the Settings dropdown reads this shared catalog.
4. Extend authentication/discovery if the provider requires a distinct flow.
5. Test non-streaming, split SSE chunks, tool calls, cancellation, and failure behavior with local mock providers.

### TypeScript Architecture

- **Strict mode**: `strict: true` in `tsconfig.json` (target: ES2020, module: CommonJS)
- **Centralized types**: Model capabilities in `modelUtils.ts`, shared state in `shared.ts`
- **No `eval()`**: JSON repair uses `repairPartialJson()` instead of dangerous `eval()` calls
- **No `any` in critical paths**: Request/response mapping uses explicit interfaces

### Debug Mode
```powershell
$env:HEADLESS="1"; .\Antigravity.exe
```

Set `DEBUG=antigravity:*` for verbose logging (debug level captures stream parse fallbacks and wire-level details).

---

## Changelog

### Unreleased — Model management and optional gateway

- Add grouped model editing, duplication, enable/disable, provider/local discovery, JSON/base64 import, and credential-redacted export.
- Add explicit protocols, request overrides, fallback chains, circuit breakers, and aggregate diagnostics.
- Add opt-in Google account sign-in with a user-owned OAuth client, encrypted account storage, token refresh, pool selection, and explicit quota checks.
- Add a separate authenticated gateway with provider-priority routing, web dashboard, SQLite history, replay, pricing estimates, and optional context compaction.
- Add saved remote gateway connections, authenticated alias import, and a read-only Doctor command while retaining vendor runtime hooks and transactional deployment.
- See [feature parity and boundaries](docs/feature-parity.md) for pinned source comparisons and verification limits.

### Unreleased — Antigravity 2.17.0 compatibility
- Reproduced the Windows black screen as `ERR_CERT_AUTHORITY_INVALID` with the old runtime overlay.
- Preserve the installed vendor runtime, including its certificate handling, WSL bridge, updater, and host bridge; add custom-model support through validated hooks.
- Recover recorded overlay installations from verified originals and reject unfamiliar runtime layouts before changing application files.
- Verified local UI startup with the official Windows 2.17.0 executable and language server in an isolated test profile. Authenticated model generation was not tested.

### v2.1.1
- **Critical Fix**: Fixed a startup crash (`a.getState is not a function`) when launching with Antigravity v2.12.2.
- **Architecture**: Removed a hardcoded 500ms page reload during startup that interrupted the Antigravity frontend's state hydration.
- **Compatibility**: Injected missing ContextBridge APIs (`getState`, `showOpenMultipleFolderDialog`, `revealInFilePicker`, `ideAPI`) into `preload.ts` that were introduced in Antigravity v2.12 and are required by the newer frontend renderer.

### v2.1.0
- **TypeScript**: Full migration — all 23 source files converted from JavaScript to TypeScript (`dist/*.js` → `src/*.ts`)
- **New Provider**: OpenRouter support (300+ models via unified API, OpenAI-compatible format)
- **OpenRouter UI**: Provider dropdown, auto-filled URL, connection test, icon & color in Settings modal
- **Dev Experience**: ESLint + Prettier configured with automated `lint`, `format`, `lint:fix` scripts
- **Test Coverage**: Expanded to 137 tests across 6 test files (registry, proxy, modelUtils, translators)
- **Cleanup**: Removed 25+ scratch development artifacts, added `.prettierignore`
- **Architecture**: `ideInstall/` wizard extracted to dedicated TypeScript module

### v2.0.3
- **Architecture**: Extracted Google AI Studio translator to dedicated module
- **Architecture**: Managed proxy state cleanup with proper interval lifecycle
- **New**: Model connectivity test in Settings (green/red status indicator)
- **New**: Automatic request retry with exponential backoff (429/5xx)
- **New**: Configurable `maxRetries` per model
- **Security**: Removed automatic SSL bypass for custom providers
- **Security**: Added 10MB request body size limit (413 on overflow)
- **Security**: Masked CSRF token in console output
- **Security**: Added timeouts to all Google proxy requests (30-60s)
- **Error handling**: Added debug logging to 6 previously-silent catch blocks
- **Error handling**: Proper error propagation in streaming response handlers
- **Fixed**: `deploy.ps1` now uses `$PSScriptRoot` (portable, no hardcoded paths)
- **Documentation**: Updated README with TypeScript architecture, security defaults, troubleshooting
- **Package**: Added `Apache-2.0` license field to `package.json`

### v2.0.2
- **Security**: Replaced `eval()` with safe `repairPartialJson()` (code injection fix)
- **Security**: SSL bypass now only when `allowUnauthorized: true` (not all custom providers)
- **Security**: Removed diagnostic `api_response_raw.json` disk writes
- **Security**: Added 10MB request body size limit
- **Security**: Added 120s configurable API request timeout
- **Error handling**: Added error handlers for streaming and non-streaming API responses
- **Fixed**: `deploy.ps1` hardcoded path to now uses `$PSScriptRoot`
- **Documentation**: Added Security Considerations, Troubleshooting, and Developer Guide

### v2.0.2 (2026-05-24)
- **Critical fix**: Antigravity v2.0.6 update hardcoded `fetchAvailableModels` URL to `daily-cloudcode-pa.googleapis.com`, bypassing the local proxy. Custom models disappeared from the chat dropdown.
- **Binary patch**: The Language Server binary is now automatically patched at build time to replace the hardcoded Google URL with the local proxy URL.
- **URL padding handler**: Added regex-based URL cleanup in the proxy to strip binary patch padding.
- **Model API fallbacks**: Added `GetAvailableModels` redirect, preload network interceptors, and forced page reload for robust model loading across Antigravity versions.

### v2.0.0
- Initial release: multi-provider proxy, API key encryption, streaming, tool calls, custom UI

---

## Contributing

Pull requests welcome. Please ensure:
1. Code follows existing style (JSDoc comments, consistent error handling)
2. New provider translators include both request and response mapping
3. Security-sensitive code avoids `eval`, plaintext key logging, and improper SSL handling
4. TypeScript compiles cleanly: `npx tsc --noEmit`

---

## License

Apache License 2.0. See [LICENSE](LICENSE) for details. Adapted gateway components retain their upstream MIT license and attribution in [gateway/UPSTREAM.md](gateway/UPSTREAM.md) and [gateway/LICENSE.upstream](gateway/LICENSE.upstream).

---

## Developer

**Abdulvahap OGUT**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/abdulvahap-ogut-343992398/)
