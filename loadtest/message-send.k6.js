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

function token(name) {
  return String(__ENV[name] ?? "").trim();
}

function consumerTokenOrThrow() {
  const t = token("K6_CONSUMER_TOKEN") || token("K6_AUTH_TOKEN");
  if (!t) throw new Error("K6_CONSUMER_TOKEN (or K6_AUTH_TOKEN) is required for POST /jobs and /jobs/:id/messages.");
  return t;
}

function createJobOrThrow(consumerToken) {
  const suffix = `setup-${Date.now()}`;
  const payload = {
    title: `k6 message target job ${suffix}`,
    description: `k6 setup job for messaging (created ${new Date().toISOString()})`,
    budgetMin: 100,
    budgetMax: 250,
    location: String(__ENV.K6_JOB_LOCATION ?? "New York, NY"),
  };

  const res = http.post(`${baseUrl()}/jobs`, JSON.stringify(payload), {
    headers: {
      Authorization: `Bearer ${consumerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    tags: { name: "setup POST /jobs" },
  });

  if (!(res.status === 201 || res.status === 202)) {
    throw new Error(`setup() failed to create job (status=${res.status} body=${String(res.body).slice(0, 300)})`);
  }

  const jobId = res.json("id");
  if (typeof jobId !== "number") {
    throw new Error(`setup() expected numeric job id but got: ${String(jobId)}`);
  }

  return jobId;
}

export const options = {
  vus: vus(),
  duration: duration(),
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000"],
  },
};

export function setup() {
  const consumerToken = consumerTokenOrThrow();
  const jobId = createJobOrThrow(consumerToken);
  return { jobId };
}

export default function (data) {
  const consumerToken = consumerTokenOrThrow();
  const jobId = data?.jobId;
  if (typeof jobId !== "number") throw new Error("Missing jobId from setup().");

  const payload = {
    text: `k6 message ${__VU}-${__ITER} @ ${new Date().toISOString()}`,
  };

  const res = http.post(`${baseUrl()}/jobs/${jobId}/messages`, JSON.stringify(payload), {
    headers: {
      Authorization: `Bearer ${consumerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    tags: { name: "POST /jobs/:id/messages" },
  });

  check(res, {
    "status is 201 or 429": (r) => r.status === 201 || r.status === 429,
  });

  sleep(Number(__ENV.K6_SLEEP_SECONDS ?? 0.2));
}
