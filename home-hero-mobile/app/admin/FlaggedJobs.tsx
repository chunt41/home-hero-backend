
import React from "react";
import { View, Text, FlatList, ActivityIndicator, StyleSheet, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFlaggedJobs } from "../../src/hooks/useFlaggedJobs";

export default function FlaggedJobsScreen() {
  const { jobs, loading, error } = useFlaggedJobs();

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.muted}>Loading flagged jobs...</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <Text style={styles.error}>Failed to load flagged jobs</Text>
          <Text style={styles.muted}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (!jobs.length) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <Text style={styles.muted}>No flagged jobs found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.title}>Flagged Jobs</Text>
        {jobs.map((job) => (
          <View key={job.id} style={styles.card}>
            <Text style={styles.jobTitle}>{job.title}</Text>
            <Text style={styles.jobMeta}>ID: {job.id} | Created: {new Date(job.createdAt).toLocaleString()}</Text>
            <Text style={styles.jobMeta}>Consumer: {job.consumer?.name} ({job.consumer?.email})</Text>
            <Text style={styles.sectionTitle}>Reports:</Text>
            {job.reports.map((report: any) => (
              <View key={report.id} style={styles.reportBox}>
                <Text style={styles.reportReason}>Reason: {report.reason}</Text>
                <Text style={styles.reportDetails}>{report.details}</Text>
                <Text style={styles.reportMeta}>By: {report.reporter?.name} ({report.reporter?.email})</Text>
                <Text style={styles.reportMeta}>Status: {report.status} | {report.handledAt ? `Handled at: ${new Date(report.handledAt).toLocaleString()}` : "Open"}</Text>
                {report.handledByAdmin && (
                  <Text style={styles.reportMeta}>Handled by: {report.handledByAdmin.name} ({report.handledByAdmin.email})</Text>
                )}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#020617" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: "#94a3b8", marginTop: 12 },
  error: { color: "#f59e0b", fontWeight: "700", marginBottom: 8 },
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "800", marginBottom: 18 },
  card: { backgroundColor: "#0f172a", borderRadius: 12, padding: 16, marginBottom: 18, borderWidth: 1, borderColor: "#1e293b" },
  jobTitle: { color: "#38bdf8", fontWeight: "700", fontSize: 16, marginBottom: 4 },
  jobMeta: { color: "#94a3b8", fontSize: 12, marginBottom: 2 },
  sectionTitle: { color: "#f1f5f9", fontWeight: "700", marginTop: 10, marginBottom: 4 },
  reportBox: { backgroundColor: "#1e293b", borderRadius: 8, padding: 10, marginBottom: 8 },
  reportReason: { color: "#f59e0b", fontWeight: "700" },
  reportDetails: { color: "#f1f5f9", marginBottom: 2 },
  reportMeta: { color: "#94a3b8", fontSize: 11 },
});
