import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  FlatList,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useProviderProfile } from "../hooks/useProviderProfile";

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

interface ProviderProfileScreenProps {
  providerId?: number;
}

export default function ProviderProfileScreen(props?: ProviderProfileScreenProps) {
  const router = useRouter();
  const isViewingOther = !!props?.providerId;
  
  const {
    profile,
    categories,
    selectedCategoryIds,
    loading,
    error,
    fetchProfile,
    fetchCategories,
    updateProfile,
    updateCategories,
  } = useProviderProfile(props?.providerId);

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [localSelectedCategoryIds, setLocalSelectedCategoryIds] = useState<number[]>([]);

  // Edit form state
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    location: "",
    experience: "",
    specialties: "",
  });

  useFocusEffect(
    useCallback(() => {
      fetchProfile();
      fetchCategories();
    }, [fetchProfile, fetchCategories])
  );

  // Initialize form when profile loads
  React.useEffect(() => {
    if (profile) {
      setFormData({
        name: profile.name || "",
        email: profile.email || "",
        phone: profile.phone || "",
        location: profile.location || "",
        experience: profile.experience || "",
        specialties: profile.specialties || "",
      });
    }
  }, [profile]);

  // Initialize selected categories when profile loads
  React.useEffect(() => {
    setLocalSelectedCategoryIds(selectedCategoryIds);
  }, [selectedCategoryIds]);

  const handleSaveProfile = useCallback(async () => {
    setSaving(true);
    try {
      await updateProfile({
        location: formData.location,
        experience: formData.experience,
        specialties: formData.specialties,
      });
      Alert.alert("Success", "Profile updated successfully");
      setEditMode(false);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setSaving(false);
    }
  }, [formData, updateProfile]);

  const handleCategoryToggle = useCallback(
    (categoryId: number) => {
      setLocalSelectedCategoryIds((prev: number[]) =>
        prev.includes(categoryId)
          ? prev.filter((id: number) => id !== categoryId)
          : [...prev, categoryId]
      );
    },
    []
  );

  const handleSaveCategories = useCallback(async () => {
    if (localSelectedCategoryIds.length === 0) {
      Alert.alert("Error", "Please select at least one category");
      return;
    }

    setSaving(true);
    try {
      await updateCategories(localSelectedCategoryIds);
      Alert.alert("Success", "Categories updated successfully");
      setCategoryModalVisible(false);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setSaving(false);
    }
  }, [localSelectedCategoryIds, updateCategories]);

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Loading profile…</Text>
      </View>
    );
  }

  if (error && !profile) {
    return (
      <View style={styles.centerContainer}>
        <MaterialCommunityIcons
          name="alert-circle-outline"
          size={48}
          color={COLORS.danger}
        />
        <Text style={styles.errorTitle}>Couldn't load profile</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={fetchProfile}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <MaterialCommunityIcons
              name="chevron-left"
              size={24}
              color={COLORS.accent}
            />
          </Pressable>
          <Text style={styles.title}>Provider Profile</Text>
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => {
                if (profile?.id) {
                  router.push(`/provider/reviews?providerId=${profile.id}`);
                }
              }}
            >
              <MaterialCommunityIcons
                name="star"
                size={24}
                color={COLORS.accent}
              />
            </Pressable>
            {!isViewingOther && (
              <Pressable
                onPress={() => {
                  if (editMode) {
                    setEditMode(false);
                  } else {
                    setEditMode(true);
                  }
                }}
              >
                <MaterialCommunityIcons
                  name={editMode ? "close" : "pencil"}
                  size={24}
                  color={COLORS.accent}
                />
              </Pressable>
            )}
          </View>
        </View>

        {/* Profile Card */}
        <View style={styles.section}>
          <View style={styles.profileCard}>
            <View style={styles.avatarSection}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.name || "P")[0].toUpperCase()}
                </Text>
              </View>
              <View style={styles.profileInfo}>
                <Text style={styles.profileName}>
                  {profile?.name || "Provider"}
                </Text>
                {profile?.rating !== null && (
                  <View style={styles.ratingRow}>
                    <MaterialCommunityIcons
                      name="star"
                      size={16}
                      color={COLORS.warning}
                    />
                    <Text style={styles.ratingText}>
                      {profile?.rating?.toFixed(1) || "N/A"} ({profile?.reviewCount || 0} reviews)
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </View>

        {/* Contact Info Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Contact Information</Text>
          <View style={styles.card}>
            <View style={styles.infoRow}>
              <MaterialCommunityIcons
                name="email-outline"
                size={18}
                color={COLORS.textMuted}
              />
              <Text style={styles.infoLabel}>Email</Text>
              <Text style={styles.infoValue}>{profile?.email}</Text>
            </View>

            <View style={styles.infoRow}>
              <MaterialCommunityIcons
                name="phone-outline"
                size={18}
                color={COLORS.textMuted}
              />
              <Text style={styles.infoLabel}>Phone</Text>
              {editMode ? (
                <TextInput
                  style={styles.inlineInput}
                  placeholder="Add phone"
                  placeholderTextColor={COLORS.textMuted}
                  value={formData.phone}
                  onChangeText={(text) =>
                    setFormData({ ...formData, phone: text })
                  }
                />
              ) : (
                <Text style={styles.infoValue}>{profile?.phone || "Not set"}</Text>
              )}
            </View>

            <View style={styles.infoRow}>
              <MaterialCommunityIcons
                name="map-marker-outline"
                size={18}
                color={COLORS.textMuted}
              />
              <Text style={styles.infoLabel}>Location</Text>
              {editMode ? (
                <TextInput
                  style={styles.inlineInput}
                  placeholder="Enter location"
                  placeholderTextColor={COLORS.textMuted}
                  value={formData.location}
                  onChangeText={(text) =>
                    setFormData({ ...formData, location: text })
                  }
                />
              ) : (
                <Text style={styles.infoValue}>
                  {profile?.location || "Not set"}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Professional Info Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Professional Information</Text>
          <View style={styles.card}>
            <View style={styles.formGroup}>
              <Text style={styles.label}>Experience</Text>
              {editMode ? (
                <TextInput
                  style={[styles.textarea, styles.input]}
                  placeholder="Describe your experience…"
                  placeholderTextColor={COLORS.textMuted}
                  multiline
                  numberOfLines={4}
                  value={formData.experience}
                  onChangeText={(text) =>
                    setFormData({ ...formData, experience: text })
                  }
                />
              ) : (
                <Text style={styles.fieldValue}>
                  {profile?.experience || "Not set"}
                </Text>
              )}
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.label}>Specialties</Text>
              {editMode ? (
                <TextInput
                  style={[styles.textarea, styles.input]}
                  placeholder="E.g., Plumbing, Electrical, General repairs…"
                  placeholderTextColor={COLORS.textMuted}
                  multiline
                  numberOfLines={3}
                  value={formData.specialties}
                  onChangeText={(text) =>
                    setFormData({ ...formData, specialties: text })
                  }
                />
              ) : (
                <Text style={styles.fieldValue}>
                  {profile?.specialties || "Not set"}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Categories Section */}
        <View style={styles.section}>
          <View style={styles.categoryHeader}>
            <Text style={styles.sectionTitle}>Service Categories</Text>
            <Pressable
              onPress={() => setCategoryModalVisible(true)}
              style={styles.editCategoriesButton}
            >
              <MaterialCommunityIcons
                name="pencil"
                size={16}
                color={COLORS.accent}
              />
              <Text style={styles.editCategoriesButtonText}>Edit</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            {selectedCategoryIds.length > 0 ? (
              <View style={styles.categoriesList}>
                {categories
                  .filter((c) => selectedCategoryIds.includes(c.id))
                  .map((category) => (
                    <View key={category.id} style={styles.categoryTag}>
                      <Text style={styles.categoryTagText}>{category.name}</Text>
                    </View>
                  ))}
              </View>
            ) : (
              <Text style={styles.noCategoriesText}>
                No categories selected. Tap "Edit" to add services.
              </Text>
            )}
          </View>
        </View>

        {/* Save Button */}
        {editMode && !isViewingOther && (
          <View style={styles.section}>
            <Pressable
              style={[styles.saveButton, saving && styles.saveButtonDisabled]}
              onPress={handleSaveProfile}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={COLORS.bg} />
              ) : (
                <>
                  <MaterialCommunityIcons
                    name="check"
                    size={18}
                    color={COLORS.bg}
                  />
                  <Text style={styles.saveButtonText}>Save Changes</Text>
                </>
              )}
            </Pressable>
          </View>
        )}
        </ScrollView>
      </SafeAreaView>

      {/* Category Selection Modal */}
      {!isViewingOther && (
        <Modal
          visible={categoryModalVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setCategoryModalVisible(false)}
        >
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Service Categories</Text>
              <Pressable onPress={() => setCategoryModalVisible(false)}>
                <MaterialCommunityIcons
                  name="close"
                  size={24}
                  color={COLORS.text}
                />
              </Pressable>
            </View>

            <FlatList
              data={categories}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.categoryItem}
                  onPress={() => handleCategoryToggle(item.id)}
                >
                  <View
                    style={[
                      styles.checkbox,
                      localSelectedCategoryIds.includes(item.id) &&
                        styles.checkboxChecked,
                    ]}
                  >
                    {localSelectedCategoryIds.includes(item.id) && (
                      <MaterialCommunityIcons
                        name="check"
                        size={16}
                        color={COLORS.bg}
                      />
                    )}
                  </View>
                  <Text style={styles.categoryItemText}>{item.name}</Text>
                </Pressable>
              )}
              style={styles.categoriesFlatList}
            />

            <View style={styles.modalActions}>
              <Pressable
                style={styles.cancelButton}
                onPress={() => setCategoryModalVisible(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.confirmButton, saving && styles.confirmButtonDisabled]}
                onPress={handleSaveCategories}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color={COLORS.bg} />
                ) : (
                  <Text style={styles.confirmButtonText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  loadingText: {
    color: COLORS.textMuted,
    marginTop: 12,
    fontSize: 14,
  },
  errorTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 12,
  },
  errorText: {
    color: COLORS.textMuted,
    marginTop: 8,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: COLORS.accent,
    borderRadius: 8,
  },
  retryButtonText: {
    color: COLORS.bg,
    fontWeight: "600",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.text,
  },

  section: {
    padding: 16,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.text,
  },

  profileCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  avatarSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: COLORS.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    fontSize: 24,
    fontWeight: "700",
    color: COLORS.bg,
  },
  profileInfo: {
    flex: 1,
    gap: 6,
  },
  profileName: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
  },
  ratingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  ratingText: {
    fontSize: 13,
    color: COLORS.textMuted,
  },

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  infoLabel: {
    width: 80,
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: "500",
  },
  infoValue: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    fontWeight: "500",
  },
  inlineInput: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: COLORS.bg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  formGroup: {
    gap: 8,
  },
  label: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  fieldValue: {
    fontSize: 13,
    color: COLORS.text,
    lineHeight: 18,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    backgroundColor: COLORS.bg,
  },
  textarea: {
    textAlignVertical: "top",
  },

  categoryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  editCategoriesButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: COLORS.card,
  },
  editCategoriesButtonText: {
    color: COLORS.accent,
    fontWeight: "600",
    fontSize: 12,
  },

  categoriesList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  categoryTag: {
    backgroundColor: COLORS.accent + "25",
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  categoryTagText: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: "600",
  },
  noCategoriesText: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontStyle: "italic",
  },

  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    backgroundColor: COLORS.success,
    borderRadius: 8,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: COLORS.bg,
    fontWeight: "700",
    fontSize: 14,
  },

  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: COLORS.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "80%",
    paddingTop: 16,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
  },

  categoriesFlatList: {
    maxHeight: 300,
  },
  categoryItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: COLORS.border,
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxChecked: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  categoryItemText: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
    fontWeight: "500",
  },

  modalActions: {
    flexDirection: "row",
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
  },
  cancelButtonText: {
    color: COLORS.text,
    fontWeight: "600",
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: "center",
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    color: COLORS.bg,
    fontWeight: "700",
  },
});
