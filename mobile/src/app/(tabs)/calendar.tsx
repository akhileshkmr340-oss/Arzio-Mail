// Agenda: the next weeks grouped by day.
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { api, type CalendarEvent } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { dayHeading, time } from '../../lib/format';
import { Button, Empty, ErrorLine, Loading } from '../../components/ui';

const DAYS = 28;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function Agenda() {
  const t = useTheme();
  const [start, setStart] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const end = new Date(start.getTime() + DAYS * 86400e3);
      setEvents(await api.events(start, end));
      setError('');
    } catch (e) { setError((e as Error).message); } finally { setRefreshing(false); }
  }, [start]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!events) return error ? <ErrorLine text={error} /> : <Loading />;
  const groups = new Map<string, { title: string; data: CalendarEvent[] }>();
  for (const e of events) {
    const d = new Date(e.start_at);
    const k = dayKey(e.all_day ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : d);
    const dd = e.all_day ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : d;
    if (!groups.has(k)) groups.set(k, { title: dayHeading(dd), data: [] });
    groups.get(k)!.data.push(e);
  }
  const shift = (days: number) => setStart((s) => new Date(s.getTime() + days * 86400e3));

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.nav, { backgroundColor: t.panel, borderBottomColor: t.line }]}>
        <Button small kind="secondary" title="‹ Earlier" onPress={() => shift(-DAYS)} />
        <Button small kind="secondary" title="Today" onPress={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setStart(d); }} />
        <Button small kind="secondary" title="Later ›" onPress={() => shift(DAYS)} />
      </View>
      <ErrorLine text={error} />
      <SectionList
        sections={[...groups.values()]}
        keyExtractor={(e, i) => `${e.id}-${e.occurrence || e.start_at}-${i}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={t.brand} />}
        renderSectionHeader={({ section }) => <Text style={[styles.day, { color: t.muted, backgroundColor: t.bg }]} accessibilityRole="header">{section.title}</Text>}
        renderItem={({ item: e }) => {
          const pending = e.my_status === 'needs-action';
          return (
            <Pressable onPress={() => router.push({ pathname: '/event/[id]', params: { id: String(e.id) } })} accessibilityRole="button"
              style={[styles.event, { backgroundColor: t.panel, borderLeftColor: e.my_status === 'declined' ? t.line : t.brand }]}>
              <Text style={[styles.when, { color: t.muted }]}>{e.all_day ? 'All day' : `${time(e.start_at)}\n${time(e.end_at)}`}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600', textDecorationLine: e.my_status === 'declined' ? 'line-through' : 'none' }} numberOfLines={2}>{e.title}</Text>
                {e.location ? <Text style={{ color: t.muted }} numberOfLines={1}>{e.location}</Text> : null}
                {pending ? <Text style={{ color: t.brand, marginTop: 2 }}>Invitation: tap to reply</Text> : null}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Empty title="Nothing planned">No events in these {DAYS} days.</Empty>}
        stickySectionHeadersEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  day: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, fontWeight: '600', fontSize: 13, textTransform: 'uppercase' },
  event: { flexDirection: 'row', marginHorizontal: 12, marginBottom: 6, padding: 12, borderRadius: 8, borderLeftWidth: 4 },
  when: { width: 72, fontSize: 13 },
});
