import { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, type CalendarEvent } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { longDate, time } from '../../lib/format';
import { Button, ErrorLine, Loading } from '../../components/ui';

const STATUS: Record<string, string> = { accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined', 'needs-action': 'No reply yet', organizer: 'Organizer' };

export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [e, setE] = useState<CalendarEvent | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setE(await api.event(Number(id)));
    } catch (err) { setError((err as Error & { status?: number }).status === 404 ? 'This event is not in your calendar any more.' : (err as Error).message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!e) return error ? <ErrorLine text={error} /> : <Loading />;
  const reply = async (s: 'accepted' | 'tentative' | 'declined') => {
    try { await api.respond(e.id, s); await load(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">{e.title}</Text>
      <Text style={{ color: t.text, marginTop: 8 }}>{e.all_day ? `${new Date(e.start_at).toLocaleDateString([], { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })}, all day` : `${longDate(e.start_at)} – ${time(e.end_at)}`}</Text>
      {e.recurrence !== 'none' ? <Text style={{ color: t.muted, marginTop: 2 }}>Repeats {e.recurrence}</Text> : null}
      {e.location ? <Text style={{ color: t.text, marginTop: 8 }}>📍 {e.location}</Text> : null}
      {e.online_url ? <Button small kind="secondary" title="Join online meeting" onPress={() => Linking.openURL(e.online_url)} style={{ marginTop: 12, alignSelf: 'flex-start' }} /> : null}

      {e.my_status !== 'organizer' ? (
        <View style={[styles.box, { backgroundColor: t.panel, borderColor: t.line }]}>
          <Text style={{ color: t.muted }}>Your reply: {STATUS[e.my_status] || e.my_status}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Button small kind={e.my_status === 'accepted' ? 'primary' : 'secondary'} title="Accept" onPress={() => reply('accepted')} />
            <Button small kind={e.my_status === 'tentative' ? 'primary' : 'secondary'} title="Maybe" onPress={() => reply('tentative')} />
            <Button small kind={e.my_status === 'declined' ? 'primary' : 'danger'} title="Decline" onPress={() => reply('declined')} />
          </View>
        </View>
      ) : null}

      {e.organizer_email || e.attendees.length ? (
        <View style={[styles.box, { backgroundColor: t.panel, borderColor: t.line }]}>
          {e.organizer_email ? <Text style={{ color: t.text, marginBottom: 6 }}>Organizer: {e.organizer_name || e.organizer_email}</Text> : null}
          {e.attendees.map((a) => <Text key={a.email} style={{ color: t.muted }}>{a.name || a.email} · {STATUS[a.status] || a.status}</Text>)}
        </View>
      ) : null}
      {e.description ? <Text style={{ color: t.text, marginTop: 16, lineHeight: 22 }} selectable>{e.description}</Text> : null}
      <ErrorLine text={error} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  box: { marginTop: 16, padding: 12, borderRadius: 10, borderWidth: 1 },
});
