import http from "k6/http";
import { check, sleep } from "k6";

function baseUrl() {
  const raw = String(__ENV.K6_BASE_URL ?? "http://localhost:4000");
  return raw.replace(/\/+$/, "");
}

function vus() {
  const n = Number(__ENV.K6_VUS ?? 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

function duration() {
  return String(__ENV.K6_DURATION ?? "20s");
}

function authTokenOrThrow() {
  const t = String(__ENV.K6_AUTH_TOKEN ?? "").trim();
  if (!t) throw new Error("K6_AUTH_TOKEN is required for POST /jobs (Bearer JWT for a verified CONSUMER).");
  return t;
}

export const options = {
  vus: vus(),
  duration: duration(),
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000"],
  },
};

export default function () {
  const token = authTokenOrThrow();

  const suffix = `${__VU}-${__ITER}-${Date.now()}`;
  const payload = {
    title: `k6 job ${suffix}`,
    description: `k6 load test job created at ${new Date().toISOString()}`,
    budgetMin: 100,
    budgetMax: 250,
    location: String(__ENV.K6_JOB_LOCATION ?? "New York, NY"),
  };

  const res = http.post(`${baseUrl()}/jobs`, JSON.stringify(payload), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    tags: { name: "POST /jobs" },
  });

  check(res, {
    "status is 201/202 or 429": (r) => r.status === 201 || r.status === 202 || r.status === 429,
  });

  sleep(Number(__ENV.K6_SLEEP_SECONDS ?? 0.2));
}
