# CaseCanvas tool bridge

The CaseCanvas fork includes an opt-in internal plugin that registers CaseCanvas tools directly with the OpenCode tool registry. It does not use MCP.

## Configuration

Set both variables on the OpenCode server process:

- `CASECANVAS_TOOL_ENDPOINT`: Base URL for the authenticated internal CaseCanvas tool gateway. The URL must use HTTP or HTTPS.
- `CASECANVAS_TOOL_TOKEN`: Bearer service credential used only between OpenCode and the CaseCanvas gateway.

If neither variable is set, the plugin registers no tools. If only one is set, startup reports a configuration error and skips the plugin.

`CASECANVAS_TOOL_TIMEOUT_MS` optionally sets the request timeout. It must be an integer from 100 through 120000. The default is 15000 milliseconds.

Keep the token in the server environment. Do not put it in an OpenCode project configuration, browser bundle, renderer process, or model context.

## Registered tools

- `casecanvas_search_documents` accepts `query` and an optional `limit` from 1 through 50.
- `casecanvas_read_document` accepts `documentId` and optional `pageStart`, `pageEnd`, and `maxCharacters` fields.

CaseCanvas controls which tools a session may use through OpenCode's per-session tool permissions. The bridge does not globally disable OpenCode's built-in coding tools.

## Request contract

For each invocation, OpenCode sends:

```http
POST {CASECANVAS_TOOL_ENDPOINT}/{toolName}
Authorization: Bearer {CASECANVAS_TOOL_TOKEN}
Content-Type: application/json
```

```json
{
  "sessionId": "ses_...",
  "callId": "call_...",
  "arguments": {}
}
```

The tool name is one of the registered names above. `sessionId` and `callId` come from OpenCode's tool context. The `arguments` object is validated and normalized before transmission.

## Response contract

The gateway must return a successful JSON response with this shape:

```json
{
  "modelContent": "Display-safe content for the model",
  "data": {},
  "sources": [
    {
      "documentId": "document-id",
      "title": "Optional title",
      "page": 1,
      "pageEnd": 2,
      "chunkId": "optional-chunk-id",
      "excerpt": "Optional evidence excerpt"
    }
  ],
  "security": {
    "classification": "safe",
    "promptInjectionStatus": "not_detected"
  },
  "ui": {},
  "retryable": false
}
```

`data`, `sources`, `ui`, and `retryable` are optional. `modelContent` and `security` are required. Objects reject undeclared fields.

OpenCode serializes the complete response into the model-visible tool result. It also copies sources, security, and retryability into tool metadata for the CaseCanvas interface.

## Failure contract

Configuration, validation, cancellation, timeout, network, HTTP, and response-validation failures return a stable JSON tool result. The model-facing message starts with `CaseCanvas tool bridge error [CODE]`. Error results use `security.classification` equal to `tool_error` and never include the service token, gateway body, or gateway URL.
