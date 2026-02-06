import React, { useCallback } from "react";
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useProviderReviews } from "../hooks/useProviderReviews";

export default function ProviderReviewsScreen() {
  const router = useRouter();
  const { providerId } = useLocalSearchParams<{ providerId: string }>();

  const providerIdNum = providerId ? Number(providerId) : 0;
  const { summary, loading, error, refetch } = useProviderReviews(providerIdNum);

  useFocusEffect(
    useCallback(() => {
      if (providerIdNum) {
        refetch();
      }
    }, [providerIdNum, refetch])
  );

  const renderReviewItem = ({ item }: { item: any }) => (
    <View style={styles.reviewCard}>
      <View style={styles.reviewHeader}>
        <View style={styles.consumerInfo}>
          <View style={styles.avatar}>
            <MaterialCommunityIcons
              name="account"
              size={20}
              color="#38bdf8"
            />
          </View>
          <View style={styles.consumerDetails}>
            <Text style={styles.consumerName}>{item.reviewer?.name ?? "User"}</Text>
            <Text style={styles.jobTitle} numberOfLines={1}>
              {item.job.title}
            </Text>
          </View>
        </View>

        <View style={styles.rating}>
          {[...Array(5)].map((_, i) => (
            <MaterialCommunityIcons
              key={i}
              name={i < item.rating ? "star" : "star-outline"}
              size={16}
              color={i < item.rating ? "#f59e0b" : "#64748b"}
            />
          ))}
        </View>
      </View>

      {item.text && (
        <Text style={styles.comment} numberOfLines={4}>
          {item.text}
        </Text>
      )}

      <Text style={styles.date}>
        {new Date(item.createdAt).toLocaleDateString()}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialCommunityIcons name="chevron-left" size={28} color="#38bdf8" />
        </Pressable>
        <Text style={styles.headerTitle}>Reviews & Ratings</Text>
        <View style={{ width: 28 }} />
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading reviews...</Text>
        </View>
      ) : summary ? (
        <FlatList
          data={summary.reviews}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderReviewItem}
          ListHeaderComponent={
            <View style={styles.summarySection}>
              <View style={styles.ratingCircle}>
                <Text style={styles.ratingNumber}>
                  {summary.ratingSummary.averageRating
                    ? summary.ratingSummary.averageRating.toFixed(1)
                    : "—"}
                </Text>
                <View style={styles.stars}>
                  {[...Array(5)].map((_, i) => (
                    <MaterialCommunityIcons
                      key={i}
                      name={
                        summary.ratingSummary.averageRating
                          ? i < Math.round(summary.ratingSummary.averageRating)
                            ? "star"
                            : "star-outline"
                          : "star-outline"
                      }
                      size={12}
                      color={
                        summary.ratingSummary.averageRating &&
                        i < Math.round(summary.ratingSummary.averageRating)
                          ? "#f59e0b"
                          : "#64748b"
                      }
                    />
                  ))}
                </View>
              </View>

              <View style={styles.ratingDetails}>
                <Text style={styles.ratingLabel}>Based on</Text>
                <Text style={styles.reviewCount}>
                  {summary.ratingSummary.reviewCount} reviews
                </Text>
              </View>
            </View>
          }
          ListHeaderComponentStyle={styles.listHeader}
          contentContainerStyle={
            summary.reviews.length === 0
              ? styles.emptyContainer
              : styles.listContent
          }
          ListEmptyComponent={
            <View style={styles.emptyContent}>
              <MaterialCommunityIcons
                name="star-outline"
                size={48}
                color="#64748b"
              />
              <Text style={styles.emptyText}>No reviews yet</Text>
              <Text style={styles.emptySubText}>
                First reviews will appear here
              </Text>
            </View>
          }
          onRefresh={refetch}
          refreshing={false}
        />
      ) : null}
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

  listHeader: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },

  summarySection: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center",
  },

  ratingCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },

  ratingNumber: {
    color: "#f59e0b",
    fontSize: 36,
    fontWeight: "800",
  },

  stars: {
    flexDirection: "row",
    gap: 2,
    marginTop: 4,
  },

  ratingDetails: {
    alignItems: "center",
  },

  ratingLabel: {
    color: "#94a3b8",
    fontSize: 12,
    marginBottom: 4,
  },

  reviewCount: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
  },

  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },

  emptyContent: {
    alignItems: "center",
    paddingVertical: 40,
  },

  emptyText: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 16,
  },

  emptySubText: {
    color: "#94a3b8",
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },

  ratingBarRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    gap: 8,
  },

  starGroup: {
    flexDirection: "row",
    gap: 2,
    width: 70,
  },

  barContainer: {
    flex: 1,
    height: 6,
    backgroundColor: "#1e293b",
    borderRadius: 3,
    overflow: "hidden",
  },

  bar: {
    height: "100%",
    borderRadius: 3,
  },

  barCount: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
    width: 30,
    textAlign: "right",
  },

  reviewCard: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  reviewHeader: {
    marginBottom: 12,
  },

  consumerInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },

  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
  },

  consumerDetails: {
    flex: 1,
  },

  consumerName: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },

  jobTitle: {
    color: "#cbd5e1",
    fontSize: 12,
    marginTop: 2,
  },

  rating: {
    flexDirection: "row",
    gap: 3,
  },

  comment: {
    color: "#cbd5e1",
    fontSize: 13,
    marginBottom: 10,
    lineHeight: 18,
  },

  date: {
    color: "#64748b",
    fontSize: 11,
  },
});
