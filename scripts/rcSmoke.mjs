const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function getJson(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "cache-control": "no-store",
      "pragma": "no-cache",
    },
  });

  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  return { ok: r.ok, status: r.status, text, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const baseUrl = (process.env.RC_SMOKE_URL || DEFAULT_BASE_URL).trim();
  const allowDbDown = String(process.env.RC_SMOKE_ALLOW_DB_DOWN || "").trim() === "1";

  console.log("[rc:smoke] baseUrl=", baseUrl);

  const healthUrl = joinUrl(baseUrl, "/healthz");
  const readyUrl = joinUrl(baseUrl, "/readyz");

  const health = await getJson(healthUrl);
  console.log("[rc:smoke] GET", healthUrl, "->", health.status, health.json ?? health.text);
  assert(health.ok, `healthz failed: HTTP ${health.status}`);
  assert(health.json && health.json.ok === true, "healthz expected JSON { ok: true }");

  const ready = await getJson(readyUrl);
  console.log("[rc:smoke] GET", readyUrl, "->", ready.status, ready.json ?? ready.text);
  if (!allowDbDown) {
    assert(ready.ok, `readyz failed: HTTP ${ready.status}`);
    assert(ready.json && ready.json.ok === true, "readyz expected JSON { ok: true, db: true }");
    assert(ready.json.db === true, "readyz expected db: true");
  } else {
    assert(ready.status === 200 || ready.status === 503, "readyz expected 200 or 503 in allow-db-down mode");
  }

  console.log("[rc:smoke] OK");
}

main().catch((e) => {
  console.error("[rc:smoke] FAIL:", e?.message || e);
  process.exitCode = 1;
});
