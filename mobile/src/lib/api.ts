// Talks to the Arzio server's REST API (the same one the web app uses).
// The session from sign-in goes in the X-Arzio-Session header.
import { storage } from './storage';

export type Person = { address: string; name: string };
export type Folder = { id: number; name: string; role: string | null; unread: number; total: number };
export type MessageSummary = {
  id: number; folder_id: number; thread_id: string; from_addr: string; from_name: string; to: Person[];
  subject: string; snippet: string; date: string; is_read: boolean; is_flagged: boolean; is_pinned: boolean;
  is_focused: boolean; has_attachments: boolean; ai_priority?: string | null; ai_needs_reply?: boolean | null;
};
export type Attachment = { id: number; filename: string; content_type: string; size: number };
export type Message = MessageSummary & {
  cc: Person[]; bcc: Person[]; text_body: string; html_body: string; message_id: string | null; refs: string | null;
  attachments: Attachment[]; ai_summary?: string | null;
  calendar?: { method: string; eventId: number; title?: string; start_at?: string; response?: string | null; removed?: boolean; stale?: boolean } | null;
};
export type Attendee = { email: string; name: string; status: string };
export type CalendarEvent = {
  id: number; title: string; location: string; description: string; start_at: string; end_at: string; all_day: boolean;
  recurrence: string; organizer_email: string; organizer_name: string; attendees: Attendee[]; my_status: string; online_url: string;
  occurrence?: string;
};
export type Task = { id: number; title: string; notes: string; list_name: string; due_at: string | null; important: boolean; completed_at: string | null };
export type Me = { user: { id: number; email: string; name: string; ooo_enabled?: number | boolean; ooo_message?: string; signature?: string; totp_enabled?: number | boolean };
  usage: { bytes: number; quota: number }; plan: { name: string } | null };

export class ApiError extends Error {
  status: number;
  mfaRequired: boolean;
  constructor(message: string, status: number, mfaRequired = false) { super(message); this.status = status; this.mfaRequired = mfaRequired; }
}

let server = '';
let session = '';
let onSignedOut: (() => void) | null = null;

export async function loadSession() {
  server = (await storage.get('server')) || '';
  session = (await storage.get('session')) || '';
  return { server, session };
}
export const currentServer = () => server;
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

export function normalizeServer(input: string) {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

export async function request<T = any>(path: string, { method, body, auth = true }: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  if (!server) throw new ApiError('Choose your Arzio server first.', 0);
  let res: Response;
  try {
    res = await fetch(`${server}/api${path}`, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(auth && session ? { 'x-arzio-session': session } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth && session && !data.mfaRequired) {
    session = '';
    await storage.remove('session');
    onSignedOut?.();
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, !!data.mfaRequired);
  return data as T;
}

export async function signIn(serverInput: string, email: string, password: string, code?: string, device?: string) {
  server = normalizeServer(serverInput);
  const r = await request<{ session: string }>('/auth/login', { body: { email, password, code: code || undefined, client: 'app', device }, auth: false });
  session = r.session;
  await storage.set('server', server);
  await storage.set('session', session);
}

export async function signOut(pushToken?: string | null) {
  try {
    if (pushToken) await request('/me/push-tokens', { method: 'DELETE', body: { token: pushToken } });
    await request('/auth/logout', { body: {} });
  } catch { /* signed out locally anyway */ }
  session = '';
  await storage.remove('session');
}

/** URL and headers to open an attachment in a web view */
export const attachmentSource = (id: number) => ({ uri: `${server}/api/attachments/${id}`, headers: { 'x-arzio-session': session } });

export const api = {
  me: () => request<Me>('/me'),
  folders: () => request<{ folders: Folder[] }>('/folders').then((r) => r.folders),
  messages: (q: { folder?: number; focus?: string; q?: string; offset?: number; limit?: number; flagged?: boolean }) => {
    const p = new URLSearchParams();
    if (q.folder) p.set('folder', String(q.folder));
    if (q.focus) p.set('focus', q.focus);
    if (q.q) p.set('q', q.q);
    if (q.flagged) p.set('flagged', '1');
    p.set('offset', String(q.offset || 0));
    p.set('limit', String(q.limit || 40));
    return request<{ messages: MessageSummary[] }>(`/messages?${p}`).then((r) => r.messages);
  },
  message: (id: number) => request<{ message: Message }>(`/messages/${id}`).then((r) => r.message),
  update: (id: number, patch: Partial<Pick<MessageSummary, 'is_read' | 'is_flagged' | 'folder_id'>>) => request(`/messages/${id}`, { method: 'PATCH', body: patch }),
  remove: (id: number) => request(`/messages/${id}`, { method: 'DELETE' }),
  send: (m: { to: string; cc?: string; subject: string; text: string; inReplyTo?: string; references?: string; forwardOf?: number; attachments?: { filename: string; contentType: string; contentBase64: string }[] }) =>
    request<{ queued?: boolean; id?: number }>('/send', { body: m }),
  suggest: (q: string) => request<{ suggestions: { email: string; name: string }[] }>(`/contacts/suggest?q=${encodeURIComponent(q)}`).then((r) => r.suggestions || []),
  summarize: (messageId: number) => request<{ summary: string; actionItems?: string[]; note?: string }>('/ai/summarize', { body: { messageId } }),
  draft: (messageId: number | undefined, instructions: string) => request<{ subject: string; body: string }>('/ai/draft', { body: { messageId, instructions } }),
  events: (from: Date, to: Date) => request<{ events: CalendarEvent[] }>(`/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`).then((r) => r.events),
  event: (id: number) => request<{ event: CalendarEvent }>(`/calendar/events/${id}`).then((r) => r.event),
  respond: (id: number, status: 'accepted' | 'tentative' | 'declined') => request(`/calendar/events/${id}/respond`, { body: { status } }),
  tasks: () => request<{ tasks: Task[] }>('/tasks').then((r) => r.tasks),
  addTask: (title: string) => request<{ task: Task }>('/tasks', { body: { title } }),
  updateTask: (id: number, patch: { completed?: boolean; important?: boolean; title?: string }) => request(`/tasks/${id}`, { method: 'PATCH', body: patch }),
  deleteTask: (id: number) => request(`/tasks/${id}`, { method: 'DELETE' }),
  preferences: (patch: Record<string, unknown>) => request('/me/preferences', { method: 'PATCH', body: patch }),
  registerPush: (token: string, platform: string, deviceName: string) => request('/me/push-tokens', { body: { token, platform, deviceName } }),
};
