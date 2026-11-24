import { useCallback, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../../lib/auth';
import { api, currentServer } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { bytes } from '../../lib/format';
import { Avatar, Button, ErrorLine } from '../../components/ui';

export default function Account() {
  const t = useTheme();
  const { me, signOut, refreshMe } = useAuth();
  const [ooo, setOoo] = useState(false);
  const [oooMsg, setOooMsg] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    refreshMe().catch(() => {});
  }, [refreshMe]));
  useFocusEffect(useCallback(() => {
    setOoo(!!me?.user.ooo_enabled);
    setOooMsg(me?.user.ooo_message || '');
  }, [me]));

  if (!me) return null;
  const used = me.usage.quota ? Math.min(1, me.usage.bytes / me.usage.quota) : 0;
  const save = async () => {
    try { await api.preferences({ ooo_enabled: ooo, ooo_message: oooMsg }); setSaved('Saved.'); setError(''); await refreshMe(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}>
      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line, flexDirection: 'row', alignItems: 'center' }]}>
        <Avatar name={me.user.name || me.user.email} size={52} />
        <View style={{ marginLeft: 12, flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '600' }}>{me.user.name}</Text>
          <Text style={{ color: t.muted }}>{me.user.email}</Text>
          {me.plan ? <Text style={{ color: t.brand, marginTop: 2 }}>{me.plan.name} plan</Text> : null}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text style={[styles.h, { color: t.text }]}>Storage</Text>
        <View style={[styles.meter, { backgroundColor: t.line }]}><View style={{ width: `${Math.round(used * 100)}%`, backgroundColor: used > 0.9 ? t.danger : t.brand, height: '100%', borderRadius: 4 }} /></View>
        <Text style={{ color: t.muted, marginTop: 6 }}>{bytes(me.usage.bytes)} of {bytes(me.usage.quota)} used</Text>
      </View>

      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[styles.h, { color: t.text, flex: 1, marginBottom: 0 }]}>Automatic replies</Text>
          <Switch value={ooo} onValueChange={(v) => { setOoo(v); setSaved(''); }} accessibilityLabel="Automatic replies" trackColor={{ true: t.brand, false: t.line }} />
        </View>
        {ooo ? (
          <TextInput value={oooMsg} onChangeText={(v) => { setOooMsg(v); setSaved(''); }} multiline placeholder="I'm away until Monday and will reply when I'm back." placeholderTextColor={t.muted}
            style={[styles.input, { color: t.text, borderColor: t.line, backgroundColor: t.bg }]} accessibilityLabel="Automatic reply message" />
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
          <Button small title="Save" onPress={save} />
          {saved ? <Text style={{ color: t.muted, marginLeft: 10 }}>{saved}</Text> : null}
        </View>
        <ErrorLine text={error} />
      </View>

      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text style={[styles.h, { color: t.text }]}>More settings</Text>
        <Text style={{ color: t.muted, marginBottom: 10 }}>Rules, signatures, two-step verification, plans and more are on the website.</Text>
        <Button small kind="secondary" title="Open Arzio on the web" onPress={() => Linking.openURL(currentServer())} style={{ alignSelf: 'flex-start' }} />
      </View>

      <Button kind="danger" title="Sign out" onPress={signOut} style={{ marginTop: 8 }} />
      <Text style={{ color: t.muted, textAlign: 'center', marginTop: 16, fontSize: 12 }}>{currentServer().replace(/^https?:\/\//, '')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 12 },
  h: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
  meter: { height: 8, borderRadius: 4, overflow: 'hidden' },
  input: { marginTop: 10, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 70, fontSize: 15 },
});
