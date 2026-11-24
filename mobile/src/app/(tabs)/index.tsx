// Mail: folders, Focused / Other, search, pull to refresh, endless scroll.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { api, type Folder, type MessageSummary } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { shortDate } from '../../lib/format';
import { Avatar, Chip, Empty, ErrorLine, Loading } from '../../components/ui';

const PAGE = 40;
const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export default function MailList() {
  const t = useTheme();
  const nav = useNavigation();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [focus, setFocus] = useState<'focused' | 'other'>('focused');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MessageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(false);
  const loadingMore = useRef(false);

  const isInbox = folder?.role === 'inbox' && !query;
  const load = useCallback(async (reset = true) => {
    if (!folder) return;
    if (!reset && (done || loadingMore.current)) return;
    loadingMore.current = true;
    try {
      const page = await api.messages({ folder: query ? undefined : folder.id, q: query || undefined, focus: isInbox ? focus : undefined, offset: reset ? 0 : items.length, limit: PAGE });
      setItems((prev) => (reset ? page : [...prev, ...page.filter((m) => !prev.some((p) => p.id === m.id))]));
      setDone(page.length < PAGE);
      setError('');
    } catch (e) { setError((e as Error).message); } finally { loadingMore.current = false; setLoading(false); setRefreshing(false); }
  }, [folder, focus, query, isInbox, items.length, done]);

  const loadFolders = useCallback(async () => {
    try {
      const fs = (await api.folders()).filter((f) => f.role !== 'recoverable');
      fs.sort((a, b) => (ROLE_ORDER.indexOf(a.role ?? '') + 1 || 99) - (ROLE_ORDER.indexOf(b.role ?? '') + 1 || 99) || a.name.localeCompare(b.name));
      setFolders(fs);
      setFolder((cur) => (cur ? fs.find((f) => f.id === cur.id) ?? fs[0] : fs.find((f) => f.role === 'inbox') ?? fs[0]) ?? null);
    } catch (e) { setError((e as Error).message); setLoading(false); }
  }, []);

  useEffect(() => { loadFolders(); }, [loadFolders]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(true); setDone(false); load(true); }, [folder?.id, focus, query]);
  // Coming back from a message: refresh read state and counts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useFocusEffect(useCallback(() => { if (folder) { load(true); loadFolders(); } }, [folder?.id, focus, query]));

  useLayoutEffect(() => {
    nav.setOptions({
      title: query ? 'Search' : folder?.name ?? 'Mail',
      headerTitle: () => (
        <Pressable onPress={() => setPicker(true)} accessibilityRole="button" accessibilityLabel="Choose folder" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '600' }}>{query ? 'Search' : folder?.name ?? 'Mail'}</Text>
          <Text style={{ color: t.muted, marginLeft: 6 }}>▾</Text>
        </Pressable>
      ),
      headerRight: () => (
        <Pressable onPress={() => router.push('/compose')} accessibilityRole="button" accessibilityLabel="New message" style={{ paddingHorizontal: 16 }}>
          <Text style={{ color: t.brand, fontSize: 16, fontWeight: '600' }}>New</Text>
        </Pressable>
      ),
    });
  }, [nav, folder, query, t]);

  const toggleRead = async (m: MessageSummary) => {
    setItems((all) => all.map((x) => (x.id === m.id ? { ...x, is_read: !m.is_read } : x)));
    await api.update(m.id, { is_read: !m.is_read }).catch(() => load(true));
  };

  const renderItem = ({ item: m }: { item: MessageSummary }) => {
    const who = folder?.role === 'sent' || folder?.role === 'drafts' ? (m.to?.map((p) => p.name || p.address).join(', ') || '(no recipients)') : m.from_name || m.from_addr || '(unknown)';
    return (
      <Pressable onPress={() => router.push(`/message/${m.id}`)} onLongPress={() => toggleRead(m)} accessibilityRole="button"
        accessibilityLabel={`${m.is_read ? '' : 'Unread. '}From ${who}. ${m.subject}`} accessibilityHint="Long press to mark read or unread"
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.brandLight : t.panel, borderBottomColor: t.line }]}>
        <View style={styles.dotCol}>{!m.is_read ? <View style={[styles.dot, { backgroundColor: t.unreadDot }]} /> : null}</View>
        <Avatar name={who} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={styles.line1}>
            <Text numberOfLines={1} style={[styles.from, { color: t.text, fontWeight: m.is_read ? '400' : '700' }]}>{who}</Text>
            <Text style={[styles.date, { color: m.is_read ? t.muted : t.brand }]}>{shortDate(m.date)}</Text>
          </View>
          <View style={styles.line1}>
            <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontWeight: m.is_read ? '400' : '600' }}>{m.subject || '(no subject)'}</Text>
            {m.has_attachments ? <Text style={{ color: t.muted, marginLeft: 6 }}>📎</Text> : null}
            {m.is_flagged ? <Text style={{ color: t.danger, marginLeft: 6 }}>⚑</Text> : null}
          </View>
          <Text numberOfLines={2} style={{ color: t.muted, marginTop: 2 }}>{m.snippet}</Text>
          {m.ai_priority === 'high' || m.ai_needs_reply ? (
            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              {m.ai_priority === 'high' ? <Text style={[styles.tag, { color: t.danger, borderColor: t.danger }]}>Important</Text> : null}
              {m.ai_needs_reply ? <Text style={[styles.tag, { color: t.ai, borderColor: t.ai }]}>Needs reply</Text> : null}
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={[styles.searchBar, { backgroundColor: t.panel, borderBottomColor: t.line }]}>
        <TextInput placeholder="Search mail" placeholderTextColor={t.muted} returnKeyType="search" clearButtonMode="while-editing"
          style={[styles.search, { backgroundColor: t.bg, color: t.text }]} accessibilityLabel="Search mail"
          onSubmitEditing={(e) => setQuery(e.nativeEvent.text.trim())} onChangeText={(v) => { if (!v) setQuery(''); }} />
        {isInbox ? (
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <Chip label="Focused" active={focus === 'focused'} onPress={() => setFocus('focused')} />
            <Chip label="Other" active={focus === 'other'} onPress={() => setFocus('other')} />
          </View>
        ) : null}
      </View>
      <ErrorLine text={error} />
      {loading && !items.length ? <Loading /> : (
        <FlatList
          data={items}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderItem}
          onEndReached={() => load(false)}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); loadFolders(); }} tintColor={t.brand} />}
          ListEmptyComponent={<Empty title={query ? 'No results' : 'Nothing here'}>{query ? `No messages match "${query}".` : isInbox ? 'You are all caught up.' : 'This folder is empty.'}</Empty>}
        />
      )}

      <Modal visible={picker} transparent animationType="fade" onRequestClose={() => setPicker(false)}>
        <Pressable style={styles.backdrop} onPress={() => setPicker(false)} accessibilityLabel="Close folders">
          <View style={[styles.sheet, { backgroundColor: t.panel }]}>
            <Text style={[styles.sheetTitle, { color: t.muted }]}>Folders</Text>
            <ScrollView>
              {folders.map((f) => (
                <Pressable key={f.id} onPress={() => { setQuery(''); setFolder(f); setPicker(false); }} accessibilityRole="button"
                  style={[styles.folder, f.id === folder?.id && { backgroundColor: t.brandLight }]}>
                  <Text style={{ color: t.text, fontSize: 16, flex: 1, fontWeight: f.id === folder?.id ? '600' : '400' }}>{f.name}</Text>
                  {f.unread ? <Text style={{ color: t.brand, fontWeight: '600' }}>{f.unread}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  searchBar: { padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16 },
  row: { flexDirection: 'row', paddingVertical: 12, paddingRight: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  dotCol: { width: 14, alignItems: 'center', paddingTop: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  line1: { flexDirection: 'row', alignItems: 'center' },
  from: { flex: 1, fontSize: 16 },
  date: { fontSize: 13, marginLeft: 8 },
  tag: { fontSize: 11, borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, marginRight: 6, overflow: 'hidden' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '70%', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 30, paddingTop: 8 },
  sheetTitle: { paddingHorizontal: 20, paddingVertical: 10, fontSize: 13, textTransform: 'uppercase' },
  folder: { flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 14 },
});
