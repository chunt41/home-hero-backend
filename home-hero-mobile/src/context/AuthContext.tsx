import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { api, deleteAuthToken, saveAuthToken } from "../lib/apiClient";

const TOKEN_KEY = "homeHero.authToken";

type AuthUser = {
  id: number;
  role: "CONSUMER" | "PROVIDER" | "ADMIN" | string;
  name?: string | null;
  email?: string | null;
};

type SignupPayload = {
  email: string;
  password: string;
  role: "CONSUMER" | "PROVIDER";
  name?: string;
};

type AuthContextValue = {
  isAuthenticated: boolean;
  isBooting: boolean;
  token: string | null;
  user: AuthUser | null;

  login: (email: string, password: string) => Promise<void>;
  signup: (payload: SignupPayload) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isBooting, setIsBooting] = useState(true);

  // Hydrate token on app start
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const t = await SecureStore.getItemAsync(TOKEN_KEY);
        if (!mounted) return;
        setToken(t);
      } finally {
        if (mounted) setIsBooting(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: !!token,
      token,
      user,
      isBooting,

      login: async (email: string, password: string) => {
        const data = await api.post<{ token: string; user?: AuthUser }>(
          "/auth/login",
          { email, password }
        );
        await saveAuthToken(data.token);
        setToken(data.token);
        if (data.user) setUser(data.user);
      },

      signup: async (payload) => {
        const data = await api.post<{ token: string; user?: AuthUser }>(
          "/auth/signup",
          payload
        );
        await saveAuthToken(data.token);
        setToken(data.token);
        if (data.user) setUser(data.user);
      },

      logout: async () => {
        await deleteAuthToken();
        setToken(null);
        setUser(null);
      },
    }),
    [token, user, isBooting]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
