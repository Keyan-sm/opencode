import { afterEach, describe, expect, test } from "bun:test"
import type { Hooks, ToolContext, ToolResult } from "@opencode-ai/plugin"
import {
  CASECANVAS_PRODUCT_TOOL_IDS,
  caseCanvasConfiguration,
  createCaseCanvasHooks,
  createCaseCanvasPlugin,
} from "@/plugin/casecanvas"

const servers: Bun.Server<unknown>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("plugin.casecanvas", () => {
  test("installs the Cassius system policy and denies non-CaseCanvas tools", async () => {
    const active = createCaseCanvasHooks({
      endpoint: new URL("https://casecanvas.test/internal/tools"),
      token: "service-secret",
      timeoutMs: 1_000,
    })
    const system = { system: ["Existing product policy."] }
    await active["experimental.chat.system.transform"]?.({ sessionID: "ses_casecanvas" } as never, system)
    expect(system.system).toHaveLength(2)
    expect(system.system[1]).toContain("untrusted evidence")

    await expect(
      active["tool.execute.before"]?.(
        { tool: "casecanvas_read_document", sessionID: "ses_casecanvas", callID: "call_read" },
        { args: { documentId: "doc-1" } },
      ),
    ).resolves.toBeUndefined()
    await expect(
      active["tool.execute.before"]?.(
        { tool: "shell", sessionID: "ses_casecanvas", callID: "call_shell" },
        { args: { command: "whoami" } },
      ),
    ).rejects.toThrow("CaseCanvas denied unavailable tool: shell")

    const allowed: { status: "ask" | "allow" | "deny" } = { status: "ask" }
    await active["permission.ask"]?.({ type: "casecanvas_search_documents" } as never, allowed)
    expect(allowed.status).toBe("allow")
    const denied: { status: "ask" | "allow" | "deny" } = { status: "ask" }
    await active["permission.ask"]?.({ type: "webfetch" } as never, denied)
    expect(denied.status).toBe("deny")
  })

  test("registers tools only when the bridge is configured", async () => {
    expect((await createCaseCanvasPlugin({})({} as never)).tool).toBeUndefined()

    const configured = await createCaseCanvasPlugin({
      CASECANVAS_TOOL_ENDPOINT: "https://casecanvas.test/internal/tools",
      CASECANVAS_TOOL_TOKEN: "service-secret",
    })({} as never)
    const registered = Object.keys(configured.tool ?? {}).sort()
    expect(registered).toEqual([
      "casecanvas_ingestion_status",
      "casecanvas_propose_case_party",
      "casecanvas_propose_schedule_update",
      "casecanvas_read_document",
      "casecanvas_search_documents",
    ])
    expect(registered).toEqual([...CASECANVAS_PRODUCT_TOOL_IDS].sort())
  })

  test("installs a bounded Cassius agent even when local configuration asks for more steps", async () => {
    const active = createCaseCanvasHooks({
      endpoint: new URL("https://casecanvas.test/internal/tools"),
      token: "service-secret",
      timeoutMs: 1_000,
    })
    const config = { agent: { cassius: { maxSteps: 99 } } }
    await active.config?.(config as never)

    expect(config.agent.cassius).toMatchObject({
      description: "CaseCanvas forensic investigation agent",
      mode: "primary",
      maxSteps: 12,
    })
  })

  test("forwards latest and named ingestion-status requests without model-supplied case scope", async () => {
    const received: unknown[] = []
    const server = serve(async (request) => {
      received.push(await request.json())
      return Response.json({
        modelContent: '{"stage":"scanning","completedFiles":2,"totalFiles":5}',
        data: { jobId: "job-1", stage: "scanning", completedFiles: 2, totalFiles: 5 },
        sources: [],
        security: {
          classification: "trusted_application_state",
          promptInjectionStatus: "not_applicable",
        },
      })
    })
    const statusTool = tool(hooks(server, 1_000), "casecanvas_ingestion_status")
    const latest = await statusTool.execute({}, context({ callID: "call-latest-status" }))
    const result = await statusTool.execute({ jobId: "job-1" }, context({ callID: "call-status" }))

    expect(received).toEqual([
      {
        sessionId: "ses_casecanvas",
        callId: "call-latest-status",
        instructionId: "msg_casecanvas",
        arguments: {},
      },
      {
        sessionId: "ses_casecanvas",
        callId: "call-status",
        instructionId: "msg_casecanvas",
        arguments: { jobId: "job-1" },
      },
    ])
    expect(output(latest)).toContain('"completedFiles": 2')
    expect(output(result)).toContain('"completedFiles": 2')
    expect(metadata(result).security).toEqual({
      classification: "trusted_application_state",
      promptInjectionStatus: "not_applicable",
    })
  })

  test("requires the endpoint and token together", () => {
    expect(caseCanvasConfiguration({})).toBeUndefined()
    expect(() => caseCanvasConfiguration({ CASECANVAS_TOOL_ENDPOINT: "https://casecanvas.test/tools" })).toThrow(
      "CASECANVAS_TOOL_ENDPOINT and CASECANVAS_TOOL_TOKEN must be set together",
    )
    expect(() =>
      caseCanvasConfiguration({
        CASECANVAS_TOOL_ENDPOINT: "file:///tmp/tools",
        CASECANVAS_TOOL_TOKEN: "secret",
      }),
    ).toThrow("CASECANVAS_TOOL_ENDPOINT must use http or https")
    expect(() =>
      caseCanvasConfiguration({
        CASECANVAS_TOOL_ENDPOINT: "https://casecanvas.test/tools",
        CASECANVAS_TOOL_TOKEN: "secret",
        CASECANVAS_TOOL_TIMEOUT_MS: "12",
      }),
    ).toThrow("CASECANVAS_TOOL_TIMEOUT_MS must be an integer from 100 through 120000")
  })

  test("forwards a validated search with service authentication and preserves evidence metadata", async () => {
    const received: { path: string; authorization: string | null; body: unknown }[] = []
    const server = serve(async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      })
      return Response.json({
        modelContent: "Two matching documents.",
        data: { matches: [{ documentId: "doc-1" }] },
        sources: [{ documentId: "doc-1", title: "Ledger", page: 4 }],
        security: { classification: "safe", promptInjectionStatus: "not_detected" },
        ui: { openDocumentId: "doc-1" },
        retryable: false,
      })
    })
    const result = await tool(hooks(server, 1_000), "casecanvas_search_documents").execute(
      { query: "  bank account  ", limit: 5 },
      context(),
    )

    expect(received).toEqual([
      {
        path: "/internal/tools/casecanvas_search_documents",
        authorization: "Bearer service-secret",
        body: {
          sessionId: "ses_casecanvas",
          callId: "call_search",
          instructionId: "msg_casecanvas",
          arguments: { query: "bank account", limit: 5 },
        },
      },
    ])
    const parsed = JSON.parse(output(result))
    expect(parsed.sources).toEqual([{ documentId: "doc-1", title: "Ledger", page: 4 }])
    expect(parsed.security).toEqual({ classification: "safe", promptInjectionStatus: "not_detected" })
    expect(metadata(result)).toEqual({
      sources: [{ documentId: "doc-1", title: "Ledger", page: 4 }],
      security: { classification: "safe", promptInjectionStatus: "not_detected" },
      retryable: false,
    })
  })

  test("forwards a validated read to its distinct route", async () => {
    const received: unknown[] = []
    const server = serve(async (request) => {
      received.push(await request.json())
      return Response.json({
        modelContent: "Page four text.",
        sources: [{ documentId: "doc-1", page: 4 }],
        security: { classification: "safe", promptInjectionStatus: "not_detected" },
      })
    })
    const result = await tool(hooks(server, 1_000), "casecanvas_read_document").execute(
      { documentId: "doc-1", pageStart: 4, pageEnd: 4 },
      context(),
    )

    expect(received).toEqual([
      {
        sessionId: "ses_casecanvas",
        callId: "call_search",
        instructionId: "msg_casecanvas",
        arguments: { documentId: "doc-1", pageStart: 4, pageEnd: 4 },
      },
    ])
    expect(JSON.parse(output(result)).modelContent).toBe("Page four text.")
  })

  test("returns proposal authorization metadata without claiming the write was applied", async () => {
    const server = serve(async () =>
      Response.json({
        modelContent: "Awaiting expert approval.",
        data: { pending: true },
        authorization: {
          id: "auth-1",
          actionType: "schedule.populate",
          summary: "Update 1 schedule cell",
          version: 1,
        },
        sources: [],
        security: { classification: "business_proposal", promptInjectionStatus: "not_applicable" },
      }),
    )
    const result = await tool(hooks(server, 1_000), "casecanvas_propose_schedule_update").execute(
      {
        scheduleId: "schedule-1",
        cells: [{ rowKey: "revenue", colKey: "2025", value: "125", aiSourceRef: "doc-1" }],
      },
      context({ callID: "call-proposal" }),
    )

    expect(metadata(result)).toMatchObject({
      authorization: {
        id: "auth-1",
        actionType: "schedule.populate",
        version: 1,
      },
      security: { classification: "business_proposal" },
    })
    expect(output(result)).toContain("Awaiting expert approval")
    expect(output(result)).not.toContain("applied")
  })

  test("forwards a case-party proposal as an authorization without applying it", async () => {
    const received: unknown[] = []
    const server = serve(async (request) => {
      received.push(await request.json())
      return Response.json({
        modelContent: "Adding Northstar Services is awaiting expert approval. The case was not changed.",
        data: { pending: true },
        authorization: {
          id: "auth-party-1",
          actionType: "case.addParty",
          summary: "Add Northstar Services as a case party",
          version: 1,
        },
        sources: [],
        security: { classification: "business_proposal", promptInjectionStatus: "not_applicable" },
      })
    })
    const result = await tool(hooks(server, 1_000), "casecanvas_propose_case_party").execute(
      { party: " Northstar Services " },
      context({ callID: "call-party-proposal" }),
    )

    expect(received).toEqual([
      {
        sessionId: "ses_casecanvas",
        callId: "call-party-proposal",
        instructionId: "msg_casecanvas",
        arguments: { party: "Northstar Services" },
      },
    ])
    expect(metadata(result)).toMatchObject({
      authorization: { id: "auth-party-1", actionType: "case.addParty", version: 1 },
      security: { classification: "business_proposal" },
    })
    expect(output(result)).toContain("case was not changed")
  })

  test("rejects undeclared and inconsistent arguments before making a request", async () => {
    let requests = 0
    const server = serve(() => {
      requests++
      return Response.json({})
    })
    const search = await tool(hooks(server, 1_000), "casecanvas_search_documents").execute(
      { query: "ledger", caseId: "case-from-model" } as never,
      context(),
    )
    const read = await tool(hooks(server, 1_000), "casecanvas_read_document").execute(
      { documentId: "doc-1", pageStart: 9, pageEnd: 2 },
      context(),
    )

    expect(requests).toBe(0)
    expect(output(search)).toContain("CaseCanvas tool bridge error [INVALID_ARGUMENTS]")
    expect(output(read)).toContain("CaseCanvas tool bridge error [INVALID_ARGUMENTS]")
  })

  test("stops a repeated identical tool loop before a fourth gateway call", async () => {
    let requests = 0
    const server = serve(() => {
      requests++
      return Response.json({
        modelContent: "No matches.",
        data: { documents: [] },
        sources: [],
        security: { classification: "untrusted_evidence", promptInjectionStatus: "not_detected" },
      })
    })
    const active = hooks(server, 1_000)
    const results: ToolResult[] = []
    for (let attempt = 1; attempt <= 4; attempt++) {
      results.push(
        await tool(active, "casecanvas_search_documents").execute(
          { query: "same ledger query" },
          context({ callID: `call-repeat-${attempt}`, messageID: "message-repeat" }),
        ),
      )
    }

    expect(requests).toBe(3)
    expect(output(results[3]!)).toContain("CaseCanvas tool bridge error [REPEATED_CALL_LIMIT]")
  })

  test("stops one provider turn before a thirty-third tool call", async () => {
    let requests = 0
    const server = serve(() => {
      requests++
      return Response.json({
        modelContent: "No matches.",
        data: { documents: [] },
        sources: [],
        security: { classification: "untrusted_evidence", promptInjectionStatus: "not_detected" },
      })
    })
    const active = hooks(server, 1_000)
    let last: ToolResult = ""
    for (let attempt = 1; attempt <= 33; attempt++) {
      last = await tool(active, "casecanvas_search_documents").execute(
        { query: `ledger query ${attempt}` },
        context({ callID: `call-budget-${attempt}`, messageID: "message-budget" }),
      )
    }

    expect(requests).toBe(32)
    expect(output(last)).toContain("CaseCanvas tool bridge error [TOOL_CALL_LIMIT]")
  })

  test("withholds evidence that would exceed the per-turn retrieval ceiling", async () => {
    let requests = 0
    const server = serve(() => {
      requests++
      return Response.json({
        modelContent: "Document text.",
        data: { limits: { returnedCharacters: 200_000 } },
        sources: [],
        security: { classification: "untrusted_evidence", promptInjectionStatus: "not_detected" },
      })
    })
    const active = hooks(server, 1_000)
    const results: ToolResult[] = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      results.push(
        await tool(active, "casecanvas_read_document").execute(
          { documentId: `document-${attempt}` },
          context({ callID: `call-retrieval-${attempt}`, messageID: "message-retrieval" }),
        ),
      )
    }

    expect(requests).toBe(3)
    expect(output(results[1]!)).not.toContain("RETRIEVAL_LIMIT")
    expect(output(results[2]!)).toContain("CaseCanvas tool bridge error [RETRIEVAL_LIMIT]")
  })

  test("returns stable errors for missing context, gateway failures, and invalid responses", async () => {
    const invalid = serve(() => Response.json({ modelContent: "missing security" }))
    const unavailable = serve(() => new Response("private failure detail", { status: 503 }))
    const noCall = await tool(hooks(invalid, 1_000), "casecanvas_search_documents").execute(
      { query: "ledger" },
      context({ callID: undefined }),
    )
    const controller = new AbortController()
    controller.abort()
    const cancelled = await tool(hooks(invalid, 1_000), "casecanvas_search_documents").execute(
      { query: "ledger" },
      context({ abort: controller.signal }),
    )
    const invalidResponse = await tool(hooks(invalid, 1_000), "casecanvas_search_documents").execute(
      { query: "ledger" },
      context(),
    )
    const httpError = await tool(hooks(unavailable, 1_000), "casecanvas_search_documents").execute(
      { query: "ledger" },
      context(),
    )

    expect(output(noCall)).toContain("CaseCanvas tool bridge error [INVALID_CONTEXT]")
    expect(output(cancelled)).toContain("CaseCanvas tool bridge error [CANCELLED]")
    expect(output(invalidResponse)).toContain("CaseCanvas tool bridge error [INVALID_RESPONSE]")
    expect(output(httpError)).toContain("CaseCanvas tool bridge error [HTTP_ERROR]")
    expect(output(httpError)).toContain("HTTP 503")
    expect(output(httpError)).not.toContain("private failure detail")
    expect(JSON.parse(output(httpError)).retryable).toBe(true)
  })

  test("bounds gateway requests with a deterministic timeout", async () => {
    const server = serve(async () => {
      await Bun.sleep(250)
      return Response.json({})
    })
    const result = await tool(hooks(server, 100), "casecanvas_search_documents").execute({ query: "ledger" }, context())

    expect(output(result)).toContain(
      "CaseCanvas tool bridge error [TIMEOUT]: The CaseCanvas gateway did not respond within 100 ms.",
    )
    expect(JSON.parse(output(result)).retryable).toBe(true)
  })
})

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return server
}

function hooks(server: Bun.Server<unknown>, timeoutMs: number) {
  return createCaseCanvasHooks({
    endpoint: new URL("internal/tools", server.url),
    token: "service-secret",
    timeoutMs,
  })
}

function tool(hooks: Hooks, name: string) {
  const result = hooks.tool?.[name]
  if (!result) throw new Error(`Missing ${name}`)
  return result
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "ses_casecanvas",
    messageID: "msg_casecanvas",
    callID: "call_search",
    agent: "cassius",
    directory: "/casecanvas",
    worktree: "/casecanvas",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    ...overrides,
  }
}

function output(result: ToolResult) {
  return typeof result === "string" ? result : result.output
}

function metadata(result: ToolResult) {
  if (typeof result === "string") return
  const value = result.metadata?.casecanvas
  if (!value || typeof value !== "object") return
  return value
}
