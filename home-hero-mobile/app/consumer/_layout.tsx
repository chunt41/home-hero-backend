import { Stack } from "expo-router";

export default function ConsumerLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="job-bids" />
    </Stack>
  );
}
