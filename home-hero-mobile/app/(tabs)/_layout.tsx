import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";
import { useNotificationsBadge } from "../../src/hooks/useNotificationsBadge";



export default function TabLayout() {
  const { isAuthenticated, user } = useAuth();
  const { unreadCount } = useNotificationsBadge(30000);

  // If logged out, block tabs entirely
  if (!isAuthenticated) {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: "#020617" },
        tabBarActiveTintColor: "#38bdf8",
        tabBarInactiveTintColor: "#64748b",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />

      {/* Provider-facing Jobs tab - only visible to PROVIDER role */}
      <Tabs.Screen
        name="jobs"
        options={{
          title: "Jobs",
          href: user?.role === "PROVIDER" ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="briefcase-outline" size={size} color={color} />
          ),
        }}
      />

      {/* Earnings tab - visible to PROVIDER and ADMIN */}
      <Tabs.Screen
        name="provider/earnings"
        options={{
          title: "Earnings",
          href:
            user?.role === "PROVIDER" || user?.role === "ADMIN"
              ? undefined
              : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet-outline" size={size} color={color} />
          ),
        }}
      />

      {/* Consumer-facing My Jobs tab - only visible to CONSUMER role */}
      <Tabs.Screen
        name="consumer-jobs"
        options={{
          title: "My Jobs",
          href: user?.role === "CONSUMER" ? undefined : null,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="briefcase-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="messages"
        options={{
          title: "Messages",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: "Logout",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="log-out-outline" size={size} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="notifications"
        options={{
          title: "Alerts",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" size={size} color={color} />
          ),
          tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
        }}
      />
    </Tabs>
  );
}
