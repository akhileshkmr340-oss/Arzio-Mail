// Arzio Mail web client: a dependency-free single-page app over /api.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  service: null, me: null, folders: [], folderId: null, smart: null, focus: 'focused', q: '',
  messages: [], selectedId: null, offset: 0, composer: null,
};

// ------------------------------------------------------------ API helper
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') { showAuth(); throw new Error(data.error || 'Please sign in.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span> ${esc(label || 'Working')}`; btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.disabled = false; }
}

function fmtDate(iso, long = false) {
  const d = new Date(iso);
  const now = new Date();
  if (long) return d.toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 86400e3) return d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}
const initials = (name, email) => (name || email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const people = (list) => (list || []).map((p) => p.name || p.address).join(', ');

// ------------------------------------------------------------ auth screens
function showAuth(which = 'login') {
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
  $('#login-form').classList.toggle('hidden', which !== 'login');
  $('#signup-form').classList.toggle('hidden', which !== 'signup');
  $('.signup-link').classList.toggle('hidden', !state.service?.signupOpen);
}

$$('[data-auth]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showAuth(a.dataset.auth); }));

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('.form-error', f);
  err.textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
    f.reset();
    await startApp();
  } catch (ex) { err.textContent = ex.message; }
});

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('.form-error', f);
  err.textContent = '';
  try {
    await api('/auth/signup', { method: 'POST', body: { name: f.name.value, username: f.username.value, password: f.password.value } });
    f.reset();
    await startApp();
    toast('Welcome to Arzio Mail!');
  } catch (ex) { err.textContent = ex.message; }
});

// ------------------------------------------------------------ app start
async function startApp() {
  const { user, usage } = await api('/me');
  state.me = user;
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#avatar-btn').textContent = initials(user.name, user.email);
  $('#me-name').textContent = user.name;
  $('#me-email').textContent = user.email;
  $('#me-org').textContent = user.org_kind === 'private' ? user.org_name : '';
  $('#org-admin-link').classList.toggle('hidden', !(user.role === 'org_admin' && user.org_kind === 'private'));
  $('#service-admin-link').classList.toggle('hidden', !user.is_admin);
  const pct = Math.min(100, (usage.bytes / usage.quota) * 100);
  $('#usage').innerHTML = `${fmtBytes(usage.bytes)} of ${fmtBytes(usage.quota)} used<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>`;
  await loadFolders();
  if (!state.folderId) selectFolder(state.folders.find((f) => f.role === 'inbox').id);
}

async function boot() {
  state.service = await api('/service').catch(() => ({ name: 'Arzio Mail', domain: 'arzio', signupOpen: true, ai: {} }));
  $$('.service-name').forEach((el) => { el.textContent = state.service.name; });
  document.title = state.service.name;
  $('.addr-domain').textContent = `@${state.service.domain}`;
  const ai = state.service.ai || {};
  $('#ai-badge').textContent = ai.provider === 'anthropic' ? '✨ AI: Claude' : '✨ AI: basic';
  try { await startApp(); } catch { showAuth(); }
  setInterval(() => { if (state.me && !document.hidden) refresh(true); }, 30000);
}

// ------------------------------------------------------------ folders
const FOLDER_ICONS = { inbox: '\u{1F4E5}', drafts: '\u{1F4DD}', sent: '\u{1F4E4}', archive: '\u{1F5C4}', junk: '⚠', trash: '\u{1F5D1}' };

async function loadFolders() {
  state.folders = (await api('/folders')).folders;
  renderFolders();
}

function renderFolders() {
  $('#folder-list').innerHTML = state.folders.map((f) => `
    <li><button data-folder="${f.id}" class="${!state.smart && f.id === state.folderId ? 'active' : ''}">
      <span>${FOLDER_ICONS[f.role] || '\u{1F4C1}'} ${esc(f.name)}</span>
      ${f.role === 'drafts' ? (f.total ? `<span class="count">${f.total}</span>` : '') : f.unread ? `<span class="count">${f.unread}</span>` : ''}
    </button></li>`).join('');
  $$('[data-smart]').forEach((b) => b.classList.toggle('active', state.smart === b.dataset.smart));
}

$('#folder-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-folder]');
  if (b) selectFolder(Number(b.dataset.folder));
});
$('#folder-list').addEventListener('contextmenu', async (e) => {
  const b = e.target.closest('[data-folder]');
  const f = b && state.folders.find((x) => x.id === Number(b.dataset.folder));
  if (!f || f.role) return;
  e.preventDefault();
  const name = prompt(`Rename folder "${f.name}" (leave empty to delete it):`, f.name);
  if (name === null) return;
  try {
    if (name.trim()) await api(`/folders/${f.id}`, { method: 'PATCH', body: { name } });
    else if (confirm(`Delete "${f.name}"? Its messages move to Deleted Items.`)) { await api(`/folders/${f.id}`, { method: 'DELETE' }); if (state.folderId === f.id) state.folderId = null; }
    await loadFolders();
    if (!state.folderId) selectFolder(state.folders[0].id);
  } catch (ex) { toast(ex.message); }
});
$$('[data-smart]').forEach((b) => b.addEventListener('click', () => { state.smart = b.dataset.smart; state.q = ''; $('#search-input').value = ''; loadList(); renderFolders(); }));
$('#new-folder-btn').addEventListener('click', async () => {
  const name = prompt('Folder name');
  if (!name) return;
  try { await api('/folders', { method: 'POST', body: { name } }); await loadFolders(); } catch (ex) { toast(ex.message); }
});

// Drag messages onto folders to move them
$('#folder-list').addEventListener('dragover', (e) => { const b = e.target.closest('[data-folder]'); if (b) { e.preventDefault(); b.classList.add('drop-target'); } });
$('#folder-list').addEventListener('dragleave', (e) => { const b = e.target.closest('[data-folder]'); if (b) b.classList.remove('drop-target'); });
$('#folder-list').addEventListener('drop', async (e) => {
  const b = e.target.closest('[data-folder]');
  if (!b) return;
  e.preventDefault();
  b.classList.remove('drop-target');
  const id = Number(e.dataTransfer.getData('text/arzio-id'));
  if (id) { await api('/messages/bulk', { method: 'POST', body: { ids: [id], action: 'move', folder_id: Number(b.dataset.folder) } }); refresh(); }
});

function currentFolder() { return state.folders.find((f) => f.id === state.folderId); }

function selectFolder(id) {
  state.folderId = id;
  state.smart = null;
  state.q = '';
  $('#search-input').value = '';
  state.selectedId = null;
  closeReader();
  renderFolders();
  loadList();
  $('#sidebar').classList.remove('open');
}

// ------------------------------------------------------------ message list
async function loadList(append = false) {
  const f = currentFolder();
  const isInbox = f?.role === 'inbox' && !state.q && !state.smart;
  $('#focus-tabs').classList.toggle('hidden', !isInbox);
  $('#list-title').textContent = state.q ? `Results for "${state.q}"` : state.smart === 'flagged' ? 'Flagged' : f?.name || '';
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  else if (state.smart === 'flagged') params.set('flagged', '1');
  else params.set('folder', state.folderId);
  if (isInbox) params.set('focus', state.focus);
  if (!append) state.offset = 0;
  params.set('offset', state.offset);
  params.set('limit', 50);
  const { messages } = await api(`/messages?${params}`);
  state.messages = append ? [...state.messages, ...messages] : messages;
  $('#load-more').classList.toggle('hidden', messages.length < 50);
  renderList();
}

function renderList() {
  const f = currentFolder();
  const showTo = f && ['sent', 'drafts'].includes(f.role) && !state.q;
  if (!state.messages.length) {
    $('#msg-list').innerHTML = `<li class="list-empty">${state.q ? 'No results.' : 'Nothing here yet.'}</li>`;
    return;
  }
  $('#msg-list').innerHTML = state.messages.map((m) => `
    <li class="msg ${m.is_read ? '' : 'unread'} ${m.id === state.selectedId ? 'selected' : ''}" data-id="${m.id}" draggable="true" tabindex="0">
      <span class="who">${esc(showTo ? `To: ${people(m.to)}` : m.from_name || m.from_addr || '(unknown sender)')}</span>
      <span class="icons">${m.is_pinned ? '\u{1F4CC}' : ''}${m.has_attachments ? '\u{1F4CE}' : ''}${m.is_flagged ? '<span class="flag">⚑</span>' : ''}</span>
      <span class="subj">${esc(m.subject || '(no subject)')}</span>
      <span class="when">${fmtDate(m.date)}</span>
      <span class="snip">${m.ai_priority === 'high' ? '<span class="tag high">High priority</span>' : ''}${m.ai_needs_reply && f?.role !== 'sent' ? '<span class="tag reply">Needs reply</span>' : ''}${(m.categories || []).map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}${esc(m.snippet)}</span>
    </li>`).join('');
}

$('#msg-list').addEventListener('click', (e) => {
  const li = e.target.closest('.msg');
  if (li) openMessage(Number(li.dataset.id));
});
$('#msg-list').addEventListener('keydown', (e) => {
  const li = e.target.closest('.msg');
  if (li && e.key === 'Enter') openMessage(Number(li.dataset.id));
});
$('#msg-list').addEventListener('dragstart', (e) => {
  const li = e.target.closest('.msg');
  if (li) e.dataTransfer.setData('text/arzio-id', li.dataset.id);
});
$('#load-more').addEventListener('click', () => { state.offset += 50; loadList(true); });
$$('#focus-tabs button').forEach((b) => b.addEventListener('click', () => {
  state.focus = b.dataset.focus;
  $$('#focus-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  loadList();
}));

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  state.q = $('#search-input').value.trim();
  state.smart = null;
  closeReader();
  loadList();
  renderFolders();
});

async function refresh(quiet = false) {
  try { await loadFolders(); await loadList(); } catch (e) { if (!quiet) toast(e.message); }
}

// ------------------------------------------------------------ reading pane
function closeReader() {
  $('#reader').classList.add('hidden');
  $('#composer').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  $('#app-view').classList.remove('reading');
}

function showPane(which) {
  $('#empty-state').classList.add('hidden');
  $('#reader').classList.toggle('hidden', which !== 'reader');
  $('#composer').classList.toggle('hidden', which !== 'composer');
  $('#app-view').classList.add('reading');
  $('#read-pane').scrollTop = 0;
}

async function openMessage(id) {
  const listed = state.messages.find((m) => m.id === id);
  const f = currentFolder();
  if (listed && f?.role === 'drafts' && !state.q) return openDraft(id);
  state.selectedId = id;
  const { message } = await api(`/messages/${id}`);
  if (listed && !listed.is_read) { listed.is_read = true; loadFolders(); }
  renderList();
  const { messages: thread } = await api(`/threads/${encodeURIComponent(message.thread_id)}`);
  renderReader(message, thread);
}

function renderReader(message, thread) {
  const r = $('#reader');
  const folderOpts = state.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  r.innerHTML = `
    <div class="toolbar">
      <button class="btn back-btn" data-act="back">← Back</button>
      <button class="btn" data-act="reply">↩ Reply</button>
      <button class="btn" data-act="replyall">↩↩ Reply all</button>
      <button class="btn" data-act="forward">↪ Forward</button>
      <span class="sep"></span>
      <button class="btn" data-act="archive">Archive</button>
      <button class="btn danger" data-act="delete">Delete</button>
      <button class="btn" data-act="junk">Junk</button>
      <select class="btn" data-act="move" aria-label="Move to folder"><option value="">Move to…</option>${folderOpts}</select>
      <span class="sep"></span>
      <button class="btn" data-act="flag">${message.is_flagged ? 'Unflag' : '⚑ Flag'}</button>
      <button class="btn" data-act="pin">${message.is_pinned ? 'Unpin' : '\u{1F4CC} Pin'}</button>
      <button class="btn" data-act="unread">Mark unread</button>
      <button class="btn" data-act="category">Categorize</button>
      <span class="sep"></span>
      <button class="btn ai" data-act="summarize">✨ Summarize</button>
      <button class="btn ai" data-act="aireply">✨ Draft reply</button>
    </div>
    <h1 class="thread-subject">${esc(message.subject || '(no subject)')}</h1>
    <div class="thread-meta">
      ${message.ai_priority === 'high' ? '<span class="tag high">High priority</span>' : ''}
      ${message.ai_category ? `<span class="tag">${esc(message.ai_category)}</span>` : ''}
      ${(message.categories || []).map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}
      ${thread.length > 1 ? `<span class="muted small">${thread.length} messages in this conversation</span>` : ''}
    </div>
    <div id="ai-out">${message.ai_summary ? aiCard({ summary: message.ai_summary, actionItems: [] }, true) : ''}</div>
    ${thread.map((m) => mailItem(m, m.id === message.id || thread.length === 1 || m === thread[thread.length - 1])).join('')}`;
  showPane('reader');
  $$('.mail-item', r).forEach((el) => {
    $('.mail-head', el).addEventListener('click', () => el.classList.toggle('collapsed'));
    const iframe = $('iframe', el);
    if (iframe) {
      const m = thread.find((x) => x.id === Number(el.dataset.id));
      loadHtmlFrame(iframe, m.html_body);
    }
  });
  r.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b && b.tagName !== 'SELECT') readerAction(b.dataset.act, message, thread, b);
  };
  $('[data-act="move"]', r).onchange = async (e) => {
    if (!e.target.value) return;
    await api('/messages/bulk', { method: 'POST', body: { ids: [message.id], action: 'move', folder_id: Number(e.target.value) } });
    toast('Moved.');
    afterRemove();
  };
}

function mailItem(m, open) {
  const atts = (m.attachments || []).map((a) => `<a class="attachment" href="/api/attachments/${a.id}">\u{1F4CE} ${esc(a.filename)} <span class="muted">(${fmtBytes(a.size)})</span></a>`).join('');
  return `
    <div class="mail-item ${open ? '' : 'collapsed'}" data-id="${m.id}">
      <div class="mail-head">
        <span class="avatar">${esc(initials(m.from_name, m.from_addr))}</span>
        <div>
          <div class="from">${esc(m.from_name || m.from_addr)} <span class="muted small">&lt;${esc(m.from_addr)}&gt;</span></div>
          <div class="to">To: ${esc(people(m.to))}${m.cc?.length ? ` · Cc: ${esc(people(m.cc))}` : ''}</div>
        </div>
        <span class="date">${fmtDate(m.date, true)}</span>
      </div>
      <div class="mail-body">
        ${m.html_body ? '<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Message content"></iframe>' : `<pre>${esc(m.text_body)}</pre>`}
        ${atts ? `<div class="attachments">${atts}</div>` : ''}
      </div>
    </div>`;
}

// HTML mail renders in a sandboxed iframe: no scripts, links open in a new tab.
function loadHtmlFrame(iframe, html) {
  iframe.srcdoc = `<!DOCTYPE html><html><head><base target="_blank"><meta charset="utf-8"><style>body{font-family:Segoe UI,system-ui,sans-serif;font-size:14px;margin:0;color:#242424;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  iframe.onload = () => {
    try { iframe.style.height = `${iframe.contentDocument.documentElement.scrollHeight + 10}px`; } catch { iframe.style.height = '400px'; }
  };
}

function aiCard(r, cached = false) {
  const items = (r.actionItems || []).length ? `<ul>${r.actionItems.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '';
  return `<div class="ai-card"><h4>✨ ${cached ? 'AI summary' : 'Summary by Arzio AI'}</h4><p>${esc(r.summary)}</p>${items ? `<strong class="small">Action items</strong>${items}` : ''}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}</div>`;
}

function afterRemove() {
  state.messages = state.messages.filter((m) => m.id !== state.selectedId);
  state.selectedId = null;
  renderList();
  closeReader();
  loadFolders();
}

async function readerAction(act, message, thread, btn) {
  try {
    switch (act) {
      case 'back': closeReader(); break;
      case 'reply': case 'replyall': case 'forward': openComposer(act, message); break;
      case 'archive': case 'junk':
        await api('/messages/bulk', { method: 'POST', body: { ids: [message.id], action: act } });
        toast(act === 'archive' ? 'Archived.' : 'Moved to Junk Email.'); afterRemove(); break;
      case 'delete':
        await api(`/messages/${message.id}`, { method: 'DELETE' });
        toast(currentFolder()?.role === 'trash' ? 'Permanently deleted.' : 'Moved to Deleted Items.'); afterRemove(); break;
      case 'flag': case 'pin': {
        const key = act === 'flag' ? 'is_flagged' : 'is_pinned';
        const { message: m } = await api(`/messages/${message.id}`, { method: 'PATCH', body: { [key]: !message[key] } });
        Object.assign(state.messages.find((x) => x.id === m.id) || {}, { [key]: m[key] });
        renderList(); renderReader(m, thread); break;
      }
      case 'unread':
        await api(`/messages/${message.id}`, { method: 'PATCH', body: { is_read: false } });
        Object.assign(state.messages.find((x) => x.id === message.id) || {}, { is_read: false });
        state.selectedId = null; renderList(); closeReader(); loadFolders(); break;
      case 'category': {
        const v = prompt('Categories (comma separated), e.g. Work, Family, Bills:', (message.categories || []).join(', '));
        if (v === null) return;
        const cats = v.split(',').map((s) => s.trim()).filter(Boolean);
        const { message: m } = await api(`/messages/${message.id}`, { method: 'PATCH', body: { categories: cats } });
        Object.assign(state.messages.find((x) => x.id === m.id) || {}, { categories: m.categories });
        renderList(); renderReader(m, thread); break;
      }
      case 'summarize': {
        busy(btn, true, 'Summarizing');
        try {
          const r = await api('/ai/summarize', { method: 'POST', body: { messageId: message.id } });
          $('#ai-out').innerHTML = aiCard(r);
        } finally { busy(btn, false); }
        break;
      }
      case 'aireply': openComposer('reply', message, { ai: true }); break;
      default:
    }
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------ composer
function quote(m) {
  const body = (m.text_body || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\n\nOn ${fmtDate(m.date, true)}, ${m.from_name || m.from_addr} wrote:\n${body}`;
}
// Where the quoted original starts in a reply ("On <date>, <name> wrote:")
const quoteIndex = (text) => text.search(/\n*(On [^\n]+ wrote:|---------- Forwarded message ----------)\n/);
const fmtAddr = (p) => (p.name ? `${p.name} <${p.address}>` : p.address);

function openComposer(mode, m, opts = {}) {
  const me = state.me.email;
  let c = { mode, to: '', cc: '', bcc: '', subject: '', text: '', inReplyTo: null, references: null, replyTo: m?.id || null, attachments: [], draftId: null };
  if (m && (mode === 'reply' || mode === 'replyall')) {
    const sentByMe = m.from_addr === me;
    const primary = sentByMe ? m.to : [{ address: m.from_addr, name: m.from_name }];
    c.to = primary.map(fmtAddr).join(', ');
    if (mode === 'replyall') {
      const others = [...(sentByMe ? [] : m.to || []), ...(m.cc || [])].filter((p) => p.address !== me && !primary.some((x) => x.address === p.address));
      c.cc = others.map(fmtAddr).join(', ');
    }
    c.subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
    c.text = quote(m);
    c.inReplyTo = m.message_id;
    c.references = [m.refs, m.message_id].filter(Boolean).join(' ');
  } else if (m && mode === 'forward') {
    c.subject = /^fw[d]?:/i.test(m.subject) ? m.subject : `Fw: ${m.subject}`;
    c.text = `\n\n\n---------- Forwarded message ----------\nFrom: ${fmtAddr({ name: m.from_name, address: m.from_addr })}\nDate: ${fmtDate(m.date, true)}\nSubject: ${m.subject}\nTo: ${people(m.to)}\n\n${m.text_body || ''}`;
  }
  Object.assign(c, opts.prefill || {});
  state.composer = c;
  renderComposer(opts.ai);
}

async function openDraft(id) {
  const { message: d } = await api(`/messages/${id}`);
  state.selectedId = id;
  renderList();
  state.composer = {
    mode: 'new', to: (d.to || []).map(fmtAddr).join(', '), cc: (d.cc || []).map(fmtAddr).join(', '), bcc: (d.bcc || []).map(fmtAddr).join(', '),
    subject: d.subject, text: d.text_body, inReplyTo: d.in_reply_to, references: d.refs, replyTo: null, attachments: [], draftId: d.id,
  };
  renderComposer();
}

function renderComposer(focusAi = false) {
  const c = state.composer;
  const form = $('#composer');
  const isReply = !!c.replyTo && c.mode !== 'forward';
  form.innerHTML = `
    <div class="toolbar">
      <button class="btn back-btn" type="button" data-c="close">←</button>
      <button class="btn primary" type="submit">Send</button>
      <button class="btn" type="button" data-c="attach">\u{1F4CE} Attach</button>
      <button class="btn" type="button" data-c="save">Save draft</button>
      <button class="btn" type="button" data-c="discard">Discard</button>
      <span class="sep"></span>
      <button class="btn ai" type="button" data-c="rw-improve">✨ Improve</button>
      <button class="btn ai" type="button" data-c="rw-shorten">Shorten</button>
      <button class="btn ai" type="button" data-c="rw-formal">More formal</button>
      <button class="btn ai" type="button" data-c="rw-friendly">Friendlier</button>
      <input type="file" multiple hidden id="file-input">
    </div>
    <div class="ai-bar">
      <strong style="color:var(--ai)">✨ ${isReply ? 'Draft a reply' : 'Draft with AI'}</strong>
      <input id="ai-instructions" placeholder="${isReply ? 'e.g. Accept, and suggest Tuesday 3 pm instead' : 'e.g. Invite the team to Friday’s launch lunch'}">
      <select id="ai-tone" aria-label="Tone"><option>professional</option><option>friendly</option><option>concise</option><option>formal</option></select>
      <button class="btn ai" type="button" data-c="ai-draft">Generate</button>
    </div>
    <div class="field"><label for="c-to">To</label><input id="c-to" name="to" value="${esc(c.to)}" placeholder="name@example.com"><button class="link-btn" type="button" data-c="show-cc">Cc/Bcc</button></div>
    <div class="field cc-row ${c.cc || c.bcc ? '' : 'hidden'}"><label for="c-cc">Cc</label><input id="c-cc" name="cc" value="${esc(c.cc)}"></div>
    <div class="field cc-row ${c.cc || c.bcc ? '' : 'hidden'}"><label for="c-bcc">Bcc</label><input id="c-bcc" name="bcc" value="${esc(c.bcc)}"></div>
    <div class="field"><label for="c-subject">Subject</label><input id="c-subject" name="subject" value="${esc(c.subject)}"></div>
    <div class="att-list" id="att-list"></div>
    <textarea name="text" id="c-text" aria-label="Message body">${esc(c.text)}</textarea>`;
  showPane('composer');
  renderAttachments();
  if (focusAi) $('#ai-instructions').focus();
  else if (!c.to) $('#c-to').focus();
  else { const t = $('#c-text'); t.focus(); t.setSelectionRange(0, 0); }

  form.onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (b) composerAction(b.dataset.c, b);
  };
  $('#file-input').onchange = async (e) => {
    for (const file of e.target.files) {
      if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is larger than 20 MB.`); continue; }
      const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
      c.attachments.push({ filename: file.name, contentType: file.type || 'application/octet-stream', contentBase64: b64, size: file.size });
    }
    e.target.value = '';
    renderAttachments();
  };
  $('#ai-instructions').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); composerAction('ai-draft', $('[data-c="ai-draft"]')); } };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    syncComposer();
    busy(btn, true, 'Sending');
    try {
      const r = await api('/send', { method: 'POST', body: { to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: c.text, attachments: c.attachments, inReplyTo: c.inReplyTo, references: c.references, draftId: c.draftId } });
      toast(r.sentRemotely?.length && r.transport === 'log' ? 'Sent (development mode: external mail saved to the outbox folder).' : 'Sent.');
      state.composer = null;
      closeReader();
      refresh();
    } catch (ex) { toast(ex.message); busy(btn, false); }
  };
}

function renderAttachments() {
  const c = state.composer;
  $('#att-list').innerHTML = c.attachments.map((a, i) => `<span>\u{1F4CE} ${esc(a.filename)} (${fmtBytes(a.size || 0)}) <button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`).join('');
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { c.attachments.splice(Number(b.dataset.rm), 1); renderAttachments(); }));
}

function syncComposer() {
  const c = state.composer;
  c.to = $('#c-to').value; c.cc = $('#c-cc').value; c.bcc = $('#c-bcc').value; c.subject = $('#c-subject').value; c.text = $('#c-text').value;
}

async function composerAction(act, btn) {
  const c = state.composer;
  syncComposer();
  try {
    if (act === 'close') { closeReader(); return; }
    if (act === 'attach') { $('#file-input').click(); return; }
    if (act === 'show-cc') { $$('.cc-row').forEach((r) => r.classList.remove('hidden')); $('#c-cc').focus(); return; }
    if (act === 'discard') {
      if (c.draftId) await api(`/messages/${c.draftId}`, { method: 'DELETE' });
      state.composer = null; closeReader(); if (c.draftId) refresh(); return;
    }
    if (act === 'save') {
      const r = await api('/drafts', { method: 'POST', body: { id: c.draftId, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: c.text, inReplyTo: c.inReplyTo, references: c.references } });
      c.draftId = r.id; toast('Draft saved.'); loadFolders(); return;
    }
    if (act === 'ai-draft') {
      busy(btn, true, 'Writing');
      try {
        const r = await api('/ai/draft', { method: 'POST', body: { messageId: c.mode === 'forward' ? null : c.replyTo, instructions: $('#ai-instructions').value, tone: $('#ai-tone').value } });
        const qi = quoteIndex(c.text);
        const quoted = c.replyTo && qi >= 0 ? `\n\n${c.text.slice(qi).replace(/^\n+/, '')}` : '';
        $('#c-text').value = `${r.body}${quoted}`;
        if (!$('#c-subject').value && r.subject) $('#c-subject').value = r.subject;
        toast('Draft ready. Review it before sending.');
      } finally { busy(btn, false); }
      return;
    }
    if (act.startsWith('rw-')) {
      const t = $('#c-text');
      const hasSel = t.selectionEnd > t.selectionStart;
      const cut = quoteIndex(c.text);
      const target = hasSel ? t.value.slice(t.selectionStart, t.selectionEnd) : cut >= 0 ? c.text.slice(0, cut) : c.text;
      if (!target.trim()) { toast('Write something first, or select text to rewrite.'); return; }
      busy(btn, true, 'Rewriting');
      try {
        const r = await api('/ai/rewrite', { method: 'POST', body: { text: target, style: act.slice(3) } });
        if (hasSel) t.setRangeText(r.text, t.selectionStart, t.selectionEnd, 'select');
        else t.value = cut >= 0 ? r.text + c.text.slice(cut) : r.text;
      } finally { busy(btn, false); }
    }
  } catch (e) { toast(e.message); }
}

$('#new-mail-btn').addEventListener('click', () => { state.selectedId = null; renderList(); openComposer('new'); $('#sidebar').classList.remove('open'); });

// ------------------------------------------------------------ menus, settings, admin
$('#nav-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#avatar-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#avatar-dropdown').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#avatar-dropdown').classList.add('hidden'));
$('#settings-btn').addEventListener('click', openSettings);
$('#avatar-dropdown').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'settings') openSettings();
  if (a === 'org-admin') openOrgAdmin();
  if (a === 'service-admin') openServiceAdmin();
  if (a === 'logout') { await api('/auth/logout', { method: 'POST', body: {} }); state.me = null; state.folderId = null; showAuth(); }
});

function modal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
  return $('#modal-body');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openSettings() {
  const u = state.me;
  const m = modal(`
    <h2>Settings</h2>
    <form id="settings-form">
      <label>Display name<input name="name" value="${esc(u.name)}" required></label>
      <label>Email signature<textarea name="signature" rows="3">${esc(u.signature)}</textarea></label>
      <label class="check"><input type="checkbox" name="ai_enabled" ${u.ai_enabled ? 'checked' : ''}> Use AI features (summaries, drafting, inbox triage)</label>
      <p class="muted small">AI provider: ${esc(state.service.ai?.provider === 'anthropic' ? `Claude (${state.service.ai.model})` : 'basic built-in')}. Mail is sent to the AI only when a feature runs and is not used for training.</p>
      <h3>Change password</h3>
      <div class="row"><label>Current password<input type="password" name="currentPassword" autocomplete="current-password"></label>
      <label>New password<input type="password" name="newPassword" minlength="8" autocomplete="new-password"></label></div>
      <p class="form-error"></p>
      <div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
  $('#settings-form', m).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const body = { name: f.name.value, signature: f.signature.value, ai_enabled: f.ai_enabled.checked };
      if (f.newPassword.value) Object.assign(body, { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
      const { user } = await api('/me', { method: 'PATCH', body });
      state.me = user; $('#me-name').textContent = user.name; closeModal(); toast('Settings saved.');
    } catch (ex) { $('.form-error', f).textContent = ex.message; }
  };
}

async function openOrgAdmin() {
  const [{ org }, { users }, { domains }] = await Promise.all([api('/org'), api('/org/users'), api('/org/domains')]);
  const verified = domains.filter((d) => d.verified);
  const m = modal(`
    <h2>${esc(org.name)} · Organization admin</h2>
    <p class="muted">${users.length} of ${org.max_users || '∞'} users</p>
    <h3>Users</h3>
    <table><thead><tr><th>Address</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td><td>${u.role === 'org_admin' ? 'Admin' : 'User'}</td><td>${u.is_disabled ? 'Disabled' : 'Active'}</td>
      <td><button class="link-btn" data-u="${u.id}" data-op="${u.is_disabled ? 'enable' : 'disable'}">${u.is_disabled ? 'Enable' : 'Disable'}</button>
      <button class="link-btn" data-u="${u.id}" data-op="reset">Reset password</button>
      <button class="link-btn" data-u="${u.id}" data-op="${u.role === 'org_admin' ? 'demote' : 'promote'}">${u.role === 'org_admin' ? 'Make user' : 'Make admin'}</button></td></tr>`).join('')}
    </tbody></table>
    <h3>Add user</h3>
    ${verified.length ? `<form id="add-user" class="row">
      <label>Name<input name="name" required></label>
      <label>Username<input name="username" required></label>
      <label>Domain<select name="domain">${verified.map((d) => `<option>${esc(d.name)}</option>`).join('')}</select></label>
      <label>Temporary password<input name="password" type="text" minlength="8" required></label>
      <button class="btn primary">Add</button></form>` : '<p class="muted">Verify a domain below before adding users.</p>'}
    <h3>Domains</h3>
    ${domains.map((d) => `<div style="margin-bottom:14px"><strong>${esc(d.name)}</strong> ${d.verified ? '<span class="tag cat">Verified</span>' : `<span class="tag high">Not verified</span> <button class="btn" data-verify="${d.id}">Check DNS</button>`}
      <table><thead><tr><th>Type</th><th>Host</th><th>Value</th><th>Purpose</th></tr></thead><tbody>${d.dns.map((r) => `<tr><td>${r.type}</td><td><code>${esc(r.host)}</code></td><td><code>${esc(r.value)}</code></td><td>${esc(r.purpose)}</td></tr>`).join('')}</tbody></table></div>`).join('')}
    <form id="add-domain" class="row"><label>Add a domain<input name="name" placeholder="example.com" required></label><button class="btn">Add domain</button></form>
    <p class="form-error"></p>
    <div class="actions"><button class="btn" data-close>Close</button></div>`);
  const err = $('.form-error', m);
  m.onclick = async (e) => {
    const b = e.target.closest('[data-op],[data-verify]');
    if (!b) return;
    try {
      if (b.dataset.verify) { await api(`/org/domains/${b.dataset.verify}/verify`, { method: 'POST', body: {} }); toast('Domain verified.'); return openOrgAdmin(); }
      const op = b.dataset.op;
      const body = op === 'disable' ? { is_disabled: true } : op === 'enable' ? { is_disabled: false } : op === 'promote' ? { role: 'org_admin' } : op === 'demote' ? { role: 'user' } : {};
      if (op === 'reset') { const p = prompt('New temporary password (8+ characters):'); if (!p) return; body.password = p; }
      await api(`/org/users/${b.dataset.u}`, { method: 'PATCH', body });
      openOrgAdmin();
    } catch (ex) { err.textContent = ex.message; }
  };
  const au = $('#add-user', m);
  if (au) au.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api('/org/users', { method: 'POST', body: { name: f.name.value, username: f.username.value, domain: f.domain.value, password: f.password.value } }); toast('User added.'); openOrgAdmin(); } catch (ex) { err.textContent = ex.message; }
  };
  $('#add-domain', m).onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/org/domains', { method: 'POST', body: { name: e.target.name.value } }); openOrgAdmin(); } catch (ex) { err.textContent = ex.message; }
  };
}

async function openServiceAdmin() {
  const { orgs } = await api('/admin/orgs');
  const m = modal(`
    <h2>Service admin</h2>
    <h3>Organizations</h3>
    <table><thead><tr><th>Name</th><th>Type</th><th>Domains</th><th>Users</th></tr></thead><tbody>
    ${orgs.map((o) => `<tr><td>${esc(o.name)}</td><td>${o.kind === 'public' ? 'Public (free signups)' : 'Private'}</td><td>${esc(o.domains || '')}</td><td>${o.users}</td></tr>`).join('')}
    </tbody></table>
    <h3>Create a private organization</h3>
    <form id="new-org">
      <div class="row"><label>Organization name<input name="name" required></label><label>Domain<input name="domain" placeholder="company.com" required></label><label>Max users<input name="maxUsers" type="number" value="50" min="1"></label></div>
      <div class="row"><label>Admin name<input name="adminName" required></label><label>Admin username<input name="adminUsername" required></label><label>Admin password<input name="adminPassword" minlength="8" required></label></div>
      <p class="muted small">The admin signs in as username@domain and adds users after verifying the domain's DNS.</p>
      <p class="form-error"></p>
      <div class="actions"><button class="btn" type="button" data-close>Close</button><button class="btn primary">Create organization</button></div>
    </form>`);
  $('#new-org', m).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/admin/orgs', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
      toast(`Created. Admin: ${r.admin.email}`); openServiceAdmin();
    } catch (ex) { $('.form-error', f).textContent = ex.message; }
  };
}

// Keyboard shortcuts (Outlook-style)
document.addEventListener('keydown', (e) => {
  if (!state.me || e.target.matches('input, textarea, select') || !$('#modal').classList.contains('hidden')) return;
  if (e.key === 'n') { e.preventDefault(); $('#new-mail-btn').click(); }
  if (e.key === '/') { e.preventDefault(); $('#search-input').focus(); }
  if (e.key === 'r' && !$('#reader').classList.contains('hidden')) $('[data-act="reply"]')?.click();
  if (e.key === 'Delete' && !$('#reader').classList.contains('hidden')) $('[data-act="delete"]')?.click();
});

boot();
