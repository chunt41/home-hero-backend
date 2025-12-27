import { Stack } from "expo-router";

export default function MessagesLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: "Messages" }} />
      <Stack.Screen name="[jobId]" options={{ title: "Chat" }} />
    </Stack>
  );
}

