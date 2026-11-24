import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../lib/theme';
import { initials } from '../lib/format';

export function Button({ title, onPress, disabled, kind = 'primary', style, small }: { title: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger' | 'ai'; style?: StyleProp<ViewStyle>; small?: boolean }) {
  const t = useTheme();
  const bg = { primary: t.brand, secondary: t.panel, danger: t.panel, ai: t.aiLight }[kind];
  const fg = { primary: '#fff', secondary: t.text, danger: t.danger, ai: t.ai }[kind];
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.btn, small && styles.small, { backgroundColor: bg, borderColor: kind === 'primary' ? bg : t.line, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }, style]}>
      <Text style={[styles.btnText, { color: fg }, small && { fontSize: 14 }]}>{title}</Text>
    </Pressable>
  );
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const hue = [...(name || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${hue}, 45%, 45%)`, alignItems: 'center', justifyContent: 'center' }} accessible={false}>
      <Text style={{ color: '#fff', fontWeight: '600', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ padding: 40, alignItems: 'center' }}>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: '600' }}>{title}</Text>
      {children ? <Text style={{ color: t.muted, marginTop: 6, textAlign: 'center' }}>{children}</Text> : null}
    </View>
  );
}

export function Loading() {
  const t = useTheme();
  return <View style={{ padding: 40 }}><ActivityIndicator color={t.brand} /></View>;
}

export function ErrorLine({ text }: { text: string }) {
  const t = useTheme();
  return text ? <Text style={{ color: t.danger, padding: 12 }} accessibilityRole="alert">{text}</Text> : null;
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!active }}
      style={[styles.chip, { backgroundColor: active ? t.brandLight : t.panel, borderColor: active ? t.brand : t.line }]}>
      <Text style={{ color: active ? t.brand : t.text, fontWeight: active ? '600' : '400' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', borderWidth: 1 },
  small: { paddingVertical: 7, paddingHorizontal: 12 },
  btnText: { fontSize: 16, fontWeight: '600' },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, marginRight: 8 },
});
