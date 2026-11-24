// Opens an attachment. Phones show it in a web view with the session header;
// the web build downloads it.
import { useEffect, useLayoutEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { WebView } from 'react-native-webview';
import { attachmentSource } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Loading } from '../components/ui';

export default function AttachmentScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const nav = useNavigation();
  const t = useTheme();
  const [msg, setMsg] = useState('');
  useLayoutEffect(() => { nav.setOptions({ title: name || 'Attachment' }); }, [nav, name]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const src = attachmentSource(Number(id));
    fetch(src.uri, { headers: src.headers }).then(async (r) => {
      if (!r.ok) throw new Error('Could not download the file.');
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name || 'attachment' });
      a.click();
      setMsg('Downloaded.');
    }).catch((e) => setMsg(e.message));
  }, [id, name]);

  if (Platform.OS === 'web') return <View style={{ padding: 24 }}>{msg ? <Text style={{ color: t.text }}>{msg}</Text> : <Loading />}</View>;
  return <WebView source={attachmentSource(Number(id))} originWhitelist={['*']} javaScriptEnabled={false} style={{ flex: 1 }} startInLoadingState renderLoading={() => <Loading />} />;
}
