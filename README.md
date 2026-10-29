# Tracey's Pizzeria

Sample application for the *Building End-to-End Observability into AI Applications* workshop. Order a pizza by chatting with Tracey, an LLM-powered order-taker, then walk a four-step checkout funnel. Every step — the chat message, the order-parsing LLM call, the inventory check, the kitchen bake, each status poll — is one correlated trace across RUM, APM, and Agent Observability.

## The checkout funnel (and why it's four documents)

```
/            →  /checkout/     →  /payment/      →  /tracking/
order chat      pickup or         fake card         received → making →
                delivery +        + tip             baking → packaging →
                address                             out_for_delivery →
                                                    delivered
```

The tracking stages diverge at the hand-off (`kitchen/src/index.ts` → `DELIVERY_STAGES` / `PICKUP_STAGES`): a delivery order ends `out_for_delivery → delivered`, a pickup order ends at `ready_for_pickup`. Each stage holds for `STAGE_DURATION_MS` (9s), so a full funnel finishes while you're still talking about it. `frontend/src/lib/order.ts` maps the stage ids to the labels and icons the page shows (`baking` → "In the oven").

Each arrow is a **hard page transition** (`location.assign`), not client-side routing. That is deliberate: a real browser unload/load means every step reports its *own* `browser.navigation_timing`, its *own* Core Web Vitals, and its *own* resource timings. With a SPA router the SDK can only emit a `browser.navigation` marker, and the navigation/vitals numbers stay pinned to the first document forever — so there is nothing per-step to compare.

All four documents are stitched into **one RUM session** by the localStorage-backed session id, so the funnel reads as a single user journey.

Two details make this work, and both are easy to get wrong:

| Concern                                        | Where                              | Why                                                                                                                                                                                                              |
|------------------------------------------------|------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Events emitted just before navigating are lost | `rum/otel-rum.ts` → `flushRum()`   | Both SDKs export on a timer and neither installs a `pagehide` flush, so `traceys.pizzeria.funnel.step_completed` would be discarded with the document. `hardNavigate` awaits a flush *before* `location.assign`. |
| Clicks land on a button's child span           | `App.css` → `pointer-events: none` | `UserActionInstrumentation` reads `data-otel-*` off the **event target**, so a click on an icon arrives with no action name.                                                                                     |

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
   │  spans on span-end, plus gen_ai.* metrics pushed to /v1/metrics every 10s
   │
   ├──► Claude Haiku via Amazon Bedrock:
   │    "chat us.anthropic.claude-haiku-4-5-20251001-v1:0" span (gen_ai.*)
   ├──► tracey-inventory: check_stock span (occasionally out of stock — pineapple, always)
   └──► tracey-kitchen: bake_pizza span (artificial delay — the "slow dependency")
   │
   ▼
OTel Collector → Datadog (APM Traces, RUM Sessions, Agent Observability)
   three pipelines — traces, metrics, logs — all to otlp.$DD_SITE
```

Four Node services plus the Collector. Two ways to run them: five local processes with only the Collector containerised (`make run-*`), or all five in containers (`docker compose up`). Both are supported — see Setup.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `AWS_REGION` — the region to call Bedrock in (no default; the lab uses `us-east-1`)
   - `BEDROCK_MODEL_ID` — *optional.* `backend/src/claude.ts` already defaults to the lab's `us.anthropic.claude-haiku-4-5-20251001-v1:0`; set this only to repoint at a different model
   - `AWS_BEARER_TOKEN_BEDROCK` — the Bedrock API key, and the only credential the stack uses. It expires; see *Reference: Claude via Amazon Bedrock* below. In the Instruqt lab it is already in the VM environment.
   - `DD_API_KEY` / `DD_SITE` — your Datadog org (defaults to `datadoghq.com`)
   - `DD_RUM_APPLICATION_ID` — a RUM application you've created in Datadog (**UX Monitoring > RUM Applications > New Application**, choose "React"). The `Makefile` and `frontend/vite.config.ts` both read it from here, so there is no application id to edit in source.
2. Run everything — **five terminals, one service each**. `make` with no arguments lists the targets:

   | Terminal | Command             |
   |----------|---------------------|
   | 1        | `make run-collector`|
   | 2        | `make run-inventory`|
   | 3        | `make run-kitchen`  |
   | 4        | `make run-backend`  |
   | 5        | `make run-frontend` |

   Start the Collector first so the other four have somewhere to export from their first span. On this path it is the only thing that needs Docker — a single `docker run`. The other four run under `tsx watch` / Vite, so edits reload in the terminal that owns them, and there is nothing to rebuild. The Makefile loads `.env` itself, so every terminal gets the keys with no per-terminal setup.

   **Or run the whole stack in containers** — `docker compose up --build` is a supported alternative to the five terminals; see *Running under Docker Compose* below.

3. Open **http://localhost:5173**, order a pizza, then walk the funnel: confirm the pizza in chat → **Checkout** → pickup or delivery → **Next** → card and tip → **Complete purchase** → watch the tracking page.

4. An org currently needs these two feature flags turned on:

  * `rule_mapper_enable_otel_rum_rum_track_rules`
  * `enable-otlp-intake-rum-routing`

   See [CO-OP OTEL](https://docs.google.com/document/d/1eQOOG9973NB27xxiB9zJcrTWHcx-F20S7gUVXAw_vEQ/edit?tab=t.uzzwxaxegzhx) for more details.

## RUM events this app emits

Auto-instrumented by the browser SDK (see `frontend/src/rum/otel-rum.ts`) — **once per document**, so four times per funnel:

| `event_name`                    | Datadog RUM type |
|---------------------------------|------------------|
| `session.start` / `session.end` | Session          |
| `browser.navigation`            | Page view marker |
| `browser.navigation_timing`     | Resource         |
| `browser.web_vital`             | Core Web Vitals  |
| `browser.resource_timing`       | Resource         |
| `browser.user_action.click`     | Action           |
| `exception`                     | Error            |

Three more auto-instrumentations are registered but don't fit the once-per-document framing: `ConsoleInstrumentation` turns every `console.*` call into a log record, and `FetchInstrumentation` / `XhrInstrumentation` emit a span per request — those are the spans carrying `traceparent` to the backend, so they're what makes the browser→backend trace one trace.

Custom events (see `frontend/src/rum/events.ts`):

All attributes below are `traceys.pizzeria.*`-prefixed in full (`traceys.pizzeria.funnel.step_index`, not `step_index`) — the prefix is dropped here only to keep the table readable.

| `event_name`            | Emitted when                                   | Key attributes (all `traceys.pizzeria.`-prefixed)                                                      |
|-------------------------|------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| `funnel.step_entered`   | `bootstrapPage` runs, as soon as the SDK is up | `funnel.step`, `funnel.step_index`, `funnel.total_steps`                                               |
| `page.entered`          | The page *component* mounts (`usePageEntered`) | `funnel.step`, `page.url`, plus page-specific detail                                                   |
| `funnel.step_completed` | Just before a hard transition                  | `funnel.step`, `funnel.step_index`, `funnel.next_step`, `funnel.step_duration_ms`, `funnel.elapsed_ms` |
| `funnel.completed`      | Pizza handed over                              | `funnel.outcome`, `funnel.total_duration_ms`                                                           |
| `stage_changed`         | Tracking page sees a new stage                 | `stage`, `stage_label`, `stage_index`, `total_stages`, `is_final_stage`                                |
| `exception`             | Validation fails, or any API call fails        | `validation.field` + `validation.rule`, or `exception.type`/`message`/`stacktrace`                     |

`funnel.step_entered` and `page.entered` are deliberately separate: the first fires before React has rendered anything, the second when the component is actually on screen, so the gap between their timestamps is the document's React startup cost.

The `exception` events come from two helpers in `events.ts`. `emitValidationError` covers address and card validation; `emitAppError` covers everything else — a declined card, an unreachable kitchen, any failed fetch — and is called from all four pages. Both deliberately use the `exception` event name and the standard `exception.*` attributes, so they land as real **RUM Errors** rather than info logs nobody will find.

### Attributes on *every* event

`frontend/src/rum/order-context.ts` installs a span processor and a log-record processor that stamp the live order onto every span and log — `traceys.pizzeria.size`, `crust`, `topping_count`, `toppings`, `fulfillment`, `tip_percent`, `subtotal`, `total`, `number`, `stage`, plus `traceys.pizzeria.funnel.step` and `traceys.pizzeria.chaos_mode`.

They are processors rather than resource attributes on purpose: the resource is frozen when the SDK starts, but the order keeps changing *within* a page view (pick delivery, then type a tip). A processor reads the live value at emit time, so a web vital recorded before the tip and a click recorded after it both carry the correct total. The practical payoff is that `browser.navigation_timing` and `browser.web_vital` are faceted by order contents — "is LCP worse on delivery orders" is a group-by, not a guess.

Named actions use `data-otel-*` DOM attributes (via the `namedAction()` helper), which `UserActionInstrumentation` collects and `promoteNamedAction` lifts to `traceys.pizzeria.action.name` — so clicks group as `payment.place_order` rather than `div#root>div>button:nth-of-type(2)`.

### Getting trace ids onto browser log records

This is the subtlest problem in the app, and two files exist solely to solve it — worth reading before Section 2.

A log record gets its `trace_id` / `span_id` from exactly one place: the span active in the `Context` at `emit()` time. The browser SDK installs a **synchronous stack** context manager (no Zone, no `AsyncLocalStorage`), so the active context does not survive an `await`. `FetchInstrumentation` activates its span only for the synchronous body of its wrapper, which means by the time a `catch` block runs the context is back to ROOT. The default outcome is empty trace ids on effectively every RUM log event — clicks, web vitals, funnel events, and every error caught after an `await`.

| File                             | What it does                                                                                                                                                                                                                                                                                                    |
|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `frontend/src/rum/page-trace.ts` | `startPageTrace()` opens a marker span per document, and a log-record processor backfills `spanContext` on any record that doesn't already have one — so everything unparented falls back to the page-view trace.                                                                                               |
| `frontend/src/rum/operation.ts`  | `startOperation()` carries context *explicitly* instead of relying on the ambient stack: it keeps the operation's `Context` in a variable, runs the fetch inside it (so the fetch span is a child), and hands the same `Context` to `emitAppError` so the error lands in the trace whose fetch actually failed. |

The precedence matters: a record emitted inside a real operation keeps its own, more specific trace; everything else gets the page trace. Worth being honest about the trade-off, because it's a good discussion point — the page trace *synthesises* correlation rather than discovering it. A click and a web vital sharing a trace id means "same page view", not "same causal operation". The marker span also ends immediately rather than on `pagehide`: a span held open would carry a real time-on-page duration, but would never export if the tab were closed outright, leaving every log record pointing at a trace that doesn't exist. Guaranteed export beats an accurate duration.

## Chaos mode

Append `?chaos=true` to the frontend URL (`http://localhost:5173/?chaos=true`) to raise the kitchen's failure/latency rate and the inventory's stockout rate, and to make roughly one card in three decline on the payment page. The flag is sticky across the hard transitions (it is mirrored into sessionStorage), since the query param only ever appears on the first document.

Useful for demoing error spans and slow-trace correlation on demand instead of waiting for it to happen naturally. Pineapple is *always* out of stock, chaos mode or not — that one's not a bug.

## Where the workshop exercises live

One file carries an explicit `WORKSHOP EXERCISE` comment block. It's fully implemented here as the reference/instructor build, but the comment marks exactly what to strip out if you want attendees to build that piece live:

| File                        | Exercise                                                                                                                | Section   |
|-----------------------------|-------------------------------------------------------------------------------------------------------------------------|-----------|
| `backend/src/claude.ts:145` | Manual `gen_ai.*` span around the Claude call, OTel API only — delete the body of the `tracer.startActiveSpan` callback | Section 1 |

Section 2 covers browser→backend trace propagation in `frontend/src/rum/otel-rum.ts`, but that file carries **no** `WORKSHOP EXERCISE` marker — the relevant code is `propagateTraceHeaderCorsUrls` on the `FetchInstrumentation` and `XhrInstrumentation` registrations (around lines 366-373), currently set to `[/.*/]`. Narrow or remove that to demonstrate the effect; if you want it marked up like Section 1, the annotation still needs writing.

Everything else (auto-instrumentation, the Collector pipeline, the Inventory/Kitchen services, Agent Observability ingestion) works out of the box and doesn't need to be built live — it's the scaffolding the exercises sit inside.

## Running under Docker Compose

`docker compose up --build` brings up all five services. `compose.yaml` is an alternative to the five-terminal path, not a replacement — both are maintained, and neither needs code changes to switch, because the compose service names (`collector`, `inventory`, `kitchen`, `backend`, `frontend`) are exactly the hostnames the source already falls back to when `OTEL_EXPORTER_OTLP_ENDPOINT` / `INVENTORY_URL` / `KITCHEN_URL` are unset.

Each service builds the `dev` stage of its Dockerfile and bind-mounts `./src`, so edits hot-reload here the same way they do on the host. Only `src/` and the config files are mounted — mounting a service root would shadow the image's `node_modules` with the host's and break the container.

Startup is health-gated rather than merely ordered:

```
collector  (started)
   ├─► inventory ──┐  (healthy: /healthz answers)
   ├─► kitchen ────┤
   └─────────────► backend  (healthy)
                      └─────► frontend
```

The three Node services have healthchecks hitting `/healthz`, and `backend` waits for `inventory` and `kitchen` to pass them, so the first chat message can't race a cold dependency. The probes invoke `node` rather than curl or wget — `node` is the one binary a node image is guaranteed to have. The Collector is gated with `service_started` instead: its image is minimal and may carry no shell for a probe to run, and gating buys little anyway since the OTel SDKs retry exports.

Two environment variables are deliberately asymmetric, and getting them backwards is the most likely way to break this:

| Variable | Value | Why |
|---|---|---|
| `VITE_OTEL_COLLECTOR_URL` | `http://localhost:4318` | Consumed by the **browser**, which resolves it against the host — not the compose network. Pointing it at `http://collector:4318` breaks every browser OTLP export. |
| `VITE_API_PROXY_TARGET` | `http://backend:4000` | Consumed by the Vite dev server **inside** the container, where `localhost` is the frontend itself. |

Ports: `5173` (frontend) and `4318` (Collector, because the browser posts to it directly) are required. `4000` is published only for curling the API. `inventory` and `kitchen` stay internal, matching the architecture diagram — reach them with `docker compose exec`.

Credentials come from the same `.env`, which compose reads automatically. `DD_API_KEY`, `DD_RUM_APPLICATION_ID`, and `AWS_BEARER_TOKEN_BEDROCK` are declared with `:?`, so a missing one fails immediately naming the variable instead of surfacing later as a 401 from the Datadog exporter or a 403 from Bedrock.

## Local dev without Docker

This is the `make` path above, and it is what the workshop runs. Each Node service runs under `tsx watch` and the frontend under Vite's dev server, so everything hot-reloads. The targets set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and the localhost service URLs for you; `vite.config.ts` proxies `/api` to `localhost:4000` so the browser's API calls stay same-origin. Only `make run-collector` needs Docker.

Note the frontend is configured as a Vite **MPA** (`appType: 'mpa'`, four entries in `build.rollupOptions.input`). The dev server therefore has no SPA fallback: a mistyped path 404s instead of silently serving the order page. Always navigate *with* the trailing slash (`/checkout/`, not `/checkout`) to avoid a redirect hop before the page load.

## Reference: OTel GenAI semantic conventions used

Span name follows the convention's `{gen_ai.operation.name} {gen_ai.request.model}` pattern — `chat us.anthropic.claude-haiku-4-5-20251001-v1:0`. Attributes set in `backend/src/claude.ts`:

- Request: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens`
- Response: `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`
- Usage: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- Content (conditional, see below): `gen_ai.input.messages`, `gen_ai.output.messages`
- Errors: `error.type` — from the *stable* `@opentelemetry/semantic-conventions` entry point, while every `gen_ai.*` constant above comes from the `/incubating` entry point, because those conventions are still experimental.

Two metrics on the `tracey.llm` meter, both histograms: `gen_ai.client.token.usage` (recorded twice per call, split by `gen_ai.token.type` = `input` / `output`) and `gen_ai.client.operation.duration` (seconds). These push to `/v1/metrics` every 10s — a separate OTLP endpoint, which is why `collector-config.yaml` carries a separate `metrics` pipeline.

These are the exact attributes Datadog Agent Observability ingests natively — no Datadog SDK anywhere in `backend/`, `inventory/`, or `kitchen/`.

`gen_ai.provider.name` is `aws.bedrock`, not `anthropic` — see the Bedrock section below. The constant appears twice in `claude.ts` (once on the span, once in the `common` object shared by both metric instruments) and the two must agree, or a metric time series and a span filter disagree on provider and the cross-signal correlation the workshop demonstrates quietly breaks.

### Reference: Claude via Amazon Bedrock

The backend reaches Claude through Bedrock, so there is no Anthropic API key anywhere in the stack. Three consequences worth knowing before the lab:

| Concern | Detail |
|---|---|
| Client | `AnthropicBedrock` from `@anthropic-ai/bedrock-sdk` — the `bedrock-runtime` (InvokeModel) client, chosen because it accepts the `us.anthropic.…-v1:0` cross-region inference profile ids the lab provisions. Its `.messages.create()` surface is identical to the first-party client's, which is why `callClaude` is otherwise unchanged. |
| Model id | `us.anthropic.claude-haiku-4-5-20251001-v1:0` — provider prefix, version suffix, and a leading `us.` marking a cross-region inference profile. The first-party `claude-haiku-4-5-20251001` 404s here. Read from `BEDROCK_MODEL_ID`. |
| Credentials | `AWS_BEARER_TOKEN_BEDROCK` — a Bedrock API key, sent as a bearer token, and the only credential the stack uses. It is presigned and **time-limited**, so a long session can see it expire: Bedrock answers 403 and `/api/chat` 500s. The span still carries `error.type`, so the trace shows the failure, but the cause is credential expiry rather than anything about the request. If chat breaks partway through a lab, mint a fresh token before debugging the call. |

Bedrock also drops several first-party features — automatic prompt caching, Batches, Files, the Models API, web search, and task budgets. This app uses none of them. Tool use, which the whole chat flow depends on, is supported.

### ⚠️ Prompt and completion content is captured

`make run-backend` sets `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, which puts the full prompt and completion on every LLM span as `gen_ai.input.messages` / `gen_ai.output.messages`. That is the point of the content exercise, and it is a deliberate **lab** setting — not a default worth copying. In production it is how customer PII, pasted credentials and your system prompt end up in a vendor's index for the retention period. The OTel conventions default it off, and `claude.ts` also defaults it off when the variable is unset.
