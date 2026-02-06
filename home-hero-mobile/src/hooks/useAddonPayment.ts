import { useCallback, useState } from "react";
import { api } from "../lib/apiClient";

type StripeHooks = {
  initPaymentSheet: ((args: any) => Promise<{ error?: { message?: string } }>) | null;
  presentPaymentSheet: (() => Promise<{ error?: { code?: string; message?: string } }>) | null;
};

let stripeAvailable = false;
let useStripeHook: () => StripeHooks = () => ({ initPaymentSheet: null, presentPaymentSheet: null });

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stripeModule = require("@stripe/stripe-react-native");
  useStripeHook = stripeModule.useStripe;
  stripeAvailable = true;
} catch {
  // Stripe not available (e.g. web without native module)
}

export type PaymentStatus = "idle" | "processing" | "success" | "error";

export type AddonPurchase =
  | { type: "EXTRA_LEADS"; quantity: number }
  | { type: "VERIFICATION_BADGE" }
  | { type: "FEATURED_ZIP_CODES"; zipCodes: string[] };

export function useAddonPayment() {
  const { initPaymentSheet, presentPaymentSheet } = useStripeHook();

  const [status, setStatus] = useState<PaymentStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const initiateAddonPayment = useCallback(
    async (addon: AddonPurchase) => {
      if (!stripeAvailable || !initPaymentSheet || !presentPaymentSheet) {
        setError("Payment processing is not available");
        setStatus("error");
        return { success: false as const };
      }

      setStatus("processing");
      setError(null);

      try {
        const response = await api.post<{
          clientSecret: string;
          paymentIntentId: string;
        }>("/provider/addons/purchase", addon);

        const { clientSecret } = response;

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

        const { error: presentError } = await presentPaymentSheet();

        if (presentError?.code === "Cancelled") {
          setStatus("idle");
          return { success: false as const, cancelled: true as const };
        }

        if (presentError) {
          throw new Error(presentError.message || "Payment failed");
        }

        const confirmResponse = await api.post<{
          success: boolean;
          subscription: any;
        }>("/payments/confirm", {
          paymentIntentId: response.paymentIntentId,
        });

        setStatus("success");
        return { success: true as const, subscription: confirmResponse.subscription };
      } catch (err: any) {
        const message = err?.message || "Payment failed. Please try again.";
        setError(message);
        setStatus("error");
        return { success: false as const, error: message };
      }
    },
    [initPaymentSheet, presentPaymentSheet]
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return {
    initiateAddonPayment,
    status,
    error,
    reset,
  };
}
