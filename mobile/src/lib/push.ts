// Push notifications: ask permission, get the Expo push token, give it to the
// server. New mail and reminders then arrive even when the app is closed.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { api } from './api';
import { storage } from './storage';

if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

export const getRegisteredToken = () => storage.get('pushToken');

/** Returns the token, or null when push is not possible (web, simulator, refused, no project id) */
export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('mail', { name: 'New mail', importance: Notifications.AndroidImportance.HIGH });
    await Notifications.setNotificationChannelAsync('reminders', { name: 'Reminders', importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  // Set by `eas init` (app.json extra.eas.projectId)
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) { console.warn('[push] no EAS project id: run "eas init" to enable push'); return null; }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api.registerPush(token, Platform.OS, Device.deviceName || Device.modelName || Platform.OS);
  await storage.set('pushToken', token);
  return token;
}

/** What a tapped notification should open */
export function routeForNotification(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (data.type === 'mail' && data.messageId) return `/message/${data.messageId}`;
  if (data.eventId) return `/event/${data.eventId}`;
  if (data.type === 'task' || data.taskId) return '/todo';
  return null;
}
