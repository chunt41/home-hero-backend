import client from "prom-client";

let _initialized = false;
let _enabled = false;

const register = new client.Registry();

let attestationCacheHits: client.Counter<string> | null = null;
let attestationCacheMisses: client.Counter<string> | null = null;
let attestationCacheHitRatio: client.Gauge<string> | null = null;

const localCounts = {
  hits: 0,
  misses: 0,
};

export function isMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.METRICS_ENABLED ?? "").toLowerCase() === "true";
}

function initIfNeeded() {
  if (_initialized) return;
  _initialized = true;
  _enabled = isMetricsEnabled(process.env);

  if (!_enabled) return;

  register.setDefaultLabels({ app: "home-hero-backend" });
  client.collectDefaultMetrics({ register });

  attestationCacheHits = new client.Counter({
    name: "attestation_cache_hits_total",
    help: "Total number of attestation cache hits",
    registers: [register],
  });

  attestationCacheMisses = new client.Counter({
    name: "attestation_cache_misses_total",
    help: "Total number of attestation cache misses",
    registers: [register],
  });

  attestationCacheHitRatio = new client.Gauge({
    name: "attestation_cache_hit_ratio",
    help: "Best-effort attestation cache hit ratio (hits / (hits + misses))",
    registers: [register],
  });
}

function updateRatio() {
  if (!attestationCacheHitRatio) return;
  const total = localCounts.hits + localCounts.misses;
  const ratio = total > 0 ? localCounts.hits / total : 0;
  attestationCacheHitRatio.set(ratio);
}

export function recordAttestationCacheHit() {
  initIfNeeded();
  localCounts.hits += 1;
  if (attestationCacheHits) attestationCacheHits.inc();
  updateRatio();
}

export function recordAttestationCacheMiss() {
  initIfNeeded();
  localCounts.misses += 1;
  if (attestationCacheMisses) attestationCacheMisses.inc();
  updateRatio();
}

export function prometheusContentType(): string {
  initIfNeeded();
  return register.contentType;
}

export async function prometheusMetricsText(): Promise<string> {
  initIfNeeded();
  if (!_enabled) return "";
  return register.metrics();
}
