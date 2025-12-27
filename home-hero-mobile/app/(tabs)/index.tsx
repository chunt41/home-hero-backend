import { useAuth } from "../../src/context/AuthContext";
import ProviderDashboardScreen from "../../src/screens/ProviderDashboardScreen";
import ConsumerDashboardScreen from "../../src/screens/ConsumerDashboardScreen";

export default function HomeScreen() {
  const { user } = useAuth();

  if (user?.role === "PROVIDER") {
    return <ProviderDashboardScreen />;
  }

  return <ConsumerDashboardScreen />;
}

