export class RescheduleJobError extends Error {
  runAt: Date;

  constructor(runAt: Date, message: string = "Rescheduled") {
    super(message);
    this.name = "RescheduleJobError";
    this.runAt = runAt;
  }
}

export function isRescheduleJobError(err: unknown): err is RescheduleJobError {
  return err instanceof RescheduleJobError;
}
