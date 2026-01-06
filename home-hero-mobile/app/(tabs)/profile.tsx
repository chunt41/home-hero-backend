import { View, Text, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";
import { useSubscription } from "../../src/hooks/useSubscription";
import { StatusBar } from "expo-status-bar";

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
