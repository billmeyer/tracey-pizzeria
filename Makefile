SHELL := /bin/bash

# `make` with no target prints the target list. That is the first thing an
# attendee runs, so keep `help` first and keep its text honest.
.DEFAULT_GOAL := help

# Load the repo's .env so every target sees the AWS Bedrock settings
# (AWS_REGION, AWS_BEARER_TOKEN_BEDROCK, BEDROCK_MODEL_ID), DD_API_KEY,
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
	check-collector-config run-stack \
	run-collector run-backend run-frontend run-inventory run-kitchen

help:
	@echo "Targets:"
	@echo "  make install                Install dependencies for all four services (in parallel)"
	@echo ""
	@echo "Run these in five separate terminals, in this order:"
	@echo "  make run-collector          1. OTel Collector, OTLP/HTTP on 4318 (requires docker)"
	@echo "  make run-inventory          2. inventory on PORT 4001"
	@echo "  make run-kitchen            3. kitchen on PORT 4002"
	@echo "  make run-backend            4. backend on PORT 4000"
	@echo "  make run-frontend           5. frontend dev server (vite) on PORT 5173"
	@echo ""
	@echo "Or run the whole stack in containers instead, from one terminal:"
	@echo "  make run-stack              all five services, dependencies ordered for you"
	@echo ""
	@echo "Then open http://localhost:5173 in the browser."

# The four installs are independent, so `make install` fans them out rather
# than running them end to end. It does that by re-entering make with -j4
# instead of declaring the four targets as prerequisites: that way the
# parallelism belongs to this one target, attendees never have to remember
# `make -j4 install`, and the run-* targets stay sequential.
#
# --output-sync=target keeps each service's npm output in one contiguous block
# instead of four interleaved streams — the difference between a readable
# install and noise. It arrived in GNU Make 4.0, and macOS still ships 3.81,
# where an unknown flag is a hard error; hence the version guard rather than
# passing it unconditionally. On 3.81 the installs still run in parallel, the
# output is just interleaved.
MAKE_MAJOR_VERSION := $(firstword $(subst ., ,$(MAKE_VERSION)))
OUTPUT_SYNC := $(if $(filter-out 3,$(MAKE_MAJOR_VERSION)),--output-sync=target)

install:
	$(MAKE) $(OUTPUT_SYNC) -j4 install-backend install-frontend install-inventory install-kitchen

install-backend:
	cd backend && npm install

install-frontend:
	cd frontend && npm install

install-inventory:
	cd inventory && npm install

install-kitchen:
	cd kitchen && npm install

# Shared by run-collector and run-stack, because both bind-mount
# collector-config.yaml and both hit the same hazard if it is missing.
#
# The check is not defensive padding. A bind mount against a host path that
# does not exist makes the daemon create a *directory* there — so a missing
# collector-config.yaml would silently leave a directory of that name sitting
# in the repo, and the real file could then never be written. At workshop
# start the config is deliberately absent (it is the Chapter 03 asset), so
# this is the expected path on day one, not an edge case.
check-collector-config:
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

# Containerised alternative to the five run-* targets: compose brings up all
# five services with the dependency ordering declared in compose.yaml.
#
# --build rather than a bare `up` so an edited Dockerfile or a changed
# package.json is picked up instead of silently reusing a stale image. The
# source itself is bind-mounted and hot-reloads, so a code edit alone does not
# need a rebuild.
run-stack: check-collector-config
	docker compose up --build

# The OTel Collector has no native binary target here; run it via Docker
# using the same config the other services expect to send data to. On the
# five-terminal path this is the only target that needs Docker.
run-collector: check-collector-config
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
	AWS_REGION=$${AWS_REGION} \
	AWS_BEARER_TOKEN_BEDROCK=$${AWS_BEARER_TOKEN_BEDROCK} \
	BEDROCK_MODEL_ID=$${BEDROCK_MODEL_ID} \
	INVENTORY_URL=http://localhost:4001 \
	KITCHEN_URL=http://localhost:4002 \
	npm run dev

run-inventory:
	cd inventory && \
	PORT=4001 \
	OTEL_SERVICE_NAME=tracey-inventory \
	OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
	OTEL_LOG_LEVEL=error \
	npm run dev

run-kitchen:
	cd kitchen && \
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
	npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
