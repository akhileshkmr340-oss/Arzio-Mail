// Shows HTML mail in a locked-down web view: no scripts, links open in the
// browser, and remote images only when the user asks (they can track opens).
import { Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { mailDocument } from './mailDocument';

export function HtmlView({ html, showImages, dark }: { html: string; showImages: boolean; dark: boolean }) {
  return (
    <WebView
      originWhitelist={['about:*', 'data:*']}
      source={{ html: mailDocument(html, { showImages, dark }) }}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      allowFileAccess={false}
      setSupportMultipleWindows={false}
      style={{ flex: 1, backgroundColor: 'transparent' }}
      onShouldStartLoadWithRequest={(req) => {
        if (req.url.startsWith('about:') || req.url.startsWith('data:')) return true;
        if (/^(https?|mailto|tel):/i.test(req.url)) Linking.openURL(req.url);
        return false;
      }}
    />
  );
}
