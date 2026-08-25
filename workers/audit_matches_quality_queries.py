"""Fail when operational/model SQL reads matches directly instead of v_valid_matches."""

from __future__ import annotations

import json
import re
from pathlib import Path


DIRECT_MATCH_READ = re.compile(r"\b(?:FROM|JOIN)\s+matches\b", re.IGNORECASE)
SCAN_ROOTS = ("workers", "backend/src", "analytics", "scripts")
ALLOW_DIRECT_MATCH_READ = {
    "backend/src/modules/mappings/mapping.routes.ts",
    "backend/src/trading/mlb-fixture-time-repair.ts",
    "scripts/dedupe_coritiba_cruzeiro_20260730_apply.sql",
    "workers/audit_espn_soccer_duplicate_fixtures.py",
    "workers/audit_mlb_duplicate_fixtures.py",
    "workers/audit_mlb_stale_fixtures.py",
    "workers/fixture_review_report_common.py",
    "workers/generate_collision_review.py",
    "workers/generate_unresolved_review.py",
    "workers/invalidate_exact_duplicates.py",
    "workers/reidentify_and_invalidate.py",
    "workers/review_fixture_identity_plan.py",
    "workers/rollback_fixture_identity.py",
}
SOURCE_SUFFIXES = {".py", ".ts", ".sql", ".ps1"}


def find_unapproved_queries(project_root: Path) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = []
    for relative_root in SCAN_ROOTS:
        root = project_root / relative_root
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if (
                not path.is_file()
                or path.suffix.lower() not in SOURCE_SUFFIXES
                or path.name.startswith("test_")
            ):
                continue
            relative = path.relative_to(project_root).as_posix()
            if relative in ALLOW_DIRECT_MATCH_READ:
                continue
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if DIRECT_MATCH_READ.search(line):
                    findings.append({
                        "file": relative,
                        "line": line_number,
                        "text": line.strip(),
                    })
    return findings


def assert_quality_query_gate(project_root: Path) -> None:
    findings = find_unapproved_queries(project_root)
    if findings:
        raise RuntimeError(f"MATCH_QUALITY_QUERY_GATE_FAILED:{json.dumps(findings)}")


def main() -> None:
    project_root = Path(__file__).resolve().parent.parent
    findings = find_unapproved_queries(project_root)
    print(json.dumps({
        "status": "PASS" if not findings else "FAIL",
        "unapproved_direct_match_reads": findings,
        "allowed_direct_read_files": sorted(ALLOW_DIRECT_MATCH_READ),
    }, indent=2))
    if findings:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
