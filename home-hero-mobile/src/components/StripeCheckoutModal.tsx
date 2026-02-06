import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { useStripePayment } from "../hooks/useStripePayment";

interface StripeCheckoutModalProps {
  visible: boolean;
  tier: "BASIC" | "PRO" | null;
  onClose: () => void;
  onSuccess: (subscription: any) => void;
}

const TIER_DETAILS = {
  BASIC: {
    name: "BASIC",
    price: "$6",
    billing: "/month",
    description: "100 bids per month + email support",
  },
  PRO: {
    name: "PRO",
    price: "$12",
    billing: "/month",
    description: "Unlimited bids + 24/7 priority support",
  },
};

export const StripeCheckoutModal: React.FC<StripeCheckoutModalProps> = ({
  visible,
  tier,
  onClose,
  onSuccess,
}) => {
  const { initiatePayment, status, error, reset } = useStripePayment();

  const handlePayment = async () => {
    if (!tier) return;

    const result = await initiatePayment(tier);

    if (result.success) {
      onSuccess(result.subscription);
      onClose();
      reset();
    }
  };

  const handleClose = () => {
    if (status === "processing") return; // Prevent closing while processing
    reset();
    onClose();
  };

  if (!tier) return null;

  const details = TIER_DETAILS[tier];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Upgrade Subscription</Text>
            <Pressable
              onPress={handleClose}
              disabled={status === "processing"}
              hitSlop={10}
            >
              <MaterialCommunityIcons name="close" size={28} color="#fff" />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
          >
            {/* Plan Summary */}
            <View style={styles.planSummary}>
              <Text style={styles.planName}>{details.name} Plan</Text>
              <View style={styles.priceRow}>
                <Text style={styles.price}>{details.price}</Text>
                <Text style={styles.billing}>{details.billing}</Text>
              </View>
              <Text style={styles.description}>{details.description}</Text>
            </View>

            {/* Payment Form */}
            <View style={styles.formSection}>
              <Text style={styles.sectionTitle}>Payment Information</Text>

              {error && (
                <View style={styles.errorBox}>
                  <MaterialCommunityIcons
                    name="alert-circle"
                    size={20}
                    color="#fca5a5"
                  />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              {status === "success" && (
                <View style={styles.successBox}>
                  <MaterialCommunityIcons
                    name="check-circle"
                    size={20}
                    color="#86efac"
                  />
                  <Text style={styles.successText}>Payment successful!</Text>
                </View>
              )}

              <Text style={styles.infoText}>
                Your payment will be processed securely by Stripe. We do not
                store your card details.
              </Text>
            </View>

            {/* Terms */}
            <View style={styles.termsSection}>
              <Text style={styles.termsText}>
                By clicking “Pay Now”, you agree to subscribe to this plan.
                Your subscription will renew automatically each month unless you
                cancel.
              </Text>
            </View>
          </ScrollView>

          {/* Footer Buttons */}
          <View style={styles.footer}>
            <Pressable
              style={[styles.button, styles.cancelButton]}
              onPress={handleClose}
              disabled={status === "processing"}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>

            <Pressable
              style={[
                styles.button,
                styles.payButton,
                status === "processing" && styles.payButtonDisabled,
              ]}
              onPress={handlePayment}
              disabled={status === "processing"}
            >
              {status === "processing" ? (
                <>
                  <ActivityIndicator color="#020617" />
                  <Text style={styles.payButtonText}>Processing...</Text>
                </>
              ) : (
                <Text style={styles.payButtonText}>Pay Now</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

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
  planSummary: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  planName: {
    fontSize: 18,
    fontWeight: "900",
    color: "#38bdf8",
    marginBottom: 8,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginBottom: 8,
  },
  price: {
    fontSize: 32,
    fontWeight: "900",
    color: "#fff",
  },
  billing: {
    fontSize: 14,
    color: "#94a3b8",
    marginLeft: 4,
  },
  description: {
    fontSize: 14,
    color: "#cbd5e1",
  },
  formSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "900",
    color: "#fff",
    marginBottom: 12,
  },
  errorBox: {
    backgroundColor: "#7f1d1d",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: {
    color: "#fca5a5",
    flex: 1,
    fontSize: 13,
  },
  successBox: {
    backgroundColor: "#1b5e20",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  successText: {
    color: "#86efac",
    flex: 1,
    fontSize: 13,
  },
  infoText: {
    fontSize: 12,
    color: "#94a3b8",
    fontStyle: "italic",
  },
  termsSection: {
    marginBottom: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
  termsText: {
    fontSize: 12,
    color: "#64748b",
    lineHeight: 18,
  },
  footer: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  cancelButton: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  cancelButtonText: {
    color: "#38bdf8",
    fontWeight: "900",
    fontSize: 14,
  },
  payButton: {
    backgroundColor: "#38bdf8",
  },
  payButtonDisabled: {
    opacity: 0.6,
  },
  payButtonText: {
    color: "#020617",
    fontWeight: "900",
    fontSize: 14,
  },
});
