type AttestationTokenState = {
  token: string;
  expiresAtMs: number;
};

let cached: AttestationTokenState | null = null;

function nowMs() {
  return Date.now();
}

/**
 * Stub implementation.
 *
 * For production, replace with:
 * - Android: Play Integrity API (server-side verification)
 * - iOS: App Attest / DeviceCheck (server-side verification)
 */
async function mintStubToken(): Promise<AttestationTokenState> {
  // The backend currently accepts a JWT signed with env-provided keys.
  // The mobile app cannot safely hold a signing key, so this stub returns a
  // non-JWT token and is intended for development until real attestation is wired.
  const token = `stub.${Math.random().toString(16).slice(2)}.${nowMs()}`;
  return { token, expiresAtMs: nowMs() + 5 * 60_000 };
}

export async function getAppAttestationToken(): Promise<string> {
  const skewMs = 30_000;
  if (cached && cached.expiresAtMs - skewMs > nowMs()) return cached.token;
  cached = await mintStubToken();
  return cached.token;
}
