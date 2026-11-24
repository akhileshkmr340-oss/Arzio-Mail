// Arzio AI service. Every client calls the same four operations; the provider
// behind them is pluggable (Claude by default, a local heuristic fallback when
// no API key is configured). Mail content is sent only for the request being
// made and is never stored by Arzio beyond the result shown to the user.
import { config } from '../config.js';
import { anthropicProvider } from './anthropic.js';
import { heuristicProvider } from './heuristic.js';

let provider = heuristicProvider;
if (config.ai.provider === 'anthropic') provider = anthropicProvider(config.ai.model);

export function aiInfo() {
  return { provider: provider.name, model: provider.model || null };
}

const MAX_INPUT_CHARS = 60000;

function formatMessage(m) {
  const to = (m.to || []).map((p) => p.address).join(', ');
  return `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}\nTo: ${to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.text_body || ''}`;
}

function threadText(messages) {
  let text = messages.map(formatMessage).join('\n\n---\n\n');
  // Keep the newest content if a very long thread exceeds the budget
  if (text.length > MAX_INPUT_CHARS) text = '[earlier messages omitted]\n' + text.slice(-MAX_INPUT_CHARS);
  return text;
}

/** Summarize a message or whole thread. Returns { summary, actionItems[] } */
export async function summarize(messages) {
  return provider.summarize(threadText(messages));
}

/**
 * Draft an email.
 * mode 'reply': messages = thread being replied to; mode 'new': messages = []
 * instructions: what the user wants to say; tone: professional | friendly | concise | formal
 */
export async function draft({ messages = [], instructions = '', tone = 'professional', user }) {
  return provider.draft({
    context: messages.length ? threadText(messages) : '',
    instructions: String(instructions).slice(0, 4000),
    tone,
    senderName: user?.name || '',
  });
}

/** Rewrite user text: improve | shorten | formal | friendly */
export async function rewrite({ text, style }) {
  return provider.rewrite({ text: String(text).slice(0, 20000), style });
}

/** Classify an incoming message. Returns { priority, category, needsReply, focused } */
export async function triage(message) {
  return provider.triage(formatMessage(message).slice(0, 8000));
}

/** Coaching: review a draft before sending. Returns { verdict, tone, suggestions[] } */
export async function coach({ text, recipients }) {
  return provider.coach({ text: String(text).slice(0, 20000), recipients: String(recipients || '') });
}

/**
 * Ask your mailbox: answer a question using the user's own messages.
 * sources: messages found by search (most relevant first). Returns { answer, citedIds[] }
 */
export async function ask({ question, sources }) {
  const ctx = sources.map((m) => `[#${m.id}] ${formatMessage(m).slice(0, 3000)}`).join('\n\n---\n\n').slice(0, MAX_INPUT_CHARS);
  return provider.ask({ question: String(question).slice(0, 1000), context: ctx, sources });
}

/** Meeting prep: brief the user before an event using related mail. */
export async function meetingBrief({ event, sources }) {
  const ctx = sources.map((m) => `[#${m.id}] ${formatMessage(m).slice(0, 2500)}`).join('\n\n---\n\n').slice(0, MAX_INPUT_CHARS);
  return provider.meetingBrief({ event, context: ctx, sources });
}
