import React from "react";
import { useAuth } from "../context/AuthContext";
import ProviderEarningsScreen from "./ProviderEarningsScreen";
import AdminEarningsScreen from "./AdminEarningsScreen";

export default function EarningsScreen() {
  const { user } = useAuth();

  // Show admin earnings dashboard if user is admin
  if (user?.role === "ADMIN") {
    return <AdminEarningsScreen />;
  }

  // Default: Show provider earnings for providers and consumers
  return <ProviderEarningsScreen />;
}
