
import { useAuth } from "../../src/context/AuthContext";
import ProviderDashboardScreen from "../../src/screens/ProviderDashboardScreen";
import ConsumerDashboardScreen from "../../src/screens/ConsumerDashboardScreen";
import { Redirect } from "expo-router";

export default function HomeScreen() {
  const { user } = useAuth();

  if (user?.role === "ADMIN") {
    return <Redirect href="/admin" />;
  }
  if (user?.role === "PROVIDER") {
    return <ProviderDashboardScreen />;
  }
  return <ConsumerDashboardScreen />;
}

