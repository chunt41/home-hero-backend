import { View, Text, Pressable, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";
import { useSubscription } from "../../src/hooks/useSubscription";
import { StatusBar } from "expo-status-bar";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../../src/config";

export default function ProfileScreen() {
  const { logout, user } = useAuth();
  const { subscription, fetchSubscription } = useSubscription();

  const isProvider = user?.role === "PROVIDER";
  return (
    <SafeAreaView
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        gap: 12,
        backgroundColor: "#020617",
      }}
      edges={["top"]}
    >
      <StatusBar style="light" backgroundColor="#020617" />
      {isProvider ? (
        <>
          <View style={{ alignItems: "center", gap: 6 }}>
            <Text style={{ color: "#94a3b8", fontWeight: "800" }}>Current plan</Text>
            <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 18 }}>
              {subscription?.tier ?? "FREE"}
            </Text>
          </View>

          <Pressable
            onPress={() => router.push("/provider/subscription")}
            style={{
              backgroundColor: "#1e293b",
              padding: 16,
              borderRadius: 10,
              minWidth: 220,
              alignItems: "center",
            }}
          >
            <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 16 }}>
              Subscription
            </Text>
          </Pressable>

          <Pressable
            onPress={() => fetchSubscription()}
            style={{
              backgroundColor: "#0f172a",
              padding: 12,
              borderRadius: 10,
              minWidth: 220,
              alignItems: "center",
              borderWidth: 1,
              borderColor: "#1e293b",
            }}
          >
            <Text style={{ color: "#cbd5e1", fontWeight: "900", fontSize: 14 }}>
              Refresh Subscription
            </Text>
          </Pressable>
        </>
      ) : null}

      <Pressable
        onPress={() => router.push("/blocked-users")}
        style={{
          backgroundColor: "#1e293b",
          padding: 16,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 16 }}>
          Blocked Users
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.push("/my-reports")}
        style={{
          backgroundColor: "#1e293b",
          padding: 16,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 16 }}>
          My Reports
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.push("/notification-preferences" as any)}
        style={{
          backgroundColor: "#1e293b",
          padding: 16,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#e2e8f0", fontWeight: "900", fontSize: 16 }}>
          Notification Settings
        </Text>
      </Pressable>

      <View style={{ height: 8 }} />

      <Pressable
        onPress={() => {
          if (PRIVACY_POLICY_URL) return Linking.openURL(PRIVACY_POLICY_URL);
          router.push("/legal/privacy" as any);
        }}
        style={{
          backgroundColor: "#0f172a",
          padding: 12,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
          borderWidth: 1,
          borderColor: "#1e293b",
        }}
      >
        <Text style={{ color: "#cbd5e1", fontWeight: "900", fontSize: 14 }}>
          Privacy Policy
        </Text>
      </Pressable>

      <Pressable
        onPress={() => {
          if (TERMS_OF_SERVICE_URL) return Linking.openURL(TERMS_OF_SERVICE_URL);
          router.push("/legal/terms" as any);
        }}
        style={{
          backgroundColor: "#0f172a",
          padding: 12,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
          borderWidth: 1,
          borderColor: "#1e293b",
        }}
      >
        <Text style={{ color: "#cbd5e1", fontWeight: "900", fontSize: 14 }}>
          Terms of Service
        </Text>
      </Pressable>

      <Text style={{ color: "#64748b", fontSize: 12, maxWidth: 260, textAlign: "center" }}>
        Ads + data collection disclosure is included in the policies.
      </Text>

      <Pressable
        onPress={() => logout()}
        style={{
          backgroundColor: "#ef4444",
          padding: 16,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "900", fontSize: 16 }}>Logout</Text>
      </Pressable>
    </SafeAreaView>
  );
}
