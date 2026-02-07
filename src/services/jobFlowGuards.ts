export function canReviewJob(status: string): boolean {
  return status === "COMPLETED";
}

export function canOpenDispute(status: string): boolean {
  return (
    status === "IN_PROGRESS" ||
    status === "COMPLETED" ||
    status === "COMPLETED_PENDING_CONFIRMATION"
  );
}

export function canMarkComplete(status: string): boolean {
  return status === "IN_PROGRESS";
}

export function canConfirmComplete(status: string): boolean {
  return status === "COMPLETED_PENDING_CONFIRMATION";
}
