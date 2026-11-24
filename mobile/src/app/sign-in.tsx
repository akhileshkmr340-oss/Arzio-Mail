import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../lib/auth';
import { ApiError, currentServer } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Button } from '../components/ui';

const defaultServer = (Constants.expoConfig?.extra?.defaultServer as string) || '';

export default function SignIn() {
  const t = useTheme();
  const { signIn } = useAuth();
  const [server, setServer] = useState(currentServer() || defaultServer);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showServer, setShowServer] = useState(!defaultServer);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await signIn(server, email.trim(), password, needCode ? code.trim() : undefined);
    } catch (e) {
      const err = e as ApiError;
      if (err.mfaRequired) setNeedCode(true);
      setError(err.message);
    } finally { setBusy(false); }
  };
  const input = [styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.panel }];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
          <View style={[styles.logo, { backgroundColor: t.brand }]}><Text style={styles.logoText}>A</Text></View>
          <Text style={[styles.title, { color: t.text }]}>Arzio Mail</Text>
          <Text style={[styles.sub, { color: t.muted }]}>Mail, calendar and To Do with built-in AI</Text>

          {showServer ? (
            <>
              <Text style={[styles.label, { color: t.muted }]}>Server</Text>
              <TextInput style={input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="mail.example.com" placeholderTextColor={t.muted} accessibilityLabel="Server" />
            </>
          ) : null}
          <Text style={[styles.label, { color: t.muted }]}>Email</Text>
          <TextInput style={input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" placeholder="you@example.com" placeholderTextColor={t.muted} accessibilityLabel="Email" />
          <Text style={[styles.label, { color: t.muted }]}>Password</Text>
          <TextInput style={input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" accessibilityLabel="Password" onSubmitEditing={submit} />
          {needCode ? (
            <>
              <Text style={[styles.label, { color: t.muted }]}>Code from your authenticator app</Text>
              <TextInput style={input} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={8} accessibilityLabel="Verification code" onSubmitEditing={submit} />
            </>
          ) : null}
          {error ? <Text style={[styles.error, { color: t.danger }]} accessibilityRole="alert">{error}</Text> : null}
          <Button title={busy ? 'Signing in…' : 'Sign in'} onPress={submit} disabled={busy || !email || !password || !server} style={{ marginTop: 20 }} />
          {!showServer ? (
            <Pressable onPress={() => setShowServer(true)} style={{ marginTop: 18 }}>
              <Text style={{ color: t.brand, textAlign: 'center' }}>Use a different server</Text>
            </Pressable>
          ) : null}
          <Text style={[styles.note, { color: t.muted }]}>New to Arzio? Create an account on the website, then sign in here.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 24, paddingTop: 48, maxWidth: 440, width: '100%', alignSelf: 'center' },
  logo: { width: 56, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  logoText: { color: '#fff', fontSize: 30, fontWeight: '700' },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center', marginTop: 14 },
  sub: { textAlign: 'center', marginTop: 4, marginBottom: 20 },
  label: { marginTop: 14, marginBottom: 6, fontSize: 13 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  error: { marginTop: 12 },
  note: { marginTop: 28, textAlign: 'center', fontSize: 13 },
});
