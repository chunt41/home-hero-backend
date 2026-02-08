import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function joinUrl(base, path) {
  const u = new URL(String(path || ""), String(base || ""));
  return u.toString();
}

function previewBody(body, maxLen = 500) {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

async function requestJson(baseUrl, path, { method = "GET", token, body } = {}) {
  const url = joinUrl(baseUrl, path);
  const headers = {
    accept: "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
  };

  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const r = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  return { url, ok: r.ok, status: r.status, text, json };
}

async function getJson(baseUrl, path, opts) {
  return requestJson(baseUrl, path, { ...(opts || {}), method: "GET" });
}

async function postJson(baseUrl, path, body, opts) {
  return requestJson(baseUrl, path, { ...(opts || {}), method: "POST", body });
}

function isLocalHost(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return false;
  }
}

async function waitForHealth(baseUrl, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await getJson(baseUrl, "/healthz");
      if (r.ok && r.json && r.json.ok === true) return;
    } catch {
      // ignore
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for server healthz at ${joinUrl(baseUrl, "/healthz")}`);
}

async function maybeStartLocalServer(baseUrl) {
  const startEnabled = String(process.env.RC_SMOKE_START_SERVER || "").trim() !== "0";
  if (!startEnabled) return null;
  if (!isLocalHost(baseUrl)) return null;

  // If a server is already up, don't start another one.
  try {
    const existing = await getJson(baseUrl, "/healthz");
    if (existing.ok && existing.json && existing.json.ok === true) {
      console.log("[rc:smoke] server already running; not starting another");
      return null;
    }
  } catch {
    // ignore
  }

  const u = new URL(baseUrl);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;

  console.log("[rc:smoke] starting local server for smoke checks");

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: process.env.NODE_ENV || "development",
        APP_ATTESTATION_ENFORCE: "false",
        EXPOSE_EMAIL_VERIFICATION_TOKEN: "1",
      },
    }
  );

  // Best-effort: if we exit early, surface it.
  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    if (code && code !== 0) {
      console.error(`[rc:smoke] server exited early with code ${code}`);
    }
  });

  await waitForHealth(baseUrl, { timeoutMs: 45_000 });
  if (exited) {
    throw new Error("Server process exited before becoming healthy.");
  }

  return child;
}

function randSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function expectOkJson(name, res) {
  console.log(`[rc:smoke] ${name} ->`, res.status, res.json ?? previewBody(res.text));
  assert(res.ok, `${name} failed: HTTP ${res.status} body=${previewBody(res.json ?? res.text)}`);
  return res;
}

async function main() {
  const baseUrl = (process.env.RC_SMOKE_URL || DEFAULT_BASE_URL).trim();
  const allowDbDown = String(process.env.RC_SMOKE_ALLOW_DB_DOWN || "").trim() === "1";

  console.log("[rc:smoke] baseUrl=", baseUrl);

  const serverProc = await maybeStartLocalServer(baseUrl);
  try {
    // 1) Health/readiness
    {
      const health = await getJson(baseUrl, "/healthz");
      await expectOkJson(`GET ${health.url}`, health);
      assert(health.json && health.json.ok === true, "healthz expected JSON { ok: true }");
    }

    {
      const ready = await getJson(baseUrl, "/readyz");
      console.log(`[rc:smoke] GET ${ready.url} ->`, ready.status, ready.json ?? previewBody(ready.text));
      if (!allowDbDown) {
        assert(ready.ok, `readyz failed: HTTP ${ready.status}`);
        assert(ready.json && ready.json.ok === true, "readyz expected JSON { ok: true, db: true }");
        assert(ready.json.db === true, "readyz expected db: true");
      } else {
        assert(
          ready.status === 200 || ready.status === 503,
          "readyz expected 200 or 503 in allow-db-down mode"
        );
      }
    }

    // 2) Auth flow (signup → verify → login)
    const password = `HhRc!${randSuffix()}Z9`;
    const consumerEmail = `rcsmoke-consumer-${randSuffix()}@example.com`;
    const providerEmail = `rcsmoke-provider-${randSuffix()}@example.com`;

    async function signupVerifyLogin({ role, email, name }) {
      const signup = await postJson(baseUrl, "/auth/signup", {
        role,
        name,
        email,
        password,
        location: "New York, NY 10001",
      });
      await expectOkJson(`POST ${signup.url}`, signup);
      assert(signup.status === 201, `signup expected 201, got ${signup.status}`);
      assert(signup.json && typeof signup.json.token === "string", "signup expected token");

      const debugToken = signup.json?.debugEmailVerificationToken;
      assert(
        typeof debugToken === "string" && debugToken.length > 0,
        "signup did not expose debugEmailVerificationToken. For local smoke, start the server with EXPOSE_EMAIL_VERIFICATION_TOKEN=1 (rcSmoke does this automatically when it starts the server)."
      );

      const verify = await postJson(baseUrl, "/auth/verify-email", { token: debugToken });
      await expectOkJson(`POST ${verify.url}`, verify);
      assert(verify.json && verify.json.ok === true, "verify-email expected { ok: true }");

      const login = await postJson(baseUrl, "/auth/login", { email, password });
      await expectOkJson(`POST ${login.url}`, login);
      assert(login.json && typeof login.json.token === "string", "login expected token");

      return { token: login.json.token, user: login.json.user ?? null };
    }

    const consumer = await signupVerifyLogin({
      role: "CONSUMER",
      email: consumerEmail,
      name: "RC Smoke Consumer",
    });
    const provider = await signupVerifyLogin({
      role: "PROVIDER",
      email: providerEmail,
      name: "RC Smoke Provider",
    });

    // 3) Provider search
    {
      const r = await getJson(baseUrl, "/providers/search?zip=10001&limit=5", {
        token: consumer.token,
      });
      await expectOkJson(`GET ${r.url}`, r);
      assert(r.json && Array.isArray(r.json.items), "providers/search expected { items: [] }");
    }

    // 4) Post job (consumer)
    let jobId;
    {
      const r = await postJson(
        baseUrl,
        "/jobs",
        {
          title: "Fix leaking kitchen sink",
          description: "Kitchen sink is leaking under the cabinet. Need help ASAP.",
          budgetMin: 75,
          budgetMax: 200,
          location: "New York, NY 10001",
        },
        { token: consumer.token }
      );
      await expectOkJson(`POST ${r.url}`, r);
      assert(r.status === 201 || r.status === 202, `job create expected 201/202, got ${r.status}`);
      assert(r.json && (typeof r.json.id === "number" || typeof r.json.id === "string"), "job create expected id");
      jobId = r.json.id;
    }

    // 5) Place bid (provider)
    {
      const r = await postJson(
        baseUrl,
        `/jobs/${jobId}/bids`,
        {
          amount: 150,
          message: "I can fix this today. Licensed and insured.",
        },
        { token: provider.token }
      );
      await expectOkJson(`POST ${r.url}`, r);
      assert(r.status === 201 || r.status === 200, `place bid expected 200/201, got ${r.status}`);
      assert(r.json && (typeof r.json.id === "number" || typeof r.json.id === "string"), "bid expected id");
    }

    // 6) Send message (consumer)
    {
      const r = await postJson(
        baseUrl,
        `/jobs/${jobId}/messages`,
        { text: "Thanks — are you available this afternoon?" },
        { token: consumer.token }
      );
      await expectOkJson(`POST ${r.url}`, r);
      assert(r.status === 201, `send message expected 201, got ${r.status}`);
      assert(r.json && r.json.jobId === Number(jobId), "message expected jobId");
    }

    // 7) Notifications fetch (both endpoints)
    {
      const r1 = await getJson(baseUrl, "/notifications?limit=10", { token: consumer.token });
      await expectOkJson(`GET ${r1.url}`, r1);
      assert(r1.json && Array.isArray(r1.json.items), "/notifications expected { items: [] }");

      const r2 = await getJson(baseUrl, "/me/notifications?limit=10", { token: consumer.token });
      await expectOkJson(`GET ${r2.url}`, r2);
      assert(r2.json && Array.isArray(r2.json.items), "/me/notifications expected { items: [] }");
    }

    console.log("[rc:smoke] OK");
  } finally {
    if (serverProc) {
      console.log("[rc:smoke] stopping local server");
      serverProc.kill("SIGTERM");
      // Give it a moment; don't hang if it refuses.
      await Promise.race([delay(1_000), new Promise((r) => serverProc.once("exit", r))]);
    }
  }
}

main().catch((e) => {
  console.error("[rc:smoke] FAIL:", e?.message || e);
  process.exitCode = 1;
});
