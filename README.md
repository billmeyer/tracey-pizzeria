# Tracey's Pizzeria

Sample application for the *Building End-to-End Observability into AI Applications* workshop. Order a pizza by chatting with Tracey, an LLM-powered order-taker, then walk a four-step checkout funnel. Every step — the chat message, the order-parsing LLM call, the inventory check, the kitchen bake, each status poll — is one correlated trace across RUM, APM, and Agent Observability.

## The checkout funnel (and why it's four documents)

```
/            →  /checkout/     →  /payment/      →  /tracking/
order chat      pickup or         fake card         made → baked →
                delivery +        + tip             packaged → out for
                address                             delivery → delivered
```

Each arrow is a **hard page transition** (`location.assign`), not client-side routing. That is deliberate: a real browser unload/load means every step reports its *own* `browser.navigation_timing`, its *own* Core Web Vitals, and its *own* resource timings. With a SPA router the SDK can only emit a `browser.navigation` marker, and the navigation/vitals numbers stay pinned to the first document forever — so there is nothing per-step to compare.

All four documents are stitched into **one RUM session** by the localStorage-backed session id, so the funnel reads as a single user journey.

Two details make this work, and both are easy to get wrong:

| Concern | Where | Why |
|---|---|---|
| Events emitted just before navigating are lost | `rum/otel-rum.ts` → `flushRum()` | Both SDKs export on a timer and neither installs a `pagehide` flush, so `traceys.pizzeria.funnel.step_completed` would be discarded with the document. `hardNavigate` awaits a flush *before* `location.assign`. |
| Clicks land on a button's child span | `App.css` → `pointer-events: none` | `UserActionInstrumentation` reads `data-otel-*` off the **event target**, so a click on an icon arrives with no action name. |

## Architecture

```
Browser (React MPA + OTel browser SDK, tracecontext propagator)
   │  4 documents, hard transitions, one RUM session
   │  /api/* proxied to the backend same-origin by Vite's dev server
   │
   ├──► OTLP logs + spans POSTed straight to localhost:4318 (the Collector's
   │    published port — no proxy, hence the CORS block in its config)
   ▼
Backend: tracey-backend (Node/Express + OTel SDK)
   │
   ├──► Claude Haiku call: "chat claude-haiku-4-5-20251001" span (gen_ai.*)
   ├──► tracey-inventory: check_stock span (occasionally out of stock — pineapple, always)
   └──► tracey-kitchen: bake_pizza span (artificial delay — the "slow dependency")
   │
   ▼
OTel Collector → Datadog (APM Traces, RUM Sessions, Agent Observability)
```

Four Node services plus the Collector. Only the Collector runs in a container — the rest run as local processes, one per terminal (see Setup).

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `DD_API_KEY` / `DD_SITE` — your Datadog org (defaults to `datadoghq.com`)
   - `DD_RUM_APPLICATION_ID` — a RUM application you've created in Datadog (**UX Monitoring > RUM Applications > New Application**, choose "React"). The `Makefile` and `frontend/vite.config.ts` both read it from here, so there is no application id to edit in source.
2. Run everything — **five terminals, one service each**. `make` with no arguments lists the targets:

   | Terminal | Command |
   |---|---|
   | 1 | `make run-otel-collector` |
   | 2 | `make run-inventory-service` |
   | 3 | `make run-kitchen-service` |
   | 4 | `make run-backend` |
   | 5 | `make run-frontend` |

   Start the Collector first so the other four have somewhere to export from their first span. It is the only thing that needs Docker — a single `docker run`, no Compose. The other four run under `tsx watch` / Vite, so edits reload in the terminal that owns them, and there is nothing to rebuild. The Makefile loads `.env` itself, so every terminal gets the keys with no per-terminal setup.

3. Open **http://localhost:5173**, order a pizza, then walk the funnel: confirm the pizza in chat → **Checkout** → pickup or delivery → **Next** → card and tip → **Complete purchase** → watch the tracking page.

4. An org currently needs these two feature flags turned on:

  * `rule_mapper_enable_otel_rum_rum_track_rules`
  * `enable-otlp-intake-rum-routing`

   See [CO-OP OTEL](https://docs.google.com/document/d/1eQOOG9973NB27xxiB9zJcrTWHcx-F20S7gUVXAw_vEQ/edit?tab=t.uzzwxaxegzhx) for more details.

## RUM events this app emits

Auto-instrumented by the browser SDK (see `frontend/src/rum/otel-rum.ts`) — **once per document**, so four times per funnel:

| `event_name` | Datadog RUM type |
|---|---|
| `session.start` / `session.end` | Session |
| `browser.navigation` | Page view marker |
| `browser.navigation_timing` | Resource |
| `browser.web_vital` | Core Web Vitals |
| `browser.resource_timing` | Resource |
| `browser.user_action.click` | Action |
| `exception` | Error |

Custom events (see `frontend/src/rum/events.ts`):

| `event_name` | Emitted when | Key attributes |
|---|---|---|
| `traceys.pizzeria.funnel.step_entered` | Each document loads | `traceys.pizzeria.funnel.step`, `step_index` |
| `traceys.pizzeria.funnel.step_completed` | Just before a hard transition | `step_duration_ms`, `elapsed_ms`, `next_step` |
| `traceys.pizzeria.funnel.completed` | Pizza handed over | `traceys.pizzeria.funnel.outcome`, `total_duration_ms` |
| `traceys.pizzeria.stage_changed` | Tracking page sees a new stage | `traceys.pizzeria.stage`, `stage_index` |
| `exception` | Address/card validation fails, or a card is declined | `traceys.pizzeria.validation.field`, `traceys.pizzeria.validation.rule` |

Validation failures deliberately use the `exception` event name and the standard `exception.*` attributes, so they land as real **RUM Errors** rather than info logs nobody will find.

### Attributes on *every* event

`frontend/src/rum/order-context.ts` installs a span processor and a log-record processor that stamp the live order onto every span and log — `traceys.pizzeria.size`, `crust`, `topping_count`, `toppings`, `fulfillment`, `tip_percent`, `subtotal`, `total`, `number`, `stage`, plus `traceys.pizzeria.funnel.step` and `traceys.pizzeria.chaos_mode`.

They are processors rather than resource attributes on purpose: the resource is frozen when the SDK starts, but the order keeps changing *within* a page view (pick delivery, then type a tip). A processor reads the live value at emit time, so a web vital recorded before the tip and a click recorded after it both carry the correct total. The practical payoff is that `browser.navigation_timing` and `browser.web_vital` are faceted by order contents — "is LCP worse on delivery orders" is a group-by, not a guess.

Named actions use `data-otel-*` DOM attributes (via the `namedAction()` helper), which `UserActionInstrumentation` collects and `promoteNamedAction` lifts to `traceys.pizzeria.action.name` — so clicks group as `payment.place_order` rather than `div#root>div>button:nth-of-type(2)`.

## Chaos mode

Append `?chaos=true` to the frontend URL (`http://localhost:5173/?chaos=true`) to raise the kitchen's failure/latency rate and the inventory's stockout rate, and to make roughly one card in three decline on the payment page. The flag is sticky across the hard transitions (it is mirrored into sessionStorage), since the query param only ever appears on the first document.

Useful for demoing error spans and slow-trace correlation on demand instead of waiting for it to happen naturally. Pineapple is *always* out of stock, chaos mode or not — that one's not a bug.

## Where the workshop exercises live

Two files are explicitly annotated with `WORKSHOP EXERCISE` comment blocks — they're fully implemented here as the reference/instructor build, but the comments mark exactly what to strip out if you want attendees to build that piece live:

| File | Exercise | Section |
|---|---|---|
| `backend/src/claude.ts` | Manual `gen_ai.*` span around the Claude call, OTel API only | Section 1 |
| `frontend/src/rum/otel-rum.ts` | `propagateTraceHeaderCorsUrls` with the `tracecontext` propagator | Section 2 |

Everything else (auto-instrumentation, the Collector pipeline, the Inventory/ Kitchen services, Agent Observability ingestion) works out of the box and doesn't need to be built live — it's the scaffolding the exercises sit inside.

## Local dev without Docker

This is the `make` path above, and it is what the workshop runs. Each Node service runs under `tsx watch` and the frontend under Vite's dev server, so everything hot-reloads. The targets set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and the localhost service URLs for you; `vite.config.ts` proxies `/api` to `localhost:4000` so the browser's API calls stay same-origin. Only `make run-otel-collector` needs Docker.

Note the frontend is configured as a Vite **MPA** (`appType: 'mpa'`, four entries in `build.rollupOptions.input`). The dev server therefore has no SPA fallback: a mistyped path 404s instead of silently serving the order page. Always navigate *with* the trailing slash (`/checkout/`, not `/checkout`) to avoid a redirect hop before the page load.

## Reference: OTel GenAI semantic conventions used

- `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.response.finish_reasons`, `gen_ai.response.model`

These are the exact attributes Datadog Agent Observability ingests natively — no Datadog SDK anywhere in `backend/`, `inventory-service/`, or `kitchen-service/`.

## Reference: Datadog RUM with OpenTelemetry Integration Guide

https://docs.google.com/document/d/1eQOOG9973NB27xxiB9zJcrTWHcx-F20S7gUVXAw_vEQ/edit?tab=t.crjfpnx16m1w#heading=h.pbt6p2gvaz46
