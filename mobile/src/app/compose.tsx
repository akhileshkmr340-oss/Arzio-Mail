// Writing mail: new, reply, reply all, forward. Recipient suggestions,
// attachments and "Draft with AI".
import { useEffect, useLayoutEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { api, type Message } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { bytes, longDate, personLabel, quote, replySubject } from '../lib/format';
import { Button, ErrorLine } from '../components/ui';

type Picked = { filename: string; contentType: string; contentBase64: string; size: number };
const MAX_TOTAL = 20 * 1024 * 1024;

async function toBase64(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

export default function Compose() {
  const t = useTheme();
  const nav = useNavigation();
  const { me } = useAuth();
  const { replyTo, mode, to: toParam } = useLocalSearchParams<{ replyTo?: string; mode?: 'reply' | 'all' | 'forward'; to?: string }>();
  const [to, setTo] = useState(toParam || '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [quoted, setQuoted] = useState('');
  const [orig, setOrig] = useState<Message | null>(null);
  const [files, setFiles] = useState<Picked[]>([]);
  const [suggest, setSuggest] = useState<{ email: string; name: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [aiAsk, setAiAsk] = useState<string | null>(null);
  const myEmail = me?.user.email || '';

  // Reply / forward: fill in recipients, subject and the quoted original
  useEffect(() => {
    if (!replyTo) return;
    api.message(Number(replyTo)).then((m) => {
      setOrig(m);
      const header = `On ${longDate(m.date)}, ${personLabel({ name: m.from_name, address: m.from_addr })} wrote:`;
      if (mode === 'forward') {
        setSubject(replySubject(m.subject, 'Fwd'));
        setQuoted(`\n\n-------- Forwarded message --------\nFrom: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}\nDate: ${longDate(m.date)}\nSubject: ${m.subject}\n\n${m.text_body}`);
      } else {
        setSubject(replySubject(m.subject, 'Re'));
        setTo(m.from_addr);
        if (mode === 'all') setCc([...m.to, ...m.cc].map((p) => p.address).filter((a) => a && a !== myEmail && a !== m.from_addr).join(', '));
        setQuoted(quote(m.text_body, header));
      }
    }).catch((e) => setError(e.message));
  }, [replyTo, mode, myEmail]);

  useLayoutEffect(() => {
    nav.setOptions({
      title: mode === 'forward' ? 'Forward' : mode ? 'Reply' : 'New message',
      headerLeft: () => <Pressable onPress={() => router.back()} accessibilityRole="button" style={{ paddingHorizontal: 12 }}><Text style={{ color: t.brand, fontSize: 16 }}>Cancel</Text></Pressable>,
    });
  }, [nav, mode, t]);

  // Suggestions for the last address being typed
  useEffect(() => {
    const last = to.split(',').pop()!.trim();
    if (last.length < 2 || last.includes('@') && /\.\w{2,}$/.test(last)) { setSuggest([]); return; }
    const timer = setTimeout(() => api.suggest(last).then((s) => setSuggest(s.slice(0, 5))).catch(() => setSuggest([])), 200);
    return () => clearTimeout(timer);
  }, [to]);

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, base64: Platform.OS === 'web' });
    if (r.canceled) return;
    setBusy('attach');
    try {
      const added: Picked[] = [];
      for (const a of r.assets) {
        const b64 = a.base64 ? a.base64.replace(/^data:[^,]*,/, '') : await toBase64(a.uri);
        added.push({ filename: a.name, contentType: a.mimeType || 'application/octet-stream', contentBase64: b64, size: a.size ?? Math.round((b64.length * 3) / 4) });
      }
      const total = [...files, ...added].reduce((s, f) => s + f.size, 0);
      if (total > MAX_TOTAL) throw new Error('Attachments can be up to 20 MB in total.');
      setFiles((f) => [...f, ...added]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  const draftWithAi = async () => {
    setBusy('ai'); setError('');
    try {
      const d = await api.draft(orig?.id, aiAsk || '');
      setBody(d.body);
      if (!subject && d.subject) setSubject(d.subject);
      setAiAsk(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  const send = async () => {
    setBusy('send'); setError('');
    try {
      await api.send({
        to, cc: cc || undefined, subject, text: body + quoted,
        inReplyTo: mode && mode !== 'forward' ? orig?.message_id || undefined : undefined,
        references: mode && mode !== 'forward' && orig ? [orig.refs, orig.message_id].filter(Boolean).join(' ') || undefined : undefined,
        attachments: files.map(({ filename, contentType, contentBase64 }) => ({ filename, contentType, contentBase64 })),
        forwardOf: mode === 'forward' && orig ? orig.id : undefined,
      });
      router.back();
    } catch (e) { setError((e as Error).message); setBusy(''); }
  };

  const field = [styles.field, { color: t.text, borderBottomColor: t.line }];
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.panel }} keyboardVerticalOffset={90}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Row label="To" t={t}><TextInput style={field} value={to} onChangeText={setTo} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" accessibilityLabel="To" autoFocus={!replyTo} /></Row>
        {suggest.length ? (
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
            {suggest.map((s) => (
              <Pressable key={s.email} accessibilityRole="button" style={{ paddingHorizontal: 16, paddingVertical: 10 }}
                onPress={() => { const parts = to.split(','); parts[parts.length - 1] = ` ${s.email}`; setTo(parts.join(',').replace(/^\s+/, '') + ', '); setSuggest([]); }}>
                <Text style={{ color: t.text }}>{s.name || s.email}</Text>{s.name ? <Text style={{ color: t.muted, fontSize: 13 }}>{s.email}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
        <Row label="Cc" t={t}><TextInput style={field} value={cc} onChangeText={setCc} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" accessibilityLabel="Cc" /></Row>
        <Row label="Subject" t={t}><TextInput style={field} value={subject} onChangeText={setSubject} accessibilityLabel="Subject" /></Row>

        {files.length || (mode === 'forward' && orig?.attachments.length) ? (
          <View style={{ padding: 12 }}>
            {mode === 'forward' ? orig?.attachments.map((a) => <Text key={`o${a.id}`} style={{ color: t.muted, marginBottom: 4 }}>📎 {a.filename} ({bytes(a.size)}), from the original</Text>) : null}
            {files.map((f, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                <Text style={{ color: t.text, flex: 1 }} numberOfLines={1}>📎 {f.filename} ({bytes(f.size)})</Text>
                <Pressable onPress={() => setFiles((all) => all.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={`Remove ${f.filename}`}><Text style={{ color: t.danger, padding: 4 }}>Remove</Text></Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {aiAsk !== null ? (
          <View style={[styles.ai, { backgroundColor: t.aiLight, borderColor: t.ai }]}>
            <Text style={{ color: t.ai, fontWeight: '600' }}>Draft with AI</Text>
            <TextInput value={aiAsk} onChangeText={setAiAsk} placeholder={orig ? 'e.g. Say yes, Friday 3 pm works' : 'e.g. Ask the team for their Q3 numbers by Monday'} placeholderTextColor={t.muted}
              style={[styles.aiInput, { color: t.text, borderColor: t.line, backgroundColor: t.panel }]} multiline accessibilityLabel="What should the draft say" />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Button small kind="ai" title={busy === 'ai' ? 'Writing…' : 'Write draft'} onPress={draftWithAi} disabled={busy === 'ai'} />
              <Button small kind="secondary" title="Close" onPress={() => setAiAsk(null)} />
            </View>
          </View>
        ) : null}

        <TextInput style={[styles.body, { color: t.text }]} value={body} onChangeText={setBody} multiline textAlignVertical="top" placeholder="Write your message" placeholderTextColor={t.muted} accessibilityLabel="Message" autoFocus={!!replyTo && mode !== 'forward'} />
        {quoted ? <Text style={[styles.quoted, { color: t.muted, borderLeftColor: t.line }]} numberOfLines={12}>{quoted.trim()}</Text> : null}
        <ErrorLine text={error} />
      </ScrollView>
      <View style={[styles.bar, { borderTopColor: t.line }]}>
        <Button small kind="secondary" title={busy === 'attach' ? 'Adding…' : '📎 Attach'} onPress={pick} disabled={!!busy} />
        <Button small kind="ai" title="✨ Draft" onPress={() => setAiAsk(aiAsk === null ? '' : null)} disabled={!!busy} />
        <View style={{ flex: 1 }} />
        <Button small title={busy === 'send' ? 'Sending…' : 'Send'} onPress={send} disabled={!!busy || !to.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Row({ label, children, t }: { label: string; children: React.ReactNode; t: ReturnType<typeof useTheme> }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16 }}>
      <Text style={{ color: t.muted, width: 62 }}>{label}</Text>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { fontSize: 16, paddingVertical: 12, paddingRight: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  quoted: { marginHorizontal: 16, paddingLeft: 10, borderLeftWidth: 3, marginBottom: 16 },
  body: { minHeight: 160, fontSize: 16, lineHeight: 22, padding: 16 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, paddingBottom: 24, borderTopWidth: StyleSheet.hairlineWidth },
  ai: { margin: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  aiInput: { marginTop: 8, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 60, fontSize: 15 },
});
