export const JOB_CANCELLATION_REASON_LABELS: Record<string, string> = {
  CHANGE_OF_PLANS: "Change of plans",
  HIRED_SOMEONE_ELSE: "Hired someone else",
  TOO_EXPENSIVE: "Too expensive",
  SCHEDULING_CONFLICT: "Scheduling conflict",
  NO_SHOW: "No show",
  UNRESPONSIVE: "Unresponsive",
  SAFETY_CONCERN: "Safety concern",
  DUPLICATE_JOB: "Duplicate job",
  OTHER: "Other",
};

export function cancellationReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return JOB_CANCELLATION_REASON_LABELS[code] ?? code;
}
