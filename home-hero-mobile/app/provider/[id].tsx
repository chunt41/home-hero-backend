import { useLocalSearchParams } from "expo-router";
import ProviderProfileScreen from "../../src/screens/ProviderProfileScreen";

export default function ProviderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <ProviderProfileScreen providerId={id ? parseInt(id) : undefined} />;
}
