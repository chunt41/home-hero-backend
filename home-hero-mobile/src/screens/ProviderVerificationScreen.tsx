import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api } from "../lib/apiClient";
import { getErrorMessage } from "../lib/getErrorMessage";

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

type VerificationStatus = "NONE" | "PENDING" | "VERIFIED" | "REJECTED";

type VerificationAttachment = {
  id: number;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  url: string;
};

type VerificationStatusResponse = {
  providerId: number;
  status: VerificationStatus;
  method: "ID" | "BACKGROUND_CHECK" | null;
  providerSubmittedAt: string | null;
  verifiedAt: string | null;
  metadataJson: unknown;
  attachments: VerificationAttachment[];
};

export default function ProviderVerificationScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [data, setData] = useState<VerificationStatusResponse | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<VerificationStatusResponse>(
        "/provider/verification/status"
      );
      setData(res);
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to load verification status"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const statusLabel = useMemo(() => {
    const s = data?.status ?? "NONE";
    if (s === "VERIFIED") return "Verified";
    if (s === "PENDING") return "Pending review";
    if (s === "REJECTED") return "Rejected";
    return "Not verified";
  }, [data?.status]);

  const statusColor = useMemo(() => {
    const s = data?.status ?? "NONE";
    if (s === "VERIFIED") return COLORS.success;
    if (s === "PENDING") return COLORS.warning;
    if (s === "REJECTED") return COLORS.danger;
    return COLORS.textMuted;
  }, [data?.status]);

  const pickAndUpload = useCallback(async () => {
    try {
      setUploading(true);

      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission required",
          "Please allow photo library access to upload documents."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        quality: 0.9,
      });

      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      const uri = asset.uri;

      const filename =
        (asset.fileName as string | undefined) ||
        `verification_${Date.now()}.jpg`;

      const mimeType =
        (asset.mimeType as string | undefined) || "image/jpeg";

      const form = new FormData();
      form.append(
        "file",
        {
          uri,
          name: filename,
          type: mimeType,
        } as any
      );

      await api.upload("/provider/verification/attachments/upload", form);
      await fetchStatus();
    } catch (e: any) {
      Alert.alert("Upload failed", getErrorMessage(e, "Failed to upload document"));
    } finally {
      setUploading(false);
    }
  }, [fetchStatus]);

  const submitVerification = useCallback(async () => {
    try {
      setSubmitting(true);
      const attachmentIds = (data?.attachments ?? []).map((a) => a.id);

      if (!attachmentIds.length) {
        Alert.alert("Missing document", "Please upload at least one document.");
        return;
      }

      await api.post("/provider/verification/submit", {
        method: "ID",
        attachmentIds,
      });

      await fetchStatus();
      Alert.alert("Submitted", "Your verification has been submitted for review.");
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to submit verification"));
    } finally {
      setSubmitting(false);
    }
  }, [data?.attachments, fetchStatus]);

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialCommunityIcons
            name="chevron-left"
            size={24}
            color={COLORS.accent}
          />
        </Pressable>
        <Text style={styles.title}>Verification</Text>
        <View style={{ width: 24 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <MaterialCommunityIcons
                name={
                  data?.status === "VERIFIED"
                    ? "check-decagram"
                    : data?.status === "PENDING"
                      ? "clock-outline"
                      : data?.status === "REJECTED"
                        ? "close-octagon"
                        : "shield-outline"
                }
                size={22}
                color={statusColor}
              />
              <Text style={styles.statusText}>{statusLabel}</Text>
            </View>

            <Text style={styles.help}>
              Upload a photo of a government ID or other documentation. Your files
              are stored privately and reviewed by an admin.
            </Text>

            <Pressable
              style={[styles.button, uploading && styles.buttonDisabled]}
              disabled={uploading}
              onPress={pickAndUpload}
            >
              <MaterialCommunityIcons
                name="cloud-upload-outline"
                size={18}
                color={COLORS.bg}
              />
              <Text style={styles.buttonText}>
                {uploading ? "Uploading…" : "Upload document"}
              </Text>
            </Pressable>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Uploaded documents</Text>
            <Text style={styles.sectionMeta}>{data?.attachments?.length ?? 0}</Text>
          </View>

          <View style={styles.card}>
            {data?.attachments?.length ? (
              <View style={{ gap: 10 }}>
                {data.attachments.map((a) => (
                  <View key={String(a.id)} style={styles.attachmentRow}>
                    <MaterialCommunityIcons
                      name={a.mimeType === "application/pdf" ? "file-pdf-box" : "image-outline"}
                      size={18}
                      color={COLORS.textMuted}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.attachmentName} numberOfLines={1}>
                        {a.filename || `Attachment #${a.id}`}
                      </Text>
                      <Text style={styles.attachmentMeta}>
                        {new Date(a.createdAt).toLocaleString()}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.muted}>No documents uploaded yet.</Text>
            )}
          </View>

          {data?.status !== "VERIFIED" ? (
            <Pressable
              style={[styles.submitButton, (submitting || uploading) && styles.buttonDisabled]}
              disabled={submitting || uploading}
              onPress={submitVerification}
            >
              <Text style={styles.submitButtonText}>
                {submitting ? "Submitting…" : "Submit for review"}
              </Text>
            </Pressable>
          ) : null}

          <Pressable style={styles.refresh} onPress={fetchStatus}>
            <MaterialCommunityIcons name="refresh" size={18} color={COLORS.accent} />
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  title: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "800",
  },
  scroll: {
    padding: 16,
    gap: 14,
    paddingBottom: 24,
  },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  muted: {
    color: COLORS.textMuted,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "800",
  },
  help: {
    color: COLORS.textMuted,
    lineHeight: 18,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
  },
  buttonText: {
    color: COLORS.bg,
    fontWeight: "800",
  },
  submitButton: {
    backgroundColor: COLORS.success,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitButtonText: {
    color: COLORS.bg,
    fontWeight: "900",
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 2,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "800",
  },
  sectionMeta: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  attachmentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  attachmentName: {
    color: COLORS.text,
    fontWeight: "700",
  },
  attachmentMeta: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  refresh: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  refreshText: {
    color: COLORS.accent,
    fontWeight: "800",
  },
});
