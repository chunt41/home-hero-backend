export type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

export type VisibilityReq = {
  user?: {
    userId: number;
    role: UserRole;
  } | null;
};

export function isAdminLike(req: VisibilityReq): boolean {
  return req.user?.role === "ADMIN";
}

export function jobWhereVisible(req: VisibilityReq): any {
  if (isAdminLike(req)) return {};
  return {
    isHidden: false,
    consumer: { isSuspended: false },
  };
}

/**
 * Shadow-hidden messages are visible to:
 * - admins
 * - the author (senderId)
 * but NOT to other users.
 */
export function messageWhereVisible(req: VisibilityReq): any {
  if (isAdminLike(req)) return {};
  const senderId = req.user?.userId;
  if (typeof senderId === "number") {
    return { OR: [{ isHidden: false }, { senderId }] };
  }
  return { isHidden: false };
}

export function userWhereVisible(req: VisibilityReq): any {
  if (isAdminLike(req)) return {};
  return { isSuspended: false };
}
