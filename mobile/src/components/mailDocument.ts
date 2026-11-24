/**
 * Wraps message HTML in a page with a strict content policy. HTML mail is
 * designed for a light page, so it stays light in dark mode (like most mail apps).
 */
export function mailDocument(html: string, { showImages }: { showImages: boolean; dark?: boolean }) {
  const img = showImages ? 'img-src https: http: data: cid:;' : 'img-src data: cid:;';
  const csp = `default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
  body { padding: 4px 16px 24px; font: 16px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; word-wrap: break-word; overflow-wrap: anywhere;
    color: #242424; background: #ffffff; }
  img, table { max-width: 100% !important; height: auto; }
  pre { white-space: pre-wrap; }
  a { color: #0f6cbd; }
  blockquote { margin: 0 0 0 8px; padding-left: 10px; border-left: 3px solid #ccc; color: #666; }
</style></head><body>${html}</body></html>`;
}
