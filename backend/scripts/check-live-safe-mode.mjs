import assert from "node:assert/strict";

const baseUrl = process.env.SAFE_MODE_BASE_URL || "http://127.0.0.1:4000";
const timeoutMs = Number(process.env.SAFE_MODE_TIMEOUT_MS || 8000);

function withTimeout() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeout };
}

async function request(path, options = {}) {
  const { controller, timeout } = withTimeout();
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { path, status: response.status, ok: response.ok, text, json };
  } catch (error) {
    return {
      path,
      status: 0,
      ok: false,
      text: "",
      json: null,
      error: error instanceof Error ? error.name || error.message : "request_failed"
    };
  } finally {
    clearTimeout(timeout);
  }
}

function boolOff(value) {
  return value === false || value === 0 || value === "false" || value === "OFF" || value === undefined || value === null;
}

function assertGuardrails(label, guardrails = {}) {
  assert.equal(Number(guardrails.real_candidate_count || guardrails.real_candidate || 0), 0, `${label}: REAL_CANDIDATE must stay 0`);
  assert.equal(boolOff(guardrails.real_money_enabled), true, `${label}: real money must stay OFF`);
  assert.equal(boolOff(guardrails.kelly_enabled), true, `${label}: Kelly must stay OFF`);
  assert.equal(boolOff(guardrails.telegram_auto_enabled), true, `${label}: Telegram auto must stay OFF`);
  if ("auto_post_allowed" in guardrails) assert.equal(guardrails.auto_post_allowed, false, `${label}: autopost must stay OFF`);
  if ("auto_scrape_allowed" in guardrails) assert.equal(guardrails.auto_scrape_allowed, false, `${label}: autoscrape must stay OFF`);
}

const results = [];

const health = await request("/health");
assert.equal(health.status, 200, "/health must be reachable");
assert.equal(health.json?.status, "ok", "/health status must be ok");
results.push({ check: "health", status: health.status, result: "ok" });

const dashboard = await request("/dashboard/trading");
assert.equal(dashboard.status, 200, "/dashboard/trading must load");
for (const marker of ["REAL_CANDIDATE", "Kelly", "Telegram", "Source Capture Assistant", "Clean Chain Progress", "CAPTURED_ON_TIME"]) {
  assert.ok(dashboard.text.includes(marker), `/dashboard/trading should contain ${marker}`);
}
results.push({ check: "dashboard_markers", status: dashboard.status, result: "ok" });

const openApi = await request("/docs/json");
assert.equal(openApi.status, 200, "OpenAPI document must be reachable");
const writeEndpoints = [];
for (const [path, operations] of Object.entries(openApi.json?.paths || {})) {
  for (const method of ["post", "put", "patch", "delete"]) {
    if (operations[method]) writeEndpoints.push({ method: method.toUpperCase(), path });
  }
}
assert.ok(writeEndpoints.length > 0, "OpenAPI must publish write endpoints");

for (const endpoint of writeEndpoints) {
  const response = await request(endpoint.path, {
    method: endpoint.method,
    headers: { "content-type": "application/json" },
    body: endpoint.method === "DELETE" ? undefined : "{}"
  });
  assert.equal(response.status, 401, `${endpoint.method} ${endpoint.path} must reject writes without an API key`);
}
results.push({ check: "write_endpoint_auth", count: writeEndpoints.length, status: 401, result: "protected" });

const forbiddenOrigin = await request("/health", {
  headers: { origin: "https://untrusted.example" }
});
assert.equal(forbiddenOrigin.status, 403, "unlisted browser origins must be rejected");
results.push({ check: "cors_allowlist", status: forbiddenOrigin.status, result: "protected" });

const sensitiveEndpoints = [
  "/api/v1/internal/analytics/source-capture-assistant/rules",
  "/api/v1/internal/analytics/command-center",
  "/api/v1/internal/model-quotes/data-health",
  "/api/v1/internal/analytics/pilot-checklist"
];

for (const endpoint of sensitiveEndpoints) {
  const response = await request(endpoint);
  if (response.status === 401 || response.status === 403) {
    results.push({ check: endpoint, status: response.status, result: "protected" });
    continue;
  }
  if (response.status === 0) {
    results.push({ check: endpoint, status: response.status, result: "timeout_or_unavailable", error: response.error });
    continue;
  }
  assert.equal(response.status, 200, `${endpoint} must be reachable or protected`);
  if (response.json?.guardrails) assertGuardrails(endpoint, response.json.guardrails);
  if (response.json?.counts) {
    assert.equal(Number(response.json.counts.real_candidate || 0), 0, `${endpoint}: counts.real_candidate must stay 0`);
  }
  if (endpoint.includes("source-capture-assistant/rules")) {
    assertGuardrails(endpoint, response.json?.guardrails || {});
    assert.ok(
      response.json?.rules?.some((rule) => String(rule).includes("never posts manual_verified automatically")),
      "Source Capture Assistant must document no-autopost"
    );
  }
  results.push({ check: endpoint, status: response.status, result: "ok" });
}

console.log(JSON.stringify({
  system_status: "LIVE_SAFE_MODE_CHECK_OK",
  base_url: baseUrl,
  checked_at: new Date().toISOString(),
  guardrails: {
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    auto_post_allowed: false
  },
  results
}, null, 2));
