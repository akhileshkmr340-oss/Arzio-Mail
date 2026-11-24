// Plans and billing: limits, Stripe and Razorpay checkout through signed
// webhooks, seats, feature gating, cancellation, invoices, operator tools.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arzio-bill-'));
// A fake Stripe and Razorpay API that records calls
const calls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/checkout/sessions') return send({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' });
    if (req.url === '/v1/plans') return send({ id: 'plan_rzp_1' });
    if (req.url === '/v1/subscriptions' && req.method === 'POST') return send({ id: 'sub_rzp_1', short_url: 'https://rzp.test/i/abc' });
    if (req.url.startsWith('/v1/subscriptions/sub_stripe_1') && req.method === 'GET') return send({ id: 'sub_stripe_1', items: { data: [{ id: 'si_1' }] } });
    return send({ ok: true });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;
mock.unref();

Object.assign(process.env, {
  ARZIO_DATA_DIR: dir, ARZIO_DOMAIN: 'arzio.test', ARZIO_ADMIN_EMAILS: 'ops@arzio.test', AI_PROVIDER: 'none', OUTBOUND_TRANSPORT: 'log',
  ARZIO_BILLING: '1', BILLING_CURRENCY: 'INR', BILLING_TAX_PERCENT: '18', BILLING_TAX_NAME: 'GST', BILLING_TRIAL_SEATS: '3',
  STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_BASE: mockBase,
  RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'rzp_secret', RAZORPAY_WEBHOOK_SECRET: 'rzp_whsec', RAZORPAY_API_BASE: mockBase,
});
const { app } = await import('../src/server.js');
const billing = await import('../src/billing.js');

let root; let ops; let mia; let boss;
function client() {
  let cookie = '';
  return async (p, body, method) => {
    const res = await fetch(root + '/api' + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}
const stripeHook = async (evt, secret = 'whsec_test') => {
  const raw = JSON.stringify(evt);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(root + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: raw });
};
const rzpHook = async (evt, id) => {
  const raw = JSON.stringify(evt);
  const sig = crypto.createHmac('sha256', 'rzp_whsec').update(raw).digest('hex');
  return fetch(root + '/webhooks/razorpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': id }, body: raw });
};

before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  ops = client();
  assert.equal((await ops('/auth/signup', { username: 'ops', name: 'Ops', password: 'password123' })).status, 201);
  mia = client();
  assert.equal((await mia('/auth/signup', { username: 'mia', name: 'Mia Ross', password: 'password123' })).status, 201);
  const org = await ops('/admin/orgs', { name: 'Acme', domain: 'acme.test', adminUsername: 'boss', adminName: 'Boss', adminPassword: 'password123', maxUsers: 50 });
  const doms = (await ops(`/org/domains?org=${org.data.orgId}`)).data.domains;
  await ops(`/org/domains/${doms[0].id}/verify?org=${org.data.orgId}`, { force: true });
  boss = client();
  assert.equal((await boss('/auth/login', { email: 'boss@acme.test', password: 'password123' })).status, 200);
});

test('free plan limits apply, including daily AI use', async () => {
  const o = (await mia('/billing')).data;
  assert.equal(o.enabled, true);
  assert.equal(o.plan.code, 'free');
  assert.deepEqual(o.plans.map((p) => p.code), ['free', 'premium']);
  assert.equal((await mia('/me')).data.usage.quota, 5 * 1024 * 1024 * 1024);
  assert.equal((await ops('/admin/plans/free', { ai_per_day: 2 }, 'PUT')).status, 200);
  assert.equal((await mia('/ai/rewrite', { text: 'hi there', style: 'formal' })).status, 200);
  assert.equal((await mia('/ai/rewrite', { text: 'hi there', style: 'formal' })).status, 200);
  const third = await mia('/ai/rewrite', { text: 'hi there', style: 'formal' });
  assert.equal(third.status, 429);
  assert.match(third.data.error, /Upgrade/);
  assert.equal((await mia('/admin/plans/free', { ai_per_day: 99 }, 'PUT')).status, 403, 'only operators edit plans');
});

test('upgrade to Premium with Stripe; webhooks activate and record the invoice', async () => {
  const c = await mia('/billing/checkout', { plan: 'premium', interval: 'month', provider: 'stripe' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.url, 'https://checkout.stripe.test/cs_test_1');
  const call = calls.find((x) => x.url === '/v1/checkout/sessions');
  const params = new URLSearchParams(call.body);
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), String(Math.round(14900 * 1.18)), 'price includes GST');
  assert.equal(params.get('mode'), 'subscription');
  const subId = params.get('metadata[arzio_subscription]');
  assert.equal((await mia('/billing')).data.plan.code, 'free', 'nothing changes before payment');

  assert.equal((await stripeHook({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }, 'wrong')).status, 400, 'signature checked');
  await stripeHook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', subscription: 'sub_stripe_1', metadata: { arzio_subscription: subId } } } });
  const now = Math.floor(Date.now() / 1000);
  const paid = { id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1', subscription: 'sub_stripe_1', amount_paid: 17582, lines: { data: [{ period: { start: now, end: now + 30 * 86400 } }] } } } };
  assert.equal((await stripeHook(paid)).status, 200);
  assert.deepEqual(await (await stripeHook(paid)).json(), { duplicate: true }, 'replays ignored');

  const o = (await mia('/billing')).data;
  assert.equal(o.plan.code, 'premium');
  assert.equal(o.subscription.status, 'active');
  assert.equal(o.invoices.length, 1);
  assert.equal(o.invoices[0].total, 17582);
  assert.equal((await mia('/me')).data.usage.quota, 100 * 1024 * 1024 * 1024);
  assert.equal((await mia('/ai/rewrite', { text: 'hi there', style: 'formal' })).status, 200, 'more AI on Premium');

  const inv = await mia(`/billing/invoices/${o.invoices[0].id}`);
  assert.match(inv.data, /GST \(18%\)/);
  assert.match(inv.data, /Premium/);
  assert.equal((await boss(`/billing/invoices/${o.invoices[0].id}`)).status, 404, 'others cannot see it');
});

test('cancel at period end, then back to Free', async () => {
  const c = await mia('/billing/cancel', {});
  assert.equal(c.status, 200);
  assert.equal(c.data.subscription.cancelAtPeriodEnd, true);
  assert.ok(calls.some((x) => x.url === '/v1/subscriptions/sub_stripe_1' && x.body.includes('cancel_at_period_end=true')));
  assert.equal((await mia('/billing')).data.plan.code, 'premium', 'keeps Premium until the paid period ends');
  billing.runBillingMaintenance(new Date(Date.now() + 40 * 86400e3));
  assert.equal((await mia('/billing')).data.plan.code, 'free');
});

test('organizations: trial seats, gated features, Razorpay per-seat upgrade', async () => {
  const o = (await boss('/org/billing')).data;
  assert.equal(o.plan.code, 'business_basic');
  assert.equal(o.usage.seats, 3);
  assert.ok(o.plans.every((p) => p.audience === 'business'));
  for (const u of ['ann', 'raj']) assert.equal((await boss('/org/users', { username: u, name: u, domain: 'acme.test', password: 'password123' })).status, 201);
  const over = await boss('/org/users', { username: 'lee', name: 'Lee', domain: 'acme.test', password: 'password123' });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /limit of 3 users/);
  const gated = await boss('/org/ediscovery/search', { q: 'x' });
  assert.equal(gated.status, 402);
  assert.equal((await boss('/org/groups', { name: 'Team', username: 'team', domain: 'acme.test', members: ['ann@acme.test'] })).status, 201, 'groups are in Basic');
  assert.equal((await mia('/org/billing')).status, 403);
  assert.equal((await boss('/org/billing/checkout', { plan: 'business_standard', seats: 2 })).status, 400, 'fewer seats than users');

  const c = await boss('/org/billing/checkout', { plan: 'business_standard', interval: 'month', seats: 6 });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.url, 'https://rzp.test/i/abc', 'INR defaults to Razorpay');
  const planCall = JSON.parse(calls.find((x) => x.url === '/v1/plans').body);
  assert.equal(planCall.item.amount, Math.round(35000 * 1.18));
  assert.equal(planCall.period, 'monthly');
  const subCall = JSON.parse(calls.find((x) => x.url === '/v1/subscriptions').body);
  assert.equal(subCall.quantity, 6);
  const now = Math.floor(Date.now() / 1000);
  const evt = { event: 'subscription.charged', payload: {
    subscription: { entity: { id: 'sub_rzp_1', current_start: now, current_end: now + 30 * 86400, notes: subCall.notes } },
    payment: { entity: { id: 'pay_1', amount: 41300 * 6 } } } };
  assert.equal((await rzpHook(evt, 'rzp_evt_1')).status, 200);
  const after = (await boss('/org/billing')).data;
  assert.equal(after.plan.code, 'business_standard');
  assert.equal(after.subscription.seats, 6);
  assert.equal(after.invoices[0].total, 41300 * 6);
  assert.equal((await boss('/org/ediscovery/search', { q: 'x' })).status, 200, 'compliance unlocked');
  assert.equal((await boss('/org/users', { username: 'lee', name: 'Lee', domain: 'acme.test', password: 'password123' })).status, 201);

  const seats = await boss('/org/billing/seats', { seats: 10 }, 'PUT');
  assert.equal(seats.data.subscription.seats, 10);
  assert.ok(calls.some((x) => x.method === 'PATCH' && x.url === '/v1/subscriptions/sub_rzp_1' && JSON.parse(x.body).quantity === 10));

  await rzpHook({ event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_rzp_1' } } } }, 'rzp_evt_2');
  assert.equal((await boss('/org/billing')).data.subscription.status, 'past_due');
  assert.equal((await boss('/org/ediscovery/search', { q: 'x' })).status, 200, 'still works during the grace period');
  billing.runBillingMaintenance(new Date(Date.now() + 8 * 86400e3));
  assert.equal((await boss('/org/billing')).data.plan.code, 'business_basic', 'unpaid past grace: back to the default plan');
});

test('operator: assign a plan by hand and see revenue', async () => {
  const r = await ops('/admin/billing/assign', { userEmail: 'mia@arzio.test', plan: 'premium', interval: 'year', months: 12, paid: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await mia('/billing')).data.plan.code, 'premium');
  const rep = (await ops('/admin/billing')).data;
  assert.equal(rep.mrr, Math.round(149000 / 12));
  assert.ok(rep.recentInvoices.length >= 3);
  assert.equal(rep.providers.razorpay, true);
  assert.equal((await mia('/admin/billing')).status, 403);
});
