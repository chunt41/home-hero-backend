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
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
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

type QuickReply = {
  id: number;
  providerId: number;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

type QuickRepliesResponse = { items: QuickReply[] };

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export default function ProviderQuickRepliesScreen() {
  const router = useRouter();

  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [saving, setSaving] = useState(false);

  const isEditing = useMemo(() => typeof editingId === "number", [editingId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<QuickRepliesResponse>("/provider/quick-replies");
      setItems(data.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load quick replies");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const resetForm = useCallback(() => {
    setEditingId(null);
    setTitle("");
    setBody("");
    setTagsText("");
  }, []);

  const beginEdit = useCallback((q: QuickReply) => {
    setEditingId(q.id);
    setTitle(q.title ?? "");
    setBody(q.body ?? "");
    setTagsText((q.tags ?? []).join(", "));
  }, []);

  const onSave = useCallback(async () => {
    if (!title.trim()) {
      Alert.alert("Title required", "Please enter a quick reply title.");
      return;
    }
    if (!body.trim()) {
      Alert.alert("Body required", "Please enter a quick reply body.");
      return;
    }

    const tags = parseTags(tagsText);

    setSaving(true);
    try {
      if (isEditing && editingId != null) {
        await api.put(`/provider/quick-replies/${editingId}`, {
          title: title.trim(),
          body: body.trim(),
          tags,
        });
      } else {
        await api.post("/provider/quick-replies", {
          title: title.trim(),
          body: body.trim(),
          ...(tags.length ? { tags } : null),
        });
      }

      resetForm();
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Failed to save quick reply");
    } finally {
      setSaving(false);
    }
  }, [title, body, tagsText, isEditing, editingId, load, resetForm]);

  const onDelete = useCallback(
    (q: QuickReply) => {
      Alert.alert(
        "Delete quick reply?",
        `Delete “${q.title}”?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await api.delete(`/provider/quick-replies/${q.id}`);
                if (editingId === q.id) resetForm();
                await load();
              } catch (e: any) {
                Alert.alert("Error", e?.message ?? "Failed to delete quick reply");
              }
            },
          },
        ]
      );
    },
    [editingId, load, resetForm]
  );

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <MaterialCommunityIcons name="chevron-left" size={24} color={COLORS.accent} />
        </Pressable>
        <Text style={styles.headerTitle}>Quick Replies</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{isEditing ? "Edit quick reply" : "New quick reply"}</Text>

          <Text style={styles.label}>Title</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. On my way"
            placeholderTextColor={COLORS.textMuted}
            style={styles.input}
            editable={!saving}
          />

          <Text style={styles.label}>Body</Text>
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="Message text…"
            placeholderTextColor={COLORS.textMuted}
            style={[styles.input, styles.textarea]}
            multiline
            numberOfLines={4}
            editable={!saving}
          />

          <Text style={styles.label}>Tags (comma-separated)</Text>
          <TextInput
            value={tagsText}
            onChangeText={setTagsText}
            placeholder="e.g. eta, pricing"
            placeholderTextColor={COLORS.textMuted}
            style={styles.input}
            editable={!saving}
          />

          <View style={styles.row}>
            <Pressable
              style={[styles.primaryBtn, saving && styles.btnDisabled]}
              onPress={onSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={COLORS.bg} />
              ) : (
                <Text style={styles.primaryText}>{isEditing ? "Save" : "Create"}</Text>
              )}
            </Pressable>

            <Pressable style={styles.secondaryBtn} onPress={resetForm} disabled={saving}>
              <Text style={styles.secondaryText}>Clear</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your quick replies</Text>
          <Pressable onPress={load} hitSlop={10}>
            <Text style={styles.link}>Refresh</Text>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.muted}>Loading…</Text>
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.primaryBtn} onPress={load}>
              <Text style={styles.primaryText}>Retry</Text>
            </Pressable>
          </View>
        ) : items.length === 0 ? (
          <Text style={styles.muted}>No quick replies yet.</Text>
        ) : (
          items.map((q) => (
            <Pressable key={q.id} style={styles.listItem} onPress={() => beginEdit(q)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {q.title}
                </Text>
                <Text style={styles.itemMeta} numberOfLines={2}>
                  {q.body}
                </Text>
              </View>

              <Pressable onPress={() => onDelete(q)} hitSlop={10}>
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </Pressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: "800" },
  scroll: { padding: 16, paddingBottom: 28, gap: 14 },

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  cardTitle: { color: COLORS.text, fontSize: 14, fontWeight: "800" },

  label: { color: COLORS.textMuted, fontSize: 12, fontWeight: "700" },
  input: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
  },
  textarea: { minHeight: 96, textAlignVertical: "top" },

  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  primaryBtn: {
    flex: 1,
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: COLORS.bg, fontWeight: "900" },
  secondaryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { color: COLORS.text, fontWeight: "800" },

  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  sectionTitle: { color: COLORS.text, fontSize: 14, fontWeight: "800" },
  link: { color: COLORS.accent, fontWeight: "800" },

  listItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 14,
  },
  itemTitle: { color: COLORS.text, fontWeight: "900" },
  itemMeta: { color: COLORS.textMuted, marginTop: 4, fontWeight: "700", fontSize: 12 },
  deleteText: { color: COLORS.danger, fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },

  center: { alignItems: "center", justifyContent: "center", paddingVertical: 20 },
  muted: { color: COLORS.textMuted, marginTop: 10, fontWeight: "700" },

  errorBox: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  errorText: { color: "#fca5a5", fontWeight: "800" },
});
