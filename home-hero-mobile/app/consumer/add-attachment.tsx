import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import * as FileSystem from "expo-file-system";
import { api } from "../../src/lib/apiClient";
import { getErrorMessage } from "../../src/lib/getErrorMessage";

function getImagePicker(): any | null {
  try {
    return require("expo-image-picker");
  } catch {
    return null;
  }
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = (() => {
  const mb = Number(process.env.EXPO_PUBLIC_MAX_ATTACHMENT_MB);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return DEFAULT_MAX_ATTACHMENT_BYTES;
})();

type Picked = {
  uri: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  kind: "image" | "video";
};

export default function AddAttachmentScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const numericJobId = useMemo(() => Number(jobId), [jobId]);

  const [picked, setPicked] = useState<Picked | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = Number.isFinite(numericJobId) && !!picked;

  const pickMedia = async () => {
    if (!Number.isFinite(numericJobId)) return;

    try {
      const ImagePicker = getImagePicker();
      if (!ImagePicker) {
        Alert.alert(
          "Not available",
          "Media picking isn't available in this build. If you're using a development build, rebuild it after adding expo-image-picker. Expo Go should include it by default."
        );
        return;
      }

      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "Please allow photo library access to attach media."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: false,
        quality: 1,
      });

      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      const info = await FileSystem.getInfoAsync(asset.uri);
      const inferredSize = (info as any)?.size;
      const sizeBytes = typeof inferredSize === "number" ? inferredSize : 0;

      if (sizeBytes && sizeBytes > MAX_ATTACHMENT_BYTES) {
        Alert.alert(
          "Too large",
          `That file is too large. Max allowed is ${Math.floor(
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
          )}MB.`
        );
        return;
      }

      const kind: "image" | "video" = asset.type === "video" ? "video" : "image";

      const filenameFromUri =
        asset.uri.split("/").pop() ||
        (kind === "video" ? "attachment.mp4" : "attachment.jpg");

      // Expo's asset mime typing isn't always available; use a safe default.
      const mimeType = kind === "video" ? "video/mp4" : "image/jpeg";

      setPicked({
        uri: asset.uri,
        filename: (asset as any).fileName || filenameFromUri,
        mimeType,
        sizeBytes,
        kind,
      });
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to pick media."));
    }
  };

  const onSubmit = async () => {
    if (!canSubmit || submitting) return;

    try {
      setSubmitting(true);
      if (!picked) throw new Error("No attachment selected");

      const form = new FormData();
      form.append(
        "file",
        {
          uri: picked.uri,
          name: picked.filename,
          type: picked.mimeType,
        } as any
      );

      await api.upload(`/jobs/${numericJobId}/attachments/upload`, form);

      Alert.alert("Added", "Attachment added to job.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to add attachment."));
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
        <Text style={styles.headerTitle}>Add Attachment</Text>
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
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Attachment</Text>

              <Pressable
                style={[styles.secondaryBtnWide, submitting && styles.btnDisabled]}
                onPress={pickMedia}
                disabled={submitting}
              >
                <Text style={styles.secondaryText}>
                  {picked ? "Change" : "Pick photo/video"}
                </Text>
              </Pressable>

              {picked ? (
                <View style={styles.pickInfo}>
                  <Text style={styles.body} numberOfLines={1}>
                    {picked.filename}
                  </Text>
                  <Text style={styles.bodyMuted}>
                    {picked.kind.toUpperCase()}
                    {picked.sizeBytes
                      ? ` • ${Math.ceil(picked.sizeBytes / 1024)} KB`
                      : ""}
                  </Text>
                  <Pressable
                    onPress={() => setPicked(null)}
                    style={styles.removeBtn}
                    disabled={submitting}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.bodyMuted}>
                  Images and videos only. Max {Math.floor(
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                  )}
                  MB.
                </Text>
              )}
            </View>

            <Pressable
              style={[styles.primaryBtn, (!canSubmit || submitting) && styles.btnDisabled]}
              onPress={onSubmit}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ActivityIndicator />
                  <Text style={styles.primaryText}>Adding…</Text>
                </View>
              ) : (
                <Text style={styles.primaryText}>Add Attachment</Text>
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

  secondaryBtnWide: {
    marginTop: 8,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "#1e293b",
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  pickInfo: {
    marginTop: 12,
    backgroundColor: "#020617",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    padding: 12,
    gap: 6,
  },
  removeBtn: { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 10 },
  removeText: { color: "#f87171", fontWeight: "900" },

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
