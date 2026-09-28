import { z } from "zod";
import { loadConfig } from "../config.js";
import { PancakeHttpClient } from "../api-client/pancake-http-client.js";

export const CONVERSIONS_PATH = "/webhooks/pancake/openai-ads";
const TARGET_SHOP = "430426051";
const MAX_BODY_BYTES = 64 * 1024;
const identifier = z.union([z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), z.number().int().nonnegative().safe()]);
const settingsSchema = z.object({
  OPENAI_ADS_PIXEL_ID: z.string().trim().min(1),
  OPENAI_ADS_CAPI_KEY: z.string().min(1),
  PANCAKE_ADS_WEBHOOK_TOKEN: z.string().min(32),
  OPENAI_ADS_ACTION_SOURCE: z.enum(["web", "offline", "physical_store", "phone_call", "email", "other"]),
  OPENAI_ADS_SITE_URL: z.string().optional(),
  OPENAI_ADS_VALIDATE_ONLY: z.enum(["true", "false"]).default("false"),
  OPENAI_ADS_MATCHING_ENABLED: z.enum(["true", "false"]).default("false"),
});
// Adapter contract, NOT a native Pancake field. An authenticated MineFlow backend
// must join this context to the correct order before forwarding the webhook.
const contextSchema = z.object({
  measurement_allowed: z.boolean(),
  matching_allowed: z.boolean().default(false),
  source_url: z.string().max(4096).optional(),
  oppref: z.string().min(1).max(4096).optional(),
  obref: z.string().min(1).max(4096).refine((value) => value.trim().length > 0).optional(),
  user_agent: z.string().min(1).max(2048).optional(),
  ip_address: z.union([z.ipv4(), z.ipv6()]).optional(),
});
const webhookSchema = z.object({
  event: z.string(),
  shop_id: identifier.optional(),
  data: z.object({ id: identifier, shop_id: identifier.optional() }),
  conversion_context: contextSchema.optional(),
});
const orderSchema = z.object({
  id: identifier,
  shop_id: identifier,
  status: z.number().int(),
  // Fail closed if the upstream cannot positively identify a non-exchange order.
  is_exchange_order: z.boolean(),
  order_currency: z.literal("VND"),
  total_price: z.number().int().safe().positive(),
  status_history: z.array(z.object({ status: z.number().int(), updated_at: z.string() })),
  bill_email: z.string().nullable().optional(),
  bill_phone_number: z.string().nullable().optional(),
});
type Settings = z.infer<typeof settingsSchema>;
type Context = z.infer<typeof contextSchema>;
type Dependencies = {
  loadOrder?: (id: string) => Promise<unknown>;
  send?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

const reply = (status: number, result: string) => Response.json({ result }, { status });

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticated(provided: string, expected: string): Promise<boolean> {
  // Compare equal-length digests without exiting early on individual bytes.
  const a = await sha256(provided);
  const b = await sha256(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new Error("invalid_body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function utcTime(value: string): number {
  // Pancake timestamps without an offset are UTC, not the host's local timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`);
}

function sourceUrl(settings: Settings, context?: Context): string {
  const canonical = new URL(settings.OPENAI_ADS_SITE_URL ?? "");
  if (!["http:", "https:"].includes(canonical.protocol) || canonical.username || canonical.password) throw new Error("invalid_site_url");
  if (context?.source_url) {
    try {
      const provided = new URL(context.source_url);
      if (provided.origin === canonical.origin && !provided.username && !provided.password) return provided.origin + provided.pathname;
    } catch { /* Fall back to the configured canonical conversion URL. */ }
  }
  return canonical.origin + canonical.pathname;
}

async function buildEvent(raw: unknown, id: string, settings: Settings, now: number, context?: Context) {
  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) return null;
  const order = parsed.data;
  if (String(order.id) !== id || String(order.shop_id) !== TARGET_SHOP ||
      order.status !== 3 || order.is_exchange_order) return null;
  const deliveries = order.status_history.filter((entry) => entry.status === 3);
  const times = deliveries.map((entry) => utcTime(entry.updated_at));
  if (!times.length || times.some((time) => !Number.isFinite(time))) return null;
  const timestamp = Math.min(...times);
  if (timestamp < now - 7 * 24 * 60 * 60 * 1000 || timestamp > now + 10 * 60 * 1000) return null;

  const user: Record<string, string[] | string> = {};
  if (settings.OPENAI_ADS_MATCHING_ENABLED === "true" && (settings.OPENAI_ADS_ACTION_SOURCE !== "web" || context?.matching_allowed)) {
    const email = order.bill_email?.trim().toLowerCase();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) user.emails_sha256 = [await sha256(email)];
    // Only accept explicit international format; do not guess a local number's country.
    const phone = order.bill_phone_number?.replace(/[\s().-]/g, "");
    if (phone?.startsWith("+")) {
      const normalized = phone.slice(1).replace(/^0+/, "");
      if (/^[1-9]\d{7,14}$/.test(normalized)) user.phone_numbers_sha256 = [await sha256(normalized)];
    }
    if (context?.obref) user.obref = context.obref;
    if (context?.user_agent) user.user_agent = context.user_agent;
    if (context?.ip_address) user.ip_address = context.ip_address;
  }
  return {
    // Stable event_id for CAPI retry deduplication (wire field is id).
    id: `pancake_${TARGET_SHOP}_${id}_delivered`,
    type: "order_created",
    timestamp_ms: timestamp,
    action_source: settings.OPENAI_ADS_ACTION_SOURCE,
    ...(settings.OPENAI_ADS_ACTION_SOURCE === "web" ? {
      source_url: sourceUrl(settings, context),
      ...(context?.oppref ? { oppref: context.oppref } : {}),
    } : {}),
    opt_out: true,
    ...(Object.keys(user).length ? { user } : {}),
    data: { type: "contents", amount: order.total_price, currency: "VND" },
  };
}

/** Independent webhook receiver: never called in checkout or MCP order mutations. */
export async function handlePancakeConversion(
  req: Request,
  env: Record<string, unknown>,
  dependencies: Dependencies = {},
): Promise<Response> {
  // Keep construction, hashing, configuration and dispatch in one failure boundary.
  try {
    if (env.OPENAI_ADS_ENABLED !== "true") return reply(503, "disabled");
    if (req.method !== "POST") return reply(405, "method_not_allowed");
    const settingsResult = settingsSchema.safeParse(env);
    if (!settingsResult.success || env.PANCAKE_POS_SHOP_ID !== TARGET_SHOP) return reply(503, "not_configured");
    const settings = settingsResult.data;
    if (settings.OPENAI_ADS_ACTION_SOURCE === "web") {
      try { sourceUrl(settings); } catch { return reply(503, "not_configured"); }
    }
    const token = req.headers.get("authorization") ?? "";
    if (!(await authenticated(token, `Bearer ${settings.PANCAKE_ADS_WEBHOOK_TOKEN}`))) return reply(401, "unauthorized");
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply(415, "json_required");
    let body: unknown;
    try { body = await readBody(req); }
    catch { return reply(400, "invalid_body"); }
    const payload = webhookSchema.safeParse(body);
    if (!payload.success) return reply(400, "invalid_payload");
    const { event, data, shop_id, conversion_context: context } = payload.data;
    if ([shop_id, data.shop_id].some((shop) => shop !== undefined && String(shop) !== TARGET_SHOP)) return reply(403, "wrong_shop");
    if (!["order.created", "order.updated", "order.status_changed"].includes(event)) return reply(200, "ignored_event");
    if (settings.OPENAI_ADS_ACTION_SOURCE === "web" && !context) return reply(422, "conversion_context_required");
    if (context && !context.measurement_allowed) return reply(200, "measurement_not_allowed");
    const id = String(data.id);
    const loadOrder = dependencies.loadOrder ?? (async (orderId: string) => {
      const client = new PancakeHttpClient(loadConfig(env), {
        fetchTimeoutMs: 5_000, maxRetries: 1, enableRateLimiter: false,
      });
      const result = await client.get(`orders/${encodeURIComponent(orderId)}`);
      if (!result.success) throw new Error("order_lookup_failed");
      return result.data;
    });
    const conversion = await buildEvent(await loadOrder(id), id, settings, (dependencies.now ?? Date.now)(), context);
    if (!conversion) return reply(200, "ineligible_order");
    const response = await (dependencies.send ?? fetch)(
      `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(settings.OPENAI_ADS_PIXEL_ID)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.OPENAI_ADS_CAPI_KEY}` },
        body: JSON.stringify({
          integration_source: "mientaymedia_pancake_pos",
          validate_only: settings.OPENAI_ADS_VALIDATE_ONLY === "true",
          events: [conversion],
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    // Do not log upstream payloads, response bodies, credentials or customer data.
    if (!response.ok) return reply(502, "conversion_failed");
    return reply(200, settings.OPENAI_ADS_VALIDATE_ONLY === "true" ? "validated" : "sent");
  } catch {
    return reply(502, "conversion_failed");
  }
}
