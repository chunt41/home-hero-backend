import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { api } from "./apiClient";
import { emitNotificationsChanged } from "./notificationsEvents";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

function getProjectId(): string | null {
  const easProjectId = (Constants.expoConfig as any)?.extra?.eas?.projectId;
  return typeof easProjectId === "string" && easProjectId.trim() ? easProjectId.trim() : null;
}

export async function registerForPushNotificationsAndSync(): Promise<{ token: string | null }>{
  if (!Device.isDevice) {
    // Push tokens don’t work on most emulators/simulators
    return { token: null };
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    finalStatus = req.status;
  }

  if (finalStatus !== "granted") {
    return { token: null };
  }

  const projectId = getProjectId();
  const tokenResp = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  );

  const token = tokenResp?.data ?? null;
  if (!token) return { token: null };

  // Best-effort: store token server-side
  try {
    await api.post("/me/push-token", {
      token,
      platform: Device.osName ?? null,
    });
  } catch {
    // ignore
  }

  return { token };
}

export function startPushNotificationListeners() {
  const subReceived = Notifications.addNotificationReceivedListener(() => {
    // Trigger a refresh of in-app notifications/badges on receipt
    emitNotificationsChanged();
  });

  const subResponse = Notifications.addNotificationResponseReceivedListener(() => {
    emitNotificationsChanged();
  });

  return () => {
    subReceived.remove();
    subResponse.remove();
  };
}
