import { View, Text, Pressable } from "react-native";
import { router } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";

export default function ProfileScreen() {
  const { logout, user } = useAuth();
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <Pressable
        onPress={() => logout()}
        style={{
          backgroundColor: "#ef4444",
          padding: 16,
          borderRadius: 10,
          minWidth: 220,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "900", fontSize: 16 }}>Logout</Text>
      </Pressable>
    </View>
  );
}
