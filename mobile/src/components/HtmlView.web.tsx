// Web build: a sandboxed iframe (no scripts; links open in a new tab).
import { createElement } from 'react';
import { mailDocument } from './mailDocument';

export function HtmlView({ html, showImages, dark }: { html: string; showImages: boolean; dark: boolean }) {
  return createElement('iframe', {
    title: 'Message content',
    sandbox: 'allow-popups allow-popups-to-escape-sandbox',
    srcDoc: mailDocument(html, { showImages, dark }),
    style: { border: 0, width: '100%', flex: 1, minHeight: 400, background: 'transparent' },
  });
}
