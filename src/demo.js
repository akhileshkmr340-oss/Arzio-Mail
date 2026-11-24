// Public demo mode (ARZIO_DEMO=true): a shared demo account filled with sample
// mail, a meeting invitation, events and tasks, plus guards so visitors cannot
// lock each other out. config.js already turns off outside mail in this mode.
import { config } from './config.js';
import { db } from './db.js';
import { createUser, findUserByEmail, userFromToken, parseCookies, COOKIE } from './auth.js';
import { deliverRaw } from './mail/delivery.js';
import { createEvent } from './calendar/service.js';

const dom = () => config.primaryDomain;
const demoEmail = () => `${config.demo.user}@${dom()}`;

function raw({ from, to, subject, text, html, minutesAgo }) {
  const date = new Date(Date.now() - minutesAgo * 60e3).toUTCString();
  const id = `<demo-${Math.random().toString(36).slice(2)}@demo.${dom()}>`;
  const boundary = 'demo-b';
  const body = html
    ? `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--${boundary}--\r\n`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  return Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${id}\r\nMIME-Version: 1.0\r\n${body}`);
}

export async function seedDemo() {
  if (!config.demo || findUserByEmail(demoEmail())) return;
  const me = createUser({ username: config.demo.user, name: 'Demo User', password: config.demo.password });
  const priya = createUser({ username: 'priya.sharma', name: 'Priya Sharma', password: `${config.demo.password}-colleague` });
  const to = `Demo User <${me.email}>`;

  const mails = [
    { from: 'Ravi Kumar <ravi@example.com>', subject: 'Quarterly numbers before Friday?', minutesAgo: 25,
      text: 'Hi,\n\nCould you send me the Q3 sales numbers before Friday? I need them for the board deck.\nAlso, can we move our call to Thursday 4 PM?\n\nThanks,\nRavi' },
    { from: 'Arzio Mail <welcome@' + dom() + '>', subject: 'Welcome to Arzio Mail', minutesAgo: 90,
      text: 'Welcome! Try Focused and Other, search, rules, the calendar, To Do, and the AI buttons (summarize, draft a reply).',
      html: '<h2 style="color:#0f6cbd">Welcome to Arzio Mail</h2><p>Try <b>Focused / Other</b>, search, rules, the calendar, To Do, and the <b>AI</b> buttons: summarize a thread or draft a reply.</p><p>This is a shared demo account. Mail cannot be sent outside the demo.</p>' },
    { from: 'Anita Desai <anita@example.org>', subject: 'Contract draft for review', minutesAgo: 60 * 5,
      text: 'Hello,\n\nPlease review the attached points by Wednesday:\n1. Payment terms are 30 days\n2. Renewal is automatic unless cancelled 60 days before\n3. Support hours 9 AM to 6 PM IST\n\nRegards,\nAnita' },
    { from: 'ShopKart Offers <deals@shopkart.example>', subject: 'Mega sale: 70% off this weekend only', minutesAgo: 60 * 8,
      text: 'Huge discounts on electronics this weekend. Unsubscribe at any time.' },
    { from: 'Bank Alerts <alerts@bank.example>', subject: 'Your monthly statement is ready', minutesAgo: 60 * 26,
      text: 'Your statement for this month is ready to view in net banking.' },
  ];
  for (const m of mails) await deliverRaw(raw({ ...m, to }), [me.email]);
  await deliverRaw(raw({ from: `Priya Sharma <${priya.email}>`, to, subject: 'Design review notes', minutesAgo: 40,
    text: 'Hi,\n\nNotes from today: the new sign-in page is approved, the mobile app needs a darker header, and we ship on Monday.\n\nPriya' }), [me.email]);

  // A meeting invitation from a colleague (lands in the inbox with Accept / Maybe / Decline)
  const day = (n, h) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
  await createEvent(priya, { title: 'Product launch planning', location: 'Room 4B', start_at: day(1, 5), end_at: day(1, 6),
    description: 'Agenda: launch date, pricing, press list.', attendees: [{ email: me.email, name: me.name }] });
  await createEvent(me, { title: 'Team stand-up', start_at: day(0, 4), end_at: day(0, 4).replace('T04:00', 'T04:15'), recurrence: 'daily' });
  await createEvent(me, { title: 'Lunch with Ravi', location: 'Cafe Mocha', start_at: day(2, 7), end_at: day(2, 8) });

  const contact = db.prepare('INSERT INTO contacts (user_id, email, name, company, job_title, is_saved) VALUES (?, ?, ?, ?, ?, 1)');
  contact.run(me.id, priya.email, 'Priya Sharma', 'Arzio', 'Design lead');
  contact.run(me.id, 'ravi@example.com', 'Ravi Kumar', 'Northwind', 'Finance manager');
  contact.run(me.id, 'anita@example.org', 'Anita Desai', 'Contoso Legal', 'Counsel');
  // Priya shares her calendar with the demo user so "People's calendars" has something to show
  db.prepare("INSERT INTO calendar_shares (owner_id, grantee_id, role) VALUES (?, ?, 'view')").run(priya.id, me.id);
  await createEvent(priya, { title: 'Design sync', start_at: day(1, 9), end_at: day(1, 10) });

  const task = db.prepare('INSERT INTO tasks (user_id, title, notes, due_at, important) VALUES (?, ?, ?, ?, ?)');
  task.run(me.id, 'Send Q3 numbers to Ravi', '', day(2, 12), 1);
  task.run(me.id, 'Review contract draft', 'Payment terms, renewal, support hours', day(1, 12), 0);
  task.run(me.id, 'Book flights for the conference', '', null, 0);
  console.log(`[demo] seeded ${me.email} / ${config.demo.password}`);
}

// Stops visitors from changing what everyone shares on the demo account.
const BLOCKED = [/^\/me\/mfa\//, /^\/me\/import\//, /^\/me\/delegates/, /^\/me\/(tokens|app-passwords)/, /^\/admin\b/, /^\/org\b/];
export function demoGuard(req, res, next) {
  if (!config.demo || req.method === 'GET') return next();
  const user = userFromToken(req.headers['x-arzio-session'] || parseCookies(req.headers.cookie)[COOKIE]);
  if (!user || user.email !== demoEmail()) return next();
  const pw = req.path === '/me' && req.body && req.body.newPassword;
  if (pw || BLOCKED.some((r) => r.test(req.path))) return res.status(403).json({ error: 'This is turned off on the shared demo account. Sign up for your own address to try it.' });
  next();
}
