# OpenAI Ads conversions — shop 430426051

## Status and scope

First-time, server-only CAPI integration for Bun HTTP and Cloudflare Workers.
No existing OpenAI Ads instrumentation was found. No browser checkout exists in
this repository. This patch is not a live deployment and does not configure
Pancake, MineFlow, or the advertiser's OpenAI account automatically.

The agreed conversion is **delivered**, not order creation: `order_created` is
sent only when the authoritative Pancake order is currently status `3` (Đã nhận),
explicitly has `is_exchange_order: false`, belongs to shop `430426051`, and has a
valid delivery timestamp. Status `16` (payment collected) alone is not delivery.
Cancelled/returned orders and exchanges are excluded at dispatch time. A later
return does not retract an already accepted conversion; no undocumented refund
event is invented.

## Implemented path

`POST /webhooks/pancake/openai-ads` is protected by a dedicated server-only Bearer
token. Each accepted order notification triggers a fresh, shop-scoped read from
Pancake before sending to `https://bzr.openai.com/v1/events?pid=...`.

For MineFlow website orders, use a trusted backend adapter:

1. At website conversion/checkout, capture consent and attribution in MineFlow's
   backend and persist it against the corresponding Pancake shop and order ID.
2. On Pancake delivery updates, join the correct order's stored context and
   current consent state. Forward the envelope below to this receiver.
3. This receiver independently verifies the order, sends the CAPI conversion,
   and returns an explicit result. The webhook token must never reach browsers.

**The MineFlow ingest endpoint supplied by the owner receives data into MineFlow.**
Its sample `operation: create`, `entity_type: customer` payload creates a customer;
it does not deliver conversions to OpenAI. No request was sent to that endpoint,
and its URL/key are intentionally not stored in this repository. Configure a
separate outgoing MineFlow workflow/adapter if that capability exists; it has not
been verified or installed. Do not replace an existing Pancake webhook URL without
first preserving its current integrations. The repository's webhook CRUD tools
differ from the connected Pancake configuration API, so do not use them blindly.

## Adapter contract (not a native MineFlow/Pancake payload)

Send JSON with `Authorization: Bearer <PANCAKE_ADS_WEBHOOK_TOKEN>`:

```json
{
  "event": "order.updated",
  "shop_id": 430426051,
  "data": { "id": 42 },
  "conversion_context": {
    "measurement_allowed": true,
    "matching_allowed": false,
    "source_url": "https://your-store.example/checkout/confirmation",
    "oppref": "original-opaque-value"
  }
}
```

Optional context fields are `obref`, `user_agent`, and `ip_address`. The adapter
must bind context to the correct order and verify consent; booleans are not proof
of consent on their own. Never populate the user's IP or user agent from the
Pancake webhook request. Omit unavailable attribution rather than inventing it.
For `oppref`, prefer the raw server-readable `__oppref` cookie captured at checkout;
never URL-decode, parse, modify, or log it. `obref` is likewise forwarded unchanged.
The browser's cookies will not exist on a later Pancake webhook.

## Configuration

Use `.env` for Bun or encrypted Worker secrets for secret values. Examples contain
blank placeholders, no credentials. Required settings:

| Setting | Value/purpose |
| --- | --- |
| `PANCAKE_POS_SHOP_ID` | `430426051` |
| `PANCAKE_POS_API_KEY` | Existing server-side Pancake credential |
| `OPENAI_ADS_ENABLED` | `true` only when configured and ready to send |
| `OPENAI_ADS_PIXEL_ID` | Pixel ID provisioned in the advertiser's account |
| `OPENAI_ADS_CAPI_KEY` | Server-side CAPI secret provisioned by the owner |
| `PANCAKE_ADS_WEBHOOK_TOKEN` | Separate random secret, at least 32 characters |
| `OPENAI_ADS_ACTION_SOURCE` | `web` for this MineFlow website flow |
| `OPENAI_ADS_SITE_URL` | Actual customer-facing confirmation URL; HTTP(S), no credentials |
| `OPENAI_ADS_VALIDATE_ONLY` | Production default `false`; set `true` only for smoke tests |
| `OPENAI_ADS_MATCHING_ENABLED` | Default `false`; enable only after approved data use |

The endpoint is disabled by default until activation; existing MCP behavior is
unchanged. `web` requires `conversion_context`. Non-web deployments may explicitly
select `offline`, `physical_store`, `phone_call`, `email`, or `other`; do not label
web orders as offline to bypass missing attribution. Mobile app setup is deferred.

## Attribution, consent and data handling

- `source_url` includes only origin and pathname. Accept browser context only
  when its origin matches `OPENAI_ADS_SITE_URL`; otherwise use the configured URL.
  Never trust the receiver's host as the storefront origin. Query strings,
  fragments, userinfo, and non-HTTP(S) URLs are excluded. Fallback can differ from
  a future Pixel event's browser URL; pass the correct conversion page when known.
- Measurement is skipped when `measurement_allowed` is false. For web orders,
  matching additionally requires both `matching_allowed` and the server setting.
- Matching, if enabled, hashes normalized email and explicitly international
  phone numbers using SHA-256. Local phone numbers are skipped; no country guessed.
  Optional original browser `obref`, trusted user IP and user agent can be forwarded.
  Raw contact details, names, addresses, and order notes are never sent or logged.
- `opt_out: true` is applied to all events. No browser Pixel/user-data initialization
  or Pixel consent gate is installed in this backend repository.
- Without stored attribution/matching, event receipt does not demonstrate that
  OpenAI attributed the purchase to an ad. Enabling matching is not a substitute
  for obtaining consent or a guarantee of attribution.

## Delivery, value and deduplication

`id = pancake_430426051_<order-id>_delivered` is stable across retries and updates.
OpenAI deduplicates by Pixel ID, event type and ID; this is downstream deduplication,
not a local delivery ledger. If a future browser integration sends this SAME
delivery conversion, it must reuse this ID and Pixel ID. Do not send a checkout
purchase with the same ID earlier: the first event wins and would defeat the
agreed delivered-only measurement.

Use the first status-3 timestamp in `status_history` (timezone-less Pancake dates
are UTC). Reject missing/invalid times, events older than 7 days, and timestamps
over 10 minutes ahead; do not substitute webhook arrival time. Amount is exactly
Pancake `total_price`, in VND (no multiplication), not COD. It is not asserted to be
settled cash, profit, or a net revenue metric. No item prices are guessed.

The receiver is independent of checkout and MCP mutations. All configuration,
lookup, hashing and dispatch failures are contained. Pancake lookup and CAPI each
have a 5-second timeout, without inline retries. A failed dispatch returns 502;
the outgoing workflow must retry using backoff and the same order/context.
There is no new queue/database. Verify the sender's retry behavior before launch;
otherwise a transient failure may lose an event. The receiver awaits delivery
before acknowledging, which can take roughly 10 seconds for both HTTP operations.

Results: 200 `sent`/`validated`/`ineligible_order`/`ignored_event`/
`measurement_not_allowed`; 400 invalid body/payload; 401 bad token; 403 wrong shop;
405 wrong method; 415 non-JSON; 422 missing web context; 503 disabled/misconfigured;
502 lookup/dispatch failure. Monitor result categories without logging payloads.
Missing order fields fail closed as `ineligible_order`; inspect a redacted actual
payload before rollout. Repository webhook examples are not live schema verification.

## OpenAI account setup

Reference: https://developers.openai.com/ads/api-reference/conversion-setup

The owner must provision the Pixel and CAPI secret in an enabled advertiser
account. This patch does not create/read/print keys. The current docs distinguish
the pixel resource `id` (for event setting `source_ids`) from `pixel_id` (for SDK
initialization and CAPI `pid`). Configure the conversion definition with
`event_type: order_created`, the returned source `id`, and the documented
`attribution_window_days: 30`. Account provisioning uses the Ads API; event
delivery uses the separate CAPI endpoint. The recent Pixel events endpoint is
for browser SDK events, not confirmation of CAPI attribution.

## Event coverage and launch review

New coverage: delivered `order_created`. Existing coverage: none.
Deferred: `page_viewed`, `contents_viewed`, `items_added`, `checkout_started` need
actual MineFlow frontend call sites. `lead_created`, `registration_completed`,
`appointment_scheduled`, `subscription_created`, `trial_started` have no confirmed
success boundaries in this POS backend. App lifecycle events are not applicable.
Do not interpret staff POS product lookups/customer creation as shopper actions.

Before activation: configure actual storefront URL and Pixel ID, provision secrets,
implement/verify the MineFlow context join and outgoing workflow, validate a real
redacted payload, run `validate_only` smoke tests, then switch it off and confirm
receipt/reporting in the advertiser account. No historical bulk backfill is included.

Changed surfaces: `src/server/pancake-conversions.ts`, Bun/Worker route entry points,
both env examples, focused conversion tests and the Worker route test. No package
or lockfile changes are required. Tests use synthetic data and mocked outbound HTTP.

Official references:
- https://developers.openai.com/ads/conversions-api
- https://developers.openai.com/ads/supported-events
- https://developers.openai.com/ads/api-reference/conversion-setup

Before deploying, the advertiser must review privacy, security, consent and data
handling requirements for the implementation and the MineFlow adapter.

## Verification report (2026-09-28)

TypeScript typecheck and 34 focused conversion/Worker tests passed. The initial
secret scan flagged a synthetic test credential and the ambiguous src/ads folder;
the module is now explicitly under src/server and the fixture is a short placeholder.
No real CAPI or MineFlow credentials were added. Dependency installation used the
existing Bun lockfile with scripts disabled; npm's floating resolution conflicted
with existing Cloudflare peer versions, so dependencies were not changed.

Read-only Ads Manager inventory for Tổng kho MLM found Pixel tongkhomlm.com and
Pixel mineflow.vn. Existing event settings are contents_viewed and checkout_started
for tongkhomlm.com, not proof that browser instrumentation is installed or working.
No order_created setting was found. Confirm the actual storefront/Pixel pairing
before activating this adapter; MineFlow as the site manager does not imply that
mineflow.vn is the customer's storefront. No account settings were changed.
