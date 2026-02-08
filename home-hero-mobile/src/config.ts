export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  "https://home-hero-backend-production.up.railway.app";

export const PRIVACY_POLICY_URL = (process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL ?? "").trim() || null;
export const TERMS_OF_SERVICE_URL = (process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL ?? "").trim() || null;
