export type CalendarEventInput = {
  title: string;
  startDate: Date;
  endDate: Date;
  notes?: string;
  location?: string;
};

type CalendarLike = {
  EntityTypes: { EVENT: any };
  requestCalendarPermissionsAsync: () => Promise<{ status: string; granted?: boolean }>;
  getCalendarsAsync: (entityType: any) => Promise<any[]>;
  createEventAsync: (
    calendarId: string,
    details: {
      title: string;
      startDate: Date;
      endDate: Date;
      notes?: string;
      location?: string;
      timeZone?: string;
    }
  ) => Promise<string>;
};

let calendarModule: CalendarLike | null = null;

function getCalendarModule(): CalendarLike {
  if (calendarModule) return calendarModule;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    calendarModule = require("expo-calendar") as CalendarLike;
    return calendarModule;
  } catch {
    throw new Error("Calendar integration is not available on this platform/build.");
  }
}

function pickWritableCalendar(calendars: any[]): any | null {
  if (!Array.isArray(calendars) || calendars.length === 0) return null;

  const writable = calendars.filter((c) => c && c.allowsModifications);
  if (writable.length === 0) return null;

  const primary = writable.find((c) => c.isPrimary);
  return primary ?? writable[0];
}

export async function addEventToDeviceCalendar(input: CalendarEventInput): Promise<{ eventId: string }> {
  const Calendar = getCalendarModule();

  const perm = await Calendar.requestCalendarPermissionsAsync();
  const granted = perm.status === "granted" || perm.granted === true;
  if (!granted) {
    throw new Error("Calendar permission was not granted.");
  }

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const calendar = pickWritableCalendar(calendars);
  if (!calendar?.id) {
    throw new Error("No writable calendar found on this device.");
  }

  const start = input.startDate;
  const end = input.endDate;

  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error("Invalid start date");
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid end date");
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error("End time must be after start time");
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const eventId = await Calendar.createEventAsync(String(calendar.id), {
    title: String(input.title || "Appointment").trim() || "Appointment",
    startDate: start,
    endDate: end,
    notes: input.notes,
    location: input.location,
    timeZone,
  });

  return { eventId };
}
