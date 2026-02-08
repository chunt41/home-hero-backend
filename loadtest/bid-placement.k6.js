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
  if (!t) throw new Error("K6_CONSUMER_TOKEN (or K6_AUTH_TOKEN) is required to create the job in setup().");
  return t;
}

function providerTokenOrThrow() {
  const t = token("K6_PROVIDER_TOKEN");
  if (!t) throw new Error("K6_PROVIDER_TOKEN is required for POST /jobs/:id/bids (verified PROVIDER)." );
  return t;
}

function createJobOrThrow(consumerToken) {
  const suffix = `setup-${Date.now()}`;
  const payload = {
    title: `k6 bid target job ${suffix}`,
    description: `k6 setup job for bidding (created ${new Date().toISOString()})`,
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
  const providerToken = providerTokenOrThrow();
  const jobId = data?.jobId;
  if (typeof jobId !== "number") throw new Error("Missing jobId from setup().");

  const payload = {
    amount: Number(__ENV.K6_BID_AMOUNT ?? 175),
    message: String(__ENV.K6_BID_MESSAGE ?? "k6 bid message"),
  };

  const res = http.post(`${baseUrl()}/jobs/${jobId}/bids`, JSON.stringify(payload), {
    headers: {
      Authorization: `Bearer ${providerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    tags: { name: "POST /jobs/:id/bids" },
  });

  check(res, {
    // 201 = new bid, 200 = update bid, 402 = provider out of lead capacity, 429 = rate limited
    "status is 200/201/402/429": (r) => [200, 201, 402, 429].includes(r.status),
  });

  sleep(Number(__ENV.K6_SLEEP_SECONDS ?? 0.2));
}
