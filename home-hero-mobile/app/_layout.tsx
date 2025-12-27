import { Stack } from "expo-router";
import { AuthProvider } from "../src/context/AuthContext";

let StripeProvider: any = null;

try {
  const stripeModule = require("@stripe/stripe-react-native");
  StripeProvider = stripeModule.StripeProvider;
} catch (e) {
  console.log("Stripe SDK not available");
}

const STRIPE_PUBLISHABLE_KEY =
  "pk_live_51Sinbw8MCbBWchFrU5T1o8JBARDaSNUTIc9OmP9wSQOMd43wWXcIvnWhHYhZNqs73yzlk8l6XqK8QIBNPGfTRNpr00QABmAqZL";

export default function RootLayout() {
  const LayoutContent = (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );

  // If StripeProvider is available, wrap with it
  if (StripeProvider) {
    return (
      <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY}>
        {LayoutContent}
      </StripeProvider>
    );
  }

  // Otherwise return without Stripe wrapper
  return LayoutContent;
}
