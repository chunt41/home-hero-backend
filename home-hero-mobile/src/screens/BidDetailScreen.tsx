import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
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

type JobDetail = {
  id: number;
  title: string;
  description: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  location: string | null;
  status: string;
  createdAt: string;
};

type BidDetail = {
  id: number;
  amount: number;
  message: string;
  status: string;
  createdAt: string;
  counter?: {
    id: number;
    minAmount: number;
    maxAmount: number;
    amount: number;
    message: string;
    status: string;
    createdAt: string;
  } | null;
};

type JobDetailsResponse = {
  job: JobDetail;
  myBid: BidDetail | null;
};

export default function BidDetailScreen() {
  const router = useRouter();
  const { bidId, jobId } = useLocalSearchParams();
  const numJobId = Number(jobId);

  const [jobData, setJobData] = useState<JobDetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [editAmount, setEditAmount] = useState("");
  const [editMessage, setEditMessage] = useState("");
  const [updating, setUpdating] = useState(false);
  const [counterActionLoading, setCounterActionLoading] = useState(false);

  const fetchJobDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<JobDetailsResponse>(`/provider/jobs/${numJobId}`);
      setJobData(data);
      if (data.myBid) {
        setEditAmount(String(data.myBid.amount));
        setEditMessage(data.myBid.message);
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load job details");
    } finally {
      setLoading(false);
    }
  }, [numJobId]);

  useFocusEffect(
    useCallback(() => {
      fetchJobDetails();
    }, [fetchJobDetails])
  );

  const handleUpdateBid = useCallback(async () => {
    if (!editAmount || Number(editAmount) <= 0) {
      Alert.alert("Invalid amount", "Please enter a positive amount");
      return;
    }

    setUpdating(true);
    try {
      await api.post(`/jobs/${numJobId}/bids`, {
        amount: Number(editAmount),
        message: editMessage,
      });
      Alert.alert("Success", "Bid updated successfully");
      setEditMode(false);
      await fetchJobDetails();
    } catch (err: any) {
      Alert.alert("Error", err?.message ?? "Failed to update bid");
    } finally {
      setUpdating(false);
    }
  }, [editAmount, editMessage, numJobId, fetchJobDetails]);

  const handleAcceptCounter = useCallback(async () => {
    if (!jobData?.myBid?.id) return;

    Alert.alert(
      "Accept Counter Offer?",
      `Accept $${jobData.myBid.counter?.amount.toFixed(2)} for this job?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Accept",
          style: "default",
          onPress: async () => {
            setCounterActionLoading(true);
            try {
              await api.post(`/bids/${jobData.myBid!.id}/counter/accept`);
              Alert.alert("Success", "Counter offer accepted!");
              await fetchJobDetails();
            } catch (err: any) {
              Alert.alert("Error", err?.message ?? "Failed to accept counter");
            } finally {
              setCounterActionLoading(false);
            }
          },
        },
      ]
    );
  }, [jobData, fetchJobDetails]);

  const handleDeclineCounter = useCallback(async () => {
    if (!jobData?.myBid?.id) return;

    Alert.alert(
      "Decline Counter Offer?",
      "You can still negotiate if needed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Decline",
          style: "destructive",
          onPress: async () => {
            setCounterActionLoading(true);
            try {
              await api.post(`/bids/${jobData.myBid!.id}/counter/decline`);
              Alert.alert("Success", "Counter offer declined");
              await fetchJobDetails();
            } catch (err: any) {
              Alert.alert("Error", err?.message ?? "Failed to decline counter");
            } finally {
              setCounterActionLoading(false);
            }
          },
        },
      ]
    );
  }, [jobData, fetchJobDetails]);

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Loading job details…</Text>
      </View>
    );
  }

  if (error && !jobData) {
    return (
      <View style={styles.centerContainer}>
        <MaterialCommunityIcons
          name="alert-circle-outline"
          size={48}
          color={COLORS.danger}
        />
        <Text style={styles.errorTitle}>Couldn't load details</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={fetchJobDetails}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!jobData) return null;

  const job = jobData.job;
  const bid = jobData.myBid;
  const counter = bid?.counter;
  const createdDate = new Date(job.createdAt).toLocaleDateString();
  const bidDate = bid ? new Date(bid.createdAt).toLocaleDateString() : null;

  return (
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
          <Text style={styles.title}>Job Details</Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Job Card */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Job</Text>
          <View style={styles.card}>
            <Text style={styles.jobTitle}>{job.title}</Text>

            {job.description && (
              <Text style={styles.description}>{job.description}</Text>
            )}

            <View style={styles.infoRow}>
              <Text style={styles.label}>Status</Text>
              <Text style={styles.value}>{job.status}</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.label}>Budget</Text>
              <Text style={styles.value}>
                {job.budgetMin && job.budgetMax
                  ? `$${job.budgetMin} - $${job.budgetMax}`
                  : job.budgetMin
                    ? `$${job.budgetMin}+`
                    : "Not specified"}
              </Text>
            </View>

            {job.location && (
              <View style={styles.infoRow}>
                <Text style={styles.label}>Location</Text>
                <Text style={styles.value}>{job.location}</Text>
              </View>
            )}

            <View style={styles.infoRow}>
              <Text style={styles.label}>Posted</Text>
              <Text style={styles.value}>{createdDate}</Text>
            </View>
          </View>
        </View>

        {/* Your Bid Card */}
        {bid && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Your Bid</Text>
            <View style={styles.card}>
              <View style={styles.bidHeader}>
                <View>
                  <Text style={styles.bidAmount}>${bid.amount.toFixed(2)}</Text>
                  <Text style={styles.bidDate}>{bidDate}</Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: getStatusColor(bid.status) + "25" },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      { color: getStatusColor(bid.status) },
                    ]}
                  >
                    {bid.status}
                  </Text>
                </View>
              </View>

              {bid.message && (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.label}>Message</Text>
                  <Text style={styles.messageText}>{bid.message}</Text>
                </View>
              )}

              {bid.status === "PENDING" && (
                <Pressable
                  style={styles.editButton}
                  onPress={() => setEditMode(!editMode)}
                >
                  <MaterialCommunityIcons
                    name={editMode ? "close" : "pencil"}
                    size={16}
                    color={COLORS.bg}
                  />
                  <Text style={styles.editButtonText}>
                    {editMode ? "Cancel" : "Edit Bid"}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {/* Edit Bid Form */}
        {editMode && bid && bid.status === "PENDING" && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Update Your Bid</Text>
            <View style={styles.card}>
              <View style={styles.formGroup}>
                <Text style={styles.label}>Amount</Text>
                <View style={styles.inputContainer}>
                  <Text style={styles.currencySymbol}>$</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="0.00"
                    placeholderTextColor={COLORS.textMuted}
                    keyboardType="decimal-pad"
                    value={editAmount}
                    onChangeText={setEditAmount}
                    editable={!updating}
                  />
                </View>
              </View>

              <View style={styles.formGroup}>
                <Text style={styles.label}>Message (Optional)</Text>
                <TextInput
                  style={[styles.input, styles.textarea]}
                  placeholder="Add a message to your bid…"
                  placeholderTextColor={COLORS.textMuted}
                  multiline
                  numberOfLines={4}
                  value={editMessage}
                  onChangeText={setEditMessage}
                  editable={!updating}
                />
              </View>

              <Pressable
                style={[styles.submitButton, updating && styles.submitButtonDisabled]}
                onPress={handleUpdateBid}
                disabled={updating}
              >
                {updating ? (
                  <ActivityIndicator color={COLORS.bg} size="small" />
                ) : (
                  <>
                    <MaterialCommunityIcons
                      name="check"
                      size={16}
                      color={COLORS.bg}
                    />
                    <Text style={styles.submitButtonText}>Update Bid</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        )}

        {/* Counter Offer */}
        {counter && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Counter Offer</Text>
            <View style={[styles.card, styles.counterCard]}>
              <View style={styles.counterHeader}>
                <Text style={styles.counterLabel}>Offered Amount</Text>
                <Text style={styles.counterAmount}>${counter.amount.toFixed(2)}</Text>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.label}>Range</Text>
                <Text style={styles.value}>
                  ${counter.minAmount} - ${counter.maxAmount}
                </Text>
              </View>

              {counter.message && (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.label}>Message</Text>
                  <Text style={styles.messageText}>{counter.message}</Text>
                </View>
              )}

              <View style={styles.infoRow}>
                <Text style={styles.label}>Status</Text>
                <Text
                  style={[
                    styles.value,
                    { color: getStatusColor(counter.status) },
                  ]}
                >
                  {counter.status}
                </Text>
              </View>

              {counter.status === "PENDING" && (
                <View style={styles.counterActions}>
                  <Pressable
                    style={[styles.actionButton, styles.acceptButton]}
                    onPress={handleAcceptCounter}
                    disabled={counterActionLoading}
                  >
                    {counterActionLoading ? (
                      <ActivityIndicator color="#020617" size="small" />
                    ) : (
                      <>
                        <MaterialCommunityIcons
                          name="check"
                          size={16}
                          color="#020617"
                        />
                        <Text style={styles.acceptButtonText}>Accept</Text>
                      </>
                    )}
                  </Pressable>
                  <Pressable
                    style={[styles.actionButton, styles.declineButton]}
                    onPress={handleDeclineCounter}
                    disabled={counterActionLoading}
                  >
                    {counterActionLoading ? (
                      <ActivityIndicator color={COLORS.danger} size="small" />
                    ) : (
                      <>
                        <MaterialCommunityIcons
                          name="close"
                          size={16}
                          color={COLORS.danger}
                        />
                        <Text style={styles.declineButtonText}>Decline</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function getStatusColor(status: string): string {
  switch (status) {
    case "ACCEPTED":
      return COLORS.success;
    case "PENDING":
      return COLORS.warning;
    case "REJECTED":
    case "WITHDRAWN":
      return COLORS.danger;
    default:
      return COLORS.accent;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
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

  scrollContent: {
    paddingBottom: 24,
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

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  jobTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
  },
  description: {
    fontSize: 13,
    color: COLORS.textMuted,
    lineHeight: 18,
  },

  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  label: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: "500",
  },
  value: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: "600",
  },

  bidHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  bidAmount: {
    fontSize: 24,
    fontWeight: "700",
    color: COLORS.accent,
  },
  bidDate: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 4,
  },
  statusBadge: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "700",
  },

  messageText: {
    fontSize: 13,
    color: COLORS.text,
    lineHeight: 18,
    marginTop: 6,
  },

  editButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    marginTop: 8,
  },
  editButtonText: {
    color: COLORS.bg,
    fontWeight: "600",
    fontSize: 13,
  },

  formGroup: {
    gap: 8,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: COLORS.bg,
  },
  currencySymbol: {
    color: COLORS.textMuted,
    fontSize: 16,
    fontWeight: "600",
    marginRight: 4,
  },
  input: {
    flex: 1,
    color: COLORS.text,
    paddingVertical: 10,
    fontSize: 16,
  },
  textarea: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    textAlignVertical: "top",
  },

  submitButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    marginTop: 12,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    color: COLORS.bg,
    fontWeight: "700",
    fontSize: 14,
  },

  counterCard: {
    borderWidth: 2,
    borderColor: COLORS.warning,
  },
  counterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  counterLabel: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: "500",
  },
  counterAmount: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.warning,
  },

  counterActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  acceptButton: {
    backgroundColor: COLORS.success,
  },
  acceptButtonText: {
    color: "#020617",
    fontWeight: "700",
    fontSize: 13,
  },
  declineButton: {
    backgroundColor: COLORS.danger + "20",
  },
  declineButtonText: {
    color: COLORS.danger,
    fontWeight: "700",
    fontSize: 13,
  },
});
