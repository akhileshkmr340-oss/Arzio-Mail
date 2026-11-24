// Runs inside a bridge worker: a small S3 client (AWS Signature V4) for any
// S3-compatible store: Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO.
import crypto from 'node:crypto';

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map(enc).join('/');

// Signs a request. Exported for tests (AWS's published example).
export function signV4({ method, host, path, query = {}, headers = {}, body = '', region, accessKey, secretKey, service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = headers['x-amz-content-sha256'] || sha256(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(h).sort();
  const canonQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, path, canonQuery, names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete h.host;
  return { headers: h, signature };
}

export async function init({ endpoint, region, bucket, accessKey, secretKey, pathStyle }) {
  const u = new URL(endpoint);
  const host = pathStyle ? u.host : `${bucket}.${u.host}`;
  const base = `${u.protocol}//${host}`;
  const keyPath = (key) => (pathStyle ? `/${enc(bucket)}/${encPath(key)}` : `/${encPath(key)}`);
  async function req(method, key, { body, headers = {}, okMissing = false } = {}) {
    const path = keyPath(key);
    const signed = signV4({ method, host, path, headers, body: body || '', region, accessKey, secretKey });
    const res = await fetch(base + path, { method, headers: signed.headers, body });
    if (okMissing && res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`S3 ${method} ${key} failed: ${res.status} ${text.slice(0, 200)}`), { status: res.status });
    }
    return res;
  }
  return {
    async put(key, data) { await req('PUT', key, { body: Buffer.from(data) }); return true; },
    async get(key) { const r = await req('GET', key, { okMissing: true }); return r ? Buffer.from(await r.arrayBuffer()) : null; },
    async exists(key) { return !!(await req('HEAD', key, { okMissing: true })); },
    async remove(key) { await req('DELETE', key, { okMissing: true }); return true; },
    async copy(from, to) { await req('PUT', to, { headers: { 'x-amz-copy-source': `/${bucket}/${encPath(from)}` } }); return true; },
  };
}
