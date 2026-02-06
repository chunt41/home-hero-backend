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

type Category = {
  id: number;
  name: string;
  slug: string;
};

type SavedSearch = {
  id: number;
  providerId: number;
  categories: string[];
  radiusMiles: number;
  zipCode: string;
  minBudget: number | null;
  maxBudget: number | null;
  isEnabled: boolean;
  createdAt: string;
};

type SavedSearchListResponse = { items: SavedSearch[] };

function isZip5(s: string) {
  return /^\d{5}$/.test(s.trim());
}

function parseOptionalInt(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
}

export default function ProviderSavedSearchesScreen() {
  const router = useRouter();

  const [items, setItems] = useState<SavedSearch[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [zipCode, setZipCode] = useState("");
  const [radiusMiles, setRadiusMiles] = useState("25");
  const [minBudget, setMinBudget] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [isEnabled, setIsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const isEditing = useMemo(() => typeof editingId === "number", [editingId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cats, searches] = await Promise.all([
        api.get<Category[]>("/categories"),
        api.get<SavedSearchListResponse>("/provider/saved-searches"),
      ]);

      setCategories(cats ?? []);
      setItems(searches.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load saved searches");
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
    setSelectedCategories([]);
    setZipCode("");
    setRadiusMiles("25");
    setMinBudget("");
    setMaxBudget("");
    setIsEnabled(true);
  }, []);

  const beginEdit = useCallback((s: SavedSearch) => {
    setEditingId(s.id);
    setSelectedCategories(s.categories ?? []);
    setZipCode(String(s.zipCode ?? ""));
    setRadiusMiles(String(s.radiusMiles ?? 25));
    setMinBudget(s.minBudget != null ? String(s.minBudget) : "");
    setMaxBudget(s.maxBudget != null ? String(s.maxBudget) : "");
    setIsEnabled(!!s.isEnabled);
  }, []);

  const toggleCategory = useCallback((name: string) => {
    setSelectedCategories((prev) => {
      const exists = prev.some((x) => x.toLowerCase() === name.toLowerCase());
      if (exists) return prev.filter((x) => x.toLowerCase() !== name.toLowerCase());
      return [...prev, name];
    });
  }, []);

  const onSave = useCallback(async () => {
    if (selectedCategories.length < 1) {
      Alert.alert("Category required", "Select at least one category.");
      return;
    }

    if (!isZip5(zipCode)) {
      Alert.alert("ZIP code required", "Enter a valid 5-digit ZIP code.");
      return;
    }

    const radius = parseOptionalInt(radiusMiles);
    if (!radius || radius < 1) {
      Alert.alert("Radius required", "Enter a radius in miles (e.g. 25). ");
      return;
    }

    const minB = parseOptionalInt(minBudget);
    const maxB = parseOptionalInt(maxBudget);

    if (minB != null && maxB != null && minB > maxB) {
      Alert.alert("Budget range", "Min budget must be less than or equal to max budget.");
      return;
    }

    setSaving(true);
    try {
      const payload: any = {
        categories: selectedCategories,
        zipCode: zipCode.trim(),
        radiusMiles: radius,
        isEnabled,
        ...(minB != null ? { minBudget: minB } : { minBudget: null }),
        ...(maxB != null ? { maxBudget: maxB } : { maxBudget: null }),
      };

      if (isEditing && editingId != null) {
        await api.put(`/provider/saved-searches/${editingId}`, payload);
      } else {
        await api.post("/provider/saved-searches", payload);
      }

      resetForm();
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Failed to save saved search");
    } finally {
      setSaving(false);
    }
  }, [selectedCategories, zipCode, radiusMiles, minBudget, maxBudget, isEnabled, isEditing, editingId, load, resetForm]);

  const onDelete = useCallback(
    (s: SavedSearch) => {
      Alert.alert(
        "Delete saved search?",
        "This will stop job match notifications for this search.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await api.delete(`/provider/saved-searches/${s.id}`);
                if (editingId === s.id) resetForm();
                await load();
              } catch (e: any) {
                Alert.alert("Error", e?.message ?? "Failed to delete saved search");
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
        <Text style={styles.headerTitle}>Saved Searches</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{isEditing ? "Edit saved search" : "New saved search"}</Text>

          <Text style={styles.label}>Categories</Text>
          <View style={styles.chipsWrap}>
            {(categories ?? []).slice(0, 60).map((c) => {
              const active = selectedCategories.some((x) => x.toLowerCase() === c.name.toLowerCase());
              return (
                <Pressable
                  key={c.id}
                  onPress={() => toggleCategory(c.name)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{c.name}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>ZIP code</Text>
          <TextInput
            value={zipCode}
            onChangeText={setZipCode}
            placeholder="e.g. 94105"
            placeholderTextColor={COLORS.textMuted}
            style={styles.input}
            keyboardType="number-pad"
            maxLength={5}
            editable={!saving}
          />

          <Text style={styles.label}>Radius (miles)</Text>
          <TextInput
            value={radiusMiles}
            onChangeText={setRadiusMiles}
            placeholder="e.g. 25"
            placeholderTextColor={COLORS.textMuted}
            style={styles.input}
            keyboardType="number-pad"
            editable={!saving}
          />

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Min budget (optional)</Text>
              <TextInput
                value={minBudget}
                onChangeText={setMinBudget}
                placeholder="e.g. 150"
                placeholderTextColor={COLORS.textMuted}
                style={styles.input}
                keyboardType="number-pad"
                editable={!saving}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Max budget (optional)</Text>
              <TextInput
                value={maxBudget}
                onChangeText={setMaxBudget}
                placeholder="e.g. 800"
                placeholderTextColor={COLORS.textMuted}
                style={styles.input}
                keyboardType="number-pad"
                editable={!saving}
              />
            </View>
          </View>

          <View style={styles.row}>
            <Pressable
              style={[styles.toggleBtn, isEnabled ? styles.toggleOn : styles.toggleOff]}
              onPress={() => setIsEnabled((v) => !v)}
              disabled={saving}
            >
              <Text style={styles.toggleText}>{isEnabled ? "Enabled" : "Disabled"}</Text>
            </Pressable>

            <Pressable style={styles.secondaryBtn} onPress={resetForm} disabled={saving}>
              <Text style={styles.secondaryText}>Clear</Text>
            </Pressable>
          </View>

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

          <Text style={styles.hint}>
            Job match notifications are deduped and rate-limited.
          </Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your saved searches</Text>
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
          <Text style={styles.muted}>No saved searches yet.</Text>
        ) : (
          items.map((s) => (
            <Pressable key={s.id} style={styles.listItem} onPress={() => beginEdit(s)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemTitle} numberOfLines={1}>
                  {(s.categories ?? []).join(", ")}
                </Text>
                <Text style={styles.itemMeta} numberOfLines={2}>
                  {s.zipCode} • {s.radiusMiles}mi{!s.isEnabled ? " • Disabled" : ""}
                </Text>
                {(s.minBudget != null || s.maxBudget != null) && (
                  <Text style={styles.itemMeta}>
                    Budget: {s.minBudget != null ? `$${s.minBudget}` : "Any"}–{s.maxBudget != null ? `$${s.maxBudget}` : "Any"}
                  </Text>
                )}
              </View>

              <Pressable onPress={() => onDelete(s)} hitSlop={10}>
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

  chipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
  },
  chipActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  chipText: {
    color: COLORS.text,
    fontWeight: "800",
    fontSize: 12,
  },
  chipTextActive: {
    color: COLORS.bg,
  },

  row: { flexDirection: "row", gap: 10, marginTop: 6 },

  toggleBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  toggleOn: {
    backgroundColor: COLORS.success,
    borderColor: COLORS.success,
  },
  toggleOff: {
    backgroundColor: COLORS.bg,
    borderColor: COLORS.border,
  },
  toggleText: { color: "#020617", fontWeight: "900" },

  primaryBtn: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
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

  hint: { color: COLORS.textMuted, fontWeight: "700", fontSize: 12, marginTop: 2 },
});
