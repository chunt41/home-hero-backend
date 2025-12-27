import { useState, useCallback } from "react";
import { api } from "../lib/apiClient";

let useStripe: any = null;
let CardField: any = null;

try {
  const stripeModule = require("@stripe/stripe-react-native");
  useStripe = stripeModule.useStripe;
  CardField = stripeModule.CardField;
} catch (e) {
  console.log("Stripe not available");
}

export type PaymentStatus = "idle" | "processing" | "success" | "error";

export function useStripePayment() {
  const stripeHooks = useStripe ? useStripe() : { initPaymentSheet: null, presentPaymentSheet: null };
  const { initPaymentSheet, presentPaymentSheet } = stripeHooks;
  const [status, setStatus] = useState<PaymentStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const initiatePayment = useCallback(
    async (tier: "BASIC" | "PRO") => {
      if (!useStripe || !initPaymentSheet) {
        setError("Payment processing is not available");
        setStatus("error");
        return { success: false, subscription: null };
      }

      setStatus("processing");
      setError(null);

      try {
        // Step 1: Create payment intent on backend
        const response = await api.post<{
          clientSecret: string;
          paymentIntentId: string;
        }>("/payments/create-intent", {
          tier,
        });

        const { clientSecret } = response;

        // Step 2: Initialize payment sheet
        const { error: initError } = await initPaymentSheet({
          paymentIntentClientSecret: clientSecret,
          merchantDisplayName: "Home Hero",
          defaultBillingDetails: {
            name: "Customer",
          },
        });

        if (initError) {
          throw new Error(initError.message || "Failed to initialize payment");
        }

        // Step 3: Present payment sheet to user
        const { error: presentError } = await presentPaymentSheet();

        if (presentError?.code === "Cancelled") {
          setStatus("idle");
          return { success: false, cancelled: true };
        }

        if (presentError) {
          throw new Error(presentError.message || "Payment failed");
        }

        // Step 4: Confirm payment on backend
        const confirmResponse = await api.post<{
          success: boolean;
          subscription: any;
        }>("/payments/confirm", {
          paymentIntentId: response.paymentIntentId,
        });

        setStatus("success");
        return { success: true, subscription: confirmResponse.subscription };
      } catch (err: any) {
        const message = err?.message || "Payment failed. Please try again.";
        setError(message);
        setStatus("error");
        return { success: false, error: message };
      }
    },
    [initPaymentSheet, presentPaymentSheet]
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    initiatePayment,
    status,
    error,
    reset,
  };
}
