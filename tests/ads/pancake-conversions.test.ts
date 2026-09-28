import { describe, it, expect, vi } from "vitest";
import { handlePancakeConversion } from "../../src/server/pancake-conversions.js";

const now = Date.parse("2026-09-28T09:00:00Z");
const env = {
  PANCAKE_POS_SHOP_ID: "430426051",
  OPENAI_ADS_ENABLED: "true",
  OPENAI_ADS_PIXEL_ID: "test-pixel",
  OPENAI_ADS_CAPI_KEY: "example",
  PANCAKE_ADS_WEBHOOK_TOKEN: "test-only-webhook-token-32-characters",
  OPENAI_ADS_ACTION_SOURCE: "other",
};
const order = {
  id: 42, shop_id: 430426051, status: 3, is_exchange_order: false,
  order_currency: "VND", total_price: 398000,
  status_history: [{ status: 0, updated_at: "2026-09-20T01:00:00" }, { status: 3, updated_at: "2026-09-28T08:00:00" }],
  bill_email: " Buyer@Example.com ", bill_phone_number: "+84 919-000-000",
};
function request(body: unknown = { event: "order.updated", data: { id: 42 } }, token = env.PANCAKE_ADS_WEBHOOK_TOKEN) {
  return new Request("https://example.com/webhooks/pancake/openai-ads", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
function deps(value: unknown = order) {
  const loadOrder = vi.fn(async () => value);
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  return { loadOrder, send, now: () => now };
}

describe("Pancake delivered-order conversions", () => {
  it("sends the delivery time, VND amount, fixed event ID, and no raw personal data", async () => {
    const d = deps();
    const response = await handlePancakeConversion(request(), env, d);
    expect(response.status).toBe(200);
    expect(d.loadOrder).toHaveBeenCalledWith("42");
    const [url, init] = (d.send.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe("https://bzr.openai.com/v1/events?pid=test-pixel");
    const payload = JSON.parse(String(init.body));
    expect(payload.validate_only).toBe(false);
    expect(payload.events).toEqual([{
      id: "pancake_430426051_42_delivered", type: "order_created",
      timestamp_ms: Date.parse("2026-09-28T08:00:00Z"), action_source: "other", opt_out: true,
      data: { type: "contents", amount: 398000, currency: "VND" },
    }]);
    expect(String(init.body)).not.toContain("Buyer");
  });

  it("uses the same deduplication key and first delivery time on repeated updates", async () => {
    const d = deps({ ...order, status_history: [...order.status_history, { status: 3, updated_at: "2026-09-28T08:30:00Z" }] });
    await handlePancakeConversion(request(), env, d);
    await handlePancakeConversion(request(), env, d);
    const events = (d.send.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => JSON.parse(String(init.body)).events[0]);
    expect(events[0]).toEqual(events[1]);
    expect(events[0].timestamp_ms).toBe(Date.parse("2026-09-28T08:00:00Z"));
  });

  it.each([
    { status: 0 }, { status: 4 }, { status: 5 }, { status: 16 },
    { is_exchange_order: true }, { is_exchange_order: undefined },
    { shop_id: 100995649 }, { id: 43 }, { total_price: 0 }, { total_price: 1.2 },
    { order_currency: "USD" }, { status_history: [] },
    { status_history: [{ status: 3, updated_at: "2026-09-10T00:00:00" }] },
    { status_history: [{ status: 3, updated_at: "2026-09-29T00:00:00" }] },
    { status_history: [{ status: 3, updated_at: "invalid" }] },
  ])("does not send ineligible or incomplete orders: %j", async (change) => {
    const d = deps({ ...order, ...change });
    const response = await handlePancakeConversion(request(), env, d);
    expect(await response.json()).toEqual({ result: "ineligible_order" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("fails closed when disabled, wrong shop, bad token, or missing required config", async () => {
    const d = deps();
    expect((await handlePancakeConversion(request(), {}, d)).status).toBe(503);
    expect((await handlePancakeConversion(request(), { ...env, PANCAKE_POS_SHOP_ID: "999" }, d)).status).toBe(503);
    expect((await handlePancakeConversion(request(undefined, "wrong"), env, d)).status).toBe(401);
    expect((await handlePancakeConversion(request(), { ...env, OPENAI_ADS_PIXEL_ID: "" }, d)).status).toBe(503);
    expect((await handlePancakeConversion(request(), { ...env, OPENAI_ADS_ACTION_SOURCE: "web" }, d)).status).toBe(503);
    expect(d.loadOrder).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("rejects mismatched payload shops and malformed/oversized bodies", async () => {
    const d = deps();
    expect((await handlePancakeConversion(request({ event: "order.updated", data: { id: 42, shop_id: 999 } }), env, d)).status).toBe(403);
    expect((await handlePancakeConversion(request({ event: "order.updated", data: { id: "../42" } }), env, d)).status).toBe(400);
    expect((await handlePancakeConversion(request({ text: "x".repeat(70000) }), env, d)).status).toBe(400);
    expect(d.loadOrder).not.toHaveBeenCalled();
  });

  it("does not trust webhook order values or use the webhook sender IP/cookies", async () => {
    const d = deps({ ...order, status: 4 });
    await handlePancakeConversion(request({ event: "order.updated", data: { ...order, total_price: 999999 } }), env, d);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("contains lookup and network failures and returns a retryable response", async () => {
    const d = deps();
    d.loadOrder.mockRejectedValueOnce(new Error("sensitive upstream detail"));
    expect(await (await handlePancakeConversion(request(), env, d)).json()).toEqual({ result: "conversion_failed" });
    d.send.mockRejectedValueOnce(new Error("sensitive network detail"));
    expect((await handlePancakeConversion(request(), env, d)).status).toBe(502);
    d.send.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await handlePancakeConversion(request(), env, d)).status).toBe(502);
  });

  it("sends only hashed matching data when explicitly enabled; validates without saving when requested", async () => {
    const d = deps();
    const response = await handlePancakeConversion(request(), { ...env, OPENAI_ADS_MATCHING_ENABLED: "true", OPENAI_ADS_VALIDATE_ONLY: "true" }, d);
    expect(await response.json()).toEqual({ result: "validated" });
    const payload = JSON.parse(String((d.send.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(payload.validate_only).toBe(true);
    expect(payload.events[0].user.emails_sha256[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.events[0].user.phone_numbers_sha256[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain("example.com");
    expect(JSON.stringify(payload)).not.toContain("919000000");
  });

  it("requires web context and consent, preserves opaque attribution, strips query/fragment", async () => {
    const d = deps();
    const web = { ...env, OPENAI_ADS_ACTION_SOURCE: "web", OPENAI_ADS_SITE_URL: "https://shop.example.com/confirmation?secret=1" };
    expect((await handlePancakeConversion(request(), web, d)).status).toBe(422);
    const context = { measurement_allowed: true, source_url: "https://shop.example.com/checkout?email=private#secret", oppref: "opaque%2Fref+unchanged" };
    await handlePancakeConversion(request({ event: "order.updated", data: { id: 42 }, conversion_context: { ...context, measurement_allowed: false } }), web, d);
    expect(d.send).not.toHaveBeenCalled();
    await handlePancakeConversion(request({ event: "order.updated", data: { id: 42 }, conversion_context: context }), web, d);
    const payload = JSON.parse(String((d.send.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(payload.events[0].source_url).toBe("https://shop.example.com/checkout");
    expect(payload.events[0].oppref).toBe("opaque%2Fref+unchanged");
    expect(payload.events[0].user).toBeUndefined();
  });

  it.each(["https://evil.example/checkout?secret=1", "javascript:alert(1)", "broken", "https://user:pass@shop.example.com/path"])("uses canonical fallback for untrusted source URL %s", async (source) => {
    const d = deps();
    const web = { ...env, OPENAI_ADS_ACTION_SOURCE: "web", OPENAI_ADS_SITE_URL: "https://shop.example.com/confirmation?private=1#private", OPENAI_ADS_MATCHING_ENABLED: "true" };
    await handlePancakeConversion(request({ event: "order.updated", data: { id: 42 }, conversion_context: { measurement_allowed: true, matching_allowed: false, source_url: source } }), web, d);
    const conversion = JSON.parse(String((d.send.mock.calls as unknown as [string, RequestInit][])[0]![1].body)).events[0];
    expect(conversion.source_url).toBe("https://shop.example.com/confirmation");
    expect(conversion.user).toBeUndefined();
  });
});
