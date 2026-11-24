// Inbound delivery (raw MIME -> local mailboxes) and outbound sending with an
// outbox (undo send, scheduled send) and a retrying delivery queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { isIgnored, messageEml } from '../routes/ribbon.js';
import { simpleParser } from 'mailparser';
import { config, isLocalDomain } from '../config.js';
import { storageLimit, sendLimit } from '../billing.js';
import * as blobs from '../blobs.js';
import { db, isJobLeader } from '../db.js';
import { pushToUser } from '../push.js';
import { storeMessage, saveAi, mailboxUsage, getMessage, deleteMessage, folderByRole } from './store.js';
import { resolveRecipient, checkInbound, senderListMatch, applyRules, shouldAutoReply, recordContacts, addressesOf } from './features.js';
import { triage } from '../ai/index.js';
import { audit } from '../audit.js';
import { applyTransportRules } from './transport-rules.js';
import { cleanHtml, inlineImages, textToHtml, mentionedAddresses } from './html.js';
import { handleInboundCalendar, processReminders } from '../calendar/service.js';

const OUTBOX_DIR = path.join(config.dataDir, 'outbox');

const addrList = (v) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x) => x.value || []) : [])
  .map((a) => ({ address: String(a.address || '').toLowerCase(), name: a.name || '' }))
  .filter((a) => a.address);

const httpErr = (status, message) => Object.assign(new Error(message), { status });

function domainOf(addr) {
  return String(addr).split('@')[1]?.toLowerCase() || '';
}

function groupByAddress(addr) {
  return db.prepare('SELECT * FROM groups WHERE address = ?').get(String(addr).toLowerCase());
}

export async function isLocalAddress(addr) {
  const a = String(addr || '').toLowerCase();
  if (!(await isLocalDomain(domainOf(a)))) return false;
  return !!(resolveRecipient(a) || groupByAddress(a));
}

/**
 * Expand envelope recipients into local mailbox users.
 * Groups expand to their members; external senders may only reach groups that allow it.
 */
function expandRecipients(recipients, senderAddr) {
  const users = new Map();
  const sender = senderAddr ? resolveRecipient(senderAddr) : null;
  const senderOrg = sender ? db.prepare('SELECT org_id FROM users WHERE id = ?').get(sender.id)?.org_id : null;
  for (const rcpt of new Set(recipients.map((r) => String(r).toLowerCase()))) {
    const g = groupByAddress(rcpt);
    if (g) {
      if (!g.allow_external && senderOrg !== g.org_id) continue;
      for (const m of db.prepare('SELECT u.id, u.email, u.name, u.ai_enabled FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND u.is_disabled = 0').all(g.id)) users.set(m.id, m);
      continue;
    }
    const u = resolveRecipient(rcpt);
    if (u) users.set(u.id, u);
  }
  return [...users.values()];
}

/**
 * Deliver a raw RFC 5322 message to local recipients.
 * smtp: { ip, helo, mailFrom } when the message came from the internet (enables SPF/DKIM/DMARC checks).
 * Returns the list of mailbox addresses it was delivered to.
 */
export async function deliverRaw(raw, recipients, smtp = {}) {
  const parsed = await simpleParser(raw, { skipHtmlToText: false, keepCidLinks: true });
  const from = addrList(parsed.from)[0] || { address: '', name: '' };
  const check = smtp.ip ? await checkInbound(raw, parsed, smtp) : { score: 0, reasons: [], auth: null };
  const delivered = [];

  for (const user of expandRecipients(recipients, from.address)) {
    if (mailboxUsage(user.id) + raw.length > storageLimit(user.id)) continue; // over quota
    const full = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const listKind = senderListMatch(user.id, from.address);
    const junk = listKind === 'blocked' || (listKind !== 'safe' && check.score >= 5);
    const id = storeMessage(user.id, {
      folderRole: junk ? 'junk' : 'inbox',
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
      raw,
      // The inline text/calendar alternative of an invite is not a real attachment
      attachments: (parsed.attachments || []).filter((a) => !(/^text\/calendar/i.test(a.contentType || '') && !a.filename)).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, contentId: a.contentId })),
    });
    db.prepare('UPDATE messages SET spam_score = ?, auth_results = ? WHERE id = ?').run(check.score, check.auth ? JSON.stringify({ ...check.auth, reasons: check.reasons }) : null, id);
    // Ignored conversations: later replies go straight to Deleted Items
    const threadId = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id)?.thread_id;
    const ignored = !junk && threadId && isIgnored(user.id, threadId);
    if (ignored) db.prepare('UPDATE messages SET folder_id = ? WHERE id = ?').run(folderByRole(user.id, 'trash').id, id);
    // Outlook extras: importance, read-receipt request, @mentions of this user
    const prio = String(parsed.headers.get('priority') || parsed.headers.get('importance') || '').toLowerCase();
    const importance = prio === 'high' || prio === 'low' ? prio : null;
    const dnt = addrList(parsed.headers.get('disposition-notification-to'))[0]?.address || null;
    const mentionsMe = typeof parsed.html === 'string' && mentionedAddresses(parsed.html).includes(user.email.toLowerCase()) ? 1 : 0;
    if (importance || dnt || mentionsMe) {
      db.prepare('UPDATE messages SET importance = ?, receipt_to = ?, mentions_me = ? WHERE id = ?')
        .run(importance, dnt && dnt.toLowerCase() !== user.email.toLowerCase() && !junk ? dnt : null, mentionsMe, id);
    }
    delivered.push(user.email);
    audit(user.id, 'mail.received', { messageId: id, from: from.address, to: user.email, subject: parsed.subject || '', junk });
    if (!junk && !ignored) pushToUser(user.id, { title: from.name || from.address || 'New message', body: parsed.subject || '(no subject)', data: { type: 'mail', messageId: id } });

    if (!junk) {
      // Meeting invites, replies and cancellations (iMIP)
      const cal = (parsed.attachments || []).find((a) => /^text\/calendar/i.test(a.contentType || '') || /\.ics$/i.test(a.filename || ''));
      if (cal) {
        try {
          const summary = handleInboundCalendar(user.id, cal.content.toString('utf8'), from.address);
          if (summary) db.prepare('UPDATE messages SET calendar_json = ? WHERE id = ?').run(JSON.stringify(summary), id);
        } catch (e) {
          console.warn('[calendar] could not read invite:', e.message);
        }
      }
      const forwards = applyRules(user.id, id);
      for (const to of forwards) enqueueRemoteOrLocal(user.id, raw, user.email, [to], parsed.subject).catch(() => {});
      if (shouldAutoReply(full, parsed, from.address)) sendAutoReply(full, parsed, from).catch((e) => console.warn('[ooo]', e.message));
      if (config.ai.autoTriage && user.ai_enabled) runTriage(user.id, id);
    }
  }
  return delivered;
}

// Triage runs in the background so delivery is never blocked by the AI service.
function runTriage(userId, messageId) {
  setImmediate(async () => {
    try {
      const m = getMessage(userId, messageId);
      if (!m) return;
      const u = db.prepare('SELECT focused_inbox FROM users WHERE id = ?').get(userId);
      const t = await triage(m);
      saveAi(messageId, { ai_priority: t.priority, ai_category: t.category, ai_needs_reply: !!t.needsReply, is_focused: u.focused_inbox ? t.focused !== false : true });
    } catch (e) {
      console.warn(`[ai] triage failed for message ${messageId}: ${e.message}`);
    }
  });
}

async function sendAutoReply(user, parsed, from) {
  const subject = user.ooo_subject || `Automatic reply: ${parsed.subject || ''}`;
  const compiled = new MailComposer({
    from: { name: user.name, address: user.email },
    to: from.address,
    subject,
    text: user.ooo_message || 'I am currently away and will reply when I return.',
    inReplyTo: parsed.messageId,
    references: parsed.messageId,
    messageId: `<${crypto.randomUUID()}@${domainOf(user.email)}>`,
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
  }).compile();
  const raw = await compiled.build();
  await enqueueRemoteOrLocal(user.id, raw, user.email, [from.address], subject);
}

// ---------------------------------------------------------------- transport

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
      dkim: dkimOptions(),
    });
  } else {
    // Development: save outgoing mail as .eml files. Addresses at fail.test bounce (for testing).
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    transport = {
      async sendMail({ envelope, raw }) {
        const bad = envelope.to.filter((a) => /@fail\.test$/i.test(a));
        if (bad.length) throw Object.assign(new Error(`550 5.1.1 <${bad[0]}>: Recipient address rejected`), { responseCode: 550 });
        const file = path.join(OUTBOX_DIR, `${Date.now()}-${crypto.randomUUID()}.eml`);
        fs.writeFileSync(file, raw);
        console.log(`[outbound:log] ${envelope.from} -> ${envelope.to.join(', ')} saved to ${file}`);
        return { messageId: null };
      },
    };
  }
  return transport;
}

function dkimOptions() {
  const d = config.outbound.dkim;
  if (!d.selector || !d.privateKeyPath) return undefined;
  return { domainName: config.primaryDomain, keySelector: d.selector, privateKey: fs.readFileSync(d.privateKeyPath, 'utf8') };
}

const BACKOFF_MIN = [1, 5, 30, 120, 360, 720];

/** Deliver locally where possible; queue the rest for remote delivery with retries. */
async function enqueueRemoteOrLocal(userId, raw, from, rcpts, subject) {
  const local = [];
  const remote = [];
  for (const r of rcpts) ((await isLocalAddress(r)) ? local : remote).push(r);
  const delivered = local.length ? await deliverRaw(raw, local) : [];
  if (remote.length) {
    const file = blobs.put('queue', `${Date.now()}-${crypto.randomUUID()}.eml`, raw);
    const r = db.prepare("INSERT INTO delivery_queue (user_id, raw_path, envelope_from, rcpts_json, subject, next_attempt) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .run(userId, file, from, JSON.stringify(remote), String(subject || ''));
    await attemptDelivery(Number(r.lastInsertRowid));
  }
  return { delivered, remote };
}

async function attemptDelivery(id) {
  const q = db.prepare("SELECT * FROM delivery_queue WHERE id = ? AND status = 'pending'").get(id);
  if (!q) return;
  // Claim the row so two workers never send the same message
  const claim = db.prepare("UPDATE delivery_queue SET status = 'sending' WHERE id = ? AND status = 'pending'").run(id);
  if (!claim.changes) return;
  const rcpts = JSON.parse(q.rcpts_json);
  try {
    await getTransport().sendMail({ envelope: { from: q.envelope_from, to: rcpts }, raw: blobs.get(q.raw_path) });
    db.prepare("UPDATE delivery_queue SET status = 'sent', attempts = attempts + 1, last_error = NULL WHERE id = ?").run(id);
    blobs.remove(q.raw_path);
  } catch (e) {
    const attempts = q.attempts + 1;
    const permanent = (e.responseCode && e.responseCode >= 500) || attempts >= BACKOFF_MIN.length;
    if (permanent) {
      db.prepare("UPDATE delivery_queue SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?").run(attempts, String(e.message).slice(0, 500), id);
      blobs.remove(q.raw_path);
      bounceNotice(q.user_id, rcpts, q.subject, e.message);
    } else {
      db.prepare(`UPDATE delivery_queue SET status = 'pending', attempts = ?, last_error = ?, next_attempt = datetime('now', '+${BACKOFF_MIN[attempts - 1]} minutes') WHERE id = ?`)
        .run(attempts, String(e.message).slice(0, 500), id);
    }
  }
}

function bounceNotice(userId, rcpts, subject, reason) {
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  if (!u) return;
  storeMessage(userId, {
    folderRole: 'inbox',
    from: { address: `mailer-daemon@${config.primaryDomain}`, name: 'Mail Delivery System' },
    to: [{ address: u.email, name: '' }],
    subject: `Undeliverable: ${subject}`,
    text: `Your message couldn't be delivered to ${rcpts.join(', ')}.\n\nReason from the receiving server:\n${reason}\n\nCheck the address and try again.`,
  });
}

// ---------------------------------------------------------------- composing

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
    if (!EMAIL_RE.test(address)) throw httpErr(400, `"${s}" is not a valid email address.`);
    out.push({ address, name });
  }
  return out;
}

function sentToday(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM send_log WHERE user_id = ? AND created_at > datetime('now', '-1 day')").get(userId).n;
}

/**
 * Addresses a user may send as: their own address and aliases, plus shared
 * mailboxes and delegated mailboxes with send-as permission.
 */
export function sendIdentities(user) {
  const own = addressesOf(user.id).map((address) => ({ address, name: user.name, mailboxId: user.id, onBehalf: false }));
  const delegated = db.prepare(`SELECT u.id, u.email, u.name, d.permission FROM delegates d JOIN users u ON u.id = d.owner_id
    WHERE d.delegate_id = ? AND d.permission IN ('send_as', 'send_on_behalf', 'full') AND u.is_disabled = 0`).all(user.id)
    .map((r) => ({ address: r.email, name: r.name, mailboxId: r.id, onBehalf: r.permission === 'send_on_behalf' }));
  return [...own, ...delegated];
}

/**
 * Queue an email for sending. Applies the user's undo-send delay, or a chosen
 * send time. Returns { queued, outboxId, sendAt } or the send result if sent now.
 */
export async function sendMail(user, input) {
  const all = [...parseRecipients(input.to), ...parseRecipients(input.cc), ...parseRecipients(input.bcc)];
  if (!all.length) throw httpErr(400, 'Add at least one recipient.');
  if (all.length > 100) throw httpErr(400, 'Too many recipients (max 100).');
  if (sentToday(user.id) >= sendLimit(user.id)) throw httpErr(429, 'Daily sending limit reached for your plan.');
  if (input.from && !sendIdentities(user).some((i) => i.address === String(input.from).toLowerCase())) throw httpErr(403, 'You are not allowed to send from that address.');

  let sendAt;
  let scheduled = false;
  if (input.sendAt) {
    sendAt = new Date(input.sendAt);
    if (Number.isNaN(sendAt.getTime())) throw httpErr(400, 'Invalid send time.');
    if (sendAt.getTime() < Date.now() - 60e3) throw httpErr(400, 'Choose a time in the future.');
    scheduled = true;
  } else {
    const undo = Number(user.undo_send_seconds ?? 10);
    sendAt = new Date(Date.now() + undo * 1000);
    if (undo <= 0) return performSend(user, input);
  }
  const r = db.prepare('INSERT INTO outbox (user_id, payload_json, send_at, scheduled) VALUES (?, ?, ?, ?)')
    .run(user.id, JSON.stringify(input), sendAt.toISOString(), scheduled ? 1 : 0);
  if (input.draftId) {
    // The draft stays until the message actually goes out; hide it from Drafts meanwhile
  }
  return { queued: true, outboxId: Number(r.lastInsertRowid), sendAt: sendAt.toISOString(), scheduled };
}

export function cancelQueued(userId, outboxId) {
  const row = db.prepare("SELECT * FROM outbox WHERE id = ? AND user_id = ? AND status = 'pending'").get(Number(outboxId), userId);
  if (!row) throw httpErr(409, 'Too late: this message has already been sent.');
  const ok = db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(row.id);
  if (!ok.changes) throw httpErr(409, 'Too late: this message has already been sent.');
  return JSON.parse(row.payload_json);
}

export function listScheduled(userId) {
  return db.prepare("SELECT id, payload_json, send_at, scheduled FROM outbox WHERE user_id = ? AND status = 'pending' ORDER BY send_at").all(userId)
    .map((r) => {
      const p = JSON.parse(r.payload_json);
      return { id: r.id, sendAt: r.send_at, scheduled: !!r.scheduled, to: p.to, subject: p.subject, snippet: String(p.text || '').slice(0, 140) };
    });
}

/** Actually compose and send. Called by the outbox worker or directly when undo is off. */
export async function performSend(user, input) {
  const to = parseRecipients(input.to);
  const cc = parseRecipients(input.cc);
  const bcc = parseRecipients(input.bcc);
  const all = [...to, ...cc, ...bcc];

  // Which mailbox is this sent from? (own address, alias, shared or delegated mailbox)
  const identity = input.from ? sendIdentities(user).find((i) => i.address === String(input.from).toLowerCase()) : null;
  const fromAddr = identity?.address || user.email;
  const fromName = identity?.name || user.name;
  const mailboxId = identity?.mailboxId || user.id;

  const attachments = (input.attachments || []).map((a) => ({
    filename: String(a.filename || 'attachment'),
    contentType: a.contentType || 'application/octet-stream',
    content: Buffer.from(String(a.contentBase64 || ''), 'base64'),
  }));
  // Forwarding: carry the original message's attachments along (forwardOf = message id)
  if (input.forwardOf) {
    const orig = getMessage(user.id, input.forwardOf);
    if (orig) {
      for (const a of db.prepare('SELECT filename, content_type, storage_path FROM attachments WHERE message_id = ?').all(orig.id)) {
        if (/^text\/calendar/i.test(a.content_type)) continue;
        const content = blobs.get(a.storage_path);
        if (content) attachments.push({ filename: a.filename, contentType: a.content_type, content });
      }
    }
  }
  // Forward as attachment: the original goes along as an .eml file
  for (const mid of (Array.isArray(input.attachMessages) ? input.attachMessages : []).slice(0, 10)) {
    const eml = await messageEml(user.id, mid);
    if (eml) attachments.push({ filename: `${(eml.message.subject || 'message').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'message'}.eml`, contentType: 'message/rfc822', contentDisposition: 'attachment', content: eml.raw });
  }
  const fromDomain = domainOf(fromAddr);
  const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
  let text = String(input.text || '');
  // Rich text from the composer: cleaned, pasted pictures sent as inline attachments
  let html = '';
  if (input.html) {
    const inl = inlineImages(cleanHtml(input.html), fromDomain);
    html = inl.html;
    attachments.push(...inl.attachments);
  }
  if (user.signature && !input.noSignature) {
    text = `${text}\n\n-- \n${user.signature}`;
    if (html) html = `${html}<div class="arzio-signature"><br>-- <br>${textToHtml(user.signature)}</div>`;
  }
  const extraHeaders = {};
  if (input.importance === 'high') Object.assign(extraHeaders, { Importance: 'High', 'X-Priority': '1 (Highest)' });
  if (input.importance === 'low') Object.assign(extraHeaders, { Importance: 'Low', 'X-Priority': '5 (Lowest)' });
  if (input.readReceipt) extraHeaders['Disposition-Notification-To'] = fromAddr;

  // Organization mail flow rules (disclaimers, blocks)
  const flow = applyTransportRules(user, { to: all, subject: input.subject, text });
  if (flow.block) throw httpErr(403, flow.block);
  const added = flow.text.startsWith(text) ? flow.text.slice(text.length).trim() : '';
  if (html && added) html = `${html}<div class="arzio-disclaimer"><br>${textToHtml(added)}</div>`;
  text = flow.text;

  const mailOptions = {
    from: { name: fromName, address: fromAddr },
    sender: identity?.onBehalf ? { name: user.name, address: user.email } : undefined,
    to: to.map((p) => ({ name: p.name, address: p.address })),
    cc: cc.map((p) => ({ name: p.name, address: p.address })),
    subject: String(input.subject || '').slice(0, 998),
    text,
    html: html || undefined,
    attachments,
    messageId,
    inReplyTo: input.inReplyTo || undefined,
    references: input.references || undefined,
    date: new Date(),
    headers: { 'X-Mailer': 'Arzio Mail', ...extraHeaders, ...(input.headers || {}) },
    icalEvent: input.icalEvent || undefined,
  };
  const compiled = new MailComposer(mailOptions).compile();
  compiled.keepBcc = false;
  const raw = await compiled.build();
  if (raw.length > config.quotas.maxMessageBytes) throw httpErr(413, 'Message is too large.');

  // 1. Copy into the sending mailbox's Sent Items (threaded with the conversation)
  const sentId = storeMessage(mailboxId, {
    folderRole: 'sent', messageId, inReplyTo: input.inReplyTo, refs: input.references,
    from: { address: fromAddr, name: fromName }, to, cc, bcc,
    subject: mailOptions.subject, text, html, date: mailOptions.date, isRead: true, size: raw.length, raw,
    attachments: attachments.map((a) => ({ ...a, contentId: a.cid })),
  });
  if (input.importance === 'high' || input.importance === 'low') db.prepare('UPDATE messages SET importance = ? WHERE id = ?').run(input.importance, sentId);
  db.prepare('INSERT INTO send_log (user_id) VALUES (?)').run(user.id);
  recordContacts(user.id, all);
  audit(user.id, 'mail.sent', { messageId: sentId, from: fromAddr, to: all.map((p) => p.address), subject: mailOptions.subject });

  // 2. Local recipients now; 3. remote recipients through the queue (with retries)
  const envelopeTo = [...new Set([...all.map((p) => p.address), ...flow.bcc])];
  if (flow.matched.length) audit(user.id, 'mailflow.matched', { rules: flow.matched, subject: mailOptions.subject });
  const { delivered, remote } = await enqueueRemoteOrLocal(user.id, raw, fromAddr, envelopeTo, mailOptions.subject);

  if (input.draftId) {
    const d = getMessage(user.id, input.draftId);
    if (d && d.folder_id === folderByRole(user.id, 'drafts').id) { deleteMessage(user.id, d.id); deleteMessage(user.id, d.id); }
  }
  return { id: sentId, messageId, deliveredLocally: delivered, sentRemotely: remote, transport: config.outbound.transport };
}

// ---------------------------------------------------------------- workers

let running = false;
export async function runWorkersOnce() {
  if (running || !isJobLeader()) return;
  running = true;
  try {
    // Outbox: messages whose undo window or scheduled time has passed
    const due = db.prepare("SELECT * FROM outbox WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 50").all(new Date().toISOString());
    for (const row of due) {
      if (!db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'pending'").run(row.id).changes) continue;
      const user = db.prepare('SELECT u.*, o.kind AS org_kind FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?').get(row.user_id);
      try {
        const r = await performSend(user, JSON.parse(row.payload_json));
        db.prepare("UPDATE outbox SET status = 'sent', sent_message_id = ? WHERE id = ?").run(r.id, row.id);
      } catch (e) {
        db.prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?").run(String(e.message).slice(0, 500), row.id);
        const p = JSON.parse(row.payload_json);
        bounceNotice(row.user_id, [String(p.to)], p.subject || '', e.message);
      }
    }
    // Remote delivery retries
    for (const q of db.prepare("SELECT id FROM delivery_queue WHERE status = 'pending' AND next_attempt <= datetime('now') LIMIT 50").all()) {
      await attemptDelivery(q.id);
    }
    // Snoozed messages come back as unread
    db.prepare("UPDATE messages SET snooze_until = NULL, is_read = 0 WHERE snooze_until IS NOT NULL AND snooze_until <= ?").run(new Date().toISOString());
    // Event and task reminders
    processReminders();
  } catch (e) {
    console.error('[worker]', e);
  } finally {
    running = false;
  }
}

export function startWorkers(intervalMs = 2000) {
  const t = setInterval(runWorkersOnce, intervalMs);
  t.unref();
  return t;
}

// ---------------------------------------------------------------- SMTP submission (mail apps)

/**
 * Send a complete MIME message submitted by a mail app over SMTP AUTH.
 * The app saves its own copy in Sent over IMAP, so none is stored here.
 */
export async function submitRaw(user, raw, envelope) {
  if (sentToday(user.id) >= sendLimit(user.id)) throw httpErr(429, 'Daily sending limit reached for your plan.');
  const parsed = await simpleParser(raw);
  const from = addrList(parsed.from)[0]?.address || '';
  const allowed = new Set(sendIdentities(user).map((i) => i.address));
  if (!allowed.has(from) || (envelope.from && !allowed.has(String(envelope.from).toLowerCase()))) {
    throw httpErr(403, `You can only send as ${[...allowed].join(', ')}.`);
  }
  const rcpts = [...new Set(envelope.to.map((a) => String(a).toLowerCase()))];
  if (!rcpts.length || rcpts.length > 100) throw httpErr(400, 'Between 1 and 100 recipients are allowed.');
  const flow = applyTransportRules(user, { to: rcpts.map((address) => ({ address })), subject: parsed.subject || '', text: parsed.text || '' });
  if (flow.block) throw httpErr(403, flow.block);
  db.prepare('INSERT INTO send_log (user_id) VALUES (?)').run(user.id);
  recordContacts(user.id, rcpts.map((address) => ({ address, name: '' })));
  audit(user.id, 'mail.sent', { via: 'smtp', from, to: rcpts, subject: parsed.subject || '' });
  if (flow.matched.length) audit(user.id, 'mailflow.matched', { rules: flow.matched, subject: parsed.subject || '' });
  return enqueueRemoteOrLocal(user.id, raw, from, [...new Set([...rcpts, ...flow.bcc])], parsed.subject || '');
}
