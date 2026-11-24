// Built-in fallback used when no AI provider is configured. It keeps every AI
// feature usable (with simpler results) and makes no external calls.

const BULK_HINTS = /unsubscribe|newsletter|no-?reply|noreply|notification|promo|offer|sale|deal|% off|digest|marketing/i;
const URGENT_HINTS = /urgent|asap|immediately|deadline|today|overdue|action required|important/i;
const QUESTION_HINTS = /\?|could you|can you|please (let|send|confirm|reply|review)|let me know|what do you think/i;
const CATEGORIES = [
  ['security', /password|sign-?in|verification code|security alert|2fa|otp/i],
  ['finance', /invoice|payment|receipt|bank|statement|refund|bill|salary|transaction/i],
  ['travel', /flight|booking|hotel|itinerary|boarding|reservation|train/i],
  ['shopping', /order|shipped|delivery|tracking|cart/i],
  ['social', /friend request|followed you|mentioned you|liked your|commented/i],
  ['promotions', /offer|sale|discount|deal|% off|coupon|promo/i],
  ['work', /meeting|project|report|team|review|proposal|client|agenda/i],
];

function sentences(text) {
  return String(text)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l) && !/^\s*(on .+ wrote:|from:|to:|date:|subject:)/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function lastBody(thread) {
  const parts = String(thread).split('\n\n---\n\n');
  const last = parts[parts.length - 1];
  const i = last.indexOf('\n\n');
  return i >= 0 ? last.slice(i + 2) : last;
}

function headerOf(thread, name) {
  const parts = String(thread).split('\n\n---\n\n');
  const m = parts[parts.length - 1].match(new RegExp(`^${name}: (.*)$`, 'mi'));
  return m ? m[1].trim() : '';
}

export const heuristicProvider = {
  name: 'built-in',
  async summarize(thread) {
    const s = sentences(lastBody(thread));
    const actionItems = s.filter((x) => QUESTION_HINTS.test(x) || URGENT_HINTS.test(x)).slice(0, 3);
    return {
      summary: s.slice(0, 3).join(' ') || 'This message has no text content to summarize.',
      actionItems,
      note: 'Basic summary. Connect an AI provider for full AI summaries.',
    };
  },
  async draft({ context, instructions, senderName }) {
    const first = (senderName || '').split(' ')[0];
    if (context) {
      const subject = headerOf(context, 'Subject');
      const from = headerOf(context, 'From').replace(/<.*>/, '').trim().split(' ')[0] || 'there';
      return {
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        body: `Hi ${from},\n\nThank you for your message. ${instructions ? instructions.trim().replace(/([^.!?])$/, '$1.') : '[Your reply here]'}\n\nBest regards,\n${first}`,
      };
    }
    return { subject: '', body: `Hi [name],\n\n${instructions || '[Your message here]'}\n\nBest regards,\n${first}` };
  },
  async rewrite({ text, style }) {
    if (style === 'shorten') return sentences(text).slice(0, Math.max(1, Math.ceil(sentences(text).length / 2))).join(' ');
    return text;
  },
  async triage(message) {
    const from = headerOf(message, 'From');
    const subject = headerOf(message, 'Subject');
    const body = lastBody(message);
    const all = `${from}\n${subject}\n${body}`;
    const bulk = BULK_HINTS.test(from) || /unsubscribe/i.test(body);
    const category = (CATEGORIES.find(([, re]) => re.test(`${subject} ${body.slice(0, 2000)}`)) || ['other'])[0];
    return {
      priority: !bulk && URGENT_HINTS.test(all) ? 'high' : bulk ? 'low' : 'normal',
      category: bulk && category === 'other' ? 'updates' : category,
      needsReply: !bulk && QUESTION_HINTS.test(body),
      focused: !bulk,
    };
  },
};
