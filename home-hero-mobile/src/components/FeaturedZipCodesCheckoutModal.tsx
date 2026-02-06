import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAddonPayment } from "../hooks/useAddonPayment";

type Props = {
  visible: boolean;
  existingZipCodes?: string[];
  onClose: () => void;
  onSuccess: (purchasedZipCodes: string[]) => void;
};

function normalizeZip(raw: string) {
  return raw.replace(/[^0-9]/g, "").slice(0, 5);
}

function isValidZip(zip: string) {
  return /^[0-9]{5}$/.test(zip);
}

export function FeaturedZipCodesCheckoutModal({
  visible,
  existingZipCodes,
  onClose,
  onSuccess,
}: Props) {
  const { initiateAddonPayment, status, error, reset } = useAddonPayment();
  const [zipInput, setZipInput] = useState("");
  const [zipCodesToBuy, setZipCodesToBuy] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    setZipInput("");
    setZipCodesToBuy([]);
  }, [visible]);

  const priceCentsPerZip = 200;
  const totalPriceText = useMemo(() => {
    const totalCents = Math.max(0, zipCodesToBuy.length) * priceCentsPerZip;
    return `$${(totalCents / 100).toFixed(2)}`;
  }, [zipCodesToBuy.length]);

  const canCheckout = zipCodesToBuy.length > 0 && status !== "processing";

  const handleClose = () => {
    if (status === "processing") return;
    reset();
    onClose();
  };

  const addZip = () => {
    const normalized = normalizeZip(zipInput);
    if (!isValidZip(normalized)) {
      setZipInput(normalized);
      return;
    }

    const existing = new Set(existingZipCodes ?? []);
    if (existing.has(normalized)) {
      setZipInput("");
      return;
    }

    setZipCodesToBuy((prev) => {
      if (prev.includes(normalized)) return prev;
      return [...prev, normalized].slice(0, 50);
    });

    setZipInput("");
  };

  const removeZip = (zip: string) => {
    setZipCodesToBuy((prev) => prev.filter((z) => z !== zip));
  };

  const handlePay = async () => {
    const res = await initiateAddonPayment({
      type: "FEATURED_ZIP_CODES",
      zipCodes: zipCodesToBuy,
    });
    if (res.success) {
      onSuccess(zipCodesToBuy);
      handleClose();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Featured Zip Codes</Text>
            <Pressable onPress={handleClose} disabled={status === "processing"} hitSlop={10}>
              <MaterialCommunityIcons name="close" size={28} color="#fff" />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.summaryCard}>
              <View style={styles.summaryRow}>
                <View style={styles.iconWrap}>
                  <MaterialCommunityIcons name="map-marker" size={18} color="#38bdf8" />
                </View>
                <Text style={styles.summaryTitle}>$2.00 per zip (one-time)</Text>
              </View>
              <Text style={styles.subtitle}>
                Choose the zip codes where you want to be featured.
              </Text>
            </View>

            <View style={styles.inputRow}>
              <TextInput
                value={zipInput}
                onChangeText={(t) => setZipInput(normalizeZip(t))}
                placeholder="Enter ZIP (e.g., 90210)"
                placeholderTextColor="#94a3b8"
                keyboardType="number-pad"
                maxLength={5}
                style={styles.input}
              />
              <Pressable style={styles.addButton} onPress={addZip} disabled={status === "processing"}>
                <Text style={styles.addButtonText}>Add</Text>
              </Pressable>
            </View>

            <View style={styles.zipList}>
              {(existingZipCodes?.length ?? 0) > 0 ? (
                <View style={styles.existingWrap}>
                  <Text style={styles.existingLabel}>
                    Currently featured: {existingZipCodes?.join(", ")}
                  </Text>
                </View>
              ) : null}

              {zipCodesToBuy.length === 0 ? (
                <Text style={styles.emptyText}>No new zip codes selected yet.</Text>
              ) : (
                zipCodesToBuy.map((zip) => (
                  <View key={zip} style={styles.zipChip}>
                    <Text style={styles.zipChipText}>{zip}</Text>
                    <Pressable
                      onPress={() => removeZip(zip)}
                      disabled={status === "processing"}
                      hitSlop={10}
                    >
                      <MaterialCommunityIcons name="close-circle" size={18} color="#94a3b8" />
                    </Pressable>
                  </View>
                ))
              )}
            </View>

            {error ? (
              <View style={styles.messageBoxError}>
                <MaterialCommunityIcons name="alert-circle" size={20} color="#fca5a5" />
                <Text style={styles.messageText}>{error}</Text>
              </View>
            ) : null}

            <Text style={styles.infoText}>
              Total: {totalPriceText} for {zipCodesToBuy.length} new zip code
              {zipCodesToBuy.length === 1 ? "" : "s"}.
            </Text>
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
              style={[styles.button, styles.payButton, !canCheckout && styles.payDisabled]}
              onPress={handlePay}
              disabled={!canCheckout}
            >
              {status === "processing" ? (
                <>
                  <ActivityIndicator color="#020617" />
                  <Text style={styles.payText}>Processing…</Text>
                </>
              ) : (
                <Text style={styles.payText}>Pay {totalPriceText}</Text>
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
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
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
  subtitle: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 20,
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 12,
  },
  input: {
    flex: 1,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fff",
  },
  addButton: {
    backgroundColor: "#38bdf8",
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: {
    color: "#020617",
    fontWeight: "900",
  },
  zipList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  existingWrap: {
    width: "100%",
    marginBottom: 8,
  },
  existingLabel: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
  },
  zipChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  zipChipText: {
    color: "#e2e8f0",
    fontWeight: "800",
  },
  emptyText: {
    color: "#94a3b8",
  },
  messageBoxError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#3f1d1d",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  messageText: {
    color: "#e2e8f0",
    flex: 1,
  },
  infoText: {
    color: "#94a3b8",
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 8,
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
