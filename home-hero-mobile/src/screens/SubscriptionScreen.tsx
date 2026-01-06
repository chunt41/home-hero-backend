import React, { useCallback, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useSubscription } from "../hooks/useSubscription";
import { StripeCheckoutModal } from "../components/StripeCheckoutModal";
import { getErrorMessage } from "../lib/getErrorMessage";

export default function SubscriptionScreen() {
  const router = useRouter();
  const [checkoutTier, setCheckoutTier] = useState<"BASIC" | "PRO" | null>(null);
  const {
    subscription,
    loading,
    error,
    fetchSubscription,
    downgradeTier,
    tierFeatures,
  } = useSubscription();

  useFocusEffect(
    useCallback(() => {
      fetchSubscription();
    }, [fetchSubscription])
  );

  const handleUpgrade = (tier: "BASIC" | "PRO") => {
    setCheckoutTier(tier);
  };

  const handleDowngrade = (tier: "FREE" | "BASIC") => {
    Alert.alert(
      `Downgrade to ${tier}`,
      `You will lose premium features. Continue?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Downgrade",
          style: "destructive",
          onPress: async () => {
            try {
              await downgradeTier(tier);
              Alert.alert("Success!", `Downgraded to ${tier} plan`);
              fetchSubscription();
            } catch (err: any) {
              Alert.alert("Error", getErrorMessage(err, "Failed to downgrade"));
            }
          },
        },
      ]
    );
  };

  const handlePaymentSuccess = (subscription: any) => {
    Alert.alert("Success!", "Your subscription has been upgraded.");
    fetchSubscription();
  };

  const getTierHierarchy = (tier: "FREE" | "BASIC" | "PRO"): number => {
    switch (tier) {
      case "FREE":
        return 0;
      case "BASIC":
        return 1;
      case "PRO":
        return 2;
    }
  };

  const getButtonTextAndAction = (
    tier: "FREE" | "BASIC" | "PRO",
    currentTier: "FREE" | "BASIC" | "PRO"
  ): { text: string; isUpgrade: boolean } | null => {
    const tierHierarchy = getTierHierarchy(tier);
    const currentHierarchy = getTierHierarchy(currentTier);

    if (tierHierarchy > currentHierarchy) {
      return { text: "Upgrade", isUpgrade: true };
    }

    // Allow downgrading to any lower tier.
    if (tierHierarchy < currentHierarchy) {
      return { text: "Downgrade", isUpgrade: false };
    }

    return null;
  };

  const renderTierCard = (
    tier: "FREE" | "BASIC" | "PRO",
    isCurrentTier: boolean
  ) => {
    const features = tierFeatures[tier];
    const buttonInfo = subscription
      ? getButtonTextAndAction(tier, subscription.tier)
      : null;

    return (
      <View
        key={tier}
        style={[
          styles.tierCard,
          isCurrentTier && styles.tierCardActive,
        ]}
      >
        <View style={styles.tierHeader}>
          <Text style={styles.tierName}>{tier}</Text>
          {isCurrentTier && (
            <View style={styles.currentBadge}>
              <Text style={styles.currentBadgeText}>Current</Text>
            </View>
          )}
        </View>

        <View style={styles.priceSection}>
          <Text style={styles.price}>{features.price}</Text>
          <Text style={styles.billing}>{features.billing}</Text>
        </View>

        {tier !== "FREE" && (
          <Text style={styles.bidsPerMonth}>
            {features.bidsPerMonth} bids/month
          </Text>
        )}

        <View style={styles.featuresList}>
          {features.features.map((feature, idx) => (
            <View key={idx} style={styles.featureItem}>
              <MaterialCommunityIcons
                name="check-circle"
                size={16}
                color="#10b981"
              />
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>

        {!isCurrentTier && buttonInfo && (
          <Pressable
            style={[
              styles.actionButton,
              buttonInfo.isUpgrade
                ? styles.upgradeButton
                : styles.downgradeButton,
            ]}
            onPress={() => {
              if (buttonInfo.isUpgrade) {
                handleUpgrade(tier as "BASIC" | "PRO");
              } else {
                handleDowngrade(tier as "FREE" | "BASIC");
              }
            }}
          >
            <Text
              style={[
                styles.actionButtonText,
                buttonInfo.isUpgrade
                  ? styles.upgradeButtonText
                  : styles.downgradeButtonText,
              ]}
            >
              {buttonInfo.text}
            </Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialCommunityIcons name="chevron-left" size={28} color="#38bdf8" />
        </Pressable>
        <Text style={styles.headerTitle}>Subscription Plans</Text>
        <Pressable onPress={fetchSubscription} hitSlop={10}>
          <MaterialCommunityIcons name="refresh" size={22} color="#38bdf8" />
        </Pressable>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={fetchSubscription}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading subscription...</Text>
        </View>
      ) : subscription ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Current Tier Info */}
          <View style={styles.currentTierSection}>
            <View style={styles.currentTierBg}>
              <MaterialCommunityIcons
                name="star"
                size={48}
                color="#f59e0b"
              />
            </View>
            <Text style={styles.currentTierLabel}>Current Plan</Text>
            <Text style={styles.currentTier}>{subscription.tier}</Text>

            {subscription.tier === "FREE" &&
              subscription.remainingBids !== null && (
                <View style={styles.bidUsageSection}>
                  <Text style={styles.bidUsageLabel}>
                    Bids Used This Month
                  </Text>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${
                            subscription.bidsUsedLast30Days &&
                            subscription.bidLimitPer30Days
                              ? (subscription.bidsUsedLast30Days /
                                  subscription.bidLimitPer30Days) *
                                100
                              : 0
                          }%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.bidUsageText}>
                    {subscription.bidsUsedLast30Days} of{" "}
                    {subscription.bidLimitPer30Days} used
                  </Text>
                </View>
              )}
          </View>

          {/* Tier Cards */}
          <View style={styles.tiersContainer}>
            {renderTierCard("FREE", subscription.tier === "FREE")}
            {renderTierCard("BASIC", subscription.tier === "BASIC")}
            {renderTierCard("PRO", subscription.tier === "PRO")}
          </View>

          {/* FAQ Section */}
          <View style={styles.faqSection}>
            <Text style={styles.faqTitle}>Frequently Asked Questions</Text>

            <View style={styles.faqItem}>
              <Text style={styles.faqQuestion}>
                Can I change my plan anytime?
              </Text>
              <Text style={styles.faqAnswer}>
                Yes! You can upgrade or downgrade your plan anytime. Changes
                take effect immediately.
              </Text>
            </View>

            <View style={styles.faqItem}>
              <Text style={styles.faqQuestion}>
                What happens if I exceed my bid limit?
              </Text>
              <Text style={styles.faqAnswer}>
                For FREE tier, you won't be able to place new bids once you
                reach your monthly limit. Upgrade to place more bids.
              </Text>
            </View>

            <View style={styles.faqItem}>
              <Text style={styles.faqQuestion}>
                Is there a contract or commitment?
              </Text>
              <Text style={styles.faqAnswer}>
                No contracts! You can cancel or change your subscription at any
                time.
              </Text>
            </View>
          </View>
        </ScrollView>
      ) : null}

      {/* Stripe Checkout Modal */}
      <StripeCheckoutModal
        visible={checkoutTier !== null}
        tier={checkoutTier}
        onClose={() => setCheckoutTier(null)}
        onSuccess={handlePaymentSuccess}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#020617",
  },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },

  errorBox: {
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: "#1f2937",
    padding: 12,
    borderRadius: 12,
  },
  errorText: {
    color: "#fca5a5",
    marginBottom: 10,
    fontSize: 14,
  },
  retryBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#38bdf8",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  retryText: {
    color: "#020617",
    fontWeight: "800",
    fontSize: 12,
  },

  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#cbd5e1",
    marginTop: 12,
  },

  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },

  currentTierSection: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  currentTierBg: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },

  currentTierLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },

  currentTier: {
    color: "#38bdf8",
    fontSize: 28,
    fontWeight: "800",
    marginBottom: 16,
  },

  bidUsageSection: {
    width: "100%",
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 12,
  },

  bidUsageLabel: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 8,
  },

  progressBar: {
    height: 8,
    backgroundColor: "#334155",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },

  progressFill: {
    height: "100%",
    backgroundColor: "#10b981",
  },

  bidUsageText: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "500",
  },

  tiersContainer: {
    marginBottom: 24,
  },

  tierCard: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  tierCardActive: {
    backgroundColor: "#1e293b",
    borderColor: "#38bdf8",
    borderWidth: 2,
  },

  tierHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },

  tierName: {
    color: "#e2e8f0",
    fontSize: 20,
    fontWeight: "800",
  },

  currentBadge: {
    backgroundColor: "#10b981",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },

  currentBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },

  priceSection: {
    marginBottom: 12,
  },

  price: {
    color: "#38bdf8",
    fontSize: 32,
    fontWeight: "800",
  },

  billing: {
    color: "#94a3b8",
    fontSize: 13,
    marginTop: 4,
  },

  bidsPerMonth: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#1e293b",
    borderRadius: 8,
    alignSelf: "flex-start",
  },

  featuresList: {
    marginBottom: 16,
  },

  featureItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },

  featureText: {
    color: "#cbd5e1",
    fontSize: 13,
    flex: 1,
  },

  actionButton: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 12,
  },

  upgradeButton: {
    backgroundColor: "#38bdf8",
  },

  upgradeButtonText: {
    color: "#020617",
    fontWeight: "800",
    fontSize: 14,
  },

  downgradeButton: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#ef4444",
  },

  downgradeButtonText: {
    color: "#ef4444",
    fontWeight: "700",
    fontSize: 14,
  },

  actionButtonText: {
    fontWeight: "800",
    fontSize: 14,
  },

  faqSection: {
    backgroundColor: "#0f172a",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 24,
  },

  faqTitle: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 16,
  },

  faqItem: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },

  faqQuestion: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },

  faqAnswer: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
  },
});
