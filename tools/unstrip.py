#!/usr/bin/env python3
"""Uncomment the blocks belonging to one or more workshop exercises.

Does by script exactly what an attendee does in the IDE: select the lines
between the `Exercise N.N` markers and toggle comments once.

    tools/unstrip.py 2.1 3.1 3.2 3.3

Normally reached through the Makefile, which maps chapters to exercise lists:

    make catchup-ch03

Safe to run twice, and safe to run over work already done by hand: a block
whose body is no longer comment-prefixed is left untouched. That matters
because the guide has attendees toggle the lines *between* the markers, so
the markers stay in the file and a finished block looks like an unfinished
one to anything matching on markers alone.
"""
import re
import sys

FILES = [
    ("collector-config.yaml", "#"),
    ("backend/src/claude-instrumentation.ts", "//"),
    ("frontend/src/rum/otel.ts", "//"),
    ("frontend/src/lib/navigate.ts", "//"),
]

wanted = set(sys.argv[1:])
if not wanted:
    sys.exit("usage: unstrip.py <exercise> [<exercise> ...]")

restored = 0
already = []


def run(path, tok):
    """One pass over `path`. Returns the number of blocks restored."""
    global restored
    t = re.escape(tok)
    begin = re.compile(rf"^(\s*){t} ── Exercise (\S+) ── select .*──$")
    end = re.compile(rf"^(\s*){t} ── end Exercise (\S+) ──$")

    with open(path) as fh:
        lines = fh.read().split("\n")

    out, i, touched = [], 0, 0
    while i < len(lines):
        m = begin.match(lines[i])
        if not m or m.group(2) not in wanted:
            out.append(lines[i])
            i += 1
            continue

        indent, ex = m.group(1), m.group(2)
        prefix = f"{indent}{tok} "

        # Collect the block body first, so an already-done block can be
        # written back untouched rather than half-converted.
        body, j = [], i + 1
        while j < len(lines):
            e = end.match(lines[j])
            if e and e.group(2) == ex:
                break
            body.append(lines[j])
            j += 1
        else:
            sys.exit(f"{path}: Exercise {ex} has no end marker")

        code = [l for l in body if l.strip()]

        # A block is still stripped only if EVERY non-blank line carries the
        # prefix. Anything else is treated as already done and left alone.
        #
        # "Some lines prefixed" cannot mean "half-converted" here, because many
        # blocks contain prose that was already a comment in the reference
        # build: strip adds a second layer to those, and removing one layer
        # leaves them looking prefixed forever. So a finished block is
        # *normally* a mix, and testing for a mix would reject the common case.
        if not all(l.startswith(prefix) for l in code):
            out.extend(lines[i : j + 1])
            i = j + 1
            already.append(ex)
            continue

        out.extend(indent + l[len(prefix):] if l.strip() else l for l in body)
        i = j + 1
        touched += 1

    if touched:
        with open(path, "w") as fh:
            fh.write("\n".join(out))
        restored += touched
    return touched


for path, tok in FILES:
    # Loop to a fixpoint: restoring an outer block only *reveals* the markers
    # of any block nested inside it (Exercise 6.1 lives inside 5.2).
    while run(path, tok):
        pass

if restored:
    print(f"restored {restored} block(s)")
if already:
    print(f"already done, left alone: {', '.join(sorted(set(already)))}")
if not restored and not already:
    print("nothing to do -- every exercise in this range is already applied")
