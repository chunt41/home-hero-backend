import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "../lib/apiClient";

const COLORS = {
  bg: "#0f172a",
  card: "#1e293b",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  accent: "#38bdf8",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  border: "#334155",
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type AvailabilitySlot = {
  id: number;
  providerId: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
};

type AvailabilityResponse = {
  timezone: string | null;
  slots: AvailabilitySlot[];
};

function isHHMM(s: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim());
}

export default function ProviderAvailabilityScreen() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [timezone, setTimezone] = useState<string>(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [slots, setSlots] = useState<Pick<AvailabilitySlot, "dayOfWeek" | "startTime" | "endTime">[]>([]);

  const [newDay, setNewDay] = useState(1);
  const [newStart, setNewStart] = useState("09:00");
  const [newEnd, setNewEnd] = useState("17:00");

  const grouped = useMemo(() => {
    const m: Record<number, { startTime: string; endTime: string; idx: number }[]> = {
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
    };

    slots.forEach((s, idx) => {
      if (typeof m[s.dayOfWeek] !== "undefined") {
        m[s.dayOfWeek].push({ startTime: s.startTime, endTime: s.endTime, idx });
      }
    });

    Object.keys(m).forEach((k) => {
      m[Number(k)].sort((a, b) => a.startTime.localeCompare(b.startTime));
    });

    return m;
  }, [slots]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<AvailabilityResponse>("/provider/availability");
      if (data?.timezone) setTimezone(data.timezone);
      setSlots(
        (data?.slots ?? []).map((s) => ({
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
        }))
      );
    } catch (e: any) {
      setError(e?.message ?? "Failed to load availability");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const addSlot = useCallback(() => {
    const start = newStart.trim();
    const end = newEnd.trim();
    if (!isHHMM(start) || !isHHMM(end)) {
      Alert.alert("Invalid time", "Use HH:MM in 24-hour format (e.g. 09:00). ");
      return;
    }

    if (end <= start) {
      Alert.alert("Invalid range", "End time must be after start time.");
      return;
    }

    setSlots((prev) => [...prev, { dayOfWeek: newDay, startTime: start, endTime: end }]);
  }, [newDay, newStart, newEnd]);

  const removeSlot = useCallback((idx: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const onSave = useCallback(async () => {
    const tz = timezone.trim();
    if (!tz) {
      Alert.alert("Timezone required", "Enter a valid IANA timezone like America/New_York.");
      return;
    }

    for (const s of slots) {
      if (!isHHMM(s.startTime) || !isHHMM(s.endTime) || s.endTime <= s.startTime) {
        Alert.alert("Fix availability", "Each slot must have start/end in HH:MM and end must be after start.");
        return;
      }
    }

    setSaving(true);
    try {
      await api.put("/provider/availability", {
        timezone: tz,
        slots: slots.map((s) => ({
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime.trim(),
          endTime: s.endTime.trim(),
        })),
      });
      await load();
      Alert.alert("Saved", "Your availability is updated.");
    } catch (e: any) {
      Alert.alert("Save failed", e?.message ?? "Could not save availability");
    } finally {
      setSaving(false);
    }
  }, [timezone, slots, load]);

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <MaterialCommunityIcons name="chevron-left" size={24} color={COLORS.accent} />
        </Pressable>
        <Text style={styles.headerTitle}>Availability</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading availability…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.primaryBtn} onPress={load}>
            <Text style={styles.primaryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Timezone</Text>
            <Text style={styles.mutedSmall}>Used to interpret your weekly slots.</Text>
            <TextInput
              value={timezone}
              onChangeText={setTimezone}
              placeholder="e.g. America/New_York"
              placeholderTextColor={COLORS.textMuted}
              style={styles.input}
              editable={!saving}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add slot</Text>

            <Text style={styles.label}>Day</Text>
            <View style={styles.chipsRow}>
              {DOW.map((d, idx) => {
                const active = idx === newDay;
                return (
                  <Pressable
                    key={d}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => setNewDay(idx)}
                    disabled={saving}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{d}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Start</Text>
                <TextInput
                  value={newStart}
                  onChangeText={setNewStart}
                  placeholder="09:00"
                  placeholderTextColor={COLORS.textMuted}
                  style={styles.input}
                  editable={!saving}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={{ width: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>End</Text>
                <TextInput
                  value={newEnd}
                  onChangeText={setNewEnd}
                  placeholder="17:00"
                  placeholderTextColor={COLORS.textMuted}
                  style={styles.input}
                  editable={!saving}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            <Pressable style={[styles.secondaryBtn, saving && styles.btnDisabled]} onPress={addSlot} disabled={saving}>
              <Text style={styles.secondaryText}>Add slot</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>Weekly slots</Text>
              <Pressable
                style={[styles.primaryBtnSmall, saving && styles.btnDisabled]}
                onPress={onSave}
                disabled={saving}
              >
                <Text style={styles.primaryTextSmall}>{saving ? "Saving…" : "Save"}</Text>
              </Pressable>
            </View>

            {slots.length === 0 ? (
              <Text style={styles.mutedSmall}>No slots yet. Add at least one.</Text>
            ) : (
              <View style={{ gap: 12 }}>
                {Object.keys(grouped)
                  .map((k) => Number(k))
                  .map((day) => {
                    const items = grouped[day];
                    if (!items || items.length === 0) return null;
                    return (
                      <View key={String(day)}>
                        <Text style={styles.dayTitle}>{DOW[day]}</Text>
                        <View style={{ gap: 8 }}>
                          {items.map((it) => (
                            <View key={`${day}-${it.startTime}-${it.endTime}-${it.idx}`} style={styles.slotRow}>
                              <Text style={styles.slotText}>
                                {it.startTime} – {it.endTime}
                              </Text>
                              <Pressable
                                onPress={() => removeSlot(it.idx)}
                                disabled={saving}
                                hitSlop={10}
                              >
                                <MaterialCommunityIcons name="trash-can-outline" size={18} color={COLORS.danger} />
                              </Pressable>
                            </View>
                          ))}
                        </View>
                      </View>
                    );
                  })}
              </View>
            )}
          </View>

          <View style={styles.noteCard}>
            <Text style={styles.noteText}>
              Appointments are checked against CONFIRMED bookings. Proposed times can still overlap until a provider confirms.
            </Text>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },

  header: {
    paddingHorizontal: 14,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
  },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: "900" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  muted: { color: "#cbd5e1", marginTop: 10 },
  mutedSmall: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  error: { color: "#fca5a5", textAlign: "center", marginBottom: 12 },

  scroll: { padding: 16, paddingBottom: 26, gap: 12 },

  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14 },
  cardTitle: { color: COLORS.text, fontWeight: "900", marginBottom: 10, fontSize: 14 },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },

  label: { color: COLORS.textMuted, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: COLORS.text,
  },

  row: { flexDirection: "row", alignItems: "center" },

  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  chipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  chipText: { color: COLORS.textMuted, fontWeight: "800", fontSize: 12 },
  chipTextActive: { color: "#020617" },

  slotRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
  },
  slotText: { color: COLORS.text, fontWeight: "800" },
  dayTitle: { color: COLORS.textMuted, fontWeight: "900", marginBottom: 6 },

  actionsRow: { flexDirection: "row", gap: 10, marginTop: 12 },

  primaryBtn: { backgroundColor: COLORS.accent, padding: 12, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#020617", fontWeight: "900" },

  primaryBtnSmall: { backgroundColor: COLORS.accent, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  primaryTextSmall: { color: "#020617", fontWeight: "900" },

  secondaryBtn: { backgroundColor: "#1e293b", padding: 12, borderRadius: 12, alignItems: "center", marginTop: 12 },
  secondaryText: { color: COLORS.text, fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },

  noteCard: { backgroundColor: "#071427", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#0b2a45" },
  noteText: { color: "#93c5fd", fontSize: 12, lineHeight: 18 },
});
