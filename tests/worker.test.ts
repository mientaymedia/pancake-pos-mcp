/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("Worker fetch handler", () => {
  it("returns health check on /health", async () => {
    const res = await SELF.fetch("http://localhost/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("ok");
  });

  it("returns 404 on unknown paths", async () => {
    const res = await SELF.fetch("http://localhost/unknown");
    expect(res.status).toBe(404);
  });

  it("keeps the conversions receiver disabled until configured", async () => {
    const res = await SELF.fetch("http://localhost/webhooks/pancake/openai-ads", { method: "POST" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ result: "disabled" });
  });

  it("returns CORS headers on OPTIONS preflight", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("MCP endpoint auth", () => {
  it("returns 401 without Bearer token when MCP_AUTH_TOKEN is set", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid Bearer token and processes MCP request", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result?: { serverInfo: { name: string } };
    };
    expect(json.result?.serverInfo.name).toBe("pancake-pos");
  });
});

describe("Multi-client support (C1 fix)", () => {
  it("handles two sequential initialize requests from different clients", async () => {
    const makeInit = (clientName: string) => ({
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: clientName, version: "1.0" },
        },
        id: 1,
      }),
    });

    // Client A initializes
    const resA = await SELF.fetch(
      "http://localhost/mcp",
      makeInit("client-a"),
    );
    expect(resA.status).toBe(200);

    // Client B initializes (must NOT get "Server already initialized")
    const resB = await SELF.fetch(
      "http://localhost/mcp",
      makeInit("client-b"),
    );
    expect(resB.status).toBe(200);
    const jsonB = (await resB.json()) as {
      error?: unknown;
      result?: unknown;
    };
    expect(jsonB.error).toBeUndefined();
    expect(jsonB.result).toBeDefined();
  });
});
