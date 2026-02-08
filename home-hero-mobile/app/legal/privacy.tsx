import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

export default function PrivacyPolicyScreen() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }} edges={["top"]}>
      <StatusBar style="light" backgroundColor="#020617" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 22 }}>
          Privacy Policy
        </Text>

        <Text style={{ color: "#94a3b8" }}>
          This is a placeholder privacy policy bundled with the app for store submission
          readiness. Replace with your hosted policy URL when available.
        </Text>

        <Section title="Summary">
          <Text style={styles.p}>
            We collect information you provide (account details, job posts, messages) and
            information collected automatically (device/app usage, logs) to operate and
            improve the service.
          </Text>
        </Section>

        <Section title="Ads + Data Collection Disclosure">
          <Text style={styles.p}>
            Ads: The app may show ads in the future. If enabled, ad partners may collect
            device identifiers and usage information to measure ad performance and, if
            permitted, personalize ads.
          </Text>
          <Text style={styles.p}>
            Analytics: We may collect app usage analytics (e.g., screen views, feature
            interactions) to improve reliability and user experience.
          </Text>
        </Section>

        <Section title="Contact">
          <Text style={styles.p}>Email: support@homehero.example (replace)</Text>
        </Section>

        <Text style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>
          Tip: Set EXPO_PUBLIC_PRIVACY_POLICY_URL to open the hosted policy instead of this
          placeholder.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 16 }}>{title}</Text>
      {children}
    </View>
  );
}

const styles = {
  p: {
    color: "#cbd5e1",
    lineHeight: 20,
  } as const,
};
