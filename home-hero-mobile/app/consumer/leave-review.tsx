import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { api } from "../../src/lib/apiClient";
import { getErrorMessage } from "../../src/lib/getErrorMessage";

export default function LeaveReviewScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const numericJobId = useMemo(() => Number(jobId), [jobId]);

  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const ratingNum = useMemo(() => Number(rating), [rating]);

  const canSubmit =
    Number.isFinite(numericJobId) &&
    Number.isFinite(ratingNum) &&
    ratingNum >= 1 &&
    ratingNum <= 5;

  const onSubmit = async () => {
    if (!canSubmit || submitting) return;

    try {
      setSubmitting(true);
      const resp = await api.post<{ message: string }>(
        `/jobs/${numericJobId}/reviews`,
        {
          rating: ratingNum,
          comment: comment.trim() ? comment.trim() : undefined,
        }
      );

      Alert.alert("Success", resp?.message ?? "Review submitted.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to submit review."));
    } finally {
      setSubmitting(false);
    }
  };

  const invalid = !Number.isFinite(numericJobId);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Leave Review</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.content}>
        {invalid ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Invalid job</Text>
            <Text style={styles.bodyMuted}>Missing or invalid jobId.</Text>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Job</Text>
              <Text style={styles.body}>Job ID: {numericJobId}</Text>
              <Text style={[styles.bodyMuted, { marginTop: 8 }]}>
                Rating must be 1–5.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Rating (1–5)</Text>
              <TextInput
                value={rating}
                onChangeText={setRating}
                placeholder="5"
                placeholderTextColor="#94a3b8"
                keyboardType="number-pad"
                style={styles.input}
              />

              <Text style={[styles.sectionTitle, { marginTop: 12 }]}>Comment (optional)</Text>
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder="Share your experience"
                placeholderTextColor="#94a3b8"
                style={[styles.input, styles.inputMultiline]}
                multiline
              />
            </View>

            <Pressable
              style={[styles.primaryBtn, (!canSubmit || submitting) && styles.btnDisabled]}
              onPress={onSubmit}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ActivityIndicator />
                  <Text style={styles.primaryText}>Submitting…</Text>
                </View>
              ) : (
                <Text style={styles.primaryText}>Submit Review</Text>
              )}
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },

  header: {
    paddingBottom: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
  },
  backBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  backText: { color: "#38bdf8", fontWeight: "800" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "900" },

  content: { padding: 16 },
  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 8, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyMuted: { color: "#94a3b8", fontSize: 13, lineHeight: 18 },

  input: {
    backgroundColor: "#020617",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fff",
  },
  inputMultiline: { minHeight: 110, textAlignVertical: "top" },

  primaryBtn: {
    marginTop: 14,
    backgroundColor: "#38bdf8",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#020617", fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },
});
