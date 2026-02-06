import React, { useEffect } from "react";
import { NativeModules } from "react-native";
import { Stack } from "expo-router";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { SubscriptionProvider } from "../src/context/SubscriptionContext";
import {
  registerForPushNotificationsAndSync,
  startPushNotificationListeners,
} from "../src/lib/pushNotifications";

let StripeProvider: any = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stripeModule = require("@stripe/stripe-react-native");
  StripeProvider = stripeModule.StripeProvider;
} catch {
  console.log("Stripe SDK not available");
}

const STRIPE_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ?? "";

export default function RootLayout() {
  // Initialize Google Mobile Ads (required for reliable ad loading in dev builds).
  useEffect(() => {
    try {
      // Avoid requiring the package unless the native module exists.
      const proxy = (global as any)?.__turboModuleProxy;
      if (typeof proxy === "function") {
        try {
          if (!proxy("RNGoogleMobileAdsModule")) return;
        } catch {
          return;
        }
      } else {
        if (!(NativeModules as any)?.RNGoogleMobileAdsModule) return;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const gma = require("react-native-google-mobile-ads");
      if (typeof gma?.mobileAds === "function") {
        gma.mobileAds().initialize();
      }
    } catch {
      // ignore (e.g., Expo Go or module missing)
    }
  }, []);

  function PushBootstrapper() {
    const { isAuthenticated, isBooting } = useAuth();

    useEffect(() => {
      const stop = startPushNotificationListeners();
      return () => stop?.();
    }, []);

    useEffect(() => {
      if (isBooting) return;
      if (!isAuthenticated) return;
      registerForPushNotificationsAndSync().catch(() => null);
    }, [isAuthenticated, isBooting]);

    return null;
  }

  const LayoutContent = (
    <AuthProvider>
      <SubscriptionProvider>
        <PushBootstrapper />
        <Stack screenOptions={{ headerShown: false }} />
      </SubscriptionProvider>
    </AuthProvider>
  );

  // If StripeProvider is available and we have a publishable key, wrap with it.
  if (StripeProvider && STRIPE_PUBLISHABLE_KEY) {
    return (
      <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY}>
        {LayoutContent}
      </StripeProvider>
    );
  }

  if (StripeProvider && !STRIPE_PUBLISHABLE_KEY) {
    console.warn(
      "Stripe publishable key missing: set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to enable payments"
    );
  }

  // Otherwise return without Stripe wrapper
  return LayoutContent;
}
