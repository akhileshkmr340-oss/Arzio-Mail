// Plans and billing API, plus the payment provider webhooks.
import express from 'express';
import * as billing from '../billing.js';
import { requireAdmin, requireOrgAdmin, httpError } from '../auth.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const noTokens = (req) => { if (req.tokenScopes) throw httpError(403, 'API tokens cannot change billing.'); };

export const billingRoutes = express.Router();

// Personal accounts
billingRoutes.get('/billing', (req, res) => res.json(billing.overview(req.user)));
billingRoutes.post('/billing/checkout', wrap(async (req, res) => {
  noTokens(req);
  res.json(await billing.startCheckout(req.user, { ...(req.body || {}), forOrg: false }));
}));
billingRoutes.post('/billing/cancel', wrap(async (req, res) => { noTokens(req); res.json({ subscription: await billing.cancel(req.user) }); }));

// Organizations
billingRoutes.get('/org/billing', requireOrgAdmin, (req, res) => res.json(billing.overview(req.user, { forOrg: true })));
billingRoutes.post('/org/billing/checkout', requireOrgAdmin, wrap(async (req, res) => {
  noTokens(req);
  res.json(await billing.startCheckout(req.user, { ...(req.body || {}), forOrg: true }));
}));
billingRoutes.put('/org/billing/seats', requireOrgAdmin, wrap(async (req, res) => { noTokens(req); res.json({ subscription: await billing.changeSeats(req.user, req.body?.seats) }); }));
billingRoutes.post('/org/billing/cancel', requireOrgAdmin, wrap(async (req, res) => { noTokens(req); res.json({ subscription: await billing.cancel(req.user, { forOrg: true }) }); }));

// Invoice to print or save as PDF
billingRoutes.get('/billing/invoices/:id', (req, res) => {
  const html = billing.invoiceHtml(req.user, req.params.id);
  if (!html) return res.status(404).json({ error: 'Invoice not found.' });
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type('html').send(html);
});

// Service operator
billingRoutes.get('/admin/billing', requireAdmin, (req, res) => res.json({ ...billing.revenueReport(), plans: billing.listPlans({ all: true }), enabled: billing.billingConfig.enabled }));
billingRoutes.put('/admin/plans/:code', requireAdmin, (req, res) => { noTokens(req); res.json({ plan: billing.updatePlan(req.params.code, req.body || {}) }); });
billingRoutes.post('/admin/billing/assign', requireAdmin, (req, res) => { noTokens(req); res.json({ subscription: billing.assignPlan(req.user, req.body || {}) }); });

// ------------------------------------------------------------ webhooks (raw body, signed)
export const webhooks = express.Router();
webhooks.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!billing.verifyStripe(raw, req.headers['stripe-signature'])) return res.status(400).json({ error: 'Bad signature' });
  try { res.json(billing.handleStripeEvent(JSON.parse(raw))); } catch (e) { console.error('[billing] stripe', e); res.status(500).json({ error: 'Failed' }); }
});
webhooks.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!billing.verifyRazorpay(raw, String(req.headers['x-razorpay-signature'] || ''))) return res.status(400).json({ error: 'Bad signature' });
  try { res.json(billing.handleRazorpayEvent(JSON.parse(raw), req.headers['x-razorpay-event-id'])); } catch (e) { console.error('[billing] razorpay', e); res.status(500).json({ error: 'Failed' }); }
});
