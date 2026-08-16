#!/usr/bin/env python3
"""Read-only dump of ATLAS files.path rows for the ADR-005 coverage check.

Opens the database URI in mode=ro so a liveness probe cannot create a
journal, WAL sidecar, or otherwise write under .devteam/.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: read-atlas-paths.py <atlas.db>\n")
        return 2
    db_path = Path(sys.argv[1])
    if not db_path.is_file():
        sys.stderr.write(f"ATLAS index missing at {db_path}\n")
        return 1
    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True)
        try:
            for (path,) in con.execute("SELECT path FROM files ORDER BY path"):
                sys.stdout.write(f"{path}\n")
        finally:
            con.close()
    except sqlite3.Error as exc:
        sys.stderr.write(f"unreadable ATLAS index: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
