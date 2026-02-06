// app/consumer/create-job.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { api } from "../../src/lib/apiClient";

type PriceSuggestion = {
  suggestedMinPrice: number | null;
  suggestedMaxPrice: number | null;
  suggestedReason: string | null;
};

type SuggestPriceResponse = {
  suggestion: PriceSuggestion;
};

type CreateJobResponse = {
  id: number;
  reviewRequired?: boolean;
  restrictedUntil?: string | null;
};

function formatMoney(n: number | null | undefined) {
  if (n == null) return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `$${n}`;
  }
}

export default function CreateJobScreen() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [budgetMin, setBudgetMin] = useState("");
  const [budgetMax, setBudgetMax] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [suggestion, setSuggestion] = useState<PriceSuggestion | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [restrictedNotice, setRestrictedNotice] = useState<string | null>(null);
  const suggestRequestIdRef = useRef(0);

  const canSubmit = useMemo(() => {
    return title.trim().length > 0 && description.trim().length > 0 && !submitting;
  }, [title, description, submitting]);

  useEffect(() => {
    const t = title.trim();
    const d = description.trim();

    if (!t || !d) {
      setSuggestion(null);
      setSuggestLoading(false);
      return;
    }

    const requestId = ++suggestRequestIdRef.current;
    setSuggestLoading(true);

    const timer = setTimeout(async () => {
      try {
        const data = await api.post<SuggestPriceResponse>("/jobs/suggest-price", {
          title: t,
          description: d,
          location: location.trim() || null,
        });
        if (requestId !== suggestRequestIdRef.current) return;
        setSuggestion(data?.suggestion ?? null);
        setRestrictedNotice(null);
      } catch (e: any) {
        if (requestId !== suggestRequestIdRef.current) return;
        setSuggestion(null);

        if (e?.status === 403 && e?.details?.code === "RESTRICTED") {
          setRestrictedNotice(
            e?.message ?? "Your account is temporarily restricted. Please try again later."
          );
        } else {
          setRestrictedNotice(null);
        }
      } finally {
        if (requestId !== suggestRequestIdRef.current) return;
        setSuggestLoading(false);
      }
    }, 450);

    return () => clearTimeout(timer);
  }, [title, description, location]);

  const toNumberOrNull = (v: string) => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const submit = async () => {
    const t = title.trim();
    const d = description.trim();

    if (!t || !d) {
      Alert.alert("Missing info", "Title and description are required.");
      return;
    }

    const min = toNumberOrNull(budgetMin);
    const max = toNumberOrNull(budgetMax);

    if (budgetMin.trim() && min === null) {
      Alert.alert("Budget min", "Budget min must be a number.");
      return;
    }
    if (budgetMax.trim() && max === null) {
      Alert.alert("Budget max", "Budget max must be a number.");
      return;
    }
    if (min !== null && max !== null && min > max) {
      Alert.alert("Budget range", "Budget min cannot be greater than budget max.");
      return;
    }

    setSubmitting(true);
    try {
      // Backend: POST /jobs (consumer only)
      const created = await api.post<CreateJobResponse>("/jobs", {
        title: t,
        description: d,
        location: location.trim() || null,
        budgetMin: min,
        budgetMax: max,
      });

      const newId = created?.id;
      if (!newId) {
        // In case backend returns a full job object, fallback:
        // @ts-expect-error - defensive
        const maybeId = created?.job?.id ?? created?.jobId ?? created?.data?.id;
        if (!maybeId) throw new Error("Job created but no id returned.");
        router.replace(`/consumer/job/${maybeId}`);
        return;
      }

      if (created?.reviewRequired) {
        Alert.alert(
          "Submitted for review",
          "Your job was submitted for manual review and may not be visible to providers right away."
        );
      }

      router.replace(`/consumer/job/${newId}`);
    } catch (e: any) {
      if (e?.status === 403 && e?.details?.code === "RESTRICTED") {
        Alert.alert(
          "Temporarily restricted",
          e?.message ?? "Your account is temporarily restricted. Please try again later."
        );
        return;
      }
      Alert.alert("Create job failed", e?.message ?? "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Post a Job</Text>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.label}>Title *</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g., Clean gutters"
            placeholderTextColor="#64748b"
            style={styles.input}
          />

          <Text style={styles.label}>Description *</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Describe the work, timing, access, etc."
            placeholderTextColor="#64748b"
            multiline
            style={[styles.input, styles.textarea]}
          />

          <Text style={styles.label}>Location</Text>
          <TextInput
            value={location}
            onChangeText={setLocation}
            placeholder="City / neighborhood"
            placeholderTextColor="#64748b"
            style={styles.input}
          />

          <View style={styles.suggestionCard}>
            <View style={styles.suggestionTopRow}>
              <Text style={styles.suggestionTitle}>Suggested price range</Text>
              {suggestLoading ? <ActivityIndicator /> : null}
            </View>

            {restrictedNotice ? (
              <Text style={styles.restrictedText}>{restrictedNotice}</Text>
            ) : null}

            {suggestion?.suggestedMinPrice != null || suggestion?.suggestedMaxPrice != null ? (
              <>
                <Text style={styles.suggestionRange}>
                  {formatMoney(suggestion?.suggestedMinPrice)}
                  {suggestion?.suggestedMinPrice != null && suggestion?.suggestedMaxPrice != null
                    ? " – "
                    : ""}
                  {formatMoney(suggestion?.suggestedMaxPrice)}
                </Text>

                {suggestion?.suggestedReason ? (
                  <Text style={styles.suggestionReason}>{suggestion.suggestedReason}</Text>
                ) : null}

                <Pressable
                  style={styles.useSuggestedBtn}
                  onPress={() => {
                    if (suggestion?.suggestedMinPrice != null) {
                      setBudgetMin(String(suggestion.suggestedMinPrice));
                    }
                    if (suggestion?.suggestedMaxPrice != null) {
                      setBudgetMax(String(suggestion.suggestedMaxPrice));
                    }
                  }}
                >
                  <Text style={styles.useSuggestedText}>Use suggested range</Text>
                </Pressable>
              </>
            ) : (
              <Text style={styles.suggestionEmpty}>
                Add a bit more detail to get a suggestion.
              </Text>
            )}
          </View>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Budget Min</Text>
              <TextInput
                value={budgetMin}
                onChangeText={setBudgetMin}
                placeholder="e.g., 150"
                placeholderTextColor="#64748b"
                keyboardType="numeric"
                style={styles.input}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Budget Max</Text>
              <TextInput
                value={budgetMax}
                onChangeText={setBudgetMax}
                placeholder="e.g., 300"
                placeholderTextColor="#64748b"
                keyboardType="numeric"
                style={styles.input}
              />
            </View>
          </View>

          <Pressable
            disabled={!canSubmit}
            onPress={submit}
            style={[styles.submitBtn, !canSubmit && { opacity: 0.5 }]}
          >
            {submitting ? (
              <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                <ActivityIndicator />
                <Text style={styles.submitText}>Posting…</Text>
              </View>
            ) : (
              <Text style={styles.submitText}>Post Job</Text>
            )}
          </Pressable>

          <Text style={styles.hint}>
            Tip: after posting, providers can find it in Browse and bid. You’ll see bids in your job page.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { padding: 16, paddingBottom: 6 },
  backBtn: { paddingVertical: 6, paddingHorizontal: 4, alignSelf: "flex-start" },
  backText: { color: "#38bdf8", fontWeight: "800" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 6 },

  content: { padding: 16, paddingBottom: 28, gap: 10 },
  label: { color: "#cbd5e1", fontWeight: "800", marginTop: 8 },

  input: {
    backgroundColor: "#0f172a",
    color: "#fff",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  textarea: { minHeight: 120, textAlignVertical: "top" },

  submitBtn: {
    marginTop: 16,
    backgroundColor: "#38bdf8",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  submitText: { color: "#020617", fontWeight: "900", fontSize: 16 },

  hint: { color: "#64748b", marginTop: 14, lineHeight: 18 },

  restrictedText: { color: "#fca5a5", marginTop: 8, lineHeight: 18 },

  suggestionCard: {
    marginTop: 4,
    backgroundColor: "#0b1220",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  suggestionTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  suggestionTitle: { color: "#cbd5e1", fontWeight: "900" },
  suggestionRange: { color: "#fff", fontWeight: "900", fontSize: 16, marginTop: 8 },
  suggestionReason: { color: "#94a3b8", marginTop: 6, lineHeight: 18 },
  suggestionEmpty: { color: "#94a3b8", marginTop: 8 },
  useSuggestedBtn: {
    marginTop: 10,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#38bdf8",
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  useSuggestedText: { color: "#38bdf8", fontWeight: "900" },
});
