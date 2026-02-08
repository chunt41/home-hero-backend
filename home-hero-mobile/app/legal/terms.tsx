import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

export default function TermsOfServiceScreen() {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }} edges={["top"]}>
      <StatusBar style="light" backgroundColor="#020617" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 22 }}>
          Terms of Service
        </Text>

        <Text style={{ color: "#94a3b8" }}>
          This is a placeholder Terms of Service bundled with the app for store submission
          readiness. Replace with your hosted terms URL when available.
        </Text>

        <Section title="Key points">
          <Text style={styles.p}>
            By using the app, you agree to follow the rules, provide accurate information,
            and use the service lawfully. We may suspend or terminate accounts that violate
            policies.
          </Text>
        </Section>

        <Section title="Ads + Analytics">
          <Text style={styles.p}>
            The app may use analytics to improve the service. If advertising is enabled,
            additional data may be collected to measure ad performance (and, if permitted,
            personalize ads).
          </Text>
        </Section>

        <Section title="Contact">
          <Text style={styles.p}>Email: support@homehero.example (replace)</Text>
        </Section>

        <Text style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>
          Tip: Set EXPO_PUBLIC_TERMS_OF_SERVICE_URL to open the hosted terms instead of this
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
