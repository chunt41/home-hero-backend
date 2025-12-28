
import React from "react";
import { View, Text, ScrollView, Dimensions, ActivityIndicator, UIManager } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LineChart } from "react-native-chart-kit";
import { useAdminAnalytics } from "../../src/hooks/useAdminAnalytics";

const chartConfig = {
  backgroundGradientFrom: "#0f172a",
  backgroundGradientTo: "#0f172a",
  color: (opacity = 1) => `rgba(56, 189, 248, ${opacity})`,
  labelColor: (opacity = 1) => `rgba(148, 163, 184, ${opacity})`,
  strokeWidth: 2,
  propsForDots: { r: "2", strokeWidth: "1", stroke: "#38bdf8" },
};

export default function AdminAnalyticsScreen() {
  const { data, loading, error } = useAdminAnalytics();
  const screenWidth = Dimensions.get("window").width - 32;
  const svgAvailable = !!UIManager.getViewManagerConfig?.("RNSVGRect");

  if (loading) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: "#020617",
          alignItems: "center",
          justifyContent: "center",
        }}
        edges={["top"]}
      >
        <ActivityIndicator size="large" color="#38bdf8" />
        <Text style={{ color: "#94a3b8", marginTop: 12 }}>Loading analytics...</Text>
      </SafeAreaView>
    );
  }
  if (error || !data) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: "#020617",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
        edges={["top"]}
      >
        <Text style={{ color: "#f59e0b", fontWeight: "700" }}>Failed to load analytics</Text>
        <Text style={{ color: "#94a3b8" }}>{error || "No data"}</Text>
      </SafeAreaView>
    );
  }

  // Prepare chart data
  const labels = data.range.map((d, i) => (i % 5 === 0 ? d.slice(5) : ""));
  const usersData = data.range.map((d) => data.users[d] || 0);
  const jobsData = data.range.map((d) => data.jobs[d] || 0);
  const revenueData = data.range.map((d) => (data.revenue[d] || 0) / 100); // cents to dollars

  if (!svgAvailable) {
    const totalNewUsers = usersData.reduce((sum, n) => sum + n, 0);
    const totalJobs = jobsData.reduce((sum, n) => sum + n, 0);
    const totalRevenue = revenueData.reduce((sum, n) => sum + n, 0);

    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }} edges={["top"]}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
          <Text style={{ color: "#f1f5f9", fontSize: 22, fontWeight: "800", marginBottom: 10 }}>
            Platform Analytics
          </Text>

          <Text style={{ color: "#f59e0b", fontWeight: "700", marginBottom: 6 }}>
            Charts unavailable in this build
          </Text>
          <Text style={{ color: "#94a3b8", marginBottom: 18 }}>
            This screen uses react-native-svg. Your current Android build is missing the native SVG view manager
            (RNSVGRect), so charts are disabled to prevent a crash. Rebuild/reinstall the dev client after
            installing Android SDK Platform-Tools/SDK.
          </Text>

          <View style={{ backgroundColor: "#0f172a", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#1e293b" }}>
            <Text style={{ color: "#38bdf8", fontWeight: "700", marginBottom: 8 }}>Last 30 Days Summary</Text>
            <Text style={{ color: "#f1f5f9", marginBottom: 6 }}>New users: {totalNewUsers}</Text>
            <Text style={{ color: "#f1f5f9", marginBottom: 6 }}>Jobs created: {totalJobs}</Text>
            <Text style={{ color: "#f1f5f9" }}>Revenue: ${totalRevenue.toFixed(2)}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }} edges={["top"]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text style={{ color: "#f1f5f9", fontSize: 22, fontWeight: "800", marginBottom: 18 }}>
          Platform Analytics
        </Text>

        <Text style={{ color: "#38bdf8", fontWeight: "700", marginBottom: 6 }}>New Users (Last 30 Days)</Text>
        <LineChart
          data={{ labels, datasets: [{ data: usersData }] }}
          width={screenWidth}
          height={180}
          chartConfig={chartConfig}
          bezier
          style={{ borderRadius: 12, marginBottom: 24 }}
        />

        <Text style={{ color: "#38bdf8", fontWeight: "700", marginBottom: 6 }}>Jobs Created (Last 30 Days)</Text>
        <LineChart
          data={{ labels, datasets: [{ data: jobsData }] }}
          width={screenWidth}
          height={180}
          chartConfig={chartConfig}
          bezier
          style={{ borderRadius: 12, marginBottom: 24 }}
        />

        <Text style={{ color: "#38bdf8", fontWeight: "700", marginBottom: 6 }}>Revenue (Last 30 Days, $)</Text>
        <LineChart
          data={{ labels, datasets: [{ data: revenueData }] }}
          width={screenWidth}
          height={180}
          chartConfig={chartConfig}
          bezier
          style={{ borderRadius: 12, marginBottom: 24 }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
