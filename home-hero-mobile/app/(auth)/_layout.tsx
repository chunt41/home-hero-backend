import { Stack, Redirect } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";

export default function AuthLayout() {
  const { isAuthenticated, isBooting } = useAuth();

  if (isBooting) return null; // or a splash loader later

  if (isAuthenticated) return <Redirect href="/(tabs)" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}

