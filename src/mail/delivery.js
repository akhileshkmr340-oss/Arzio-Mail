// Inbound delivery (raw MIME -> local mailboxes) and outbound sending.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { config, isLocalDomain } from '../config.js';
import { db } from '../db.js';
import { storeMessage, saveAi, mailboxUsage, getMessage, deleteMessage } from './store.js';
import { triage } from '../ai/index.js';

const OUTBOX_DIR = path.join(config.dataDir, 'outbox');

const addrList = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []) : [])
  .map((a) => ({ address: String(a.address || '').toLowerCase(), name: a.name || '' }))
  .filter((a) => a.address);

function domainOf(addr) {
  return String(addr).split('@')[1]?.toLowerCase() || '';
}

export async function isLocalAddress(addr) {
  const a = String(addr || '').toLowerCase();
  if (!(await isLocalDomain(domainOf(a)))) return false;
  return !!db.prepare('SELECT 1 FROM users WHERE email = ? AND is_disabled = 0').get(a);
}

/**
 * Deliver a raw RFC 5322 message to local recipients.
 * recipients: envelope RCPT TO addresses (only local mailboxes receive it).
 * Returns the list of addresses it was delivered to.
 */
export async function deliverRaw(raw, recipients) {
  const parsed = await simpleParser(raw, { skipHtmlToText: false });
  const delivered = [];
  for (const rcpt of new Set(recipients.map((r) => String(r).toLowerCase()))) {
    const user = db.prepare('SELECT id, ai_enabled FROM users WHERE email = ? AND is_disabled = 0').get(rcpt);
    if (!user) continue;
    if (mailboxUsage(user.id) + raw.length > config.quotas.mailboxBytes) continue; // over quota
    const from = addrList(parsed.from)[0] || { address: '', name: '' };
    const id = storeMessage(user.id, {
      folderRole: 'inbox',
      messageId: parsed.messageId || null,
      inReplyTo: parsed.inReplyTo || null,
      refs: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || null,
      from,
      to: addrList(parsed.to),
      cc: addrList(parsed.cc),
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: typeof parsed.html === 'string' ? parsed.html : '',
      date: parsed.date || new Date(),
      size: raw.length,
      attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, contentId: a.contentId })),
    });
    delivered.push(rcpt);
    if (config.ai.autoTriage && user.ai_enabled) runTriage(user.id, id);
  }
  return delivered;
}

// Triage runs in the background so delivery is never blocked by the AI service.
function runTriage(userId, messageId) {
  setImmediate(async () => {
    try {
      const m = getMessage(userId, messageId);
      const t = await triage(m);
      saveAi(messageId, { ai_priority: t.priority, ai_category: t.category, ai_needs_reply: !!t.needsReply, is_focused: t.focused !== false });
    } catch (e) {
      console.warn(`[ai] triage failed for message ${messageId}: ${e.message}`);
    }
  });
}

// ---------------------------------------------------------------- outbound

let transport;
function getTransport() {
  if (transport) return transport;
  const o = config.outbound;
  if (o.transport === 'relay') {
    if (!o.smtp.host) throw new Error('OUTBOUND_TRANSPORT=relay needs SMTP_RELAY_HOST');
    transport = nodemailer.createTransport({
      host: o.smtp.host,
      port: o.smtp.port,
      secure: o.smtp.secure,
      auth: o.smtp.user ? { user: o.smtp.user, pass: o.smtp.pass } : undefined,
    });
  } else {
    // Development: save outgoing mail as .eml files
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    transport = {
      async sendMail({ envelope, raw }) {
        const file = path.join(OUTBOX_DIR, `${Date.now()}-${crypto.randomUUID()}.eml`);
        fs.writeFileSync(file, raw);
        console.log(`[outbound:log] ${envelope.from} -> ${envelope.to.join(', ')} saved to ${file}`);
        return { messageId: null };
      },
    };
  }
  return transport;
}

function dkimOptions(fromDomain) {
  const d = config.outbound.dkim;
  if (!d.selector || !d.privateKeyPath) return undefined;
  return { domainName: fromDomain, keySelector: d.selector, privateKey: fs.readFileSync(d.privateKeyPath, 'utf8') };
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function parseRecipients(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,;]/);
  const out = [];
  for (let item of list) {
    if (item && typeof item === 'object') item = item.name ? `${item.name} <${item.address}>` : item.address;
    const s = String(item || '').trim();
    if (!s) continue;
    const m = s.match(/^(.*)<([^>]+)>$/);
    const address = (m ? m[2] : s).trim().toLowerCase();
    const name = m ? m[1].trim().replace(/^"|"$/g, '') : '';
    if (!EMAIL_RE.test(address)) throw Object.assign(new Error(`"${s}" is not a valid email address.`), { status: 400 });
    out.push({ address, name });
  }
  return out;
}

function sentToday(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM send_log WHERE user_id = ? AND created_at > datetime('now', '-1 day')").get(userId).n;
}

/**
 * Send an email from a user.
 * input: { to, cc, bcc, subject, text, html, attachments:[{filename, contentType, contentBase64}], inReplyTo, references, draftId }
 */
export async function sendMail(user, input) {
  const to = parseRecipients(input.to);
  const cc = parseRecipients(input.cc);
  const bcc = parseRecipients(input.bcc);
  const all = [...to, ...cc, ...bcc];
  if (!all.length) throw Object.assign(new Error('Add at least one recipient.'), { status: 400 });
  if (all.length > 100) throw Object.assign(new Error('Too many recipients (max 100).'), { status: 400 });
  if (sentToday(user.id) >= config.quotas.sendsPerUserPerDay) throw Object.assign(new Error('Daily sending limit reached.'), { status: 429 });

  const attachments = (input.attachments || []).map((a) => ({
    filename: String(a.filename || 'attachment'),
    contentType: a.contentType || 'application/octet-stream',
    content: Buffer.from(String(a.contentBase64 || ''), 'base64'),
  }));
  const fromDomain = domainOf(user.email);
  const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
  let text = String(input.text || '');
  if (user.signature && !input.html) text = `${text}\n\n-- \n${user.signature}`;

  const mailOptions = {
    from: { name: user.name, address: user.email },
    to: to.map((p) => ({ name: p.name, address: p.address })),
    cc: cc.map((p) => ({ name: p.name, address: p.address })),
    subject: String(input.subject || '').slice(0, 998),
    text,
    html: input.html || undefined,
    attachments,
    messageId,
    inReplyTo: input.inReplyTo || undefined,
    references: input.references || undefined,
    date: new Date(),
    headers: { 'X-Mailer': 'Arzio Mail' },
  };
  const compiled = new MailComposer(mailOptions).compile();
  compiled.keepBcc = false;
  const raw = await compiled.build();
  if (raw.length > config.quotas.maxMessageBytes) throw Object.assign(new Error('Message is too large.'), { status: 413 });

  // 1. Copy into the sender's Sent Items (threaded with the conversation)
  const sentId = storeMessage(user.id, {
    folderRole: 'sent', messageId, inReplyTo: input.inReplyTo, refs: input.references,
    from: { address: user.email, name: user.name }, to, cc, bcc,
    subject: mailOptions.subject, text, html: input.html || '', date: mailOptions.date, isRead: true, size: raw.length,
    attachments,
  });
  db.prepare('INSERT INTO send_log (user_id) VALUES (?)').run(user.id);

  // 2. Local recipients are delivered directly; 3. the rest go out via the transport
  const local = [];
  const remote = [];
  for (const p of all) ((await isLocalAddress(p.address)) ? local : remote).push(p.address);
  const delivered = local.length ? await deliverRaw(raw, local) : [];
  let remoteResult = null;
  if (remote.length) {
    const t = getTransport();
    const sendOpts = { envelope: { from: user.email, to: remote }, raw };
    const dkim = dkimOptions(fromDomain);
    if (dkim && t.options) sendOpts.dkim = dkim;
    remoteResult = await t.sendMail(sendOpts);
  }

  if (input.draftId) {
    const d = getMessage(user.id, input.draftId);
    if (d) { deleteMessage(user.id, d.id); deleteMessage(user.id, d.id); }
  }
  return { id: sentId, messageId, deliveredLocally: delivered, sentRemotely: remote, transport: config.outbound.transport, remoteMessageId: remoteResult?.messageId || null };
}
