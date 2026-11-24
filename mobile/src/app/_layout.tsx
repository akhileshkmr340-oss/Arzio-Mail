import { useEffect } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { Stack, router, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../lib/auth';
import { routeForNotification } from '../lib/push';
import { useTheme } from '../lib/theme';

function Gate() {
  const { ready, me } = useAuth();
  const segments = useSegments();
  const t = useTheme();

  // Signed out: sign-in screen. Signed in: away from it.
  useEffect(() => {
    if (!ready) return;
    const onSignIn = segments[0] === 'sign-in';
    if (!me && !onSignIn) router.replace('/sign-in');
    else if (me && onSignIn) router.replace('/');
  }, [ready, me, segments]);

  // Tapping a notification opens the message, event or task
  useEffect(() => {
    if (Platform.OS === 'web' || !me) return;
    const open = (data: Record<string, unknown> | undefined) => { const r = routeForNotification(data); if (r) router.push(r as never); };
    Notifications.getLastNotificationResponseAsync().then((r) => r && open(r.notification.request.content.data));
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
    return () => sub.remove();
  }, [me]);

  if (!ready) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator color={t.brand} /></View>;
  return (
    <Stack screenOptions={{ headerTintColor: t.brand, headerStyle: { backgroundColor: t.panel }, headerTitleStyle: { color: t.text }, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="message/[id]" options={{ title: '' }} />
      <Stack.Screen name="event/[id]" options={{ title: 'Event' }} />
      <Stack.Screen name="compose" options={{ title: 'New message', presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
