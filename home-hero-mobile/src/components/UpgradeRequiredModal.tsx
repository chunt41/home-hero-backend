import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

export type UpgradeRequiredDetails = {
  tier?: string;
  usageMonthKey?: string;
  remainingLeadsThisMonth?: number;
  leadsUsedThisMonth?: number;
  baseLeadLimitThisMonth?: number;
  extraLeadCreditsThisMonth?: number;
};

export function UpgradeRequiredModal(props: {
  visible: boolean;
  onClose: () => void;
  onUpgrade: () => void;
  details?: UpgradeRequiredDetails | null;
}) {
  const { visible, onClose, onUpgrade, details } = props;

  const base = typeof details?.baseLeadLimitThisMonth === "number" ? details.baseLeadLimitThisMonth : null;
  const extra = typeof details?.extraLeadCreditsThisMonth === "number" ? details.extraLeadCreditsThisMonth : null;
  const total = base !== null ? base + Math.max(0, extra ?? 0) : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <MaterialCommunityIcons name="lock" size={22} color="#f59e0b" />
            <Text style={styles.title}>Upgrade required</Text>
          </View>

          <Text style={styles.body}>
            You’ve reached your monthly bid limit. Upgrade your plan to unlock more leads.
          </Text>

          {total !== null && typeof details?.leadsUsedThisMonth === "number" && (
            <View style={styles.stats}>
              <Text style={styles.statText}>
                Used: {details.leadsUsedThisMonth} / {total}
              </Text>
              {typeof details?.usageMonthKey === "string" && details.usageMonthKey && (
                <Text style={styles.statSubText}>Period: {details.usageMonthKey}</Text>
              )}
            </View>
          )}

          <View style={styles.actions}>
            <Pressable style={[styles.button, styles.secondary]} onPress={onClose}>
              <Text style={styles.secondaryText}>Not now</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.primary]} onPress={onUpgrade}>
              <Text style={styles.primaryText}>View plans</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#0f172a",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  title: {
    color: "#f1f5f9",
    fontSize: 18,
    fontWeight: "800",
  },
  body: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 20,
  },
  stats: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#111c33",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  statText: {
    color: "#e2e8f0",
    fontWeight: "700",
  },
  statSubText: {
    color: "#94a3b8",
    marginTop: 4,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: {
    backgroundColor: "#38bdf8",
  },
  primaryText: {
    color: "#020617",
    fontWeight: "900",
  },
  secondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#334155",
  },
  secondaryText: {
    color: "#e2e8f0",
    fontWeight: "800",
  },
});
