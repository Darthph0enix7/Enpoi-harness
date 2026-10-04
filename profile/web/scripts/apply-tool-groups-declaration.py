#!/usr/bin/env python3
"""Idempotently add the `dsh-enpoi-tool-groups` row to the ACTIVE preset
declarations in `cordis.patch.yml`.

Why this script exists: the merged agent-preset registry uses the
`@deepseek-ai/dsh-agent-preset` declarations inside `cordis.patch.yml`
("declarations, not directories"); `presets/<id>/agent.cordis.yml` is the old
source and is not loaded. The running host rewrites this document on settings
changes, so run this immediately before a service restart.

Usage: python3 scripts/apply-tool-groups-declaration.py [--check]
Exit 0 = rows present (or inserted); 2 = --check found a missing row.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

PROFILE = Path(__file__).resolve().parent.parent
DOCUMENT = PROFILE / "cordis.patch.yml"

SEAT_RE = re.compile(r"^(\s*)- id: preset-(\S+)\s*$")
DEBUG_RE = re.compile(r"^(\s*)- id: enpoi-debug\s*$")
ROW_RE = re.compile(r"^\s*- id: enpoi-tool-groups\s*$")


def row_block(indent: str, seat: str) -> list[str]:
    return [
        f"{indent}- id: enpoi-tool-groups\n",
        f"{indent}  name: 'dsh-enpoi-tool-groups'\n",
        f"{indent}  config:\n",
        f"{indent}    seat: {seat}\n",
    ]


def main() -> int:
    check_only = "--check" in sys.argv
    lines = DOCUMENT.read_text().splitlines(keepends=True)

    # Pass 1: which preset declarations already carry the row?
    seat: str | None = None
    present: set[str] = set()
    for line in lines:
        seat_match = SEAT_RE.match(line)
        if seat_match:
            seat = seat_match.group(2)
            continue
        if seat is not None and ROW_RE.match(line):
            present.add(seat)

    # Pass 2: insert after each `enpoi-debug` name line of a seat missing it.
    out: list[str] = []
    seat = None
    pending: tuple[str, str] | None = None  # (indent, seat)
    inserted: list[str] = []
    for line in lines:
        seat_match = SEAT_RE.match(line)
        if seat_match:
            seat = seat_match.group(2)
        if pending is not None and re.match(r"^\s*name: 'dsh-enpoi-debug'\s*$", line):
            out.append(line)
            indent, target = pending
            if target not in present:
                out.extend(row_block(indent, target))
                inserted.append(target)
            pending = None
            continue
        out.append(line)
        debug_match = DEBUG_RE.match(line)
        if debug_match and seat is not None:
            pending = (debug_match.group(1), seat)

    if pending is not None:
        print("error: enpoi-debug name line not found after its id row", file=sys.stderr)
        return 1

    if check_only:
        if inserted:
            print(f"missing tool-groups row in: {', '.join(inserted)}")
            return 2
        print(f"tool-groups rows present in: {', '.join(sorted(present))}")
        return 0

    if inserted:
        DOCUMENT.write_text("".join(out))
        print(f"inserted tool-groups row into: {', '.join(inserted)}")
    else:
        print(f"already present in: {', '.join(sorted(present))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
