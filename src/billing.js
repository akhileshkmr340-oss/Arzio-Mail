// Plans and billing.
//
// Free and paid plans for personal accounts (Outlook.com style) and per-seat
// plans for organizations (Microsoft 365 Business style). Each plan sets
// storage, daily sending, daily AI use, users and features. Payments go
// through Stripe (cards worldwide) or Razorpay (UPI, cards, netbanking in
// India); an operator can also assign a plan by hand ("manual", for invoices
// paid by bank transfer).
//
// With ARZIO_BILLING off (the default for self-hosted private servers), no
// limits change: everyone gets the limits in config.js.
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { audit } from './audit.js';

const env = process.env;
export const billingConfig = {
  get enabled() { return /^(1|true|yes|on)$/i.test(env.ARZIO_BILLING || ''); },
  get currency() { return (env.BILLING_CURRENCY || 'INR').toUpperCase(); },
  get taxName() { return env.BILLING_TAX_NAME || 'GST'; },
  get taxPercent() { return Number(env.BILLING_TAX_PERCENT || 18); },
  get seller() { return env.BILLING_SELLER || config.serviceName; },
  get sellerTaxId() { return env.BILLING_SELLER_TAX_ID || ''; },
  get graceDays() { return Number(env.BILLING_GRACE_DAYS || 7); },
  get publicUrl() { return (env.ARZIO_PUBLIC_URL || `https://${config.imap.publicHost}`).replace(/\/$/, ''); },
  stripe: {
    get key() { return env.STRIPE_SECRET_KEY || ''; },
    get webhookSecret() { return env.STRIPE_WEBHOOK_SECRET || ''; },
    get api() { return env.STRIPE_API_BASE || 'https://api.stripe.com'; },
  },
  razorpay: {
    get keyId() { return env.RAZORPAY_KEY_ID || ''; },
    get keySecret() { return env.RAZORPAY_KEY_SECRET || ''; },
    get webhookSecret() { return env.RAZORPAY_WEBHOOK_SECRET || ''; },
    get api() { return env.RAZORPAY_API_BASE || 'https://api.razorpay.com'; },
  },
};

const httpErr = (status, message) => Object.assign(new Error(message), { status, expose: true });

// ------------------------------------------------------------ schema
db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,                 -- personal | business
  price_month INTEGER NOT NULL DEFAULT 0, -- minor units (paise, cents) per account or per user
  price_year INTEGER NOT NULL DEFAULT 0,
  storage_mb INTEGER NOT NULL,
  sends_per_day INTEGER NOT NULL,
  ai_per_day INTEGER NOT NULL,            -- 0 = no AI, -1 = no limit
  max_users INTEGER NOT NULL DEFAULT 1,   -- business: most seats you can buy
  features_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  interval TEXT NOT NULL DEFAULT 'month',  -- month | year
  seats INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',   -- pending | active | past_due | canceled
  provider TEXT NOT NULL DEFAULT 'manual', -- manual | stripe | razorpay
  provider_ref TEXT,
  checkout_ref TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  past_due_since TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_org ON subscriptions(org_id, status);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  user_id INTEGER, org_id INTEGER,
  bill_to TEXT NOT NULL,
  description TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',     -- paid | open | void
  provider TEXT, provider_ref TEXT UNIQUE,
  period_start TEXT, period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS provider_plans (
  provider TEXT NOT NULL, plan_id INTEGER NOT NULL, interval TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT NOT NULL,
  PRIMARY KEY (provider, plan_id, interval, amount)
);
CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, event_id)
);
`);

// Starting plans; the operator changes prices and limits in Service admin.
const SEED = [
  { code: 'free', name: 'Free', audience: 'personal', price_month: 0, price_year: 0, storage_mb: 5 * 1024, sends_per_day: 300, ai_per_day: 20, max_users: 1, features: [], description: 'Email, calendar and To Do with basic AI help.', sort: 1 },
  { code: 'premium', name: 'Premium', audience: 'personal', price_month: 14900, price_year: 149000, storage_mb: 100 * 1024, sends_per_day: 1000, ai_per_day: 500, max_users: 1, features: ['priority_support'], description: 'More storage, more sending and AI for everything you write.', sort: 2 },
  { code: 'business_basic', name: 'Business Basic', audience: 'business', price_month: 12500, price_year: 125000, storage_mb: 50 * 1024, sends_per_day: 2000, ai_per_day: 200, max_users: 300, features: ['custom_domain', 'shared_mailboxes', 'groups'], description: 'Mail on your own domain, shared mailboxes, groups and the admin center.', sort: 3 },
  { code: 'business_standard', name: 'Business Standard', audience: 'business', price_month: 35000, price_year: 350000, storage_mb: 100 * 1024, sends_per_day: 5000, ai_per_day: -1, max_users: 300, features: ['custom_domain', 'shared_mailboxes', 'groups', 'compliance', 'priority_support'], description: 'Everything in Basic plus data loss prevention, retention, litigation hold and eDiscovery.', sort: 4 },
];
for (const p of SEED) {
  if (!db.prepare('SELECT 1 FROM plans WHERE code = ?').get(p.code)) {
    db.prepare(`INSERT INTO plans (code, name, audience, price_month, price_year, storage_mb, sends_per_day, ai_per_day, max_users, features_json, description, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.code, p.name, p.audience, p.price_month, p.price_year, p.storage_mb, p.sends_per_day, p.ai_per_day, p.max_users, JSON.stringify(p.features), p.description, p.sort);
  }
}

// ------------------------------------------------------------ plans and limits
function planRow(p) {
  if (!p) return null;
  const { features_json: fj, ...rest } = p;
  return { ...rest, features: JSON.parse(fj || '[]') };
}
export const getPlan = (id) => planRow(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
export const planByCode = (code) => planRow(db.prepare('SELECT * FROM plans WHERE code = ?').get(code));
export function listPlans({ audience, all = false } = {}) {
  return db.prepare(`SELECT * FROM plans WHERE (? IS NULL OR audience = ?) AND (? OR is_public = 1) ORDER BY sort, id`)
    .all(audience ?? null, audience ?? null, all ? 1 : 0).map(planRow);
}

const LIVE = "status IN ('active', 'past_due')";
export function subscriptionFor({ userId, orgId }) {
  return orgId
    ? db.prepare(`SELECT * FROM subscriptions WHERE org_id = ? AND ${LIVE} ORDER BY id DESC LIMIT 1`).get(orgId)
    : db.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND ${LIVE} ORDER BY id DESC LIMIT 1`).get(userId);
}

function userScope(userOrId) {
  const u = typeof userOrId === 'object' ? userOrId : db.prepare('SELECT u.id, u.org_id, o.kind AS org_kind FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?').get(userOrId);
  if (!u) return null;
  const kind = u.org_kind || db.prepare('SELECT kind FROM organizations WHERE id = ?').get(u.org_id)?.kind;
  return kind === 'private' ? { orgId: u.org_id } : { userId: u.id };
}

// The plan in force for a user: their own (personal) or their organization's.
export function planFor(userOrId) {
  const scope = userScope(userOrId);
  if (!scope) return planByCode('free');
  const sub = subscriptionFor(scope);
  if (sub) return getPlan(sub.plan_id);
  return planByCode(scope.orgId ? (env.BILLING_DEFAULT_ORG_PLAN || 'business_basic') : 'free');
}

export function limitsFor(userOrId) {
  if (!billingConfig.enabled) {
    return { billing: false, storageBytes: config.quotas.mailboxBytes, sendsPerDay: config.quotas.sendsPerUserPerDay, aiPerDay: -1, features: null };
  }
  const p = planFor(userOrId);
  return { billing: true, plan: p.code, storageBytes: p.storage_mb * 1024 * 1024, sendsPerDay: p.sends_per_day, aiPerDay: p.ai_per_day, features: p.features };
}
export const storageLimit = (userId) => limitsFor(userId).storageBytes;
export const sendLimit = (userId) => limitsFor(userId).sendsPerDay;

export function hasFeature(userOrId, feature) {
  const l = limitsFor(userOrId);
  return !l.billing || l.features.includes(feature);
}
export function requireFeature(feature, label) {
  return (req, res, next) => {
    if (hasFeature(req.user, feature)) return next();
    res.status(402).json({ error: `${label} is part of a higher plan. Upgrade in Admin center > Billing.`, upgrade: true });
  };
}

// AI use per day. Counts one per request.
const today = () => new Date().toISOString().slice(0, 10);
export function aiUsedToday(userId) {
  return db.prepare('SELECT count FROM ai_usage WHERE user_id = ? AND day = ?').get(userId, today())?.count || 0;
}
export function useAi(user) {
  const { aiPerDay } = limitsFor(user);
  if (aiPerDay === 0) throw httpErr(402, 'AI is not included in your plan. Upgrade to use it.');
  if (aiPerDay > 0 && aiUsedToday(user.id) >= aiPerDay) throw httpErr(429, `You have used today's ${aiPerDay} AI requests. Upgrade for more, or try again tomorrow.`);
  db.prepare('INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1').run(user.id, today());
}

// Seats: organizations on a paid plan get as many users as seats bought.
export function seatLimit(orgId, fallback) {
  if (!billingConfig.enabled) return fallback;
  const sub = subscriptionFor({ orgId });
  if (sub) return sub.seats;
  return Number(env.BILLING_TRIAL_SEATS || 5);
}

// ------------------------------------------------------------ money helpers
// Prices are shown before tax; customers pay the price plus tax (grossUnit).
export function priceFor(plan, interval, seats = 1) {
  const unit = interval === 'year' ? plan.price_year : plan.price_month;
  const grossUnit = Math.round(unit * (1 + billingConfig.taxPercent / 100));
  const subtotal = unit * Math.max(1, seats);
  const total = grossUnit * Math.max(1, seats);
  return { unit, grossUnit, subtotal, tax: total - subtotal, total, currency: billingConfig.currency };
}
export function formatMoney(minor, currency = billingConfig.currency) {
  try { return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency }).format(minor / 100); } catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}
function addInterval(from, interval) {
  const d = new Date(from);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

function billTo(sub) {
  if (sub.org_id) {
    const o = db.prepare('SELECT name FROM organizations WHERE id = ?').get(sub.org_id);
    const admin = db.prepare("SELECT email FROM users WHERE org_id = ? AND role = 'org_admin' ORDER BY id LIMIT 1").get(sub.org_id);
    return `${o?.name || 'Organization'}${admin ? ` <${admin.email}>` : ''}`;
  }
  const u = db.prepare('SELECT name, email FROM users WHERE id = ?').get(sub.user_id);
  return `${u?.name || ''} <${u?.email || ''}>`;
}

function nextInvoiceNumber() {
  const year = new Date().getUTCFullYear();
  const n = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?").get(`ARZ-${year}-%`).n + 1;
  return `ARZ-${year}-${String(n).padStart(5, '0')}`;
}

// Records a payment as an invoice (idempotent on provider_ref) and moves the
// subscription's paid-through date forward.
export function recordPayment(sub, { amount, providerRef, periodStart, periodEnd }) {
  if (providerRef && db.prepare('SELECT 1 FROM invoices WHERE provider_ref = ?').get(providerRef)) return null;
  const plan = getPlan(sub.plan_id);
  const p = priceFor(plan, sub.interval, sub.seats);
  // The provider's amount (tax included) wins if it differs from our price list
  const total = Number.isFinite(amount) && amount > 0 ? amount : p.total;
  const subtotal = Math.round(total / (1 + billingConfig.taxPercent / 100));
  const start = periodStart || new Date().toISOString();
  const end = periodEnd || addInterval(start, sub.interval);
  const r = db.prepare(`INSERT INTO invoices (number, subscription_id, user_id, org_id, bill_to, description, currency, subtotal, tax, total, status, provider, provider_ref, period_start, period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`).run(
    nextInvoiceNumber(), sub.id, sub.user_id, sub.org_id, billTo(sub),
    `${config.serviceName} ${plan.name}, ${sub.seats > 1 ? `${sub.seats} users, ` : ''}${sub.interval === 'year' ? 'yearly' : 'monthly'}`,
    billingConfig.currency, subtotal, total - subtotal, total, sub.provider, providerRef || null, start, end);
  db.prepare("UPDATE subscriptions SET status = 'active', past_due_since = NULL, current_period_end = ?, updated_at = datetime('now') WHERE id = ?").run(end, sub.id);
  audit(sub.user_id || null, 'billing.payment', { subscription: sub.id, total, provider: sub.provider });
  return r.lastInsertRowid;
}

// ------------------------------------------------------------ subscriptions
function scopeOf(user, forOrg) {
  if (forOrg) {
    if (user.org_kind !== 'private' || (user.role !== 'org_admin' && !user.is_admin)) throw httpErr(403, 'Only organization admins can change the organization plan.');
    return { orgId: user.org_id };
  }
  if (user.org_kind === 'private') throw httpErr(400, 'Your organization pays for your account. Ask your admin.');
  return { userId: user.id };
}

function activate(scope, plan, { interval = 'month', seats = 1, provider = 'manual', providerRef = null, periodEnd = null, status = 'active' } = {}) {
  // One live subscription per account or organization
  const old = subscriptionFor(scope);
  if (old && old.provider_ref && old.provider_ref !== providerRef && old.provider !== 'manual') {
    cancelAtProvider(old, { immediately: true }).catch((e) => console.error('[billing] cancel old', e.message));
  }
  if (old) db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = datetime('now') WHERE id = ?").run(old.id);
  db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE status = 'pending' AND (user_id IS ? AND org_id IS ?)").run(scope.userId ?? null, scope.orgId ?? null);
  const r = db.prepare(`INSERT INTO subscriptions (user_id, org_id, plan_id, interval, seats, status, provider, provider_ref, current_period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope.userId ?? null, scope.orgId ?? null, plan.id, interval, seats, status, provider, providerRef, periodEnd);
  if (scope.orgId) db.prepare('UPDATE organizations SET max_users = ? WHERE id = ?').run(seats, scope.orgId);
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(r.lastInsertRowid);
}

function checkSeats(scope, plan, seats) {
  if (!scope.orgId) return 1;
  const n = Math.floor(Number(seats) || 0);
  const used = db.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND mailbox_type != 'shared'").get(scope.orgId).n;
  if (n < Math.max(1, used)) throw httpErr(400, `You have ${used} users, so buy at least ${used} seats.`);
  if (n > plan.max_users) throw httpErr(400, `${plan.name} allows up to ${plan.max_users} users.`);
  return n;
}

// Starts a paid plan. Returns { url } to send the person to the payment page,
// or { subscription } when no payment is needed (free plan, manual).
export async function startCheckout(user, { plan: code, interval = 'month', seats, provider, forOrg = false }) {
  if (!billingConfig.enabled) throw httpErr(400, 'Billing is not turned on for this server.');
  const scope = scopeOf(user, forOrg);
  const plan = planByCode(code);
  if (!plan || !plan.is_public) throw httpErr(404, 'Plan not found.');
  if (plan.audience !== (scope.orgId ? 'business' : 'personal')) throw httpErr(400, `${plan.name} is for ${plan.audience} accounts.`);
  if (!['month', 'year'].includes(interval)) throw httpErr(400, 'Choose monthly or yearly.');
  const n = checkSeats(scope, plan, seats ?? 1);
  if (plan.price_month === 0) {
    const sub = activate(scope, plan, { seats: n });
    audit(user.id, 'billing.plan.change', { plan: plan.code });
    return { subscription: publicSub(sub) };
  }
  const prov = provider || defaultProvider();
  if (!prov) throw httpErr(503, 'Online payment is not set up yet. Contact support to upgrade.');
  const price = priceFor(plan, interval, n);
  const pending = db.prepare(`INSERT INTO subscriptions (user_id, org_id, plan_id, interval, seats, status, provider) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(scope.userId ?? null, scope.orgId ?? null, plan.id, interval, n, prov).lastInsertRowid;
  const meta = { arzio_subscription: String(pending) };
  let out;
  if (prov === 'stripe') out = await stripeCheckout(user, plan, interval, n, price, meta);
  else if (prov === 'razorpay') out = await razorpayCheckout(user, plan, interval, n, price, meta);
  else throw httpErr(400, 'Unknown payment provider.');
  db.prepare('UPDATE subscriptions SET checkout_ref = ?, provider_ref = COALESCE(?, provider_ref) WHERE id = ?').run(out.checkoutRef, out.providerRef || null, pending);
  audit(user.id, 'billing.checkout', { plan: plan.code, interval, seats: n, provider: prov });
  return { url: out.url };
}

export function defaultProvider() {
  const want = env.BILLING_PROVIDER;
  if (want === 'stripe' && billingConfig.stripe.key) return 'stripe';
  if (want === 'razorpay' && billingConfig.razorpay.keyId) return 'razorpay';
  if (billingConfig.razorpay.keyId && billingConfig.currency === 'INR') return 'razorpay';
  if (billingConfig.stripe.key) return 'stripe';
  if (billingConfig.razorpay.keyId) return 'razorpay';
  return null;
}

// Operator assigns a plan by hand (paid offline). Records an invoice when paid.
export function assignPlan(operator, { userEmail, orgId, plan: code, interval = 'month', seats = 1, months, paid = false, amount }) {
  const plan = planByCode(code);
  if (!plan) throw httpErr(404, 'Plan not found.');
  let scope;
  if (orgId) {
    if (!db.prepare("SELECT 1 FROM organizations WHERE id = ? AND kind = 'private'").get(orgId)) throw httpErr(404, 'Organization not found.');
    scope = { orgId: Number(orgId) };
  } else {
    const u = db.prepare("SELECT u.id FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.email = ? AND o.kind = 'public'").get(String(userEmail || '').toLowerCase());
    if (!u) throw httpErr(404, 'No personal account with that address.');
    scope = { userId: u.id };
  }
  const n = checkSeats(scope, plan, seats);
  const end = months ? new Date(Date.now() + Number(months) * 30.44 * 86400e3).toISOString() : null;
  const sub = activate(scope, plan, { interval, seats: n, provider: 'manual', periodEnd: end });
  if (paid && plan.price_month > 0) recordPayment(sub, { amount: Number(amount) || undefined, providerRef: `manual-${sub.id}-${Date.now()}`, periodEnd: end || undefined });
  audit(operator.id, 'billing.assign', { plan: plan.code, ...scope, seats: n });
  return publicSub(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id));
}

export async function cancel(user, { forOrg = false } = {}) {
  const scope = scopeOf(user, forOrg);
  const sub = subscriptionFor(scope);
  if (!sub || getPlan(sub.plan_id).price_month === 0) throw httpErr(400, 'You are on a free plan.');
  await cancelAtProvider(sub, { immediately: false });
  db.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = datetime('now') WHERE id = ?").run(sub.id);
  if (!sub.current_period_end) endSubscription(sub);
  audit(user.id, 'billing.cancel', { subscription: sub.id });
  return publicSub(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id));
}

export async function changeSeats(user, seats) {
  const scope = scopeOf(user, true);
  const sub = subscriptionFor(scope);
  if (!sub) throw httpErr(400, 'Choose a plan first.');
  const plan = getPlan(sub.plan_id);
  const n = checkSeats(scope, plan, seats);
  if (sub.provider === 'stripe' && sub.provider_ref) {
    const s = await stripeApi('GET', `/v1/subscriptions/${sub.provider_ref}`);
    const item = s.items?.data?.[0]?.id;
    if (item) await stripeApi('POST', `/v1/subscriptions/${sub.provider_ref}`, { 'items[0][id]': item, 'items[0][quantity]': n, proration_behavior: 'create_prorations' });
  } else if (sub.provider === 'razorpay' && sub.provider_ref) {
    await razorpayApi('PATCH', `/v1/subscriptions/${sub.provider_ref}`, { quantity: n, schedule_change_at: 'now' });
  }
  db.prepare("UPDATE subscriptions SET seats = ?, updated_at = datetime('now') WHERE id = ?").run(n, sub.id);
  db.prepare('UPDATE organizations SET max_users = ? WHERE id = ?').run(n, scope.orgId);
  audit(user.id, 'billing.seats', { seats: n });
  return publicSub(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id));
}

function endSubscription(sub) {
  db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = datetime('now') WHERE id = ?").run(sub.id);
  audit(sub.user_id || null, 'billing.ended', { subscription: sub.id, org: sub.org_id });
}

// Hourly: end subscriptions cancelled at period end, and ones unpaid past the grace period.
export function runBillingMaintenance(now = new Date()) {
  const iso = now.toISOString();
  for (const s of db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND cancel_at_period_end = 1 AND current_period_end IS NOT NULL AND current_period_end < ?").all(iso)) endSubscription(s);
  for (const s of db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND provider = 'manual' AND current_period_end IS NOT NULL AND current_period_end < ?").all(iso)) endSubscription(s);
  const graceStart = new Date(now - billingConfig.graceDays * 86400e3).toISOString();
  for (const s of db.prepare("SELECT * FROM subscriptions WHERE status = 'past_due' AND past_due_since < ?").all(graceStart)) endSubscription(s);
  db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE status = 'pending' AND created_at < datetime('now', '-2 days')").run();
  db.prepare("DELETE FROM ai_usage WHERE day < date('now', '-40 days')").run();
}

export function publicSub(s) {
  if (!s) return null;
  const plan = getPlan(s.plan_id);
  return { id: s.id, plan: plan.code, planName: plan.name, interval: s.interval, seats: s.seats, status: s.status, provider: s.provider, currentPeriodEnd: s.current_period_end, cancelAtPeriodEnd: !!s.cancel_at_period_end };
}

export function overview(user, { forOrg = false } = {}) {
  const scope = forOrg ? { orgId: user.org_id } : userScope(user);
  const plan = planFor(user);
  const sub = subscriptionFor(scope);
  const invoices = db.prepare(`SELECT id, number, description, currency, total, status, created_at, period_end FROM invoices WHERE ${scope.orgId ? 'org_id' : 'user_id'} = ? ORDER BY id DESC LIMIT 50`).all(scope.orgId || scope.userId);
  const limits = limitsFor(user);
  return {
    enabled: billingConfig.enabled,
    currency: billingConfig.currency,
    tax: { name: billingConfig.taxName, percent: billingConfig.taxPercent },
    plan: { code: plan.code, name: plan.name, features: plan.features },
    subscription: publicSub(sub),
    plans: listPlans({ audience: scope.orgId ? 'business' : 'personal' }),
    canPayOnline: !!defaultProvider(),
    usage: {
      aiToday: aiUsedToday(user.id), aiPerDay: limits.aiPerDay, sendsPerDay: limits.sendsPerDay, storageBytes: limits.storageBytes,
      ...(scope.orgId ? { users: db.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND mailbox_type != 'shared'").get(scope.orgId).n, seats: seatLimit(scope.orgId, null) } : {}),
    },
    invoices,
  };
}

export function invoiceHtml(user, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(id));
  if (!inv) return null;
  const mine = inv.user_id === user.id || (inv.org_id && inv.org_id === user.org_id && (user.role === 'org_admin')) || user.is_admin;
  if (!mine) return null;
  const e = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const d = (s) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const m = (v) => formatMoney(v, inv.currency);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${e(inv.number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1f2328}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:24px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right}.muted{color:#666}.top{display:flex;justify-content:space-between;gap:20px}@media print{button{display:none}}</style></head>
<body><div class="top"><div><h1>${e(billingConfig.seller)}</h1>${billingConfig.sellerTaxId ? `<div class="muted">${e(billingConfig.taxName)} no. ${e(billingConfig.sellerTaxId)}</div>` : ''}</div>
<div style="text-align:right"><strong>Invoice ${e(inv.number)}</strong><div class="muted">${d(inv.created_at)}</div><div>${inv.status === 'paid' ? 'Paid' : e(inv.status)}</div></div></div>
<p><strong>Billed to</strong><br>${e(inv.bill_to)}</p>
<table><tr><th>Description</th><th>Period</th><th class="r">Amount</th></tr>
<tr><td>${e(inv.description)}</td><td>${d(inv.period_start)} to ${d(inv.period_end)}</td><td class="r">${m(inv.subtotal)}</td></tr>
<tr><td colspan="2" class="r">${e(billingConfig.taxName)} (${billingConfig.taxPercent}%)</td><td class="r">${m(inv.tax)}</td></tr>
<tr><th colspan="2" class="r">Total</th><th class="r">${m(inv.total)}</th></tr></table>
<p class="muted">Paid by ${e(inv.provider || 'manual')}${inv.provider_ref ? `, reference ${e(inv.provider_ref)}` : ''}.</p>
<button onclick="print()">Print or save as PDF</button></body></html>`;
}

// ------------------------------------------------------------ Stripe
async function stripeApi(method, p, params) {
  if (!billingConfig.stripe.key) throw httpErr(503, 'Stripe is not set up.');
  const body = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : undefined;
  const res = await fetch(billingConfig.stripe.api + p, {
    method, body,
    headers: { authorization: `Bearer ${billingConfig.stripe.key}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpErr(502, `Payment provider error: ${data.error?.message || res.status}`);
  return data;
}

async function stripeCheckout(user, plan, interval, seats, price, meta) {
  const base = billingConfig.publicUrl;
  const s = await stripeApi('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer_email: user.email,
    client_reference_id: meta.arzio_subscription,
    'line_items[0][quantity]': seats,
    'line_items[0][price_data][currency]': price.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': price.grossUnit,
    'line_items[0][price_data][recurring][interval]': interval,
    'line_items[0][price_data][product_data][name]': `${config.serviceName} ${plan.name}`,
    'subscription_data[metadata][arzio_subscription]': meta.arzio_subscription,
    'metadata[arzio_subscription]': meta.arzio_subscription,
    automatic_tax: 'false',
    success_url: `${base}/?billing=success`,
    cancel_url: `${base}/?billing=cancelled`,
  });
  return { url: s.url, checkoutRef: s.id };
}

export function verifyStripe(rawBody, header, secret = billingConfig.stripe.webhookSecret, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = String(header).split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

function firstSeen(provider, id) {
  if (!id) return true;
  try { db.prepare('INSERT INTO webhook_events (provider, event_id) VALUES (?, ?)').run(provider, id); return true; } catch { return false; }
}

const pendingSub = (id) => db.prepare("SELECT * FROM subscriptions WHERE id = ? AND status IN ('pending', 'active', 'past_due')").get(Number(id));
const subByRef = (provider, ref) => db.prepare("SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ? ORDER BY id DESC LIMIT 1").get(provider, ref);

function promote(sub, providerRef) {
  if (sub.status !== 'pending') {
    if (providerRef && !sub.provider_ref) db.prepare('UPDATE subscriptions SET provider_ref = ? WHERE id = ?').run(providerRef, sub.id);
    return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id);
  }
  const scope = sub.org_id ? { orgId: sub.org_id } : { userId: sub.user_id };
  const plan = getPlan(sub.plan_id);
  // Replace the pending row with a live one (cancels any previous plan)
  db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE id = ?").run(sub.id);
  const live = activate(scope, plan, { interval: sub.interval, seats: sub.seats, provider: sub.provider, providerRef });
  db.prepare('UPDATE subscriptions SET checkout_ref = ? WHERE id = ?').run(sub.checkout_ref, live.id);
  audit(sub.user_id || null, 'billing.plan.change', { plan: plan.code, provider: sub.provider, org: sub.org_id });
  return live;
}

export function handleStripeEvent(evt) {
  if (!firstSeen('stripe', evt.id)) return { duplicate: true };
  const o = evt.data?.object || {};
  switch (evt.type) {
    case 'checkout.session.completed': {
      const sub = pendingSub(o.metadata?.arzio_subscription || o.client_reference_id);
      if (sub) promote(sub, o.subscription);
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      let sub = o.subscription && subByRef('stripe', o.subscription);
      const metaId = o.subscription_details?.metadata?.arzio_subscription || o.lines?.data?.[0]?.metadata?.arzio_subscription;
      if (!sub && metaId) { const p = pendingSub(metaId); if (p) sub = promote(p, o.subscription); }
      if (sub) {
        const line = o.lines?.data?.[0]?.period;
        recordPayment(sub, { amount: o.amount_paid, providerRef: o.id, periodStart: line?.start ? new Date(line.start * 1000).toISOString() : undefined, periodEnd: line?.end ? new Date(line.end * 1000).toISOString() : undefined });
      }
      break;
    }
    case 'invoice.payment_failed': {
      const sub = o.subscription && subByRef('stripe', o.subscription);
      if (sub) db.prepare("UPDATE subscriptions SET status = 'past_due', past_due_since = COALESCE(past_due_since, datetime('now')) WHERE id = ?").run(sub.id);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = subByRef('stripe', o.id);
      if (sub && sub.status !== 'canceled') endSubscription(sub);
      break;
    }
    default: return { ignored: true };
  }
  return { ok: true };
}

// ------------------------------------------------------------ Razorpay
async function razorpayApi(method, p, body) {
  const { keyId, keySecret, api } = billingConfig.razorpay;
  if (!keyId || !keySecret) throw httpErr(503, 'Razorpay is not set up.');
  const res = await fetch(api + p, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpErr(502, `Payment provider error: ${data.error?.description || res.status}`);
  return data;
}

async function razorpayPlanId(plan, interval, unit) {
  const row = db.prepare('SELECT ref FROM provider_plans WHERE provider = ? AND plan_id = ? AND interval = ? AND amount = ?').get('razorpay', plan.id, interval, unit);
  if (row) return row.ref;
  const p = await razorpayApi('POST', '/v1/plans', {
    period: interval === 'year' ? 'yearly' : 'monthly', interval: 1,
    item: { name: `${config.serviceName} ${plan.name}`, amount: unit, currency: billingConfig.currency },
  });
  db.prepare('INSERT OR REPLACE INTO provider_plans (provider, plan_id, interval, amount, ref) VALUES (?, ?, ?, ?, ?)').run('razorpay', plan.id, interval, unit, p.id);
  return p.id;
}

async function razorpayCheckout(user, plan, interval, seats, price, meta) {
  const planId = await razorpayPlanId(plan, interval, price.grossUnit);
  const s = await razorpayApi('POST', '/v1/subscriptions', {
    plan_id: planId, quantity: seats, total_count: interval === 'year' ? 10 : 120, customer_notify: 1,
    notes: { ...meta, email: user.email },
  });
  return { url: s.short_url, checkoutRef: s.id, providerRef: s.id };
}

export function verifyRazorpay(rawBody, signature, secret = billingConfig.razorpay.webhookSecret) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function handleRazorpayEvent(evt, eventId) {
  if (!firstSeen('razorpay', eventId)) return { duplicate: true };
  const s = evt.payload?.subscription?.entity || {};
  const pay = evt.payload?.payment?.entity;
  let sub = s.id && subByRef('razorpay', s.id);
  if (sub?.status === 'canceled' && s.notes?.arzio_subscription) sub = pendingSub(s.notes.arzio_subscription) || sub;
  if (!sub && s.notes?.arzio_subscription) sub = pendingSub(s.notes.arzio_subscription);
  if (!sub) return { ignored: true };
  const end = s.current_end ? new Date(s.current_end * 1000).toISOString() : undefined;
  const start = s.current_start ? new Date(s.current_start * 1000).toISOString() : undefined;
  switch (evt.event) {
    case 'subscription.authenticated':
      break;
    case 'subscription.activated':
      sub = promote(sub, s.id);
      if (end) db.prepare('UPDATE subscriptions SET current_period_end = ? WHERE id = ?').run(end, sub.id);
      break;
    case 'subscription.charged':
      sub = promote(sub, s.id);
      recordPayment(sub, { amount: pay?.amount, providerRef: pay?.id, periodStart: start, periodEnd: end });
      break;
    case 'subscription.pending':
    case 'subscription.halted':
      db.prepare("UPDATE subscriptions SET status = 'past_due', past_due_since = COALESCE(past_due_since, datetime('now')) WHERE id = ?").run(sub.id);
      break;
    case 'subscription.cancelled':
    case 'subscription.completed':
      if (sub.status !== 'canceled') endSubscription(sub);
      break;
    default: return { ignored: true };
  }
  return { ok: true };
}

async function cancelAtProvider(sub, { immediately }) {
  if (!sub.provider_ref) return;
  if (sub.provider === 'stripe') {
    if (immediately) await stripeApi('DELETE', `/v1/subscriptions/${sub.provider_ref}`);
    else await stripeApi('POST', `/v1/subscriptions/${sub.provider_ref}`, { cancel_at_period_end: 'true' });
  } else if (sub.provider === 'razorpay') {
    await razorpayApi('POST', `/v1/subscriptions/${sub.provider_ref}/cancel`, { cancel_at_cycle_end: immediately ? 0 : 1 });
  }
}

// ------------------------------------------------------------ operator view
export function revenueReport() {
  const live = db.prepare(`SELECT s.*, p.code, p.name, p.price_month, p.price_year FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active', 'past_due')`).all();
  let mrr = 0;
  const byPlan = {};
  for (const s of live) {
    const monthly = s.interval === 'year' ? s.price_year / 12 : s.price_month;
    mrr += monthly * s.seats;
    byPlan[s.code] = byPlan[s.code] || { plan: s.name, subscriptions: 0, seats: 0 };
    byPlan[s.code].subscriptions++;
    byPlan[s.code].seats += s.seats;
  }
  const paid30 = db.prepare("SELECT COALESCE(SUM(total), 0) AS n FROM invoices WHERE status = 'paid' AND created_at >= datetime('now', '-30 days')").get().n;
  const pastDue = live.filter((s) => s.status === 'past_due').length;
  const recent = db.prepare('SELECT id, number, bill_to, total, currency, provider, created_at FROM invoices ORDER BY id DESC LIMIT 20').all();
  return { currency: billingConfig.currency, mrr: Math.round(mrr), collected30d: paid30, pastDue, byPlan: Object.values(byPlan), recentInvoices: recent, providers: { stripe: !!billingConfig.stripe.key, razorpay: !!billingConfig.razorpay.keyId } };
}

const EDITABLE = ['name', 'price_month', 'price_year', 'storage_mb', 'sends_per_day', 'ai_per_day', 'max_users', 'description', 'is_public', 'sort'];
export function updatePlan(code, body) {
  const p = planByCode(code);
  if (!p) throw httpErr(404, 'Plan not found.');
  const sets = []; const args = [];
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    const v = ['name', 'description'].includes(k) ? String(body[k]).slice(0, 200) : Math.round(Number(body[k]));
    if (typeof v === 'number' && (!Number.isFinite(v) || (v < 0 && k !== 'ai_per_day'))) throw httpErr(400, `Bad value for ${k}.`);
    sets.push(`${k} = ?`); args.push(v);
  }
  if (Array.isArray(body.features)) { sets.push('features_json = ?'); args.push(JSON.stringify(body.features.map(String))); }
  if (sets.length) db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...args, p.id);
  return planByCode(code);
}
