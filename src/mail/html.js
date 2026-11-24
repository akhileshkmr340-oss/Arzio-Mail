// HTML written in the Arzio composer: cleaned before it is sent, with pasted
// pictures turned into inline (cid:) attachments the way Outlook sends them.
import crypto from 'node:crypto';

const DROP_BLOCKS = /<(script|style|iframe|object|embed|form|template|noscript|svg|math)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAGS = /<\/?(script|style|iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|frame|frameset|applet|template|noscript|svg|math)\b[^>]*>/gi;

/** Strip anything active from composed HTML (scripts, handlers, javascript: links). */
export function cleanHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_BLOCKS, '')
    .replace(DROP_TAGS, '')
    // on* event handlers, quoted or not
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // javascript:, vbscript: and data: (except pictures) in links and sources
    .replace(/\s(href|src|action|formaction|xlink:href)\s*=\s*("|')\s*(javascript|vbscript):[^"']*\2/gi, ' $1="#"')
    .replace(/\s(href)\s*=\s*("|')\s*data:[^"']*\2/gi, ' $1="#"')
    .replace(/\s(src)\s*=\s*("|')\s*data:(?!image\/(png|jpe?g|gif|webp|bmp);base64,)[^"']*\2/gi, ' $1=""')
    // CSS expressions and behaviours
    .replace(/expression\s*\(/gi, '(')
    .replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, 'none');
}

/**
 * Pasted pictures arrive as data: URLs. Turn each into an inline attachment
 * referenced by cid:, which every mail app can show.
 * Returns { html, attachments: [{ filename, contentType, content, cid }] }
 */
export function inlineImages(html, domain = 'arzio.local') {
  const attachments = [];
  const out = String(html || '').replace(/(<img\b[^>]*?\bsrc\s*=\s*)("|')data:(image\/(png|jpe?g|gif|webp|bmp));base64,([A-Za-z0-9+/=\s]+)\2/gi,
    (all, pre, q, type, ext, b64) => {
      const content = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
      if (!content.length || content.length > 10 * 1024 * 1024) return `${pre}${q}${q}`;
      const cid = `${crypto.randomUUID()}@${domain}`;
      attachments.push({ filename: `image${attachments.length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`, contentType: type, content, cid, contentDisposition: 'inline' });
      return `${pre}${q}cid:${cid}${q}`;
    });
  return { html: out, attachments };
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function textToHtml(text) {
  return escHtml(text).replace(/\r?\n/g, '<br>');
}

/** Addresses @mentioned in composed HTML (<a data-mention="addr">). */
export function mentionedAddresses(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/data-mention\s*=\s*("|')([^"'\s]+@[^"'\s]+)\1/gi)) out.add(m[2].toLowerCase());
  return [...out];
}
