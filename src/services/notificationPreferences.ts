export type NotificationKind = "JOB_MATCH" | "BID" | "MESSAGE";

export type NotificationPreferenceLike = {
  userId: number;
  jobMatchEnabled: boolean;
  jobMatchDigestEnabled: boolean;
  jobMatchDigestIntervalMinutes: number;
  jobMatchDigestLastSentAt: Date | null;
  bidEnabled: boolean;
  messageEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
};

export const DEFAULT_TIMEZONE = "UTC";

export const DEFAULT_NOTIFICATION_PREFERENCE = {
  jobMatchEnabled: true,
  jobMatchDigestEnabled: false,
  jobMatchDigestIntervalMinutes: 15,
  jobMatchDigestLastSentAt: null,
  bidEnabled: true,
  messageEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: DEFAULT_TIMEZONE,
} satisfies Omit<NotificationPreferenceLike, "userId">;

export function normalizePreference(
  pref: Partial<NotificationPreferenceLike> | null | undefined
): Omit<NotificationPreferenceLike, "userId"> {
  return {
    jobMatchEnabled: pref?.jobMatchEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.jobMatchEnabled,
    jobMatchDigestEnabled: pref?.jobMatchDigestEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.jobMatchDigestEnabled,
    jobMatchDigestIntervalMinutes:
      typeof pref?.jobMatchDigestIntervalMinutes === "number" && Number.isFinite(pref.jobMatchDigestIntervalMinutes)
        ? pref.jobMatchDigestIntervalMinutes
        : DEFAULT_NOTIFICATION_PREFERENCE.jobMatchDigestIntervalMinutes,
    jobMatchDigestLastSentAt: (pref as any)?.jobMatchDigestLastSentAt ?? DEFAULT_NOTIFICATION_PREFERENCE.jobMatchDigestLastSentAt,
    bidEnabled: pref?.bidEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.bidEnabled,
    messageEnabled: pref?.messageEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.messageEnabled,
    quietHoursStart: pref?.quietHoursStart ?? DEFAULT_NOTIFICATION_PREFERENCE.quietHoursStart,
    quietHoursEnd: pref?.quietHoursEnd ?? DEFAULT_NOTIFICATION_PREFERENCE.quietHoursEnd,
    timezone: pref?.timezone ?? DEFAULT_NOTIFICATION_PREFERENCE.timezone,
  };
}

export function parseHHMM(value: string): { hours: number; minutes: number } | null {
  if (typeof value !== "string") return null;
  const m = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value.trim());
  if (!m) return null;
  const [hh, mm] = value.split(":");
  const hours = Number(hh);
  const minutes = Number(mm);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return { hours, minutes };
}

export function toMinutesSinceMidnight(hhmm: string): number | null {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return null;
  return parsed.hours * 60 + parsed.minutes;
}

function getLocalMinutesSinceMidnight(now: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour")?.value;
  const minutePart = parts.find((p) => p.type === "minute")?.value;

  const hours = Number(hourPart);
  const minutes = Number(minutePart);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }

  return hours * 60 + minutes;
}

export function isWithinQuietHours(
  pref: Omit<NotificationPreferenceLike, "userId">,
  now: Date = new Date()
): boolean {
  const start = pref.quietHoursStart ? toMinutesSinceMidnight(pref.quietHoursStart) : null;
  const end = pref.quietHoursEnd ? toMinutesSinceMidnight(pref.quietHoursEnd) : null;

  if (start == null || end == null) return false;
  if (start === end) return false;

  let localMinutes: number;
  try {
    localMinutes = getLocalMinutesSinceMidnight(now, pref.timezone || DEFAULT_TIMEZONE);
  } catch {
    localMinutes = getLocalMinutesSinceMidnight(now, DEFAULT_TIMEZONE);
  }

  if (start < end) {
    return localMinutes >= start && localMinutes < end;
  }

  // Wraps midnight.
  return localMinutes >= start || localMinutes < end;
}

export function getNextAllowedSendAt(
  prefInput: Partial<NotificationPreferenceLike> | null | undefined,
  now: Date = new Date()
): Date {
  const pref = normalizePreference(prefInput);
  const start = pref.quietHoursStart ? toMinutesSinceMidnight(pref.quietHoursStart) : null;
  const end = pref.quietHoursEnd ? toMinutesSinceMidnight(pref.quietHoursEnd) : null;
  if (start == null || end == null) return now;
  if (start === end) return now;

  let localMinutes: number;
  try {
    localMinutes = getLocalMinutesSinceMidnight(now, pref.timezone || DEFAULT_TIMEZONE);
  } catch {
    localMinutes = getLocalMinutesSinceMidnight(now, DEFAULT_TIMEZONE);
  }

  const within = isWithinQuietHours(pref, now);
  if (!within) return now;

  let minutesUntilEnd = 0;
  if (start < end) {
    minutesUntilEnd = Math.max(0, end - localMinutes);
  } else {
    // Wraps midnight.
    minutesUntilEnd = localMinutes >= start ? (1440 - localMinutes) + end : Math.max(0, end - localMinutes);
  }

  // Add a small buffer to avoid edge flapping.
  return new Date(now.getTime() + minutesUntilEnd * 60_000 + 5_000);
}

export function isKindEnabled(pref: Omit<NotificationPreferenceLike, "userId">, kind: NotificationKind): boolean {
  switch (kind) {
    case "JOB_MATCH":
      return !!pref.jobMatchEnabled;
    case "BID":
      return !!pref.bidEnabled;
    case "MESSAGE":
      return !!pref.messageEnabled;
    default:
      return true;
  }
}

export function shouldSendNotification(
  prefInput: Partial<NotificationPreferenceLike> | null | undefined,
  kind: NotificationKind,
  now: Date = new Date()
): boolean {
  const pref = normalizePreference(prefInput);
  if (!isKindEnabled(pref, kind)) return false;
  if (isWithinQuietHours(pref, now)) return false;
  return true;
}

export function isMissingTableOrRelationError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "");
  return (/relation/i.test(msg) || /table/i.test(msg)) && /does not exist/i.test(msg);
}

export async function getNotificationPreferencesMap(deps: {
  prisma: {
    notificationPreference: {
      findMany: (args: any) => Promise<Array<NotificationPreferenceLike>>;
    };
  };
  userIds: number[];
}): Promise<Map<number, NotificationPreferenceLike>> {
  const { prisma, userIds } = deps;
  const uniqueIds = Array.from(new Set(userIds.filter((id) => Number.isFinite(id))));
  const map = new Map<number, NotificationPreferenceLike>();
  if (!uniqueIds.length) return map;

  try {
    const rows = await prisma.notificationPreference.findMany({
      where: { userId: { in: uniqueIds } },
    });

    for (const r of rows) {
      map.set(r.userId, {
        userId: r.userId,
        jobMatchEnabled: !!r.jobMatchEnabled,
        jobMatchDigestEnabled: !!(r as any).jobMatchDigestEnabled,
        jobMatchDigestIntervalMinutes: Number((r as any).jobMatchDigestIntervalMinutes ?? DEFAULT_NOTIFICATION_PREFERENCE.jobMatchDigestIntervalMinutes),
        jobMatchDigestLastSentAt: ((r as any).jobMatchDigestLastSentAt as any) ?? null,
        bidEnabled: !!r.bidEnabled,
        messageEnabled: !!r.messageEnabled,
        quietHoursStart: (r as any).quietHoursStart ?? null,
        quietHoursEnd: (r as any).quietHoursEnd ?? null,
        timezone: (r as any).timezone ?? DEFAULT_TIMEZONE,
      });
    }

    return map;
  } catch (err) {
    if (isMissingTableOrRelationError(err)) return map;
    throw err;
  }
}
