import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { api } from "../src/lib/apiClient";
import { router } from "expo-router";

type Prefs = {
  userId: number;
  jobMatchEnabled: boolean;
  jobMatchDigestEnabled: boolean;
  jobMatchDigestIntervalMinutes: number;
  bidEnabled: boolean;
  messageEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
};

function guessDeviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export default function NotificationPreferencesScreen() {
  const deviceTz = useMemo(() => guessDeviceTimeZone(), []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobMatchEnabled, setJobMatchEnabled] = useState(true);
  const [jobMatchDigestEnabled, setJobMatchDigestEnabled] = useState(false);
  const [jobMatchDigestIntervalMinutes, setJobMatchDigestIntervalMinutes] = useState<string>("15");
  const [bidEnabled, setBidEnabled] = useState(true);
  const [messageEnabled, setMessageEnabled] = useState(true);
  const [quietStart, setQuietStart] = useState<string>("");
  const [quietEnd, setQuietEnd] = useState<string>("");
  const [timezone, setTimezone] = useState<string>(deviceTz);

  async function load() {
    setLoading(true);
    setError(null);

    try {
      const data = await api.get<Prefs>("/me/notification-preferences");
      setJobMatchEnabled(!!data.jobMatchEnabled);
      setJobMatchDigestEnabled(!!data.jobMatchDigestEnabled);
      setJobMatchDigestIntervalMinutes(String(data.jobMatchDigestIntervalMinutes ?? 15));
      setBidEnabled(!!data.bidEnabled);
      setMessageEnabled(!!data.messageEnabled);
      setQuietStart(data.quietHoursStart ?? "");
      setQuietEnd(data.quietHoursEnd ?? "");
      setTimezone(data.timezone || deviceTz);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setSaving(true);
    setError(null);

    const start = quietStart.trim();
    const end = quietEnd.trim();

    const bothEmpty = !start && !end;
    const oneEmpty = (!start && !!end) || (!!start && !end);

    if (oneEmpty) {
      setSaving(false);
      setError("Set both quiet hour times (or clear both). Example: 22:00 → 07:00");
      return;
    }

    const digestInterval = Number(jobMatchDigestIntervalMinutes);
    if (jobMatchDigestEnabled) {
      if (!Number.isFinite(digestInterval) || !Number.isInteger(digestInterval)) {
        setSaving(false);
        setError("Digest interval must be a whole number of minutes (e.g. 15)");
        return;
      }
      if (digestInterval < 5 || digestInterval > 1440) {
        setSaving(false);
        setError("Digest interval must be between 5 and 1440 minutes");
        return;
      }
    }

    try {
      await api.put<Prefs>("/me/notification-preferences", {
        jobMatchEnabled,
        jobMatchDigestEnabled,
        jobMatchDigestIntervalMinutes: jobMatchDigestEnabled ? digestInterval : undefined,
        bidEnabled,
        messageEnabled,
        quietHoursStart: bothEmpty ? null : start,
        quietHoursEnd: bothEmpty ? null : end,
        timezone: (timezone || deviceTz).trim(),
      });

      router.back();
    } catch (e: any) {
      setError(e?.message ?? "Failed to save preferences");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }} edges={["top"]}>
      <StatusBar style="light" backgroundColor="#020617" />

      <View style={{ padding: 16, gap: 14 }}>
        <Text style={{ color: "#e2e8f0", fontSize: 22, fontWeight: "900" }}>
          Notification Settings
        </Text>

        {loading ? (
          <View style={{ marginTop: 24 }}>
            <ActivityIndicator color="#38bdf8" />
            <Text style={{ color: "#94a3b8", marginTop: 10, textAlign: "center" }}>
              Loading preferences...
            </Text>
          </View>
        ) : (
          <>
            {error ? (
              <View
                style={{
                  backgroundColor: "#3f1d1d",
                  borderColor: "#ef4444",
                  borderWidth: 1,
                  padding: 12,
                  borderRadius: 10,
                }}
              >
                <Text style={{ color: "#fecaca", fontWeight: "800" }}>{error}</Text>
              </View>
            ) : null}

            <View
              style={{
                backgroundColor: "#0f172a",
                borderColor: "#1e293b",
                borderWidth: 1,
                padding: 12,
                borderRadius: 12,
                gap: 10,
              }}
            >
              <Row label="Job matches" value={jobMatchEnabled} onChange={setJobMatchEnabled} />
              <Row
                label="Job match digest"
                value={jobMatchDigestEnabled}
                onChange={setJobMatchDigestEnabled}
              />

              {jobMatchDigestEnabled ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: "#cbd5e1", fontWeight: "800" }}>
                    Digest interval (minutes)
                  </Text>
                  <TextInput
                    value={jobMatchDigestIntervalMinutes}
                    onChangeText={setJobMatchDigestIntervalMinutes}
                    placeholder="15"
                    placeholderTextColor="#64748b"
                    keyboardType="number-pad"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      backgroundColor: "#020617",
                      borderColor: "#1e293b",
                      borderWidth: 1,
                      padding: 10,
                      borderRadius: 10,
                      color: "#e2e8f0",
                      fontWeight: "800",
                    }}
                  />
                  <Text style={{ color: "#94a3b8" }}>
                    We’ll group job matches and send one summary.
                  </Text>
                </View>
              ) : null}
              <Row label="New bids" value={bidEnabled} onChange={setBidEnabled} />
              <Row label="Messages" value={messageEnabled} onChange={setMessageEnabled} />
            </View>

            <View
              style={{
                backgroundColor: "#0f172a",
                borderColor: "#1e293b",
                borderWidth: 1,
                padding: 12,
                borderRadius: 12,
                gap: 10,
              }}
            >
              <Text style={{ color: "#e2e8f0", fontWeight: "900" }}>Quiet hours</Text>
              <Text style={{ color: "#94a3b8" }}>
                Set a window when we won’t send notifications.
              </Text>

              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#cbd5e1", fontWeight: "800", marginBottom: 6 }}>
                    Start (HH:MM)
                  </Text>
                  <TextInput
                    value={quietStart}
                    onChangeText={setQuietStart}
                    placeholder="22:00"
                    placeholderTextColor="#64748b"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      backgroundColor: "#020617",
                      borderColor: "#1e293b",
                      borderWidth: 1,
                      padding: 10,
                      borderRadius: 10,
                      color: "#e2e8f0",
                      fontWeight: "800",
                    }}
                  />
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#cbd5e1", fontWeight: "800", marginBottom: 6 }}>
                    End (HH:MM)
                  </Text>
                  <TextInput
                    value={quietEnd}
                    onChangeText={setQuietEnd}
                    placeholder="07:00"
                    placeholderTextColor="#64748b"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{
                      backgroundColor: "#020617",
                      borderColor: "#1e293b",
                      borderWidth: 1,
                      padding: 10,
                      borderRadius: 10,
                      color: "#e2e8f0",
                      fontWeight: "800",
                    }}
                  />
                </View>
              </View>

              <Text style={{ color: "#64748b", fontWeight: "800" }}>
                Time zone
              </Text>
              <TextInput
                value={timezone}
                onChangeText={setTimezone}
                placeholder={deviceTz}
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  backgroundColor: "#020617",
                  borderColor: "#1e293b",
                  borderWidth: 1,
                  padding: 10,
                  borderRadius: 10,
                  color: "#e2e8f0",
                  fontWeight: "800",
                }}
              />
              <Text style={{ color: "#94a3b8" }}>
                Tip: leave as your device time zone.
              </Text>
            </View>

            <Pressable
              onPress={save}
              disabled={saving}
              style={{
                backgroundColor: saving ? "#0b4461" : "#0284c7",
                padding: 14,
                borderRadius: 12,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "900", fontSize: 16 }}>
                {saving ? "Saving..." : "Save"}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => router.back()}
              style={{
                padding: 12,
                borderRadius: 12,
                alignItems: "center",
                borderWidth: 1,
                borderColor: "#1e293b",
                backgroundColor: "#0f172a",
              }}
            >
              <Text style={{ color: "#cbd5e1", fontWeight: "900" }}>Cancel</Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function Row(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 4,
      }}
    >
      <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 16 }}>
        {props.label}
      </Text>
      <Switch
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ false: "#334155", true: "#38bdf8" }}
        thumbColor={props.value ? "#e2e8f0" : "#94a3b8"}
      />
    </View>
  );
}
