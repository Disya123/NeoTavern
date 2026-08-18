#!/usr/bin/env python3
"""Run Perfetto SQL against a trace; print JSON rows. Debug capture helper."""
from __future__ import annotations

import csv
import io
import json
import subprocess
import sys
import tempfile
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
   OR name GLOB '*overwrite*' OR name GLOB '*traced_buf*' OR name GLOB '*android_log*'
""",
    "clock": """
SELECT ts, clock_id, clock_name, clock_value FROM clock_snapshot
""",
    "android_logs": """
SELECT ts, prio, tag, msg FROM android_logs
WHERE tag = 'NeoTavernI2P' OR msg GLOB '*i2p *'
""",
}


def rows_from_csv(text: str) -> list[dict]:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("column ") or stripped.startswith("["):
            continue
        if stripped.startswith("Loading "):
            continue
        lines.append(stripped)
    if not lines:
        return []
    reader = csv.DictReader(io.StringIO("\n".join(lines)))
    out = []
    for raw in reader:
        if not raw:
            continue
        row = {}
        for key, value in raw.items():
            if key is None:
                continue
            name = key.strip()
            cell = "" if value is None else value.strip()
            if cell == "" or cell.upper() == "NULL" or cell == "[NULL]":
                row[name] = None
                continue
            if cell.replace(".", "", 1).replace("-", "", 1).isdigit():
                row[name] = float(cell) if "." in cell else int(cell)
            else:
                row[name] = cell
        if any(value is not None and value != "" for value in row.values()):
            out.append(row)
    return out


def query_shell(shell: str, trace: str, sql: str) -> list[dict]:
    with tempfile.NamedTemporaryFile(
        "w",
        suffix=".sql",
        delete=False,
        encoding="utf-8",
    ) as handle:
        handle.write(sql.strip() + ";\n")
        sql_path = handle.name
    try:
        result = subprocess.run(
            [shell, "query", "-f", sql_path, trace],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    finally:
        Path(sql_path).unlink(missing_ok=True)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or f"trace_processor_shell exit {result.returncode}").strip()
        if "android_logs" in sql and ("no such table" in err.lower() or "does not exist" in err.lower()):
            return []
        raise SystemExit(err)
    return rows_from_csv(result.stdout)


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("usage: input-to-present-tp.py <trace_processor_shell> <trace> <out-prefix>")
    shell, trace, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    for name, sql in QUERIES.items():
        try:
            rows = query_shell(shell, trace, sql)
        except SystemExit as err:
            if name == "android_logs":
                rows = []
                print(f"{name} skipped ({err})")
            else:
                raise
        Path(f"{prefix}-{name}.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
        print(f"{name} {len(rows)}")


if __name__ == "__main__":
    main()
