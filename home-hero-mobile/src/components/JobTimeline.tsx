import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

export type JobTimelineJob = {
  status: string;
  createdAt?: string | null;
  awardedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReasonCode?: string | null;
  cancellationReasonDetails?: string | null;
};

const REASON_LABELS: Record<string, string> = {
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

type Step = {
  key: string;
  label: string;
  active: boolean;
  done: boolean;
  note?: string;
};

function formatWhen(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

export function JobTimeline(props: { job: JobTimelineJob }) {
  const { job } = props;

  const steps = useMemo<Step[]>(() => {
    const status = job.status;

    const isCancelled = status === "CANCELLED";
    const isDisputed = status === "DISPUTED";

    const createdWhen = formatWhen(job.createdAt);
    const awardedWhen = formatWhen(job.awardedAt);
    const completedWhen = formatWhen(job.completedAt);
    const cancelledWhen = formatWhen(job.cancelledAt);

    const base: Step[] = [
      {
        key: "created",
        label: "Posted",
        done: true,
        active: status === "OPEN",
        note: createdWhen ?? undefined,
      },
      {
        key: "awarded",
        label: "Awarded",
        done: status !== "OPEN" && !isCancelled,
        active: status === "AWARDED",
        note: awardedWhen ?? undefined,
      },
      {
        key: "in_progress",
        label: "In Progress",
        done:
          status === "IN_PROGRESS" ||
          status === "COMPLETED_PENDING_CONFIRMATION" ||
          status === "COMPLETED" ||
          isDisputed,
        active: status === "IN_PROGRESS",
      },
      {
        key: "completed",
        label: "Completed",
        done: status === "COMPLETED",
        active: status === "COMPLETED_PENDING_CONFIRMATION",
        note: completedWhen ?? (status === "COMPLETED_PENDING_CONFIRMATION" ? "Awaiting confirmation" : undefined),
      },
    ];

    if (isDisputed) {
      base.push({ key: "disputed", label: "Disputed", done: true, active: true });
    }

    if (isCancelled) {
      const reasonLabel = job.cancellationReasonCode
        ? (REASON_LABELS[job.cancellationReasonCode] ?? job.cancellationReasonCode)
        : null;
      const reason = reasonLabel ? `Reason: ${reasonLabel}` : undefined;
      const details = job.cancellationReasonDetails?.trim()
        ? `(${job.cancellationReasonDetails.trim()})`
        : "";
      base.push({
        key: "cancelled",
        label: "Cancelled",
        done: true,
        active: true,
        note: [cancelledWhen, reason ? `${reason} ${details}`.trim() : null].filter(Boolean).join(" • ") || undefined,
      });
    }

    return base;
  }, [job]);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Timeline</Text>
      <View style={{ gap: 10, marginTop: 8 }}>
        {steps.map((s) => (
          <View key={s.key} style={styles.stepRow}>
            <View
              style={[
                styles.dot,
                s.done && styles.dotDone,
                s.active && styles.dotActive,
              ]}
            />
            <View style={{ flex: 1 }}>
              <Text style={[styles.stepLabel, s.active && styles.stepLabelActive]}>
                {s.label}
              </Text>
              {s.note ? <Text style={styles.note}>{s.note}</Text> : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
  },
  title: { color: "#fff", fontWeight: "900", fontSize: 14 },
  stepRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#334155",
    marginTop: 3,
  },
  dotDone: { backgroundColor: "#38bdf8", borderColor: "#38bdf8" },
  dotActive: { borderColor: "#fbbf24" },
  stepLabel: { color: "#e2e8f0", fontWeight: "900" },
  stepLabelActive: { color: "#fbbf24" },
  note: { color: "#cbd5e1", fontSize: 12, marginTop: 2 },
});
