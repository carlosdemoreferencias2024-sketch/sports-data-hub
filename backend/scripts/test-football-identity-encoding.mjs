import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  footballFixtureCanonicalId,
  hasFootballIdentityEncodingIssue,
  processFootballTodayUniverse
} from "../dist/trading/football-today-universe.js";

const names = ["León", "Querétaro", "Atlético", "São Paulo", "Malmö", "Fenerbahçe", "Beşiktaş"];
const workDir = mkdtempSync(join(tmpdir(), "football-identity-utf8-"));
const inputPath = join(workDir, "input.json");
const outputPath = join(workDir, "output.json");

try {
  writeFileSync(inputPath, JSON.stringify({ names }), "utf8");

  if (process.platform === "win32") {
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = [
      `$payload = Get-Content -LiteralPath '${inputPath.replaceAll("'", "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json`,
      `$payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '${outputPath.replaceAll("'", "''")}' -Encoding UTF8`
    ].join("; ");
    const result = spawnSync(powershell, ["-NoProfile", "-Command", command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } else {
    writeFileSync(outputPath, readFileSync(inputPath));
  }

  const roundTripped = JSON.parse(readFileSync(outputPath, "utf8").replace(/^\uFEFF/, ""));
  assert.deepEqual(roundTripped.names, names);

  for (const [index, name] of names.entries()) {
    assert.equal(hasFootballIdentityEncodingIssue(name), false, `${name} must be accepted as valid Unicode`);
    const input = {
      date: "2026-08-25",
      leagueId: "identity-regression",
      homeTeam: name,
      awayTeam: "Real Salt Lake",
      kickoffUtc: `2026-08-26T0${index}:30:00.000Z`
    };
    assert.equal(
      footballFixtureCanonicalId(input),
      footballFixtureCanonicalId({ ...input, homeTeam: roundTripped.names[index] })
    );
  }

  const validId = footballFixtureCanonicalId({
    date: "2026-08-25",
    leagueId: "leagues-cup",
    homeTeam: "León",
    awayTeam: "Real Salt Lake",
    kickoffUtc: "2026-08-26T02:30:00.000Z"
  });
  const corruptedId = footballFixtureCanonicalId({
    date: "2026-08-25",
    leagueId: "leagues-cup",
    homeTeam: "Le├│n",
    awayTeam: "Real Salt Lake",
    kickoffUtc: "2026-08-26T02:30:00.000Z"
  });
  assert.notEqual(validId, corruptedId);
  assert.equal(hasFootballIdentityEncodingIssue("León"), false);
  assert.equal(hasFootballIdentityEncodingIssue("Le├│n"), true);

  const rejected = await processFootballTodayUniverse(
    { query: async () => { throw new Error("database must not be reached for invalid identity encoding"); } },
    {
      dry_run: true,
      date: "2026-08-25",
      fixtures: [{
        league: "leagues-cup",
        home_team: "Le├│n",
        away_team: "Real Salt Lake",
        kickoff: "2026-08-26T02:30:00.000Z"
      }]
    }
  );
  assert.equal(rejected.rejected, 1);
  assert.equal(rejected.rows[0].reason, "IDENTITY_ENCODING_INVALID");
  assert.equal(rejected.fixtures_would_insert, 0);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("football identity encoding regression tests ok");
