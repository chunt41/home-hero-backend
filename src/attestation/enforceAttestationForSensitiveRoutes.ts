import type { Express } from "express";

import { requireAttestation } from "../middleware/requireAttestation";

/**
 * Registers scoped app-attestation enforcement.
 *
 * Note: `requireAttestation` is still a no-op unless `APP_ATTESTATION_ENFORCE=true`.
 */
export function enforceAttestationForSensitiveRoutes(app: Express) {
  // --- Auth ---
  app.post("/auth/signup", requireAttestation);
  app.post("/auth/login", requireAttestation);
  app.post("/auth/forgot-password", requireAttestation);
  app.post("/auth/reset-password", requireAttestation);
  app.post("/auth/verify-email", requireAttestation);

  // --- Jobs (writes) ---
  app.post("/jobs", requireAttestation);
  app.post("/jobs/:jobId/attachments", requireAttestation);
  app.post("/jobs/:jobId/attachments/upload", requireAttestation);
  app.post("/jobs/:jobId/bids/:bidId/accept", requireAttestation);
  app.post("/jobs/:jobId/award", requireAttestation);
  app.post("/jobs/:jobId/cancel", requireAttestation);
  app.post("/jobs/:jobId/complete", requireAttestation);
  app.post("/jobs/:jobId/disputes", requireAttestation);
  app.post("/jobs/:id/mark-complete", requireAttestation);
  app.post("/jobs/:id/start", requireAttestation);
  app.post("/jobs/:id/confirm-complete", requireAttestation);

  // --- Bids ---
  // (place + update via upsert/counter actions)
  app.post("/jobs/:jobId/bids", requireAttestation);
  app.post("/bids/:bidId/counter", requireAttestation);
  app.post("/bids/:bidId/counter/accept", requireAttestation);
  app.post("/bids/:bidId/counter/decline", requireAttestation);

  // --- Messaging ---
  // Send message + upload attachments
  app.post("/jobs/:jobId/messages", requireAttestation);

  // --- Payments ---
  app.post("/payments/create-intent", requireAttestation);
  app.post("/provider/addons/purchase", requireAttestation);
  app.post("/subscription/upgrade", requireAttestation);
  app.post("/subscription/downgrade", requireAttestation);
}
