export class AttestationError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 401, code = "ATTESTATION_INVALID") {
    super(message);
    this.name = "AttestationError";
    this.status = status;
    this.code = code;
  }
}
