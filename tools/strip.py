#!/usr/bin/env python3
"""Apply the workshop strip: comment out exercise blocks, additively.

Every block is commented with a uniform extra '// ' (or '# ') layer over its
whole range, prose included, so that selecting the range and hitting the
IDE's toggle-comment exactly once restores it.
"""
import sys

# (path, comment_token, [(exercise, start_line, end_line), ...])
# Ranges are 1-based and inclusive, against the file as it is on `main`.
# Listed in the order they must be applied: innermost/last-line first.
SPEC = [
    # All three pipelines are stripped identically -- one line each, the
    # `- otlp_http/datadog` entry -- because all three keep `- debug` active
    # and therefore stay valid configs with the Datadog exporter commented out.
    # Do not go back to stripping the whole metrics pipeline: every Node
    # service autoconfigures a default OTLP metric reader, so a missing metrics
    # pipeline means a 404 stack trace per service every ten seconds.
    ("collector-config.yaml", "#", [
        ("2.1", 102, 102),  # logs -> datadog
        ("2.1", 96, 96),    # metrics -> datadog
        ("2.1", 82, 82),    # traces -> datadog
        ("2.1", 63, 72),    # the Datadog OTLP exporter itself
    ]),
    # backend/src/otel.ts is deliberately NOT stripped. Commenting out
    # `metricReaders` does not disable metrics: NodeSDK falls back to
    # env-var autoconfiguration and creates a default OTLP metric reader
    # anyway, so the only effect is a metrics-export 404 every 10s and a
    # Chapter 04 whose premise is false.
    ("backend/src/claude-instrumentation.ts", "//", [
        ("3.3", 245, 246),  # recordError: recordException + setStatus
        ("4.1", 239, 244),  # recordError: the duration histogram
        ("3.3", 238, 238),  # recordError: error.type
        ("4.1", 217, 228),  # recordResponse: both histograms
        ("3.2", 208, 215),  # recordResponse: the response attributes
        ("3.1", 171, 180),  # requestAttributes: the request attributes
    ]),
    ("frontend/src/rum/otel.ts", "//", [
        ("5.3", 485, 485),  # startPageTrace
        ("5.3", 471, 471),  # notifySessionReady
        ("5.3", 465, 465),  # await sessionManager.start()
        ("6.1", 450, 458),  # Fetch + Xhr  -- inner layer, applied first
        ("5.2", 394, 460),  # registerInstrumentations
        ("5.1", 274, 390),  # both SDKs, resource, session, processors
    ]),
    ("frontend/src/lib/navigate.ts", "//", [
        ("6.2", 36, 36),    # flush before replace
        ("6.2", 25, 25),    # flush before assign
    ]),
]

BANNER = "{indent}{tok} ── Exercise {ex} ── select the lines below, toggle comments once ──"
END = "{indent}{tok} ── end Exercise {ex} ──"


def indent_of(line):
    return len(line) - len(line.lstrip())


def render(lines, tok, blocks, lo, hi):
    """Render original lines[lo:hi], applying `blocks` (original 1-based,
    inclusive ranges) and commenting nested blocks from the inside out.

    Blocks may nest -- Exercise 6.1 sits inside 5.2 -- so this recurses rather
    than editing in place. Editing in place would shift the outer block's end
    line by however many marker lines the inner block inserted.
    """
    # Only the blocks at this level: those not contained in another block here.
    here = [b for b in blocks if lo <= b[1] - 1 and b[2] - 1 < hi]
    top = [b for b in here if not any(o is not b and o[1] <= b[1] and b[2] <= o[2] for o in here)]
    top.sort(key=lambda b: b[1])

    out, cursor = [], lo
    for ex, start, end in top:
        i, j = start - 1, end - 1
        out.extend(lines[cursor:i])

        inner = [b for b in here if b not in top and i <= b[1] - 1 and b[2] - 1 <= j]
        body = render(lines, tok, inner, i, j + 1)

        # The *minimum* indent in the range, which is where an IDE's
        # toggle-comment puts the token -- so this is exactly reversible, even
        # when the range contains an already-commented line at column 0.
        width = min((indent_of(l) for l in body if l.strip()), default=0)
        indent = " " * width
        out.append(BANNER.format(indent=indent, tok=tok, ex=ex))
        out.extend(f"{l[:width]}{tok} {l[width:]}" if l.strip() else l for l in body)
        out.append(END.format(indent=indent, tok=tok, ex=ex))
        cursor = j + 1

    out.extend(lines[cursor:hi])
    return out


def apply(path, tok, blocks):
    with open(path) as fh:
        lines = fh.read().split("\n")

    for ex, start, end in blocks:
        if start - 1 < 0 or end - 1 >= len(lines):
            sys.exit(f"{path}: Exercise {ex} range {start}-{end} out of bounds")

    with open(path, "w") as fh:
        fh.write("\n".join(render(lines, tok, blocks, 0, len(lines))))
    print(f"{path}: {len(blocks)} block(s) stripped")


for path, tok, blocks in SPEC:
    apply(path, tok, blocks)
