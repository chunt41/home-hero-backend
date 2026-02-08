import http from "k6/http";
import { check, sleep } from "k6";

function baseUrl() {
  const raw = String(__ENV.K6_BASE_URL ?? "http://localhost:4000");
  return raw.replace(/\/+$/, "");
}

function vus() {
  const n = Number(__ENV.K6_VUS ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function duration() {
  return String(__ENV.K6_DURATION ?? "30s");
}

function authTokenOrThrow() {
  const t = String(__ENV.K6_AUTH_TOKEN ?? "").trim();
  if (!t) throw new Error("K6_AUTH_TOKEN is required for /me/notifications (Bearer JWT).");
  return t;
}

export const options = {
  vus: vus(),
  duration: duration(),
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<1000"],
  },
};

export default function () {
  const token = authTokenOrThrow();

  const limit = String(__ENV.K6_NOTIF_LIMIT ?? "25");
  const url = `${baseUrl()}/me/notifications?limit=${encodeURIComponent(limit)}`;

  const res = http.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    tags: { name: "GET /me/notifications" },
  });

  check(res, {
    "status is 200 or 429": (r) => r.status === 200 || r.status === 429,
  });

  sleep(Number(__ENV.K6_SLEEP_SECONDS ?? 0.2));
}
