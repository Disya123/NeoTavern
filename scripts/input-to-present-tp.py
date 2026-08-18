#!/usr/bin/env python3
"""Run Perfetto SQL against a trace; print JSON rows. Debug capture helper."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

QUERIES = {
    "timeline": """
SELECT ts, dur, display_frame_token, surface_frame_token, layer_name,
       present_type, on_time_finish, gpu_composition, jank_type, prediction_type
FROM actual_frame_timeline_slice
""",
    "stats": """
SELECT name, value FROM stats
WHERE name GLOB '*lost*' OR name GLOB '*overrun*' OR name GLOB '*discard*'
   OR name GLOB '*overwrite*'
""",
    "clock": """
SELECT ts, clock_id, clock_name, clock_value FROM clock_snapshot
""",
}


def rows_from_tsv(text: str) -> list[dict]:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    headers = lines[0].split("\t")
    out = []
    for line in lines[1:]:
        cols = line.split("\t")
        row = {}
        for i, key in enumerate(headers):
            value = cols[i] if i < len(cols) else ""
            if value.replace(".", "", 1).replace("-", "", 1).isdigit():
                row[key] = float(value) if "." in value else int(value)
            else:
                row[key] = value
        out.append(row)
    return out


def query_shell(shell: str, trace: str, sql: str) -> list[dict]:
    result = subprocess.run(
        [shell, "-q", sql, trace],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr or result.stdout or f"trace_processor_shell exit {result.returncode}")
    return rows_from_tsv(result.stdout)


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("usage: input-to-present-tp.py <trace_processor_shell> <trace> <out-prefix>")
    shell, trace, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    for name, sql in QUERIES.items():
        rows = query_shell(shell, trace, sql)
        Path(f"{prefix}-{name}.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
        print(f"{name} {len(rows)}")


if __name__ == "__main__":
    main()
