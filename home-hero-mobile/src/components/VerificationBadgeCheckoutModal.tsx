import React, { useMemo } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAddonPayment } from "../hooks/useAddonPayment";

type Props = {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export function VerificationBadgeCheckoutModal({ visible, onClose, onSuccess }: Props) {
  const { initiateAddonPayment, status, error, reset } = useAddonPayment();

  const priceText = useMemo(() => "$10.00", []);

  const handleClose = () => {
    if (status === "processing") return;
    reset();
    onClose();
  };

  const handlePay = async () => {
    const res = await initiateAddonPayment({ type: "VERIFICATION_BADGE" });
    if (res.success) {
      onSuccess();
      handleClose();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Verification Badge</Text>
            <Pressable onPress={handleClose} disabled={status === "processing"} hitSlop={10}>
              <MaterialCommunityIcons name="close" size={28} color="#fff" />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.summaryCard}>
              <View style={styles.summaryRow}>
                <View style={styles.iconWrap}>
                  <MaterialCommunityIcons name="shield-check" size={18} color="#38bdf8" />
                </View>
                <Text style={styles.summaryTitle}>One-time purchase</Text>
              </View>
              <Text style={styles.price}>{priceText}</Text>
              <Text style={styles.subtitle}>Show a verified badge on your provider profile.</Text>
            </View>

            {error ? (
              <View style={styles.messageBoxError}>
                <MaterialCommunityIcons name="alert-circle" size={20} color="#fca5a5" />
                <Text style={styles.messageText}>{error}</Text>
              </View>
            ) : null}

            {status === "success" ? (
              <View style={styles.messageBoxSuccess}>
                <MaterialCommunityIcons name="check-circle" size={20} color="#86efac" />
                <Text style={styles.messageText}>Payment successful!</Text>
              </View>
            ) : null}

            <Text style={styles.infoText}>
              Your payment is processed securely by Stripe. We do not store your card details.
            </Text>
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              style={[styles.button, styles.cancelButton]}
              onPress={handleClose}
              disabled={status === "processing"}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>

            <Pressable
              style={[styles.button, styles.payButton, status === "processing" && styles.payDisabled]}
              onPress={handlePay}
              disabled={status === "processing"}
            >
              {status === "processing" ? (
                <>
                  <ActivityIndicator color="#020617" />
                  <Text style={styles.payText}>Processing…</Text>
                </>
              ) : (
                <Text style={styles.payText}>Pay {priceText}</Text>
              )}
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
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  container: {
    backgroundColor: "#020617",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "90%",
    paddingTop: 16,
    paddingBottom: 16,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  title: {
    fontSize: 20,
    fontWeight: "900",
    color: "#fff",
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  summaryCard: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#082f49",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  summaryTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "800",
  },
  price: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "900",
    marginBottom: 6,
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 20,
  },
  messageBoxError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#3f1d1d",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  messageBoxSuccess: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#14301c",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  messageText: {
    color: "#e2e8f0",
    flex: 1,
  },
  infoText: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
  button: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  cancelButton: {
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  cancelText: {
    color: "#e2e8f0",
    fontWeight: "800",
  },
  payButton: {
    backgroundColor: "#38bdf8",
  },
  payDisabled: {
    opacity: 0.7,
  },
  payText: {
    color: "#020617",
    fontWeight: "900",
  },
});
