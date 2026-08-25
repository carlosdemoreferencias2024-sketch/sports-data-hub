import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("SCRAPER_IMPORT_GUARD_SKIPPED_NON_WINDOWS");
  process.exit(0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "scraper-import-guard-"));
const script = path.resolve(process.cwd(), "..", "scripts", "import_scraper_source_capture.ps1");
const matchId = randomUUID();

async function fixture(capturedAt, kickoff) {
  const canonical = JSON.stringify({ capturedAt, kickoff, nonce: randomUUID() });
  const sha = createHash("sha256").update(canonical).digest("hex");
  const file = path.join(temp, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({
    source_name: "verified_test",
    source_url: "https://example.test/match",
    captured_at: capturedAt,
    evidence_id: sha.slice(0, 32),
    evidence_sha256: sha,
    evidence_canonical_json: canonical,
    capture_type: "match_status",
    sport: "soccer",
    bookmaker: "TestBook",
    workflow_state: "PENDING_HUMAN_VERIFICATION",
    auto_post: false,
    verified_by: null,
    source_event_id: "test-event",
    match_fingerprint: "test-fingerprint",
    data: {
      snapshot_type: "match_status",
      normalized_event: {
        home: { name: "Home" },
        away: { name: "Away" },
        starts_at: kickoff,
        status: "scheduled"
      }
    }
  }), "utf8");
  return file;
}

function run(file, kickoff, auditOnly = false) {
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-EvidencePath", file,
    "-MatchId", matchId,
    "-VerifiedBy", "automated-test",
    "-ExpectedHomeTeam", "Home",
    "-ExpectedAwayTeam", "Away",
    "-ExpectedKickoff", kickoff,
    "-ApplyVerifiedCapture"
  ];
  if (auditOnly) args.push("-PostKickoffAuditOnly", "-DryRun");
  return spawnSync("powershell.exe", args, { encoding: "utf8" });
}

try {
  const now = Date.now();
  const kickoff = new Date(now - 10 * 60_000).toISOString();
  const pregameCapture = new Date(now - 20 * 60_000).toISOString();
  const postCapture = new Date(now - 5 * 60_000).toISOString();

  const pregameFile = await fixture(pregameCapture, kickoff);
  const closed = run(pregameFile, kickoff);
  assert.notEqual(closed.status, 0);
  assert.match(`${closed.stdout}\n${closed.stderr}`, /PROSPECTIVE_WINDOW_CLOSED/);

  const postFile = await fixture(postCapture, kickoff);
  const post = run(postFile, kickoff);
  assert.notEqual(post.status, 0);
  assert.match(`${post.stdout}\n${post.stderr}`, /POST_KICKOFF_CAPTURE_REJECTED/);

  const audit = run(postFile, kickoff, true);
  assert.equal(audit.status, 0, `${audit.stdout}\n${audit.stderr}`);
  const output = JSON.parse(audit.stdout);
  assert.equal(output.post_kickoff_audit_only, true);
  assert.equal(output.posted, false);
  assert.equal(output.picks_created, 0);
  console.log("SCRAPER_IMPORT_GUARD_OK");
} finally {
  await rm(temp, { recursive: true, force: true });
}
