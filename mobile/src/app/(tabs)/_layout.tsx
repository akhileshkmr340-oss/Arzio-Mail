import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { useTheme } from '../../lib/theme';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 20 }} accessible={false}>{glyph}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{
      tabBarActiveTintColor: t.brand, tabBarInactiveTintColor: t.muted,
      tabBarStyle: { backgroundColor: t.panel, borderTopColor: t.line },
      headerStyle: { backgroundColor: t.panel }, headerTitleStyle: { color: t.text }, headerTintColor: t.brand,
    }}>
      <Tabs.Screen name="index" options={{ title: 'Mail', tabBarLabel: 'Mail', tabBarIcon: icon('✉') }} />
      <Tabs.Screen name="calendar" options={{ title: 'Calendar', tabBarIcon: icon('▦') }} />
      <Tabs.Screen name="todo" options={{ title: 'To Do', tabBarIcon: icon('✓') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('☺') }} />
    </Tabs>
  );
}
