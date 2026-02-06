import React from "react";
import { Stack } from "expo-router";

export default function ProviderLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="my-bids" />
      <Stack.Screen name="bid-detail" />
      <Stack.Screen name="bid-templates" />
      <Stack.Screen name="quick-replies" />
      <Stack.Screen name="availability" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="verification" />
    </Stack>
  );
}
