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
import { useProviderReviews } from "../hooks/useProviderReviews";
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

  const providerIdForReviews = profile?.id ?? props?.providerId ?? 0;
  const {
    summary: reviewsSummary,
    loading: reviewsLoading,
    error: reviewsError,
    refetch: refetchReviews,
  } = useProviderReviews(providerIdForReviews, { limit: 10 });

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [localSelectedCategoryIds, setLocalSelectedCategoryIds] = useState<number[]>([]);

  const [isBlocked, setIsBlocked] = useState<boolean>(false);
  const [checkingBlocked, setCheckingBlocked] = useState<boolean>(false);

  const responseTimeLabel = (() => {
    const seconds = (profile as any)?.stats?.medianResponseTimeSeconds30d;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
    if (seconds < 60) return "<1 min";
    if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min`;
    if (seconds < 24 * 60 * 60) return `${Math.round(seconds / 3600)} hr`;
    return `${Math.round(seconds / 86400)} day`;
  })();

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

  useFocusEffect(
    useCallback(() => {
      if (providerIdForReviews) {
        refetchReviews();
      }
    }, [providerIdForReviews, refetchReviews])
  );

  const refreshBlockedState = useCallback(async () => {
    if (!isViewingOther) return;
    const targetId = props?.providerId;
    if (!targetId) return;

    try {
      setCheckingBlocked(true);
      const blocks = await api.get<
        { blockedUser: { id: number } }[]
      >("/me/blocks");

      const hit = Array.isArray(blocks)
        ? blocks.some((b) => b?.blockedUser?.id === targetId)
        : false;
      setIsBlocked(hit);
    } catch {
      // ignore
    } finally {
      setCheckingBlocked(false);
    }
  }, [isViewingOther, props?.providerId]);

  useFocusEffect(
    useCallback(() => {
      refreshBlockedState();
    }, [refreshBlockedState])
  );

  const toggleBlock = useCallback(async () => {
    const targetId = profile?.id;
    if (!targetId) return;

    if (isBlocked) {
      Alert.alert(
        "Unblock user?",
        "They will be able to contact you again.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Unblock",
            style: "destructive",
            onPress: async () => {
              try {
                await api.delete(`/users/${targetId}/block`);
                setIsBlocked(false);
              } catch (e: any) {
                Alert.alert(
                  "Error",
                  e?.message ?? "Failed to unblock user."
                );
              }
            },
          },
        ]
      );
      return;
    }

    Alert.alert(
      "Block user?",
      "You won't receive messages or offers from this user.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            try {
              await api.post(`/users/${targetId}/block`, {});
              setIsBlocked(true);
            } catch (e: any) {
              Alert.alert("Error", getErrorMessage(e, "Failed to block user."));
            }
          },
        },
      ]
    );
  }, [isBlocked, profile?.id]);

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

  // (UI) Render helper: compact stat chip
  const StatChip = ({ icon, label }: { icon: string; label: string }) => (
    <View style={styles.statChip}>
      <MaterialCommunityIcons name={icon as any} size={14} color={COLORS.textMuted} />
      <Text style={styles.statChipText}>{label}</Text>
    </View>
  );

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
      Alert.alert("Error", getErrorMessage(err, "Failed to update profile"));
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
      Alert.alert("Error", getErrorMessage(err, "Failed to update categories"));
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
        <Text style={styles.errorTitle}>Couldn’t load profile</Text>
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

            {!isViewingOther ? (
              <Pressable onPress={() => router.push("/provider/verification")}
              >
                <MaterialCommunityIcons
                  name={profile?.isVerified ? "check-decagram" : "badge-account-horizontal-outline"}
                  size={24}
                  color={profile?.isVerified ? COLORS.success : COLORS.accent}
                />
              </Pressable>
            ) : null}

            {isViewingOther && profile?.id ? (
              <>
                <Pressable
                  onPress={() => {
                    router.push(`/report?type=USER&targetId=${profile.id}`);
                  }}
                >
                  <MaterialCommunityIcons
                    name="flag"
                    size={24}
                    color={COLORS.warning}
                  />
                </Pressable>

                <Pressable onPress={toggleBlock} disabled={checkingBlocked}>
                  <MaterialCommunityIcons
                    name={isBlocked ? "shield-off" : "shield"}
                    size={24}
                    color={isBlocked ? COLORS.danger : COLORS.accent}
                  />
                </Pressable>
              </>
            ) : null}

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
                <View style={styles.profileNameRow}>
                  <Text style={styles.profileName}>
                    {profile?.name || "Provider"}
                  </Text>

                  {profile?.isVerified ? (
                    <View style={[styles.verificationPill, styles.verificationPillVerified]}>
                      <MaterialCommunityIcons name="check-decagram" size={14} color={COLORS.success} />
                      <Text style={styles.verificationPillText}>Verified</Text>
                    </View>
                  ) : profile?.verificationStatus === "PENDING" ? (
                    <View style={[styles.verificationPill, styles.verificationPillPending]}>
                      <MaterialCommunityIcons name="clock-outline" size={14} color={COLORS.warning} />
                      <Text style={styles.verificationPillText}>Pending</Text>
                    </View>
                  ) : null}
                </View>
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

                {responseTimeLabel ? (
                  <View style={styles.statChipsRow}>
                    <StatChip icon="clock-outline" label={`Responds in ${responseTimeLabel}`} />
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        </View>

        {/* Quick Tools (provider only) */}
        {!isViewingOther ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Quick Tools</Text>
            <View style={styles.card}>
              <Pressable
                style={styles.quickToolRow}
                onPress={() => router.push("/provider/bid-templates")}
              >
                <MaterialCommunityIcons
                  name="file-document-edit-outline"
                  size={20}
                  color={COLORS.accent}
                />
                <View style={styles.quickToolTextWrap}>
                  <Text style={styles.quickToolTitle}>Bid templates</Text>
                  <Text style={styles.quickToolSubtitle}>
                    Reuse messages and default pricing
                  </Text>
                </View>
                <MaterialCommunityIcons
                  name="chevron-right"
                  size={22}
                  color={COLORS.textMuted}
                />
              </Pressable>

              <View style={styles.quickToolDivider} />

              <Pressable
                style={styles.quickToolRow}
                onPress={() => router.push("/provider/quick-replies")}
              >
                <MaterialCommunityIcons
                  name="message-reply-text-outline"
                  size={20}
                  color={COLORS.accent}
                />
                <View style={styles.quickToolTextWrap}>
                  <Text style={styles.quickToolTitle}>Quick replies</Text>
                  <Text style={styles.quickToolSubtitle}>
                    Tap-to-insert responses in chat
                  </Text>
                </View>
                <MaterialCommunityIcons
                  name="chevron-right"
                  size={22}
                  color={COLORS.textMuted}
                />
              </Pressable>

              <View style={styles.quickToolDivider} />

              <Pressable
                style={styles.quickToolRow}
                onPress={() => router.push("/provider/saved-searches")}
              >
                <MaterialCommunityIcons
                  name="bookmark-search-outline"
                  size={20}
                  color={COLORS.accent}
                />
                <View style={styles.quickToolTextWrap}>
                  <Text style={styles.quickToolTitle}>Saved searches</Text>
                  <Text style={styles.quickToolSubtitle}>
                    Get instant job match notifications
                  </Text>
                </View>
                <MaterialCommunityIcons
                  name="chevron-right"
                  size={22}
                  color={COLORS.textMuted}
                />
              </Pressable>

              <View style={styles.quickToolDivider} />

              <Pressable
                style={styles.quickToolRow}
                onPress={() => router.push("/provider/availability")}
              >
                <MaterialCommunityIcons
                  name="calendar-clock"
                  size={20}
                  color={COLORS.accent}
                />
                <View style={styles.quickToolTextWrap}>
                  <Text style={styles.quickToolTitle}>Availability</Text>
                  <Text style={styles.quickToolSubtitle}>
                    Set times you can take appointments
                  </Text>
                </View>
                <MaterialCommunityIcons
                  name="chevron-right"
                  size={22}
                  color={COLORS.textMuted}
                />
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* Recent Reviews */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Recent Reviews</Text>
            {profile?.id ? (
              <Pressable onPress={() => router.push(`/provider/reviews?providerId=${profile.id}`)}>
                <Text style={styles.sectionLink}>See all</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.card}>
            {reviewsLoading ? (
              <View style={styles.inlineCenterRow}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.inlineMuted}>Loading reviews…</Text>
              </View>
            ) : reviewsError ? (
              <Text style={styles.inlineMuted}>{reviewsError}</Text>
            ) : reviewsSummary?.reviews?.length ? (
              <View style={{ gap: 12 }}>
                {reviewsSummary.reviews.slice(0, 10).map((r) => (
                  <View key={String(r.id)} style={styles.reviewItem}>
                    <View style={styles.reviewHeaderRow}>
                      <Text style={styles.reviewerName} numberOfLines={1}>
                        {r.reviewer?.name ?? "User"}
                      </Text>
                      <View style={styles.reviewStars}>
                        {[...Array(5)].map((_, i) => (
                          <MaterialCommunityIcons
                            key={i}
                            name={i < r.rating ? "star" : "star-outline"}
                            size={14}
                            color={i < r.rating ? COLORS.warning : COLORS.textMuted}
                          />
                        ))}
                      </View>
                    </View>

                    {r.text ? (
                      <Text style={styles.reviewText} numberOfLines={4}>
                        {r.text}
                      </Text>
                    ) : null}

                    <Text style={styles.reviewMeta}>
                      {new Date(r.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.inlineMuted}>No reviews yet.</Text>
            )}
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
                No categories selected. Tap “Edit” to add services.
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
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionLink: {
    color: COLORS.accent,
    fontWeight: "700",
  },

  inlineCenterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  inlineMuted: {
    color: COLORS.textMuted,
  },

  reviewItem: {
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  reviewHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  reviewerName: {
    color: COLORS.text,
    fontWeight: "700",
    flex: 1,
  },
  reviewStars: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  reviewText: {
    color: COLORS.text,
    marginTop: 8,
    lineHeight: 18,
  },
  reviewMeta: {
    color: COLORS.textMuted,
    marginTop: 8,
    fontSize: 12,
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
  profileNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  profileName: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
  },
  verificationPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  verificationPillVerified: {
    backgroundColor: "rgba(16, 185, 129, 0.14)",
    borderColor: "rgba(16, 185, 129, 0.35)",
  },
  verificationPillPending: {
    backgroundColor: "rgba(245, 158, 11, 0.14)",
    borderColor: "rgba(245, 158, 11, 0.35)",
  },
  verificationPillText: {
    fontSize: 12,
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

  statChipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  statChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(148, 163, 184, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(148, 163, 184, 0.22)",
  },
  statChipText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  quickToolRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  quickToolTextWrap: {
    flex: 1,
    gap: 2,
  },
  quickToolTitle: {
    color: COLORS.text,
    fontWeight: "800",
    fontSize: 14,
  },
  quickToolSubtitle: {
    color: COLORS.textMuted,
    fontWeight: "600",
    fontSize: 12,
  },
  quickToolDivider: {
    height: 1,
    backgroundColor: COLORS.border,
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
