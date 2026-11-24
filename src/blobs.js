// Where attachments, original messages and queued outgoing mail are kept.
// Local disk by default (ARZIO_DATA_DIR). Set ARZIO_S3_BUCKET to keep them in
// S3-compatible storage instead, so several Arzio servers share them and the
// disk stays small.
//
// A stored file is referenced by a string: an absolute path for the disk,
// or s3://bucket/key. Old references keep working after a switch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { createBridge } from './sql/bridge.js';

const env = process.env;
const s3cfg = env.ARZIO_S3_BUCKET ? {
  bucket: env.ARZIO_S3_BUCKET,
  endpoint: env.ARZIO_S3_ENDPOINT || `https://s3.${env.ARZIO_S3_REGION || 'us-east-1'}.amazonaws.com`,
  region: env.ARZIO_S3_REGION || 'us-east-1',
  accessKey: env.ARZIO_S3_ACCESS_KEY || env.AWS_ACCESS_KEY_ID || '',
  secretKey: env.ARZIO_S3_SECRET_KEY || env.AWS_SECRET_ACCESS_KEY || '',
  pathStyle: /^(1|true|yes)$/i.test(env.ARZIO_S3_PATH_STYLE || ''),
  prefix: (env.ARZIO_S3_PREFIX || '').replace(/^\/+|\/+$/g, ''),
} : null;

let bridge = null;
function s3() {
  if (!bridge) bridge = createBridge(new URL('./sql/s3-handler.js', import.meta.url), s3cfg);
  return bridge;
}
export const backend = s3cfg ? 's3' : 'local';

const DIRS = { attachments: path.join(config.dataDir, 'attachments'), raw: path.join(config.dataDir, 'raw'), queue: path.join(config.dataDir, 'queue') };
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

function parse(ref) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(ref || ''));
  return m ? { s3: true, bucket: m[1], key: m[2] } : { s3: false, file: ref };
}

// Stores data and returns its reference. kind: attachments | raw | queue
export function put(kind, name, data) {
  if (!DIRS[kind]) throw new Error(`Unknown blob kind ${kind}`);
  const safe = String(name).replace(/[^\w.-]/g, '_');
  if (s3cfg) {
    const key = [s3cfg.prefix, kind, safe.slice(0, 2), safe].filter(Boolean).join('/');
    s3().call('put', key, data);
    return `s3://${s3cfg.bucket}/${key}`;
  }
  const file = path.join(DIRS[kind], safe);
  fs.writeFileSync(file, data);
  return file;
}
export const uniqueName = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export function get(ref) {
  if (!ref) return null;
  const p = parse(ref);
  if (p.s3) {
    const d = s3().call('get', p.key); // arrives as a Uint8Array from the worker
    return d ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null;
  }
  try { return fs.readFileSync(p.file); } catch { return null; }
}
export function exists(ref) {
  if (!ref) return false;
  const p = parse(ref);
  return p.s3 ? s3().call('exists', p.key) : fs.existsSync(p.file);
}
export function remove(ref) {
  if (!ref) return;
  const p = parse(ref);
  if (p.s3) { try { s3().call('remove', p.key); } catch (e) { console.error('[blobs]', e.message); } return; }
  fs.rm(p.file, { force: true }, () => {});
}
export function copy(ref, kind, name) {
  const p = parse(ref);
  if (p.s3 && s3cfg) {
    const key = [s3cfg.prefix, kind, String(name).slice(0, 2), String(name).replace(/[^\w.-]/g, '_')].filter(Boolean).join('/');
    s3().call('copy', p.key, key);
    return `s3://${s3cfg.bucket}/${key}`;
  }
  const data = get(ref);
  return data ? put(kind, name, data) : null;
}
// Sends a stored file as an HTTP response
export function send(res, ref) {
  const p = parse(ref);
  if (!p.s3) return fs.createReadStream(p.file).on('error', () => res.status(404).end()).pipe(res);
  const data = get(ref);
  if (!data) return res.status(404).end();
  res.end(data);
}
export { s3cfg };
