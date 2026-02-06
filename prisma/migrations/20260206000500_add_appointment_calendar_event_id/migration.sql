-- Add optional calendar event id for device calendar integrations
ALTER TABLE "Appointment" ADD COLUMN "calendarEventId" TEXT;
