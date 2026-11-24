// Reading a message: header, body, attachments, invitation replies, actions, AI summary.
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { api, type Folder, type Message } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { bytes, longDate, personLabel } from '../../lib/format';
import { Avatar, Button, ErrorLine, Loading } from '../../components/ui';
import { HtmlView } from '../../components/HtmlView';

export default function MessageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const dark = useColorScheme() === 'dark';
  const nav = useNavigation();
  const [m, setM] = useState<Message | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [error, setError] = useState('');
  const [images, setImages] = useState(false);
  const [summary, setSummary] = useState<{ summary: string; actionItems?: string[]; note?: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const msg = await api.message(Number(id));
      setM(msg);
      if (!msg.is_read) api.update(msg.id, { is_read: true }).catch(() => {});
      setFolders(await api.folders());
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const role = (r: string) => folders.find((f) => f.role === r);
  const act = async (label: string, fn: () => Promise<unknown>, back = true) => {
    setBusy(label);
    try { await fn(); if (back) router.back(); else await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const confirmDelete = () => {
    const inTrash = m && role('trash')?.id === m.folder_id;
    if (!inTrash) return act('delete', () => api.remove(m!.id));
    if (Platform.OS === 'web') { if (globalThis.confirm?.('Delete this message for good?')) act('delete', () => api.remove(m!.id)); return; }
    Alert.alert('Delete for good?', 'This message is already in Deleted Items.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => act('delete', () => api.remove(m!.id)) }]);
  };

  useLayoutEffect(() => {
    nav.setOptions({
      title: '',
      headerRight: () => m ? (
        <View style={{ flexDirection: 'row' }}>
          <HeaderBtn label={m.is_flagged ? 'Unflag' : 'Flag'} onPress={() => act('flag', () => api.update(m.id, { is_flagged: !m.is_flagged }), false)} />
          <HeaderBtn label="Unread" onPress={() => act('unread', () => api.update(m.id, { is_read: false }))} />
        </View>
      ) : null,
    });
  });

  if (error && !m) return <ErrorLine text={error} />;
  if (!m) return <Loading />;
  const invite = m.calendar && m.calendar.method === 'REQUEST' && !m.calendar.removed && !m.calendar.stale ? m.calendar : null;
  const people = (label: string, list: { name: string; address: string }[]) => list?.length ? <Text style={{ color: t.muted, marginTop: 2 }} numberOfLines={2}>{label} {list.map(personLabel).join(', ')}</Text> : null;
  const archive = role('archive');

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView style={{ maxHeight: invite || summary || m.attachments.length ? '55%' : undefined, flexGrow: 0 }}>
        <View style={[styles.head, { backgroundColor: t.panel, borderBottomColor: t.line }]}>
          <Text style={[styles.subject, { color: t.text }]} accessibilityRole="header">{m.subject || '(no subject)'}</Text>
          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <Avatar name={m.from_name || m.from_addr} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>{m.from_name || m.from_addr}</Text>
              {m.from_name ? <Text style={{ color: t.muted }}>{m.from_addr}</Text> : null}
              {people('To', m.to)}
              {people('Cc', m.cc)}
              <Text style={{ color: t.muted, marginTop: 2 }}>{longDate(m.date)}</Text>
            </View>
          </View>
        </View>

        {invite ? (
          <View style={[styles.box, { backgroundColor: t.brandLight, borderColor: t.brand }]}>
            <Text style={{ color: t.text, fontWeight: '600' }}>Meeting invitation{invite.start_at ? `: ${longDate(invite.start_at)}` : ''}</Text>
            {invite.response && invite.response !== 'needs-action' ? <Text style={{ color: t.muted, marginTop: 4 }}>You replied: {invite.response}</Text> : null}
            <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
              {(['accepted', 'tentative', 'declined'] as const).map((s) => (
                <Button key={s} small kind={invite.response === s ? 'primary' : 'secondary'} title={{ accepted: 'Accept', tentative: 'Maybe', declined: 'Decline' }[s]}
                  onPress={() => act('rsvp', () => api.respond(invite.eventId, s), false)} />
              ))}
            </View>
          </View>
        ) : null}

        {summary ? (
          <View style={[styles.box, { backgroundColor: t.aiLight, borderColor: t.ai }]}>
            <Text style={{ color: t.ai, fontWeight: '600', marginBottom: 4 }}>Summary</Text>
            <Text style={{ color: t.text }}>{summary.summary}</Text>
            {summary.actionItems?.map((a, i) => <Text key={i} style={{ color: t.text, marginTop: 4 }}>• {a}</Text>)}
            {summary.note ? <Text style={{ color: t.muted, marginTop: 6, fontSize: 12 }}>{summary.note}</Text> : null}
          </View>
        ) : null}

        {m.attachments.length ? (
          <View style={{ padding: 12 }}>
            {m.attachments.map((a) => (
              <Pressable key={a.id} onPress={() => router.push({ pathname: '/attachment', params: { id: String(a.id), name: a.filename } })} accessibilityRole="button"
                style={[styles.att, { backgroundColor: t.panel, borderColor: t.line }]}>
                <Text style={{ color: t.text, flex: 1 }} numberOfLines={1}>📎 {a.filename}</Text>
                <Text style={{ color: t.muted }}>{bytes(a.size)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <ErrorLine text={error} />
      </ScrollView>

      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        {m.html_body ? (
          <>
            {!images && /<img[^>]+src=["']?https?:/i.test(m.html_body) ? (
              <Pressable onPress={() => setImages(true)} style={[styles.images, { backgroundColor: t.panel, borderBottomColor: t.line }]} accessibilityRole="button">
                <Text style={{ color: t.brand }}>Pictures are hidden to protect your privacy. Show pictures</Text>
              </Pressable>
            ) : null}
            <HtmlView html={m.html_body} showImages={images} dark={dark} />
          </>
        ) : (
          <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}>
            <Text style={{ color: t.text, fontSize: 16, lineHeight: 23 }} selectable>{m.text_body}</Text>
          </ScrollView>
        )}
      </View>

      <View style={[styles.bar, { backgroundColor: t.panel, borderTopColor: t.line }]}>
        <BarBtn label="Reply" onPress={() => router.push({ pathname: '/compose', params: { replyTo: String(m.id), mode: 'reply' } })} />
        <BarBtn label="Reply all" onPress={() => router.push({ pathname: '/compose', params: { replyTo: String(m.id), mode: 'all' } })} />
        <BarBtn label="Forward" onPress={() => router.push({ pathname: '/compose', params: { replyTo: String(m.id), mode: 'forward' } })} />
        {archive && archive.id !== m.folder_id ? <BarBtn label="Archive" onPress={() => act('archive', () => api.update(m.id, { folder_id: archive.id }))} /> : null}
        <BarBtn label="Delete" danger onPress={confirmDelete} />
        <BarBtn label={busy === 'ai' ? '…' : '✨ Sum'} ai onPress={() => act('ai', async () => setSummary(await api.summarize(m.id)), false)} />
      </View>
    </View>
  );
}

function HeaderBtn({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return <Pressable onPress={onPress} accessibilityRole="button" style={{ paddingHorizontal: 10 }}><Text style={{ color: t.brand, fontSize: 16 }}>{label}</Text></Pressable>;
}
function BarBtn({ label, onPress, danger, ai }: { label: string; onPress: () => void; danger?: boolean; ai?: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label === '✨ Sum' ? 'Summarize with AI' : label} style={styles.barBtn}>
      <Text style={{ color: danger ? t.danger : ai ? t.ai : t.brand, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  subject: { fontSize: 20, fontWeight: '700' },
  box: { margin: 12, marginBottom: 0, padding: 12, borderRadius: 10, borderWidth: 1 },
  att: { flexDirection: 'row', padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 6 },
  images: { padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: 18, paddingTop: 6 },
  barBtn: { flex: 1, alignItems: 'center', paddingVertical: 8 },
});
