#!/usr/bin/env python3
"""Refuse to let a credential reach the repository.

Acceptance criterion for TAB 02: no secret appears in the repository, in an
image layer, in a log line, or in an error response. The last two are covered
by tests; this covers the first two, since .dockerignore decides what reaches a
layer and everything tracked by git can reach one.

Deliberately pattern-based and local. A hosted scanner would be better at
recall, but this must run on every commit with no credit and no network.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Files that legitimately contain the *shape* of a credential without being one.
ALLOWED = {
    ".env.example",
    "scripts/scan-secrets.py",
    "src/common/logging/logger.ts",
    "src/common/logging/logger.spec.ts",
    "src/config/app-config.spec.ts",
    "test/http.e2e-spec.ts",
}

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    (
        "assigned secret literal",
        re.compile(
            r"""(?ix)
            \b(password|passwd|secret|api[_-]?key|access[_-]?token|
               refresh[_-]?token|client[_-]?secret|private[_-]?key)\b
            \s*[:=]\s*
            ['"][^'"\s${}]{8,}['"]
            """
        ),
    ),
    (
        "connection string with an inline password",
        re.compile(r"(?i)\b(postgres|postgresql|mysql|mongodb|redis|amqp)://[^\s:@/]+:[^\s:@/]+@"),
    ),
]


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    )
    return [ROOT / line for line in result.stdout.splitlines() if line]


def main() -> None:
    findings: list[str] = []
    scanned = 0

    for path in tracked_files():
        relative = path.relative_to(ROOT).as_posix()
        if relative in ALLOWED or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary
        scanned += 1
        for line_number, line in enumerate(text.splitlines(), start=1):
            for label, pattern in PATTERNS:
                if pattern.search(line):
                    findings.append(f"{relative}:{line_number}  {label}")

    # An environment file must never be tracked, whatever it contains.
    for path in tracked_files():
        name = path.name
        if name.startswith(".env") and name != ".env.example":
            findings.append(f"{path.relative_to(ROOT).as_posix()}  a real environment file is tracked")

    if findings:
        print(f"SECRET SCAN FAILED — {len(findings)} finding(s):\n", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        sys.exit(1)

    print(f"  ok   secret scan: {scanned} tracked text files, nothing that looks like a credential")


if __name__ == "__main__":
    main()
