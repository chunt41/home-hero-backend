import { Stack } from "expo-router";

export default function MessagesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#020617" },
        headerTintColor: "#e2e8f0",
        headerTitleStyle: { color: "#e2e8f0" },
        contentStyle: { backgroundColor: "#020617" },
        statusBarStyle: "light",
      }}
    >
      <Stack.Screen name="index" options={{ title: "Messages" }} />
      <Stack.Screen name="[jobId]" options={{ title: "Chat" }} />
    </Stack>
  );
}

