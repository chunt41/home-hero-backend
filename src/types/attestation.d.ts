import type { AttestationInfo } from "../middleware/requireAttestation";

declare global {
  namespace Express {
    interface Request {
      attested?: boolean;
      attestation?: AttestationInfo;
    }
  }
}

export {};
