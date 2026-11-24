// Arzio Mail web client: a dependency-free single-page app over /api.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  service: null, me: null, folders: [], folderId: null, smart: null, focus: 'focused', q: '',
  messages: [], selectedId: null, offset: 0, composer: null, mailbox: null, mailboxes: [], view: 'mail',
};

// ------------------------------------------------------------ API helper
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(state.mailbox ? { 'x-arzio-mailbox': String(state.mailbox.id) } : {}) },
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
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.email.value, password: f.password.value, code: f.code.value || undefined }) });
    const data = await res.json();
    if (!res.ok) {
      if (data.mfaRequired) { $('#mfa-row').classList.remove('hidden'); f.code.focus(); }
      throw new Error(data.error || 'Sign-in failed.');
    }
    f.reset();
    $('#mfa-row').classList.add('hidden');
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
  loadMailboxes();
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
$$('[data-smart]').forEach((b) => b.addEventListener('click', () => { showMailView(); closeReader(); state.smart = b.dataset.smart; state.q = ''; $('#search-input').value = ''; loadList(); renderFolders(); }));
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
  showMailView();
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
  $('#list-title').textContent = (state.mailbox ? `${state.mailbox.name} \u00B7 ` : '') + (state.q ? `Results for "${state.q}"` : { flagged: 'Flagged', snoozed: 'Snoozed', scheduled: 'Scheduled' }[state.smart] || f?.name || '');
  if (state.smart === 'scheduled') {
    const { items } = await api('/outbox');
    state.messages = [];
    $('#load-more').classList.add('hidden');
    $('#msg-list').innerHTML = items.length ? items.map((it) => `
      <li class="msg" data-outbox="${it.id}">
        <span class="who">To: ${esc(Array.isArray(it.to) ? it.to.join(', ') : it.to)}</span>
        <span class="when">${fmtDate(it.sendAt, true)}</span>
        <span class="subj">${esc(it.subject || '(no subject)')}</span><span></span>
        <span class="snip">${it.scheduled ? '<span class="tag">Scheduled</span>' : '<span class="tag">Sending</span>'}${esc(it.snippet)} <button class="link-btn" data-cancel="${it.id}">Cancel and edit</button></span>
      </li>`).join('') : '<li class="list-empty">No scheduled messages.</li>';
    return;
  }
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  else if (state.smart === 'flagged') params.set('flagged', '1');
  else if (state.smart === 'snoozed') params.set('snoozed', '1');
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
      <span class="snip">${m.snooze_until ? `<span class="tag">\u23F0 ${fmtDate(m.snooze_until)}</span>` : ''}${m.ai_priority === 'high' ? '<span class="tag high">High priority</span>' : ''}${m.ai_needs_reply && f?.role !== 'sent' ? '<span class="tag reply">Needs reply</span>' : ''}${(m.categories || []).map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}${esc(m.snippet)}</span>
    </li>`).join('');
}

$('#msg-list').addEventListener('click', async (e) => {
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    try {
      const { draft } = await api(`/outbox/${cancel.dataset.cancel}/cancel`, { method: 'POST', body: {} });
      loadList();
      openComposer('new', null, { prefill: draftToComposer(draft) });
    } catch (ex) { toast(ex.message); }
    return;
  }
  const li = e.target.closest('.msg[data-id]');
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
      <button class="btn" data-act="snooze">\u23F0 Snooze</button>
      <button class="btn" data-act="more">\u22EF More</button>
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
      case 'snooze': {
        const t = new Date();
        const at = (d, h) => { const x = new Date(t); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x; };
        const nextMon = (() => { const x = at(1, 8); while (x.getDay() !== 1) x.setDate(x.getDate() + 1); return x; })();
        popMenu(btn, [
          ['Later today', new Date(t.getTime() + 3 * 3600e3)],
          ['Tomorrow', at(1, 8)],
          ['This weekend', (() => { const x = at(0, 9); while (x.getDay() !== 6 || x <= t) x.setDate(x.getDate() + 1); return x; })()],
          ['Next week', nextMon],
        ].map(([label, when]) => [`${label} \u00B7 ${fmtDate(when.toISOString(), true)}`, async () => {
          await api(`/messages/${message.id}`, { method: 'PATCH', body: { snooze_until: when.toISOString(), is_read: true } });
          toast(`Snoozed until ${fmtDate(when.toISOString(), true)}.`); afterRemove();
        }]), { datetime: async (when) => {
          await api(`/messages/${message.id}`, { method: 'PATCH', body: { snooze_until: when, is_read: true } });
          toast('Snoozed.'); afterRemove();
        } });
        break;
      }
      case 'more': {
        const inJunk = currentFolder()?.role === 'junk';
        popMenu(btn, [
          [inJunk ? 'Not junk (always trust this sender)' : 'Report junk and block sender', async () => {
            await api(`/messages/${message.id}/report`, { method: 'POST', body: { junk: !inJunk } });
            toast(inJunk ? 'Moved to Inbox. Sender marked safe.' : 'Reported as junk. Sender blocked.'); afterRemove();
          }],
          [`Sweep: archive all from ${message.from_addr}`, async () => {
            const always = confirm('Also archive future messages from this sender automatically?');
            const r = await api('/messages/sweep', { method: 'POST', body: { sender: message.from_addr, action: 'archive', always } });
            toast(`Archived ${r.moved} message(s).`); refresh(); closeReader();
          }],
          [`Sweep: delete all from ${message.from_addr}`, async () => {
            const r = await api('/messages/sweep', { method: 'POST', body: { sender: message.from_addr, action: 'delete' } });
            toast(`Deleted ${r.moved} message(s).`); refresh(); closeReader();
          }],
          ['Create rule from this message', () => openSettings('rules', { from: message.from_addr, subject: message.subject })],
          ['Add sender to contacts', async () => {
            await api('/contacts', { method: 'POST', body: { email: message.from_addr, name: message.from_name } }); toast('Added to contacts.');
          }],
          ['Show message details', () => modal(`<h2>Message details</h2><table>
            <tr><th>Message-ID</th><td><code>${esc(message.message_id || '')}</code></td></tr>
            <tr><th>Spam score</th><td>${message.spam_score ?? 'n/a'}</td></tr>
            <tr><th>Authentication</th><td><code>${esc(message.auth_results || 'internal')}</code></td></tr>
            <tr><th>Size</th><td>${fmtBytes(message.size || 0)}</td></tr></table>
            <div class="actions"><button class="btn" data-close>Close</button></div>`)],
        ]);
        break;
      }
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
      <button class="btn" type="button" data-c="schedule" title="Schedule send">\u{1F552} Later</button>
      <button class="btn" type="button" data-c="attach">\u{1F4CE} Attach</button>
      <button class="btn" type="button" data-c="save">Save draft</button>
      <button class="btn" type="button" data-c="discard">Discard</button>
      <button class="btn" type="button" data-c="templates">Templates</button>
      <span class="sep"></span>
      <button class="btn ai" type="button" data-c="coach">\u2728 Check before sending</button>
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
    <div class="field from-row hidden"><label for="c-from">From</label><select id="c-from" name="from"></select></div>
    <div class="field"><label for="c-to">To</label><input id="c-to" name="to" value="${esc(c.to)}" placeholder="name@example.com"><button class="link-btn" type="button" data-c="show-cc">Cc/Bcc</button></div>
    <div class="field cc-row ${c.cc || c.bcc ? '' : 'hidden'}"><label for="c-cc">Cc</label><input id="c-cc" name="cc" value="${esc(c.cc)}"></div>
    <div class="field cc-row ${c.cc || c.bcc ? '' : 'hidden'}"><label for="c-bcc">Bcc</label><input id="c-bcc" name="bcc" value="${esc(c.bcc)}"></div>
    <div class="field"><label for="c-subject">Subject</label><input id="c-subject" name="subject" value="${esc(c.subject)}"></div>
    <div class="att-list" id="att-list"></div>
    <div id="coach-out"></div>
    <textarea name="text" id="c-text" aria-label="Message body">${esc(c.text)}</textarea>`;
  showPane('composer');
  loadIdentities(c);
  ['#c-to', '#c-cc', '#c-bcc'].forEach((sel) => attachAutocomplete($(sel)));
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
      await submitCompose(c);
    } catch (ex) { toast(ex.message); busy(btn, false); }
  };
}

function composePayload(c, extra = {}) {
  return { from: c.from || undefined, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: c.text, attachments: c.attachments, inReplyTo: c.inReplyTo, references: c.references, draftId: c.draftId, ...extra };
}

async function submitCompose(c, extra = {}) {
  const r = await api('/send', { method: 'POST', body: composePayload(c, extra) });
  state.composer = null;
  closeReader();
  if (r.queued && r.scheduled) toast(`Scheduled for ${fmtDate(r.sendAt, true)}.`);
  else if (r.queued) undoToast(r.outboxId, Math.max(1, Math.round((new Date(r.sendAt) - Date.now()) / 1000)));
  else toast(r.sentRemotely?.length && r.transport === 'log' ? 'Sent (development mode: external mail saved to the outbox folder).' : 'Sent.');
  setTimeout(refresh, r.queued && !r.scheduled ? (new Date(r.sendAt) - Date.now()) + 2500 : 300);
}

// "Sending..." toast with an Undo button for the undo-send window
function undoToast(outboxId, seconds) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.classList.remove('hidden');
  t.classList.add('undo-toast');
  t.innerHTML = `Sending\u2026 <button type="button">Undo</button>`;
  $('button', t).onclick = async () => {
    try {
      const { draft } = await api(`/outbox/${outboxId}/cancel`, { method: 'POST', body: {} });
      t.classList.add('hidden');
      openComposer('new', null, { prefill: draftToComposer(draft) });
      toast('Sending cancelled.');
    } catch (ex) { toast(ex.message); }
  };
  toastTimer = setTimeout(() => { t.classList.add('hidden'); t.classList.remove('undo-toast'); }, seconds * 1000);
}

function draftToComposer(d) {
  const j = (v) => (Array.isArray(v) ? v.join(', ') : v || '');
  return { from: d.from || '', to: j(d.to), cc: j(d.cc), bcc: j(d.bcc), subject: d.subject || '', text: d.text || '', inReplyTo: d.inReplyTo, references: d.references, attachments: d.attachments || [], draftId: d.draftId || null };
}

async function loadIdentities(c) {
  try {
    if (!state.identities) state.identities = (await api('/me/identities')).identities;
    const ids = state.identities;
    const def = c.from || (state.mailbox ? state.mailbox.email : state.me.email);
    if (ids.length > 1) {
      $('.from-row').classList.remove('hidden');
      $('#c-from').innerHTML = ids.map((i) => `<option value="${esc(i.address)}" ${i.address === def ? 'selected' : ''}>${esc(i.name)} &lt;${esc(i.address)}&gt;${i.onBehalf ? ' (on behalf)' : ''}</option>`).join('');
    }
  } catch { /* ignore */ }
}

// Address autocomplete from contacts and the organization directory
function attachAutocomplete(input) {
  if (!input) return;
  let box;
  let items = [];
  let idx = -1;
  const close = () => { box?.remove(); box = null; idx = -1; };
  const currentTerm = () => input.value.split(/[,;]/).pop().trim();
  const pick = (it) => {
    const parts = input.value.split(/[,;]/).slice(0, -1).map((x) => x.trim()).filter(Boolean);
    parts.push(it.name ? `${it.name} <${it.email}>` : it.email);
    input.value = parts.join(', ') + ', ';
    close();
    input.focus();
  };
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const term = currentTerm();
      if (term.length < 1) return close();
      const { suggestions } = await api(`/contacts/suggest?q=${encodeURIComponent(term)}`).catch(() => ({ suggestions: [] }));
      items = suggestions;
      if (!items.length) return close();
      if (!box) { box = document.createElement('div'); box.className = 'suggest'; input.parentElement.appendChild(box); }
      box.style.left = `${input.offsetLeft}px`;
      box.style.top = `${input.offsetTop + input.offsetHeight}px`;
      box.innerHTML = items.map((it, i) => `<div data-i="${i}">${esc(it.name || it.email)}<small>${esc(it.email)}${it.source === 'directory' ? ' \u00B7 Directory' : it.source === 'group' ? ' \u00B7 Group' : ''}</small></div>`).join('');
      box.onmousedown = (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(items[Number(d.dataset.i)]); } };
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (!box) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      $$('div', box).forEach((d, i) => d.classList.toggle('active', i === idx));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && idx >= 0) { e.preventDefault(); pick(items[idx]); } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// Small pop-up menu: items = [[label, fn], ...]; opts.datetime adds a custom date/time picker
function popMenu(anchor, items, opts = {}) {
  $$('.menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map(([label], i) => `<button type="button" data-i="${i}">${esc(label)}</button>`).join('')
    + (opts.datetime ? '<div class="muted small" style="padding:6px 10px 0">Pick a date and time</div><input type="datetime-local"><button type="button" data-custom>Set</button>' : '');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, window.innerWidth - 300)}px`;
  m.style.top = `${r.bottom + 4}px`;
  m.onclick = async (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.custom !== undefined) {
        const v = $('input', m).value;
        if (!v) return;
        m.remove();
        await opts.datetime(new Date(v).toISOString());
      } else { m.remove(); await items[Number(b.dataset.i)][1](); }
    } catch (ex) { toast(ex.message); }
  };
  setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off); } }), 0);
}

function renderAttachments() {
  const c = state.composer;
  $('#att-list').innerHTML = c.attachments.map((a, i) => `<span>\u{1F4CE} ${esc(a.filename)} (${fmtBytes(a.size || 0)}) <button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`).join('');
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { c.attachments.splice(Number(b.dataset.rm), 1); renderAttachments(); }));
}

function syncComposer() {
  const c = state.composer;
  if ($('#c-from') && !$('.from-row').classList.contains('hidden')) c.from = $('#c-from').value;
  c.to = $('#c-to').value; c.cc = $('#c-cc').value; c.bcc = $('#c-bcc').value; c.subject = $('#c-subject').value; c.text = $('#c-text').value;
}

async function composerAction(act, btn) {
  const c = state.composer;
  syncComposer();
  try {
    if (act === 'close') { closeReader(); return; }
    if (act === 'attach') { $('#file-input').click(); return; }
    if (act === 'schedule') {
      const t = new Date();
      const at = (d, h) => { const x = new Date(t); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x; };
      const go = async (when) => { await submitCompose(c, { sendAt: when }); };
      popMenu(btn, [
        [`Tomorrow morning \u00B7 ${fmtDate(at(1, 8).toISOString(), true)}`, () => go(at(1, 8).toISOString())],
        [`Tomorrow afternoon \u00B7 ${fmtDate(at(1, 13).toISOString(), true)}`, () => go(at(1, 13).toISOString())],
        [`Monday morning \u00B7 ${fmtDate((() => { const x = at(1, 8); while (x.getDay() !== 1) x.setDate(x.getDate() + 1); return x; })().toISOString(), true)}`, () => { const x = at(1, 8); while (x.getDay() !== 1) x.setDate(x.getDate() + 1); return go(x.toISOString()); }],
      ], { datetime: go });
      return;
    }
    if (act === 'templates') {
      const { templates } = await api('/templates');
      popMenu(btn, [
        ...templates.map((tp) => [`Insert: ${tp.name}`, () => {
          const t = $('#c-text');
          t.setRangeText(tp.body, t.selectionStart, t.selectionEnd, 'end');
          if (!$('#c-subject').value) $('#c-subject').value = tp.subject;
        }]),
        ['Save this message as a template', async () => {
          const name = prompt('Template name');
          if (!name) return;
          await api('/templates', { method: 'POST', body: { name, subject: $('#c-subject').value, body: $('#c-text').value } });
          toast('Template saved.');
        }],
      ]);
      return;
    }
    if (act === 'coach') {
      busy(btn, true, 'Checking');
      try {
        const cut = quoteIndex(c.text);
        const r = await api('/ai/coach', { method: 'POST', body: { text: cut >= 0 ? c.text.slice(0, cut) : c.text, recipients: c.to } });
        $('#coach-out').innerHTML = `<div class="ai-card coach"><h4>\u2728 ${r.verdict === 'ready' ? 'Looks good to send' : 'Worth a second look'}</h4><p class="small">Tone: ${esc(r.tone)}</p>${r.suggestions.length ? `<ul>${r.suggestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
      } finally { busy(btn, false); }
      return;
    }
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

// ------------------------------------------------------------ settings (tabbed)
const SETTINGS_TABS = [
  ['general', 'General'], ['ooo', 'Automatic replies'], ['rules', 'Rules'], ['junk', 'Junk email'],
  ['templates', 'Templates'], ['accounts', 'Addresses & sharing'], ['security', 'Security'],
];

async function openSettings(tab = 'general', ruleSeed = null) {
  if (typeof tab !== 'string') tab = 'general';
  const u = state.me = (await api('/me')).user;
  const m = modal(`<h2>Settings</h2><div class="tabbar">${SETTINGS_TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div><div id="settings-body"></div>`);
  m.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => openSettings(b.dataset.tab); });
  const body = $('#settings-body', m);
  const footer = '<p class="form-error"></p><div class="actions"><button class="btn" type="button" data-close>Close</button><button class="btn primary">Save</button></div>';
  const fail = (f) => (ex) => { $('.form-error', f).textContent = ex.message; };
  const toLocal = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

  if (tab === 'general') {
    body.innerHTML = `<form>
      <label>Display name<input name="name" value="${esc(u.name)}" required></label>
      <label>Email signature<textarea name="signature" rows="3">${esc(u.signature)}</textarea></label>
      <label class="check"><input type="checkbox" name="ai_enabled" ${u.ai_enabled ? 'checked' : ''}> Use AI features (summaries, drafting, coaching, inbox triage)</label>
      <label class="check"><input type="checkbox" name="focused_inbox" ${u.focused_inbox ? 'checked' : ''}> Focused Inbox (AI sorts newsletters and notifications into Other)</label>
      <div class="row">
        <label>Undo send window<select name="undo_send_seconds">${[0, 5, 10, 20, 30].map((n) => `<option value="${n}" ${u.undo_send_seconds === n ? 'selected' : ''}>${n ? `${n} seconds` : 'Off'}</option>`).join('')}</select></label>
        <label>Empty Deleted Items after<select name="trash_days">${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'Never']].map(([n, l]) => `<option value="${n}" ${u.trash_days === n ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <p class="muted small">AI provider: ${esc(state.service.ai?.provider === 'anthropic' ? `Claude (${state.service.ai.model})` : 'basic built-in')}. Mail is sent to the AI only when a feature runs and is not used for training.</p>
      ${footer}</form>`;
    $('form', body).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/me', { method: 'PATCH', body: { name: f.name.value, signature: f.signature.value, ai_enabled: f.ai_enabled.checked } });
        await api('/me/preferences', { method: 'PATCH', body: { focused_inbox: f.focused_inbox.checked, undo_send_seconds: Number(f.undo_send_seconds.value), trash_days: Number(f.trash_days.value) } });
        state.me = (await api('/me')).user; $('#me-name').textContent = state.me.name; toast('Settings saved.'); closeModal();
      } catch (ex) { fail(f)(ex); }
    };
  }

  if (tab === 'ooo') {
    body.innerHTML = `<form>
      <label class="check"><input type="checkbox" name="ooo_enabled" ${u.ooo_enabled ? 'checked' : ''}> Turn on automatic replies</label>
      <div class="row"><label>Start (optional)<input type="datetime-local" name="ooo_start" value="${toLocal(u.ooo_start)}"></label><label>End (optional)<input type="datetime-local" name="ooo_end" value="${toLocal(u.ooo_end)}"></label></div>
      <label>Subject<input name="ooo_subject" value="${esc(u.ooo_subject)}" placeholder="Automatic reply: (original subject)"></label>
      <label>Message<textarea name="ooo_message" rows="5">${esc(u.ooo_message)}</textarea></label>
      <p class="muted small">Each sender gets one reply every 4 days. Mailing lists and automated mail are skipped.</p>
      ${footer}</form>`;
    $('form', body).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/me/preferences', { method: 'PATCH', body: { ooo_enabled: f.ooo_enabled.checked, ooo_subject: f.ooo_subject.value, ooo_message: f.ooo_message.value,
          ooo_start: f.ooo_start.value ? new Date(f.ooo_start.value).toISOString() : null, ooo_end: f.ooo_end.value ? new Date(f.ooo_end.value).toISOString() : null } });
        toast(f.ooo_enabled.checked ? 'Automatic replies are on.' : 'Automatic replies are off.'); closeModal();
      } catch (ex) { fail(f)(ex); }
    };
  }

  if (tab === 'rules') {
    const { rules } = await api('/rules');
    const folderOpts = state.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    const desc = (r) => `If ${r.conditions.map((c) => c.field === 'has_attachment' ? 'it has an attachment' : `${c.field} ${c.op} "${esc(c.value)}"`).join(' and ')}, then ${r.actions.map((a) => a.type === 'move' ? `move to ${esc(state.folders.find((f) => f.id === Number(a.value))?.name || '?')}` : a.type === 'category' ? `categorize "${esc(a.value)}"` : a.type === 'forward' ? `forward to ${esc(a.value)}` : a.type === 'read' ? 'mark as read' : a.type === 'stop' ? 'stop processing more rules' : a.type).join(', ')}.`;
    body.innerHTML = `${rules.length ? rules.map((r) => `<div class="rule-row"><strong>${esc(r.name)}</strong> ${r.enabled ? '' : '<span class="tag">Off</span>'}<div class="small muted">${desc(r)}</div>
        <button class="link-btn" data-toggle="${r.id}">${r.enabled ? 'Turn off' : 'Turn on'}</button><button class="link-btn" data-del="${r.id}">Delete</button></div>`).join('') : '<p class="muted">No rules yet.</p>'}
      ${rules.length ? '<button class="btn" id="run-rules">Run rules on Inbox now</button>' : ''}
      <h3>New rule</h3>
      <form id="rule-form">
        <label>Name<input name="name" required value="${esc(ruleSeed ? `From ${ruleSeed.from}` : '')}"></label>
        <div class="row"><label>When<select name="field"><option value="from">From</option><option value="subject">Subject</option><option value="to">To or Cc</option><option value="body">Body</option><option value="has_attachment">Has attachment</option></select></label>
        <label>contains<input name="value" value="${esc(ruleSeed?.from || '')}"></label></div>
        <div class="row"><label>Do this<select name="action"><option value="move">Move to folder</option><option value="category">Categorize</option><option value="flag">Flag</option><option value="read">Mark as read</option><option value="forward">Forward to</option><option value="delete">Delete</option></select></label>
        <label>Folder<select name="folder">${folderOpts}</select></label><label>Category / address<input name="actionValue"></label></div>
        <label class="check"><input type="checkbox" name="stop" checked> Stop processing more rules</label>
        <p class="form-error"></p><div class="actions"><button class="btn" type="button" data-close>Close</button><button class="btn primary">Add rule</button></div>
      </form>`;
    body.onclick = async (e) => {
      const t = e.target.closest('[data-toggle],[data-del],#run-rules');
      if (!t) return;
      try {
        if (t.id === 'run-rules') { const r = await api('/rules/run', { method: 'POST', body: {} }); toast(`Checked ${r.processed} message(s).`); refresh(); return; }
        if (t.dataset.del) await api(`/rules/${t.dataset.del}`, { method: 'DELETE' });
        if (t.dataset.toggle) { const r = rules.find((x) => x.id === Number(t.dataset.toggle)); await api(`/rules/${r.id}`, { method: 'PUT', body: { ...r, enabled: !r.enabled } }); }
        openSettings('rules');
      } catch (ex) { toast(ex.message); }
    };
    $('#rule-form', body).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const a = f.action.value;
      const actions = [{ type: a, value: a === 'move' ? f.folder.value : f.actionValue.value }];
      if (f.stop.checked) actions.push({ type: 'stop' });
      try {
        await api('/rules', { method: 'POST', body: { name: f.name.value, conditions: [{ field: f.field.value, op: 'contains', value: f.field.value === 'has_attachment' ? 'true' : f.value.value }], actions } });
        toast('Rule added.'); openSettings('rules');
      } catch (ex) { fail(f)(ex); }
    };
  }

  if (tab === 'junk') {
    const { senders } = await api('/senders');
    const list = (kind) => senders.filter((x) => x.kind === kind).map((x) => `<span class="chip">${esc(x.address)}<button data-del="${x.id}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted small">None</span>';
    body.innerHTML = `<p class="muted">Arzio checks SPF, DKIM and DMARC on incoming mail and scores its content. Likely spam goes to Junk Email.</p>
      <h3>Safe senders (never junk)</h3><div>${list('safe')}</div>
      <h3>Blocked senders (always junk)</h3><div>${list('blocked')}</div>
      <form class="row" style="margin-top:16px"><label>Address or @domain<input name="address" placeholder="name@example.com or @example.com" required></label>
      <label>List<select name="kind"><option value="blocked">Blocked</option><option value="safe">Safe</option></select></label><button class="btn primary">Add</button></form>
      <p class="form-error"></p>`;
    body.onclick = async (e) => { const b = e.target.closest('[data-del]'); if (b) { await api(`/senders/${b.dataset.del}`, { method: 'DELETE' }); openSettings('junk'); } };
    $('form', body).onsubmit = async (e) => { e.preventDefault(); try { await api('/senders', { method: 'POST', body: { address: e.target.address.value, kind: e.target.kind.value } }); openSettings('junk'); } catch (ex) { $('.form-error', body).textContent = ex.message; } };
  }

  if (tab === 'templates') {
    const { templates } = await api('/templates');
    body.innerHTML = `${templates.map((t) => `<div class="rule-row"><strong>${esc(t.name)}</strong><div class="small muted">${esc(t.subject)} · ${esc(t.body.slice(0, 120))}</div><button class="link-btn" data-del="${t.id}">Delete</button></div>`).join('') || '<p class="muted">No templates yet.</p>'}
      <h3>New template</h3><form><label>Name<input name="name" required></label><label>Subject<input name="subject"></label><label>Body<textarea name="body" rows="5"></textarea></label>
      <p class="form-error"></p><div class="actions"><button class="btn" type="button" data-close>Close</button><button class="btn primary">Save template</button></div></form>`;
    body.onclick = async (e) => { const b = e.target.closest('[data-del]'); if (b) { await api(`/templates/${b.dataset.del}`, { method: 'DELETE' }); openSettings('templates'); } };
    $('form', body).onsubmit = async (e) => { e.preventDefault(); const f = e.target; try { await api('/templates', { method: 'POST', body: { name: f.name.value, subject: f.subject.value, body: f.body.value } }); openSettings('templates'); } catch (ex) { fail(f)(ex); } };
  }

  if (tab === 'accounts') {
    const [{ aliases }, { delegates }] = await Promise.all([api('/me/aliases'), api('/me/delegates')]);
    const permLabel = { read: 'Read only', send_on_behalf: 'Read and send on behalf', send_as: 'Read and send as', full: 'Full access' };
    body.innerHTML = `<h3>Your addresses</h3>
      <p><strong>${esc(u.email)}</strong> (primary)</p>
      ${aliases.map((a) => `<span class="chip">${esc(a.address)}${u.org_kind === 'public' ? `<button data-alias="${a.id}">×</button>` : ''}</span>`).join('')}
      ${u.org_kind === 'public' ? `<form class="row" id="alias-form" style="margin-top:8px"><label>Add an alias (up to 5)<span class="addr-input"><input name="username" required><span class="addr-domain">@${esc(state.service.domain)}</span></span></label><button class="btn">Add alias</button></form>` : '<p class="muted small">Your organization admin manages aliases.</p>'}
      <p class="muted small">Tip: you can also use plus addresses like ${esc(u.email.replace('@', '+shopping@'))} without setting anything up.</p>
      <h3>Who can access your mailbox</h3>
      ${delegates.map((d) => `<div class="rule-row">${esc(d.name)} &lt;${esc(d.email)}&gt; · ${permLabel[d.permission]} <button class="link-btn" data-undelegate="${d.id}">Remove</button></div>`).join('') || '<p class="muted small">Nobody else.</p>'}
      <form class="row" id="delegate-form"><label>Person's address<input name="email" required></label>
      <label>Access<select name="permission">${Object.entries(permLabel).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label><button class="btn">Give access</button></form>
      <p class="form-error"></p>`;
    const err = $('.form-error', body);
    body.onclick = async (e) => {
      const b = e.target.closest('[data-alias],[data-undelegate]');
      if (!b) return;
      if (b.dataset.alias) await api(`/me/aliases/${b.dataset.alias}`, { method: 'DELETE' });
      if (b.dataset.undelegate) await api(`/me/delegates/${b.dataset.undelegate}`, { method: 'DELETE' });
      state.identities = null; openSettings('accounts');
    };
    const af = $('#alias-form', body);
    if (af) af.onsubmit = async (e) => { e.preventDefault(); try { await api('/me/aliases', { method: 'POST', body: { username: e.target.username.value } }); state.identities = null; openSettings('accounts'); } catch (ex) { err.textContent = ex.message; } };
    $('#delegate-form', body).onsubmit = async (e) => { e.preventDefault(); try { await api('/me/delegates', { method: 'POST', body: { email: e.target.email.value, permission: e.target.permission.value } }); openSettings('accounts'); } catch (ex) { err.textContent = ex.message; } };
  }

  if (tab === 'security') {
    body.innerHTML = `<h3>Two-step verification</h3>
      ${u.totp_enabled ? `<p>✅ On. You need a code from your authenticator app when you sign in.</p>
        <form id="mfa-off" class="row"><label>Password to turn it off<input type="password" name="password" required></label><button class="btn danger">Turn off</button></form>`
        : `<p class="muted">Protect your account with a code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, and others).</p><button class="btn primary" id="mfa-start">Set up two-step verification</button><div id="mfa-setup"></div>`}
      <h3>Change password</h3>
      <form id="pw-form"><div class="row"><label>Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="newPassword" minlength="8" autocomplete="new-password" required></label></div><button class="btn">Change password</button></form>
      <p class="form-error"></p>`;
    const err = $('.form-error', body);
    const start = $('#mfa-start', body);
    if (start) start.onclick = async () => {
      const r = await api('/me/mfa/setup', { method: 'POST', body: {} });
      $('#mfa-setup', body).innerHTML = `<p>Scan this code with your authenticator app, or enter the key <code>${esc(r.secret)}</code>.</p><img class="qr" src="${r.qr}" alt="QR code">
        <form id="mfa-on" class="row"><label>Code from the app<input name="code" inputmode="numeric" required></label><button class="btn primary">Turn on</button></form>`;
      $('#mfa-on', body).onsubmit = async (e) => { e.preventDefault(); try { await api('/me/mfa/enable', { method: 'POST', body: { code: e.target.code.value } }); toast('Two-step verification is on.'); openSettings('security'); } catch (ex) { err.textContent = ex.message; } };
    };
    const off = $('#mfa-off', body);
    if (off) off.onsubmit = async (e) => { e.preventDefault(); try { await api('/me/mfa/disable', { method: 'POST', body: { password: e.target.password.value } }); toast('Two-step verification is off.'); openSettings('security'); } catch (ex) { err.textContent = ex.message; } };
    $('#pw-form', body).onsubmit = async (e) => { e.preventDefault(); try { await api('/me', { method: 'PATCH', body: { currentPassword: e.target.currentPassword.value, newPassword: e.target.newPassword.value } }); toast('Password changed.'); e.target.reset(); } catch (ex) { err.textContent = ex.message; } };
  }
}

// ------------------------------------------------------------ Ask Arzio (questions over your mailbox)
$('#ask-btn').addEventListener('click', () => {
  const m = modal(`<h2>✨ Ask Arzio</h2><p class="muted">Ask about anything in your mail, for example "When is the board meeting?" or "What did Ravi say about the invoice?"</p>
    <form id="ask-form" class="row"><label>Question<input name="q" required autofocus></label><button class="btn ai">Ask</button></form><div id="ask-out"></div>
    <div class="actions"><button class="btn" data-close>Close</button></div>`);
  $('#ask-form', m).onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    busy(btn, true, 'Thinking');
    try {
      const r = await api('/ai/ask', { method: 'POST', body: { question: e.target.q.value } });
      $('#ask-out', m).innerHTML = `<div class="ai-card"><p>${esc(r.answer)}</p></div>${r.sources.length ? `<div class="sources"><strong class="small">Sources</strong>${r.sources.map((x) => `<a href="#" data-open="${x.id}">${esc(x.subject || '(no subject)')} <span class="muted small">· ${esc(x.from_name || x.from_addr)} · ${fmtDate(x.date)}</span></a>`).join('')}</div>` : ''}`;
      $$('[data-open]', m).forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); closeModal(); showMailView(); openMessage(Number(a.dataset.open)); }; });
    } catch (ex) { toast(ex.message); } finally { busy(btn, false); }
  };
});

// ------------------------------------------------------------ shared and delegated mailboxes
async function loadMailboxes() {
  try { state.mailboxes = (await api('/me/mailboxes')).mailboxes; } catch { state.mailboxes = []; }
  const box = $('#mailbox-switch');
  if (!state.mailboxes.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `<h4>Mailboxes</h4><ul class="folders"><li><button data-mbx="" class="${!state.mailbox ? 'active' : ''}">\u{1F464} ${esc(state.me.email)}</button></li>
    ${state.mailboxes.map((mb) => `<li><button data-mbx="${mb.id}" class="${state.mailbox?.id === mb.id ? 'active' : ''}">${mb.mailbox_type === 'shared' ? '\u{1F465}' : '\u{1F464}'} ${esc(mb.name)}</button></li>`).join('')}</ul>`;
}
$('#mailbox-switch').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mbx]');
  if (!b) return;
  state.mailbox = b.dataset.mbx ? state.mailboxes.find((x) => x.id === Number(b.dataset.mbx)) : null;
  state.folderId = null;
  showMailView();
  await loadMailboxes();
  await loadFolders();
  selectFolder(state.folders.find((f) => f.role === 'inbox').id);
});

// ------------------------------------------------------------ full-page views (People, Calendar, To Do)
const VIEWS = {};
function showMailView() {
  state.view = 'mail';
  $('.layout').classList.remove('full');
  $('#full-pane').classList.add('hidden');
  $$('[data-view]').forEach((b) => b.classList.remove('active'));
}
async function showView(name) {
  state.view = name;
  $('.layout').classList.add('full');
  $('#full-pane').classList.remove('hidden');
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('#folder-list button, [data-smart]').forEach((b) => b.classList.remove('active'));
  $('#sidebar').classList.remove('open');
  try { await VIEWS[name]($('#full-pane')); } catch (ex) { toast(ex.message); }
}
$$('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

VIEWS.people = async (pane, q = '') => {
  const { contacts } = await api(`/contacts?q=${encodeURIComponent(q)}`);
  pane.innerHTML = `<div class="row" style="justify-content:space-between;align-items:center"><h2>People</h2>
      <div><a class="btn" href="/api/contacts.vcf" download>Export vCard</a> <button class="btn primary" id="new-contact">New contact</button></div></div>
    <input id="people-q" placeholder="Search contacts" value="${esc(q)}" style="padding:7px 10px;border:1px solid var(--line);border-radius:4px;width:320px;margin:8px 0 16px">
    <table class="people"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Company</th><th></th></tr></thead><tbody>
    ${contacts.map((c) => `<tr><td>${esc(c.name)}</td><td><a href="#" data-mailto="${esc(c.email)}">${esc(c.email)}</a></td><td>${esc(c.phone)}</td><td>${esc([c.job_title, c.company].filter(Boolean).join(', '))}</td>
      <td><button class="link-btn" data-edit="${c.id}">Edit</button><button class="link-btn" data-del="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No saved contacts. People you email are suggested automatically when you write.</td></tr>'}
    </tbody></table>`;
  let t;
  $('#people-q', pane).oninput = (e) => { clearTimeout(t); t = setTimeout(() => VIEWS.people(pane, e.target.value).then(() => { const i = $('#people-q', pane); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 250); };
  const edit = (c = {}) => {
    const m = modal(`<h2>${c.id ? 'Edit contact' : 'New contact'}</h2><form>
      <div class="row"><label>Name<input name="name" value="${esc(c.name || '')}"></label><label>Email<input name="email" value="${esc(c.email || '')}" required></label></div>
      <div class="row"><label>Phone<input name="phone" value="${esc(c.phone || '')}"></label><label>Company<input name="company" value="${esc(c.company || '')}"></label><label>Job title<input name="job_title" value="${esc(c.job_title || '')}"></label></div>
      <label>Notes<textarea name="notes" rows="3">${esc(c.notes || '')}</textarea></label>
      <p class="form-error"></p><div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
    $('form', m).onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try { await api(c.id ? `/contacts/${c.id}` : '/contacts', { method: c.id ? 'PUT' : 'POST', body }); closeModal(); VIEWS.people(pane); } catch (ex) { $('.form-error', m).textContent = ex.message; }
    };
  };
  $('#new-contact', pane).onclick = () => edit();
  pane.onclick = async (e) => {
    const ed = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    const mail = e.target.closest('[data-mailto]');
    if (ed) edit(contacts.find((c) => c.id === Number(ed.dataset.edit)));
    if (del && confirm('Delete this contact?')) { await api(`/contacts/${del.dataset.del}`, { method: 'DELETE' }); VIEWS.people(pane, q); }
    if (mail) { e.preventDefault(); showMailView(); openComposer('new', null, { prefill: { to: mail.dataset.mailto } }); }
  };
};

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
