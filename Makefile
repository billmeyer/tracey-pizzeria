SHELL := /bin/bash

# `make` with no target prints the target list. That is the first thing an
# attendee runs, so keep `help` first and keep its text honest.
.DEFAULT_GOAL := help

# Load the repo's .env so every target sees ANTHROPIC_API_KEY, DD_API_KEY,
# DD_SITE and DD_RUM_APPLICATION_ID.
#
# This is load-bearing in the Instruqt layout: the services run as five
# separate `make` invocations in five separate terminals, and a shell `export`
# in terminal 1 would never reach terminals 2-5. Loading the file inside make
# means each terminal picks the values up independently, with no per-terminal
# setup step to forget. Nothing else loads this file — make is the only entry
# point to the stack.
#
# `-include` (leading dash) so a missing .env is not a fatal error — `make`,
# `make help` and `make install` all work before Chapter 01 creates it.
# Values must not contain `#`; make would read it as a comment.
-include .env
export

.PHONY: help install install-backend install-frontend install-inventory install-kitchen \
	run-otel-collector run-backend run-frontend run-inventory-service run-kitchen-service

help:
	@echo "Targets:"
	@echo "  make install                Install dependencies for all four services"
	@echo ""
	@echo "Run these in five separate terminals, in this order:"
	@echo "  make run-otel-collector     1. OTel Collector, OTLP/HTTP on 4318 (requires docker)"
	@echo "  make run-inventory-service  2. inventory-service on PORT 4001"
	@echo "  make run-kitchen-service    3. kitchen-service on PORT 4002"
	@echo "  make run-backend            4. backend on PORT 4000"
	@echo "  make run-frontend           5. frontend dev server (vite) on PORT 5173"
	@echo ""
	@echo "Then open http://localhost:5173 in the browser."

install: install-backend install-frontend install-inventory install-kitchen

install-backend:
	cd backend && npm install

install-frontend:
	cd frontend && npm install

install-inventory:
	cd inventory-service && npm install

install-kitchen:
	cd kitchen-service && npm install

# The OTel Collector has no native binary target here; run it via Docker
# using the same config the other services expect to send data to. This is
# the only target that needs Docker at all.
#
# The config check is not defensive padding. `docker run -v` against a host
# path that does not exist makes the daemon create a *directory* there — so a
# missing collector-config.yaml would silently leave a directory of that name
# sitting in the repo, and the real file could then never be written. At
# workshop/start the config is deliberately absent (it is the Chapter 03
# asset), so this is the expected path on day one, not an edge case.
run-otel-collector:
	@test -f collector-config.yaml || { \
		echo ""; \
		echo "  collector-config.yaml not found."; \
		echo ""; \
		echo "  That is expected before Chapter 03 — the Collector config is"; \
		echo "  supplied as a workshop asset. Add it to the repo root, then"; \
		echo "  run this target again."; \
		echo ""; \
		exit 1; \
	}
	docker run --rm -it \
		-p 4318:4318 \
		-v $(CURDIR)/collector-config.yaml:/etc/otelcol/config.yaml:ro \
		-e DD_API_KEY=$${DD_API_KEY} \
		-e DD_SITE=$${DD_SITE} \
		otel/opentelemetry-collector-contrib:latest \
		--config=/etc/otelcol/config.yaml

# OTEL_LOG_LEVEL=error on the three Node targets: without it the SDK swallows
# export failures entirely — a dead Collector produces *no* output at all,
# which is the single most confusing state a telemetry lab can be in. At
# `error` the terminal stays quiet while things work and prints the
# ECONNREFUSED when they don't. Verified: at the default level a failing
# export logs nothing, even with traffic flowing.
# OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true is a deliberate
# *lab* setting, not a default worth copying. It puts the full prompt and
# completion on every LLM span, which is the whole point of Chapter 05 — and in
# production is how customer PII, pasted credentials and your system prompt
# end up in a vendor's index for the retention period. The conventions default
# it off; claude.ts also defaults it off when unset. It is on here because
# exactly one person decided so, once, in a file everyone can read.
run-backend:
	cd backend && \
	PORT=4000 \
	OTEL_SERVICE_NAME=tracey-backend \
	OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
	OTEL_LOG_LEVEL=error \
	OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true \
	ANTHROPIC_API_KEY=$${ANTHROPIC_API_KEY} \
	INVENTORY_URL=http://localhost:4001 \
	KITCHEN_URL=http://localhost:4002 \
	npm run dev

run-inventory-service:
	cd inventory-service && \
	PORT=4001 \
	OTEL_SERVICE_NAME=tracey-inventory \
	OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
	OTEL_LOG_LEVEL=error \
	npm run dev

run-kitchen-service:
	cd kitchen-service && \
	PORT=4002 \
	OTEL_SERVICE_NAME=tracey-kitchen \
	OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
	OTEL_LOG_LEVEL=error \
	npm run dev

# --strictPort so a port clash fails loudly instead of silently starting on
# 5174. The page's origin has to stay http://localhost:5173: it is baked into
# the lab guide, and it has to match the Collector's cors.allowed_origins or
# every browser OTLP export fails preflight — which reads as a broken lab
# rather than a port collision.
run-frontend:
	cd frontend && \
	VITE_DD_RUM_APPLICATION_ID=$${DD_RUM_APPLICATION_ID} \
	VITE_DD_SITE=$${DD_SITE} \
	VITE_OTEL_COLLECTOR_URL=http://localhost:4318 \
	VITE_OTEL_SERVICE_NAME=tracey-frontend \
	npm run dev -- --port 5173 --strictPort
