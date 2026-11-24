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
const fmtBytes = (b) => (b >= 1073741824 ? `${+(b / 1073741824).toFixed(1)} GB` : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
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
  applyUi();
  loadQuickSteps().then(renderRibbon);
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
  pollNotifications();
  // App shortcuts (installed app) and links: ?compose=1, ?view=calendar|tasks|people
  const qp = new URLSearchParams(location.search);
  if (qp.get('compose')) openComposer('new');
  if (VIEWS[qp.get('view')]) showView(qp.get('view'));
  if (qp.get('billing') === 'success') toast('Payment received. Your plan updates in a moment.');
  if (qp.get('billing') === 'cancelled') toast('Payment cancelled. Your plan has not changed.');
}

async function boot() {
  state.service = await api('/service').catch(() => ({ name: 'Arzio Mail', domain: 'arzio', signupOpen: true, ai: {} }));
  $$('.service-name').forEach((el) => { el.textContent = state.service.name; });
  document.title = state.service.name;
  $('.addr-domain').textContent = `@${state.service.domain}`;
  if (state.service.demo) {
    const d = state.service.demo, note = $('#demo-note');
    note.innerHTML = `<b>Demo.</b> Sign in as <code>${esc(d.email)}</code> with password <code>${esc(d.password)}</code>, or create your own address. Mail stays inside the demo. <button type="button" class="btn small" id="demo-fill">Use demo account</button>`;
    note.classList.remove('hidden');
    $('#demo-fill').addEventListener('click', () => { const f = $('#login-form'); f.email.value = d.email; f.password.value = d.password; f.requestSubmit(); });
  }
  const ai = state.service.ai || {};
  $('#ai-badge').textContent = ai.provider === 'anthropic' ? '✨ AI: Claude' : '✨ AI: basic';
  try { await startApp(); } catch { showAuth(); }
  setInterval(() => { if (state.me && !document.hidden) refresh(true); }, 30000);
  setInterval(() => { if (state.me) pollNotifications(); }, 20000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ------------------------------------------------------------ folders
const FOLDER_ICONS = { inbox: '\u{1F4E5}', drafts: '\u{1F4DD}', sent: '\u{1F4E4}', archive: '\u{1F5C4}', junk: '⚠', trash: '\u{1F5D1}' };

async function loadFolders() {
  state.folders = (await api('/folders')).folders;
  renderFolders();
  renderFavorites();
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
  if (!f) return;
  e.preventDefault();
  const key = `folder:${f.id}`;
  const items = [[(ui().favorites || []).includes(key) ? 'Remove from Favorites' : 'Add to Favorites', () => toggleFavorite(key)],
    ['Mark all as read', async () => { const r = await api(`/messages?folder=${f.id}&unread=1&limit=200`); if (r.messages.length) await api('/messages/bulk', { method: 'POST', body: { ids: r.messages.map((m) => m.id), action: 'read' } }); refresh(); }]];
  if (!f.role) {
    items.push(['Rename', async () => { const name = prompt('Folder name', f.name); if (name?.trim()) { await api(`/folders/${f.id}`, { method: 'PATCH', body: { name } }); await loadFolders(); } }]);
    items.push(['Delete folder', async () => {
      if (!confirm(`Delete "${f.name}"? Its messages move to Deleted Items.`)) return;
      await api(`/folders/${f.id}`, { method: 'DELETE' }); if (state.folderId === f.id) state.folderId = null;
      await loadFolders(); if (!state.folderId) selectFolder(state.folders[0].id);
    }]);
  }
  if (f.role === 'trash' || f.role === 'junk') items.push(['Empty folder', async () => { if (!confirm(`Permanently delete everything in ${f.name}?`)) return; const r = await api(`/messages?folder=${f.id}&limit=200`); for (const m of r.messages) await api(`/messages/${m.id}`, { method: 'DELETE' }); refresh(); }]);
  popMenu(b, items);
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
  $('#list-title').textContent = (state.mailbox ? `${state.mailbox.name} \u00B7 ` : '') + (state.q ? `Results for "${state.q}"` : { flagged: 'Flagged', snoozed: 'Snoozed', scheduled: 'Scheduled', mentions: 'Mentions me' }[state.smart] || f?.name || '');
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
  else if (state.smart === 'mentions') params.set('mentions', '1');
  else params.set('folder', state.folderId);
  if (isInbox) params.set('focus', state.focus);
  if (RB.filter && state.smart !== 'scheduled') params.set('filter', RB.filter);
  if (ui().sort && ui().sort !== 'date') params.set('sort', ui().sort);
  if (!append) state.offset = 0;
  params.set('offset', state.offset);
  params.set('limit', 50);
  const { messages } = await api(`/messages?${params}`);
  state.messages = append ? [...state.messages, ...messages] : messages;
  $('#load-more').classList.toggle('hidden', messages.length < 50);
  const fl = FILTERS.find(([v]) => v === RB.filter);
  $('#filter-chip').classList.toggle('hidden', !fl);
  if (fl) $('#filter-chip').innerHTML = `Filter: ${esc(fl[1])} <button class="link-btn" data-clear-filter aria-label="Clear filter">\u00D7</button>`;
  renderList();
}

function renderList() {
  const f = currentFolder();
  const showTo = f && ['sent', 'drafts'].includes(f.role) && !state.q;
  if (!state.messages.length) {
    $('#msg-list').innerHTML = `<li class="list-empty">${state.q ? 'No results.' : RB.filter ? 'Nothing matches this filter.' : 'Nothing here yet.'}</li>`;
    ribbonSync();
    return;
  }
  $('#msg-list').innerHTML = state.messages.map((m) => `
    <li class="msg ${m.is_read ? '' : 'unread'} ${m.id === state.selectedId || state.multi.has(m.id) ? 'selected' : ''}" data-id="${m.id}" draggable="true" tabindex="0">
      <span class="lavatar" aria-hidden="true">${esc(initials(showTo ? m.to?.[0]?.name : m.from_name, showTo ? m.to?.[0]?.address : m.from_addr))}</span>
      <span class="who">${esc(showTo ? `To: ${people(m.to)}` : m.from_name || m.from_addr || '(unknown sender)')}</span>
      <span class="icons">${m.mentions_me ? '<span class="at" title="You were mentioned">@</span>' : ''}${m.importance === 'high' ? '<span class="imp" title="High importance">!</span>' : m.importance === 'low' ? '<span title="Low importance">↓</span>' : ''}${m.is_pinned ? '\u{1F4CC}' : ''}${m.has_attachments ? '\u{1F4CE}' : ''}${m.is_flagged ? '<span class="flag">⚑</span>' : m.flag_completed_at ? '<span class="done" title="Follow-up complete">✔</span>' : ''}</span>
      <span class="subj">${esc(m.subject || '(no subject)')}</span>
      <span class="when">${fmtDate(m.date)}</span>
      <span class="snip">${m.is_flagged && m.flag_due_at ? dueTag(m.flag_due_at) : ''}${m.snooze_until ? `<span class="tag">\u23F0 ${fmtDate(m.snooze_until)}</span>` : ''}${m.ai_priority === 'high' ? '<span class="tag high">High priority</span>' : ''}${m.ai_needs_reply && f?.role !== 'sent' ? '<span class="tag reply">Needs reply</span>' : ''}${(m.categories || []).map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}${esc(m.snippet)}</span>
    </li>`).join('');
  ribbonSync();
}
function dueTag(iso) {
  const d = new Date(iso); const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400e3);
  const label = days < 0 ? 'Overdue' : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;
  return `<span class="tag due${days < 0 ? ' high' : ''}">\u{1F6A9} ${label}</span>`;
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
  if (!state.multi?.size) $('#empty-state p').textContent = 'Select an item to read';
  if (speech.on) stopReading();
  if (state.current && state.current.message.id !== state.selectedId) state.current = null;
  ribbonSync();
}

function showPane(which) {
  $('#empty-state').classList.add('hidden');
  $('#reader').classList.toggle('hidden', which !== 'reader');
  $('#composer').classList.toggle('hidden', which !== 'composer');
  $('#app-view').classList.add('reading');
  $('#read-pane').scrollTop = 0;
}

async function openMessage(id) {
  state.multi.clear();
  const listed = state.messages.find((m) => m.id === id);
  const f = currentFolder();
  if (listed && f?.role === 'drafts' && !state.q) return openDraft(id);
  state.selectedId = id;
  const { message } = await api(`/messages/${id}`);
  if (listed && !listed.is_read) { listed.is_read = true; loadFolders(); }
  renderList();
  const { messages: all } = await api(`/threads/${encodeURIComponent(message.thread_id)}`);
  const thread = ui().conversations === false ? [message] : all;
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
      <button class="btn dup" data-act="archive">Archive</button>
      <button class="btn danger dup" data-act="delete">Delete</button>
      <button class="btn dup" data-act="junk">Junk</button>
      <select class="btn dup" data-act="move" aria-label="Move to folder"><option value="">Move to…</option>${folderOpts}</select>
      <span class="sep"></span>
      <button class="btn dup" data-act="flag">${message.is_flagged ? 'Unflag' : '⚑ Flag'}</button>
      <button class="btn" data-act="pin">${message.is_pinned ? 'Unpin' : '\u{1F4CC} Pin'}</button>
      <button class="btn dup" data-act="unread">Mark unread</button>
      <button class="btn dup" data-act="category">Categorize</button>
      <button class="btn" data-act="snooze">\u23F0 Snooze</button>
      <button class="btn" data-act="more">\u22EF More</button>
      <span class="sep"></span>
      <button class="btn ai" data-act="summarize">✨ Summarize</button>
      <button class="btn ai" data-act="aireply">✨ Draft reply</button>
      <button class="btn dup" data-act="translate" title="Translate this message">文A Translate</button>
      <button class="btn" data-act="immersive" title="Immersive Reader">\u{1F4D6} Immersive Reader</button>
      <button class="btn" data-act="print" title="Print">\u{1F5A8} Print</button>
    </div>
    ${message.receipt_to ? `<div class="info-bar" id="receipt-bar">${esc(message.from_name || message.from_addr)} asked to be notified when you read this message. <button class="btn small" data-act="receipt-send">Send receipt</button> <button class="link-btn" data-act="receipt-skip">Don't send</button></div>` : ''}
    <h1 class="thread-subject">${esc(message.subject || '(no subject)')}</h1>
    <div class="thread-meta">
      ${message.is_flagged ? (message.flag_due_at ? dueTag(message.flag_due_at) : '<span class="tag due">\u{1F6A9} Flagged</span>') : message.flag_completed_at ? '<span class="tag">✔ Follow-up complete</span>' : ''}
      ${message.importance === 'high' ? '<span class="tag high">! High importance</span>' : message.importance === 'low' ? '<span class="tag">↓ Low importance</span>' : ''}
      ${message.ai_priority === 'high' ? '<span class="tag high">High priority</span>' : ''}
      ${message.ai_category ? `<span class="tag">${esc(message.ai_category)}</span>` : ''}
      ${(message.categories || []).map((c) => `<span class="tag cat">${esc(c)}</span>`).join('')}
      ${thread.length > 1 ? `<span class="muted small">${thread.length} messages in this conversation</span>` : ''}
    </div>
    ${inviteCard(message)}
    <div id="ai-out">${message.ai_summary ? aiCard({ summary: message.ai_summary, actionItems: [] }, true) : ''}</div>
    ${thread.map((m) => mailItem(m, m.id === message.id || thread.length === 1 || m === thread[thread.length - 1])).join('')}`;
  showPane('reader');
  state.current = { message, thread };
  ribbonSync();
  loadReactions(thread);
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
  const atts = (m.attachments || []).filter((a) => !a.inline).map((a) => `<a class="attachment" href="/api/attachments/${a.id}">\u{1F4CE} ${esc(a.filename)} <span class="muted">(${fmtBytes(a.size)})</span></a>`).join('');
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
        <div class="reactions" data-reactions="${m.id}"></div>
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
    if (act.startsWith('rsvp:')) {
      const status = act.slice(5);
      await api(`/calendar/events/${message.calendar.eventId}/respond`, { method: 'POST', body: { status } });
      toast({ accepted: 'Accepted. The organizer has been told.', tentative: 'Tentatively accepted.', declined: 'Declined. The organizer has been told.' }[status]);
      message.calendar.response = status;
      renderReader(message, thread);
      return;
    }
    if (act === 'open-calendar') { showView('calendar', { date: message.calendar.start_at }); return; }
    if (act.startsWith('react:')) {
      const [, id, emoji] = act.split(':');
      const { reactions } = await api(`/messages/${id}/reactions`, { method: 'POST', body: { emoji } });
      renderReactions(Number(id), reactions);
      return;
    }
    if (act.startsWith('react-pick:')) {
      const id = act.slice(11);
      popMenu(btn, REACTIONS.map((em) => [em, () => readerAction(`react:${id}:${em}`, message, thread, btn)]), { grid: true });
      return;
    }
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
      case 'receipt-send': case 'receipt-skip':
        await api(`/messages/${message.id}/receipt`, { method: 'POST', body: { send: act === 'receipt-send' } });
        message.receipt_to = null;
        $('#receipt-bar')?.classList.add('hidden');
        toast(act === 'receipt-send' ? 'Read receipt sent.' : 'No receipt sent.'); break;
      case 'print': printMessage(message, thread); break;
      case 'immersive': openImmersive(message); break;
      case 'translate': {
        const langs = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Arabic', 'Chinese (Simplified)', 'Japanese', 'Portuguese', 'Bengali', 'Tamil', 'Telugu', 'Marathi', 'Urdu'];
        popMenu(btn, langs.map((lang) => [`Translate to ${lang}`, async () => {
          busy(btn, true, 'Translating');
          try {
            const t = await api('/ai/translate', { method: 'POST', body: { messageId: message.id, to: lang } });
            $('#ai-out').innerHTML = `<div class="ai-card translate"><h4>文A Translated to ${esc(t.to)}</h4><p><strong>${esc(t.subject)}</strong></p><p class="pre">${esc(t.text)}</p><button class="link-btn" data-act="untranslate">Show original only</button></div>`;
          } finally { busy(btn, false); }
        }]));
        break;
      }
      case 'untranslate': $('#ai-out').innerHTML = ''; break;
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
          ['Add to To Do', async () => {
            await api('/tasks', { method: 'POST', body: { title: message.subject || '(no subject)', notes: `From ${message.from_name || message.from_addr}`, message_id: message.id } }); toast('Added to To Do.');
          }],
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

// ------------------------------------------------------------ composer (rich text, like Outlook)
const textToHtml = (t) => esc(t).replace(/\r?\n/g, '<br>');

// Mail HTML that goes into the editor is cleaned first: no scripts, handlers, frames or forms.
function cleanForEditor(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,input,button,textarea,select,link,meta,base,svg,math,template,noscript').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith('on') || ((a.name === 'href' || a.name === 'src') && /^(javascript|vbscript):/.test(v)) || (a.name === 'src' && v.startsWith('data:') && !v.startsWith('data:image/'))) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}

function quoteHtml(m, forward) {
  const head = `<b>From:</b> ${esc(fmtAddr({ name: m.from_name, address: m.from_addr }))}<br><b>Sent:</b> ${esc(fmtDate(m.date, true))}<br><b>To:</b> ${esc(people(m.to))}${m.cc?.length ? `<br><b>Cc:</b> ${esc(people(m.cc))}` : ''}<br><b>Subject:</b> ${esc(m.subject || '')}`;
  const original = m.html_body ? cleanForEditor(m.html_body) : textToHtml(m.text_body || '');
  return `<div class="arzio-quote">${forward ? '<p>---------- Forwarded message ----------</p>' : '<hr>'}<p>${head}</p>${original}</div>`;
}
// Plain-text quote (kept for the text/plain part and for the AI)
function quote(m) {
  const body = (m.text_body || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\n\nOn ${fmtDate(m.date, true)}, ${m.from_name || m.from_addr} wrote:\n${body}`;
}
// Where the quoted original starts in a reply ("On <date>, <name> wrote:")
const quoteIndex = (text) => text.search(/\n*(On [^\n]+ wrote:|---------- Forwarded message ----------)\n/);
const fmtAddr = (p) => (p.name ? `${p.name} <${p.address}>` : p.address);
const signatureHtml = () => (state.me?.signature ? `<div class="arzio-signature"><br>-- <br>${textToHtml(state.me.signature)}</div>` : '');

function openComposer(mode, m, opts = {}) {
  const me = state.me.email;
  let c = { mode, to: '', cc: '', bcc: '', subject: '', text: '', html: `<div><br></div>${signatureHtml()}`, quoteHtml: '', inReplyTo: null, references: null, replyTo: m?.id || null, attachments: [], draftId: null, importance: 'normal', readReceipt: false };
  if (m && (mode === 'reply' || mode === 'replyall')) {
    const sentByMe = m.from_addr === me;
    const primary = sentByMe ? m.to : [{ address: m.from_addr, name: m.from_name }];
    c.to = primary.map(fmtAddr).join(', ');
    if (mode === 'replyall') {
      const others = [...(sentByMe ? [] : m.to || []), ...(m.cc || [])].filter((p) => p.address !== me && !primary.some((x) => x.address === p.address));
      c.cc = others.map(fmtAddr).join(', ');
    }
    c.subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
    c.quoteHtml = quoteHtml(m, false);
    c.quoteText = quote(m);
    c.inReplyTo = m.message_id;
    c.references = [m.refs, m.message_id].filter(Boolean).join(' ');
  } else if (m && mode === 'forward') {
    c.subject = /^fw[d]?:/i.test(m.subject) ? m.subject : `Fw: ${m.subject}`;
    c.quoteHtml = quoteHtml(m, true);
    c.quoteText = `\n\n\n---------- Forwarded message ----------\nFrom: ${fmtAddr({ name: m.from_name, address: m.from_addr })}\nDate: ${fmtDate(m.date, true)}\nSubject: ${m.subject}\nTo: ${people(m.to)}\n\n${m.text_body || ''}`;
    c.forwardOf = m.id;
  }
  Object.assign(c, opts.prefill || {});
  if (opts.prefill?.text && !opts.prefill.html) c.html = textToHtml(opts.prefill.text);
  state.composer = c;
  renderComposer(opts.ai);
}

async function openDraft(id) {
  const { message: d } = await api(`/messages/${id}`);
  state.selectedId = id;
  renderList();
  state.composer = {
    mode: 'new', to: (d.to || []).map(fmtAddr).join(', '), cc: (d.cc || []).map(fmtAddr).join(', '), bcc: (d.bcc || []).map(fmtAddr).join(', '),
    subject: d.subject, text: d.text_body, html: d.html_body ? cleanForEditor(d.html_body) : textToHtml(d.text_body || ''), quoteHtml: '',
    inReplyTo: d.in_reply_to, references: d.refs, replyTo: null, attachments: [], draftId: d.id, importance: d.importance || 'normal', readReceipt: false,
  };
  renderComposer();
}

const FONT_SIZES = [['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['6', 'Huge']];
const EMOJI = ['😀', '😂', '😊', '😍', '🙂', '😉', '🤔', '😢', '😮', '👍', '👎', '👏', '🙏', '💪', '🎉', '🔥', '❤️', '✅', '❌', '⭐', '📅', '📎', '☕', '🚀'];

function renderComposer(focusAi = false) {
  const c = state.composer;
  const form = $('#composer');
  const isReply = !!c.replyTo && c.mode !== 'forward';
  form.innerHTML = `
    <div class="toolbar">
      <button class="btn back-btn" type="button" data-c="close">←</button>
      <button class="btn primary" type="submit" title="Send (Ctrl+Enter)">Send</button>
      <button class="btn" type="button" data-c="schedule" title="Schedule send">\u{1F552} Later</button>
      <button class="btn" type="button" data-c="attach">\u{1F4CE} Attach</button>
      <button class="btn" type="button" data-c="save">Save draft</button>
      <button class="btn" type="button" data-c="discard">Discard</button>
      <button class="btn" type="button" data-c="templates">Templates</button>
      <button class="btn" type="button" data-c="options" title="Importance, read receipt">⋯ Options</button>
      <span class="sep"></span>
      <button class="btn ai" type="button" data-c="coach">✨ Check before sending</button>
      <button class="btn ai" type="button" data-c="rw-improve">✨ Improve</button>
      <button class="btn ai" type="button" data-c="rw-shorten">Shorten</button>
      <button class="btn ai" type="button" data-c="rw-formal">More formal</button>
      <button class="btn ai" type="button" data-c="rw-friendly">Friendlier</button>
      <input type="file" multiple hidden id="file-input">
      <input type="file" accept="image/*" hidden id="image-input">
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
    <div class="compose-flags" id="compose-flags"></div>
    <div class="att-list" id="att-list"></div>
    <div id="coach-out"></div>
    <div class="fmt-bar" role="toolbar" aria-label="Formatting">
      <button type="button" data-fmt="bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button type="button" data-fmt="italic" title="Italic (Ctrl+I)"><i>I</i></button>
      <button type="button" data-fmt="underline" title="Underline (Ctrl+U)"><u>U</u></button>
      <button type="button" data-fmt="strikeThrough" title="Strikethrough"><s>S</s></button>
      <select data-fmtsel="fontSize" title="Font size" aria-label="Font size">${FONT_SIZES.map(([v, l]) => `<option value="${v}" ${v === '3' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-fmtsel="fontName" title="Font" aria-label="Font"><option value="Segoe UI">Segoe UI</option><option value="Arial">Arial</option><option value="Calibri">Calibri</option><option value="Georgia">Georgia</option><option value="Times New Roman">Times New Roman</option><option value="Courier New">Courier New</option><option value="Verdana">Verdana</option></select>
      <label class="color-btn" title="Font colour">A<input type="color" data-fmtcolor="foreColor" value="#c50f1f" aria-label="Font colour"></label>
      <label class="color-btn hl" title="Highlight">ab<input type="color" data-fmtcolor="hiliteColor" value="#fff100" aria-label="Highlight colour"></label>
      <span class="sep"></span>
      <button type="button" data-fmt="insertUnorderedList" title="Bullets">• List</button>
      <button type="button" data-fmt="insertOrderedList" title="Numbering">1. List</button>
      <button type="button" data-fmt="outdent" title="Decrease indent">⇤</button>
      <button type="button" data-fmt="indent" title="Increase indent">⇥</button>
      <button type="button" data-fmt="justifyLeft" title="Align left">⯇</button>
      <button type="button" data-fmt="justifyCenter" title="Center">≡</button>
      <button type="button" data-fmt="justifyRight" title="Align right">⯈</button>
      <button type="button" data-fmt="quote" title="Quote">❝</button>
      <span class="sep"></span>
      <button type="button" data-fmt="link" title="Insert link (Ctrl+K)">\u{1F517}</button>
      <button type="button" data-fmt="image" title="Insert picture inline">\u{1F5BC}</button>
      <button type="button" data-fmt="table" title="Insert table">▦</button>
      <button type="button" data-fmt="emoji" title="Emoji">\u{1F60A}</button>
      <button type="button" data-fmt="hr" title="Horizontal line">―</button>
      <button type="button" data-fmt="removeFormat" title="Clear formatting">⌫ Clear</button>
      <button type="button" data-fmt="undo" title="Undo (Ctrl+Z)">↶</button>
      <button type="button" data-fmt="redo" title="Redo (Ctrl+Y)">↷</button>
    </div>
    <div id="c-body" class="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message body" spellcheck="true">${c.html}</div>
    ${c.quoteHtml ? `<div class="quote-wrap"><button class="link-btn" type="button" data-c="show-quote" title="Show the original message">⋯ Show original message</button><div id="c-quote" class="editor quote hidden" contenteditable="true" aria-label="Original message">${c.quoteHtml}</div></div>` : ''}`;
  showPane('composer');
  loadIdentities(c);
  ['#c-to', '#c-cc', '#c-bcc'].forEach((sel) => attachAutocomplete($(sel)));
  renderAttachments();
  renderComposeFlags();
  const bodyEl = $('#c-body');
  try { document.execCommand('styleWithCSS', false, true); } catch { /* old browsers */ }
  if (focusAi) $('#ai-instructions').focus();
  else if (!c.to) $('#c-to').focus();
  else { bodyEl.focus(); const r = document.createRange(); r.setStart(bodyEl, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }

  form.onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (b) composerAction(b.dataset.c, b);
    const f = e.target.closest('[data-fmt]');
    if (f) formatAction(f.dataset.fmt, f);
  };
  // Keep the caret in the editor when a toolbar button is pressed
  $('.fmt-bar', form).onmousedown = (e) => { if (e.target.closest('button')) e.preventDefault(); };
  $$('[data-fmtsel]', form).forEach((s) => { s.onchange = () => { restoreSel(); document.execCommand(s.dataset.fmtsel, false, s.value); bodyEl.focus(); }; });
  $$('[data-fmtcolor]', form).forEach((s) => { s.oninput = () => { restoreSel(); document.execCommand(s.dataset.fmtcolor, false, s.value); }; });
  bodyEl.addEventListener('keyup', saveSel);
  bodyEl.addEventListener('mouseup', saveSel);
  bodyEl.addEventListener('blur', saveSel);
  bodyEl.addEventListener('paste', onEditorPaste);
  bodyEl.addEventListener('drop', onEditorDrop);
  attachMentions(bodyEl);
  $('#file-input').onchange = async (e) => {
    for (const file of e.target.files) {
      if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is larger than 20 MB.`); continue; }
      const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
      c.attachments.push({ filename: file.name, contentType: file.type || 'application/octet-stream', contentBase64: b64, size: file.size });
    }
    e.target.value = '';
    renderAttachments();
  };
  $('#image-input').onchange = async (e) => { for (const file of e.target.files) await insertImageFile(file); e.target.value = ''; };
  $('#ai-instructions').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); composerAction('ai-draft', $('[data-c="ai-draft"]')); } };
  form.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && e.target.closest('.editor')) { e.preventDefault(); formatAction('link'); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    syncComposer();
    if (!c.subject.trim() && !confirm('Send this message without a subject?')) return;
    if (/\battach(ed|ment)?\b/i.test(c.text.slice(0, quoteIndex(c.text) >= 0 ? quoteIndex(c.text) : undefined)) && !c.attachments.length && !c.forwardOf && !confirm('You mention an attachment, but nothing is attached. Send anyway?')) return;
    busy(btn, true, 'Sending');
    try {
      await submitCompose(c);
    } catch (ex) { toast(ex.message); busy(btn, false); }
  };
}

let savedRange = null;
function saveSel() {
  const s = getSelection();
  if (s.rangeCount && $('#c-body')?.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
}
function restoreSel() {
  const body = $('#c-body');
  if (!body) return;
  body.focus();
  if (savedRange && body.contains(savedRange.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
}

async function insertImageFile(file) {
  if (!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(file.type)) { toast('Pictures can be PNG, JPEG, GIF, WebP or BMP.'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Pictures in the message can be up to 5 MB. Attach larger files instead.'); return; }
  const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(file); });
  restoreSel();
  document.execCommand('insertHTML', false, `<img src="${url}" alt="${esc(file.name)}" style="max-width:100%">`);
}
function onEditorPaste(e) {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); saveSel(); files.forEach(insertImageFile); }
}
function onEditorDrop(e) {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    if (f.type.startsWith('image/') && f.size <= 5 * 1024 * 1024) insertImageFile(f);
    else {
      const fr = new FileReader();
      fr.onload = () => { state.composer.attachments.push({ filename: f.name, contentType: f.type || 'application/octet-stream', contentBase64: String(fr.result).split(',')[1], size: f.size }); renderAttachments(); };
      fr.readAsDataURL(f);
    }
  }
}

function formatAction(cmd, btn) {
  const body = $('#c-body');
  if (!body) return;
  restoreSel();
  switch (cmd) {
    case 'link': {
      const sel = getSelection().toString();
      const url = prompt('Link address (https://...)', /^https?:\/\//.test(sel) ? sel : 'https://');
      if (!url || !/^(https?:\/\/|mailto:)/i.test(url)) return;
      restoreSel();
      if (sel) document.execCommand('createLink', false, url);
      else document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`);
      break;
    }
    case 'image': $('#image-input').click(); return;
    case 'quote': document.execCommand('formatBlock', false, 'blockquote'); break;
    case 'hr': document.execCommand('insertHorizontalRule'); break;
    case 'table': {
      const size = prompt('Table size: columns x rows', '3x2');
      if (!size) return;
      const [cols, rws] = size.toLowerCase().split('x').map((v) => Number(v.trim()));
      const n = Math.min(Math.max(cols || 0, 1), 10);
      const rows = Math.min(Math.max(rws || 2, 1), 30);
      const cell = '<td style="border:1px solid #bbb;padding:4px 8px;min-width:60px">&nbsp;</td>';
      restoreSel();
      document.execCommand('insertHTML', false, `<table style="border-collapse:collapse">${`<tr>${cell.repeat(n)}</tr>`.repeat(rows)}</table><br>`);
      break;
    }
    case 'emoji':
      popMenu(btn, EMOJI.map((em) => [em, () => { restoreSel(); document.execCommand('insertText', false, em); }]), { grid: true });
      return;
    default: document.execCommand(cmd);
  }
  saveSel();
}

// @mentions: type @ and a name, pick a person; they are added to To and see "@" in their inbox
function attachMentions(editor) {
  let box = null; let items = []; let idx = 0; let timer;
  const close = () => { box?.remove(); box = null; };
  const termBeforeCaret = () => {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return null;
    const node = s.anchorNode;
    if (!node || node.nodeType !== 3 || !editor.contains(node)) return null;
    const before = node.textContent.slice(0, s.anchorOffset);
    const m = before.match(/(^|[\s(])@([\p{L}\p{N}._-]{1,40})$/u);
    return m ? { node, end: s.anchorOffset, term: m[2] } : null;
  };
  const pick = (it) => {
    const t = termBeforeCaret();
    if (!t) return close();
    const r = document.createRange();
    r.setStart(t.node, t.end - t.term.length - 1); r.setEnd(t.node, t.end);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const first = (it.name || it.email).split(' ')[0];
    document.execCommand('insertHTML', false, `<a href="mailto:${esc(it.email)}" data-mention="${esc(it.email)}" class="mention">@${esc(first)}</a>&nbsp;`);
    const to = $('#c-to');
    const have = to.value.toLowerCase();
    if (!have.includes(it.email.toLowerCase()) && !$('#c-cc').value.toLowerCase().includes(it.email.toLowerCase())) to.value = (to.value.trim().replace(/[,;]\s*$/, '') ? `${to.value.trim().replace(/[,;]\s*$/, '')}, ` : '') + (it.name ? `${it.name} <${it.email}>` : it.email);
    close();
  };
  editor.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const t = termBeforeCaret();
      if (!t) return close();
      const { suggestions } = await api(`/contacts/suggest?q=${encodeURIComponent(t.term)}`).catch(() => ({ suggestions: [] }));
      items = suggestions.filter((x) => x.source !== 'group').slice(0, 8); idx = 0;
      if (!items.length) return close();
      if (!box) { box = document.createElement('div'); box.className = 'suggest mention-box'; document.body.appendChild(box); }
      const rect = getSelection().getRangeAt(0).getBoundingClientRect();
      box.style.left = `${Math.min(rect.left, innerWidth - 280)}px`; box.style.top = `${rect.bottom + 4}px`;
      box.innerHTML = items.map((it, i) => `<div data-i="${i}" class="${i === 0 ? 'active' : ''}">${esc(it.name || it.email)}<small>${esc(it.email)}</small></div>`).join('');
      box.onmousedown = (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(items[Number(d.dataset.i)]); } };
    }, 120);
  });
  editor.addEventListener('keydown', (e) => {
    if (!box) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      $$('div', box).forEach((d, i) => d.classList.toggle('active', i === idx));
    } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[idx]); } else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  editor.addEventListener('blur', () => setTimeout(close, 150));
}

function renderComposeFlags() {
  const c = state.composer;
  const el = $('#compose-flags');
  if (!el) return;
  el.innerHTML = [c.importance === 'high' ? '<span class="tag high">! High importance</span>' : '', c.importance === 'low' ? '<span class="tag">↓ Low importance</span>' : '', c.readReceipt ? '<span class="tag">Read receipt requested</span>' : ''].join('');
}

// The editor without the signature, as plain text (for the AI and the text/plain part)
function bodyText() {
  const clone = $('#c-body').cloneNode(true);
  clone.querySelectorAll('.arzio-signature').forEach((n) => n.remove());
  return clone.innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function setBodyText(text) {
  const body = $('#c-body');
  const sig = body.querySelector('.arzio-signature');
  body.innerHTML = text.split(/\n{2,}/).map((p) => `<div>${textToHtml(p)}</div><div><br></div>`).join('') + (sig ? sig.outerHTML : '');
}

function composePayload(c, extra = {}) {
  const html = `<div class="arzio-body">${c.html}</div>${c.quoteHtml ? `<br>${c.quoteHtml}` : ''}`;
  return { from: c.from || undefined, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: c.text, html, noSignature: true, attachments: c.attachments, inReplyTo: c.inReplyTo, references: c.references, draftId: c.draftId,
    importance: c.importance !== 'normal' ? c.importance : undefined, readReceipt: c.readReceipt || undefined, forwardOf: c.forwardOf || undefined, attachMessages: c.attachMessages?.length ? c.attachMessages : undefined, ...extra };
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
  t.innerHTML = `Sending… <button type="button">Undo</button>`;
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
  // A cancelled send carries the full HTML (body + quoted original): edit it as one body
  const html = d.html ? cleanForEditor(String(d.html).replace(/<div class="arzio-body">([\s\S]*)<\/div>(<br>)?(?=<div class="arzio-quote">|$)/, '$1')) : textToHtml(d.text || '');
  return { from: d.from || '', to: j(d.to), cc: j(d.cc), bcc: j(d.bcc), subject: d.subject || '', text: d.text || '', html, quoteHtml: '', inReplyTo: d.inReplyTo, references: d.references,
    attachments: d.attachments || [], draftId: d.draftId || null, importance: d.importance || 'normal', readReceipt: !!d.readReceipt, forwardOf: d.forwardOf || null };
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
      box.innerHTML = items.map((it, i) => `<div data-i="${i}">${esc(it.name || it.email)}<small>${esc(it.email)}${it.source === 'directory' ? ' · Directory' : it.source === 'group' ? ' · Group' : ''}</small></div>`).join('');
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

// Small pop-up menu: items = [[label, fn], ...]; opts.datetime adds a custom date/time picker, opts.grid lays items out as a grid
function popMenu(anchor, items, opts = {}) {
  $$('.menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = `menu${opts.grid ? ' grid' : ''}`;
  m.innerHTML = items.map(([label], i) => `<button type="button" data-i="${i}">${esc(label)}</button>`).join('')
    + (opts.datetime ? '<div class="muted small" style="padding:6px 10px 0">Pick a date and time</div><input type="datetime-local"><button type="button" data-custom>Set</button>' : '');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, window.innerWidth - 300)}px`;
  m.style.top = `${Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8)}px`;
  m.onmousedown = (e) => { if (opts.grid) e.preventDefault(); };
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
  $('#att-list').innerHTML = c.attachments.map((a, i) => `<span>\u{1F4CE} ${esc(a.filename)} (${fmtBytes(a.size || 0)}) <button type="button" data-rm="${i}" aria-label="Remove">×</button></span>`).join('')
    + (c.attachMessages || []).map((id, i) => `<span>\u2709 ${esc(state.messages.find((x) => x.id === id)?.subject || 'Message')}.eml <button type="button" data-rm-msg="${i}" aria-label="Remove">×</button></span>`).join('');
  $$('[data-rm-msg]').forEach((b) => b.addEventListener('click', () => { c.attachMessages.splice(Number(b.dataset.rmMsg), 1); renderAttachments(); }));
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { c.attachments.splice(Number(b.dataset.rm), 1); renderAttachments(); }));
}

function syncComposer() {
  const c = state.composer;
  if ($('#c-from') && !$('.from-row').classList.contains('hidden')) c.from = $('#c-from').value;
  c.to = $('#c-to').value; c.cc = $('#c-cc').value; c.bcc = $('#c-bcc').value; c.subject = $('#c-subject').value;
  c.html = $('#c-body').innerHTML;
  if ($('#c-quote')) c.quoteHtml = $('#c-quote').innerHTML;
  const own = $('#c-body').innerText.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trimEnd();
  c.text = c.quoteHtml ? `${own}${c.quoteText || `\n\n${$('#c-quote')?.innerText || ''}`}` : own;
}

async function composerAction(act, btn) {
  const c = state.composer;
  syncComposer();
  try {
    if (act === 'close') { closeReader(); return; }
    if (act === 'attach') { $('#file-input').click(); return; }
    if (act === 'show-quote') { $('#c-quote').classList.toggle('hidden'); btn.textContent = $('#c-quote').classList.contains('hidden') ? '⋯ Show original message' : 'Hide original message'; return; }
    if (act === 'options') {
      popMenu(btn, [
        [`${c.importance === 'high' ? '✓ ' : ''}High importance`, () => { c.importance = c.importance === 'high' ? 'normal' : 'high'; renderComposeFlags(); }],
        [`${c.importance === 'low' ? '✓ ' : ''}Low importance`, () => { c.importance = c.importance === 'low' ? 'normal' : 'low'; renderComposeFlags(); }],
        [`${c.readReceipt ? '✓ ' : ''}Request a read receipt`, () => { c.readReceipt = !c.readReceipt; renderComposeFlags(); }],
        ['Insert signature', () => { const b = $('#c-body'); if (!b.querySelector('.arzio-signature') && state.me.signature) b.insertAdjacentHTML('beforeend', signatureHtml()); }],
        ['Show Bcc', () => { $$('.cc-row').forEach((r) => r.classList.remove('hidden')); $('#c-bcc').focus(); }],
      ]);
      return;
    }
    if (act === 'schedule') {
      const t = new Date();
      const at = (d, h) => { const x = new Date(t); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x; };
      const go = async (when) => { await submitCompose(c, { sendAt: when }); };
      popMenu(btn, [
        [`Tomorrow morning · ${fmtDate(at(1, 8).toISOString(), true)}`, () => go(at(1, 8).toISOString())],
        [`Tomorrow afternoon · ${fmtDate(at(1, 13).toISOString(), true)}`, () => go(at(1, 13).toISOString())],
        [`Monday morning · ${fmtDate((() => { const x = at(1, 8); while (x.getDay() !== 1) x.setDate(x.getDate() + 1); return x; })().toISOString(), true)}`, () => { const x = at(1, 8); while (x.getDay() !== 1) x.setDate(x.getDate() + 1); return go(x.toISOString()); }],
      ], { datetime: go });
      return;
    }
    if (act === 'templates') {
      const { templates } = await api('/templates');
      popMenu(btn, [
        ...templates.map((tp) => [`Insert: ${tp.name}`, () => {
          restoreSel();
          document.execCommand('insertHTML', false, textToHtml(tp.body));
          if (!$('#c-subject').value) $('#c-subject').value = tp.subject;
        }]),
        ['Save this message as a template', async () => {
          const name = prompt('Template name');
          if (!name) return;
          await api('/templates', { method: 'POST', body: { name, subject: $('#c-subject').value, body: bodyText() } });
          toast('Template saved.');
        }],
      ]);
      return;
    }
    if (act === 'coach') {
      busy(btn, true, 'Checking');
      try {
        const r = await api('/ai/coach', { method: 'POST', body: { text: bodyText(), recipients: c.to } });
        $('#coach-out').innerHTML = `<div class="ai-card coach"><h4>✨ ${r.verdict === 'ready' ? 'Looks good to send' : 'Worth a second look'}</h4><p class="small">Tone: ${esc(r.tone)}</p>${r.suggestions.length ? `<ul>${r.suggestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
      } finally { busy(btn, false); }
      return;
    }
    if (act === 'show-cc') { $$('.cc-row').forEach((r) => r.classList.remove('hidden')); $('#c-cc').focus(); return; }
    if (act === 'discard') {
      if (c.draftId) await api(`/messages/${c.draftId}`, { method: 'DELETE' });
      state.composer = null; closeReader(); if (c.draftId) refresh(); return;
    }
    if (act === 'save') {
      const p = composePayload(c);
      const r = await api('/drafts', { method: 'POST', body: { id: c.draftId, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: c.text, html: p.html, inReplyTo: c.inReplyTo, references: c.references } });
      c.draftId = r.id; toast('Draft saved.'); loadFolders(); return;
    }
    if (act === 'ai-draft') {
      busy(btn, true, 'Writing');
      try {
        const r = await api('/ai/draft', { method: 'POST', body: { messageId: c.mode === 'forward' ? null : c.replyTo, instructions: $('#ai-instructions').value, tone: $('#ai-tone').value } });
        setBodyText(r.body);
        if (!$('#c-subject').value && r.subject) $('#c-subject').value = r.subject;
        toast('Draft ready. Review it before sending.');
      } finally { busy(btn, false); }
      return;
    }
    if (act.startsWith('rw-')) {
      const s = getSelection();
      const hasSel = s.rangeCount && !s.isCollapsed && $('#c-body').contains(s.anchorNode);
      const range = hasSel ? s.getRangeAt(0).cloneRange() : null;
      const target = hasSel ? s.toString() : bodyText();
      if (!target.trim()) { toast('Write something first, or select text to rewrite.'); return; }
      busy(btn, true, 'Rewriting');
      try {
        const r = await api('/ai/rewrite', { method: 'POST', body: { text: target, style: act.slice(3) } });
        if (range) { $('#c-body').focus(); s.removeAllRanges(); s.addRange(range); document.execCommand('insertText', false, r.text); } else setBodyText(r.text);
      } finally { busy(btn, false); }
    }
  } catch (e) { toast(e.message); }
}

$('#new-mail-btn').addEventListener('click', () => { if (state.view !== 'mail') showMailView(); state.selectedId = null; renderList(); openComposer('new'); $('#sidebar').classList.remove('open'); });

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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) { e.preventDefault(); closeModal(); } });

// ------------------------------------------------------------ settings (tabbed)
const SETTINGS_TABS = [
  ['general', 'General'], ['appearance', 'Appearance & layout'], ['ooo', 'Automatic replies'], ['rules', 'Rules'], ['junk', 'Junk email'],
  ['templates', 'Templates'], ['accounts', 'Addresses & sharing'], ['security', 'Security'], ['apps', 'Phones, mail apps & AI agents'], ['import', 'Import mail'], ['billing', 'Plan & billing'],
];

async function openSettings(tab = 'general', ruleSeed = null) {
  if (typeof tab !== 'string') tab = 'general';
  const u = state.me = (await api('/me')).user;
  const tabs = SETTINGS_TABS.filter(([k]) => k !== 'billing' || (state.service?.billing && u.org_kind === 'public'));
  const m = modal(`<h2>Settings</h2><div class="tabbar">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div><div id="settings-body"></div>`);
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

  if (tab === 'appearance') appearanceSettings(body);

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

  if (tab === 'billing') {
    const o = await api('/billing');
    body.innerHTML = `${billingIntro(o)}${planCards(o, { business: false })}
      ${o.subscription && !o.subscription.cancelAtPeriodEnd && o.subscription.provider !== 'manual' ? '<p><button class="link-btn" data-cancel-plan>Cancel plan</button></p>' : ''}
      <h3>Invoices</h3>${invoiceTable(o.invoices)}<p class="form-error"></p>`;
    wirePlans(body, o, { business: false, base: '/billing', onDone: () => openSettings('billing'), err: $('.form-error', body) });
  }

  if (tab === 'import') {
    const { jobs, presets } = await api('/me/import');
    const names = { gmail: 'Gmail', outlook: 'Outlook / Microsoft 365', yahoo: 'Yahoo Mail', zoho: 'Zoho Mail' };
    body.innerHTML = `<h3>Copy mail from another account</h3>
      <p class="muted">Bring your mail, folders and labels from Gmail, Outlook / Microsoft 365, Yahoo or any IMAP account. It runs in the background; duplicates are skipped.</p>
      <form id="imp-form"><div class="row"><label>From<select name="provider">${Object.keys(presets).map((k) => `<option value="${k}">${names[k] || k}</option>`).join('')}<option value="other">Other IMAP server</option></select></label>
        <label class="imp-host hidden">IMAP server<input name="host" placeholder="imap.example.com"></label><label class="imp-host hidden">Port<input name="port" value="993" style="width:80px"></label></div>
        <p class="muted small" id="imp-note">${esc(presets.gmail.note)}</p>
        <div class="row"><label>Email address<input name="username" required></label><label>Password or app password<input name="password" type="password" required></label></div>
        <button class="btn primary">Start import</button></form>
      <h3>Upload a file</h3>
      <p class="muted">An <strong>.mbox</strong> archive (Google Takeout, Thunderbird, Apple Mail export) or an <strong>.eml</strong> message, up to 25 MB. Messages go to Archive. For bigger archives, use the account import above.</p>
      <input type="file" id="imp-file" accept=".mbox,.eml,message/rfc822">
      <h3>Recent imports</h3>
      <table>${jobs.map((j) => `<tr><td>${esc(j.source)}</td><td>${j.status === 'running' ? `Running… ${j.imported} copied${j.current ? ` (${esc(j.current)})` : ''}` : j.status === 'done' ? `✔ Done: ${j.imported} copied, ${j.skipped} already here` : `✖ Failed: ${esc(j.error || '')}`}</td></tr>`).join('') || '<tr><td class="muted">None yet.</td></tr>'}</table>
      <p class="form-error"></p>`;
    const err = $('.form-error', body);
    const f = $('#imp-form', body);
    f.provider.onchange = () => { const other = f.provider.value === 'other'; $$('.imp-host', f).forEach((x) => x.classList.toggle('hidden', !other)); $('#imp-note', body).textContent = presets[f.provider.value]?.note || ''; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/me/import/imap', { method: 'POST', body: { provider: f.provider.value, host: f.provider.value === 'other' ? f.host.value : undefined, port: Number(f.port.value) || 993, username: f.username.value, password: f.password.value } });
        toast('Import started. You can keep working.'); openSettings('import');
      } catch (ex) { err.textContent = ex.message; }
    };
    $('#imp-file', body).onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const b64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
        const r = await api('/me/import/file', { method: 'POST', body: { filename: file.name, contentBase64: b64 } });
        toast(`Imported ${r.imported} message(s)${r.skipped ? `, ${r.skipped} already here` : ''}.`); refresh(true);
      } catch (ex) { err.textContent = ex.message; }
    };
    if (jobs.some((j) => j.status === 'running')) setTimeout(() => { if ($('#imp-form')) openSettings('import'); }, 3000);
  }

  if (tab === 'apps') {
    const [{ appPasswords, servers }, { tokens }, feed, { devices }] = await Promise.all([api('/me/app-passwords'), api('/me/tokens'), api('/calendar/feed'), api('/me/devices')]);
    const devStatus = { allowed: 'Connected', blocked: 'Blocked', wipe: 'Wipe requested', wiped: 'Wiped' };
    const when = (d) => (d ? fmtDate(`${d.replace(' ', 'T')}Z`, true) : 'never');
    body.innerHTML = `<h3>Phones and tablets (Exchange)</h3>
      <p class="muted">The quickest way to get mail, calendar, contacts and tasks with instant push on iPhone, Android, Outlook for iOS and Android, Samsung Email and Windows Mail. Add an <strong>Exchange</strong> account (on Android: "Exchange" or "Corporate"), enter your address and ${u.totp_enabled ? 'an app password' : 'password'}. If the app asks for a server, use the one below.</p>
      <table class="kv"><tr><th>Email</th><td><code>${esc(servers.username)}</code></td></tr><tr><th>Server</th><td><code>${esc(servers.exchange.server)}</code></td></tr><tr><th>Domain</th><td class="muted">Leave empty</td></tr></table>
      <h4>Connected phones</h4>
      <table id="devices">${devices.map((d) => `<tr><td><strong>${esc(d.friendly_name || d.model || d.device_type || 'Phone')}</strong><div class="muted small">${esc([d.model, d.os].filter(Boolean).join(', ') || d.user_agent)}</div></td>
        <td class="small">${devStatus[d.status] || esc(d.status)}<div class="muted">last synced ${when(d.last_seen)}</div></td>
        <td>${d.status === 'blocked' ? `<button class="link-btn" data-dev="${d.id}" data-act="allow">Allow</button>` : d.status === 'allowed' ? `<button class="link-btn" data-dev="${d.id}" data-act="block">Block</button> <button class="link-btn danger" data-dev="${d.id}" data-act="wipe">Wipe</button>` : ''}
        <button class="link-btn" data-dev="${d.id}" data-act="remove">Remove</button></td></tr>`).join('') || '<tr><td class="muted">No phones connected with Exchange yet.</td></tr>'}</table>
      <h3>Outlook, Apple Mail, Thunderbird and other mail apps (IMAP)</h3>
      <p class="muted">Add your account as an <strong>IMAP</strong> account with these settings.${u.totp_enabled ? ' Because two-step verification is on, sign in with an app password below instead of your normal password.' : ' You can sign in with your normal password, or create an app password for each device.'}</p>
      <table class="kv"><tr><th>Username</th><td><code>${esc(servers.username)}</code></td></tr>
      <tr><th>Incoming (IMAP)</th><td><code>${esc(servers.imap.host)}</code> port <code>${servers.imap.port}</code>, ${esc(servers.imap.security)}</td></tr>
      <tr><th>Outgoing (SMTP)</th><td><code>${esc(servers.smtp.host)}</code> port <code>${servers.smtp.port}</code>, ${esc(servers.smtp.security)}, sign-in required</td></tr></table>
      <h3>Calendar and contacts on your phone</h3>
      <p class="muted">Keep your Arzio calendar and contacts in sync with iPhone, iPad and Mac (add a <strong>CalDAV</strong> and a <strong>CardDAV</strong> account), Android (DAVx⁵) or Thunderbird. Changes go both ways.</p>
      <table class="kv"><tr><th>Server</th><td><code>${esc(location.origin)}/dav/</code></td></tr><tr><th>Username</th><td><code>${esc(servers.username)}</code></td></tr><tr><th>Password</th><td>${u.totp_enabled ? 'An app password' : 'Your password or an app password'}</td></tr></table>
      <h3>App passwords</h3>
      <table>${appPasswords.map((a) => `<tr><td>${esc(a.name)}</td><td class="muted small">created ${when(a.created_at)}, last used ${when(a.last_used)}</td><td><button class="link-btn" data-del-ap="${a.id}">Remove</button></td></tr>`).join('') || '<tr><td class="muted">None yet.</td></tr>'}</table>
      <form id="ap-form" class="row"><label>Device name<input name="name" placeholder="e.g. iPhone Mail" required></label><button class="btn">Create app password</button></form>
      <div id="ap-out"></div>
      <h3>AI agents and API access</h3>
      <p class="muted">Let an AI assistant (Claude, ChatGPT, Copilot or any MCP client) work with your mail, calendar and To Do. Add this MCP server URL in the assistant and paste a token. Read-only tokens can search and read; "read and act" tokens can also send mail, create events and tasks.</p>
      <p>MCP server: <code>${esc(location.origin)}/mcp</code></p>
      <table>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.scopes === 'read' ? 'Read only' : 'Read and act'}</td><td class="muted small">last used ${when(t.last_used)}</td><td><button class="link-btn" data-del-tok="${t.id}">Revoke</button></td></tr>`).join('') || '<tr><td class="muted">No tokens yet.</td></tr>'}</table>
      <form id="tok-form" class="row"><label>Name<input name="name" placeholder="e.g. Claude" required></label><label>Access<select name="scopes"><option value="read">Read only</option><option value="read,send">Read and act</option></select></label><button class="btn">Create token</button></form>
      <div id="tok-out"></div>
      <h3>Calendar subscription</h3>
      <p class="muted">Show your Arzio calendar in Google Calendar, Apple Calendar or Outlook with a private link. Anyone with the link can see your events.</p>
      ${feed.url ? `<p><code class="wrap">${esc(feed.url)}</code></p><button class="btn" id="feed-reset">New link</button> <button class="btn danger" id="feed-off">Turn off</button>` : '<button class="btn" id="feed-reset">Create link</button>'}
      <p class="form-error"></p>`;
    const err = $('.form-error', body);
    const secret = (label, value, note) => `<div class="secret"><p><strong>${label}</strong> ${note}</p><code>${esc(value)}</code></div>`;
    $('#ap-form', body).onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/me/app-passwords', { method: 'POST', body: { name: e.target.name.value } }); await openSettings('apps'); $('#ap-out').innerHTML = secret('Your app password:', r.password, 'Enter it in the mail app instead of your password. It is shown only once.'); } catch (ex) { err.textContent = ex.message; } };
    $('#tok-form', body).onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/me/tokens', { method: 'POST', body: { name: e.target.name.value, scopes: e.target.scopes.value } }); await openSettings('apps'); $('#tok-out').innerHTML = secret('Your token:', r.token, 'Paste it into the assistant as a Bearer token. It is shown only once.'); } catch (ex) { err.textContent = ex.message; } };
    body.onclick = async (e) => {
      const ap = e.target.closest('[data-del-ap]');
      const tok = e.target.closest('[data-del-tok]');
      const dev = e.target.closest('[data-dev]');
      try {
        if (dev) {
          const act = dev.dataset.act;
          const ask = { wipe: 'Erase this phone? Most phones reset to factory settings, which deletes everything on them, not only Arzio mail. Use this only if the phone is lost or stolen.',
            remove: 'Remove this phone from the list? It will set itself up again the next time it connects, unless you change your password.', block: 'Block this phone? It stops syncing until you allow it again.' }[act];
          if (ask && !confirm(ask)) return;
          await api(`/me/devices/${dev.dataset.dev}`, { method: 'POST', body: { action: act } });
          return openSettings('apps');
        }
        if (ap) { await api(`/me/app-passwords/${ap.dataset.delAp}`, { method: 'DELETE' }); openSettings('apps'); }
        if (tok) { await api(`/me/tokens/${tok.dataset.delTok}`, { method: 'DELETE' }); openSettings('apps'); }
        if (e.target.id === 'feed-reset') { await api('/calendar/feed', { method: 'POST', body: {} }); openSettings('apps'); }
        if (e.target.id === 'feed-off') { await api('/calendar/feed', { method: 'POST', body: { enabled: false } }); openSettings('apps'); }
      } catch (ex) { err.textContent = ex.message; }
    };
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
  ribbonSync();
}
async function showView(name, opts = {}) {
  state.view = name;
  $('.layout').classList.add('full');
  $('#full-pane').classList.remove('hidden');
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('#folder-list button, [data-smart]').forEach((b) => b.classList.remove('active'));
  $('#sidebar').classList.remove('open');
  ribbonSync();
  try { await VIEWS[name]($('#full-pane'), opts); } catch (ex) { toast(ex.message); }
}
$$('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

VIEWS.people = async (pane, q = '') => {
  if (typeof q !== 'string') q = '';
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

async function openServiceAdmin() {
  const { orgs } = await api('/admin/orgs');
  const m = modal(`
    <h2>Service admin</h2>
    <h3>Organizations</h3>
    <table><thead><tr><th>Name</th><th>Type</th><th>Domains</th><th>Users</th></tr></thead><tbody>
    ${orgs.map((o) => `<tr><td>${esc(o.name)} <span class="muted small">#${o.id}</span></td><td>${o.kind === 'public' ? 'Public (free signups)' : 'Private'}</td><td>${esc(o.domains || '')}</td><td>${o.users}</td></tr>`).join('')}
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
  if (state.service?.billing) {
    const b = await api('/admin/billing');
    const box = document.createElement('div');
    box.innerHTML = `<h3>Plans and revenue</h3>
      <div class="stats"><div><b>${money(b.mrr, b.currency)}</b><span>monthly recurring revenue</span></div><div><b>${money(b.collected30d, b.currency)}</b><span>collected, last 30 days</span></div><div><b>${b.pastDue}</b><span>payments failing</span></div>
      <div><b>${[b.providers.razorpay && 'Razorpay', b.providers.stripe && 'Stripe'].filter(Boolean).join(', ') || 'None'}</b><span>online payment</span></div></div>
      <table><thead><tr><th>Plan</th><th>Monthly</th><th>Yearly</th><th>Storage (MB)</th><th>Emails/day</th><th>AI/day</th><th></th></tr></thead><tbody>
      ${b.plans.map((p) => `<tr data-pc="${p.code}"><td>${esc(p.name)} <span class="muted small">${p.audience}</span></td>
        <td><input name="price_month" type="number" value="${p.price_month / 100}" step="0.01" style="width:90px"></td><td><input name="price_year" type="number" value="${p.price_year / 100}" step="0.01" style="width:90px"></td>
        <td><input name="storage_mb" type="number" value="${p.storage_mb}" style="width:90px"></td><td><input name="sends_per_day" type="number" value="${p.sends_per_day}" style="width:80px"></td>
        <td><input name="ai_per_day" type="number" value="${p.ai_per_day}" style="width:70px" title="-1 = no limit, 0 = no AI"></td><td><button class="btn" data-save-plan>Save</button></td></tr>`).join('')}</tbody></table>
      <p class="muted small">Prices are before ${'tax'}, in ${b.currency}. Subscribers keep their price until they change plan.</p>
      <h4>Give a plan by hand (paid by invoice or a gift)</h4>
      <form id="assign-plan" class="row"><label>Personal address or org id<input name="who" required placeholder="name@domain or 12"></label>
        <label>Plan<select name="plan">${b.plans.map((p) => `<option value="${p.code}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>Seats<input name="seats" type="number" value="1" min="1" style="width:70px"></label><label>Months<input name="months" type="number" value="12" min="1" style="width:70px"></label>
        <label class="check"><input type="checkbox" name="paid" checked> Paid (record invoice)</label><button class="btn">Assign</button></form>
      <p class="form-error" id="ops-bill-err"></p>`;
    const firstH = m.querySelector('h3'); firstH.parentNode.insertBefore(box, firstH);
    const e2 = $('#ops-bill-err', box);
    box.onclick = async (e) => {
      const btn = e.target.closest('[data-save-plan]');
      if (!btn) return;
      const row = btn.closest('tr');
      const v = (n) => Number($(`[name=${n}]`, row).value);
      try {
        await api(`/admin/plans/${row.dataset.pc}`, { method: 'PUT', body: { price_month: Math.round(v('price_month') * 100), price_year: Math.round(v('price_year') * 100), storage_mb: v('storage_mb'), sends_per_day: v('sends_per_day'), ai_per_day: v('ai_per_day') } });
        toast('Plan saved.');
      } catch (ex) { e2.textContent = ex.message; }
    };
    $('#assign-plan', box).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const who = f.who.value.trim();
      try {
        await api('/admin/billing/assign', { method: 'POST', body: { ...(/^\d+$/.test(who) ? { orgId: Number(who) } : { userEmail: who }), plan: f.plan.value, seats: Number(f.seats.value), months: Number(f.months.value), paid: f.paid.checked } });
        toast('Plan assigned.'); openServiceAdmin();
      } catch (ex) { e2.textContent = ex.message; }
    };
  }
}

// Keyboard shortcuts (Outlook-style)
// ------------------------------------------------------------ meeting invites in the reader
const fmtWhen = (start, end, allDay) => {
  const s = new Date(start);
  const e = new Date(end);
  const day = s.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (allDay) return `${day} (all day)`;
  const t = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${t(s)} – ${t(e)}`;
};

function inviteCard(m) {
  const c = m.calendar;
  if (!c) return '';
  if (c.method === 'REPLY') {
    const verb = { accepted: 'accepted', tentative: 'tentatively accepted', declined: 'declined' }[c.status] || 'responded to';
    return `<div class="invite"><div class="invite-icon">\u{1F4C5}</div><div><strong>${esc(c.attendee)} ${verb}</strong> ${esc(c.title || '')}</div></div>`;
  }
  if (c.method === 'CANCEL') {
    return `<div class="invite cancelled"><div class="invite-icon">\u{1F4C5}</div><div><strong>Canceled:</strong> ${esc(c.title || '')}<div class="muted small">${c.start_at ? esc(fmtWhen(c.start_at, c.start_at)) : ''}</div></div></div>`;
  }
  const resp = c.response;
  const answered = ['accepted', 'tentative', 'declined'].includes(resp);
  return `<div class="invite"><div class="invite-icon">\u{1F4C5}</div><div class="invite-body">
    <strong>${esc(c.title || '(no title)')}</strong>
    <div>${esc(fmtWhen(c.start_at, c.end_at))}</div>
    ${c.location ? `<div class="muted">${esc(c.location)}</div>` : ''}
    <div class="muted small">Organizer: ${esc(c.organizer || '')}</div>
    ${c.removed ? '<div class="muted">This event is no longer on your calendar.</div>' : `<div class="invite-actions">
      ${answered ? `<span class="tag">${{ accepted: '✔ Accepted', tentative: '? Tentative', declined: '✖ Declined' }[resp]}</span>` : ''}
      <button class="btn ${resp === 'accepted' ? 'primary' : ''}" data-act="rsvp:accepted">✔ Accept</button>
      <button class="btn" data-act="rsvp:tentative">? Tentative</button>
      <button class="btn" data-act="rsvp:declined">✖ Decline</button>
      <button class="link-btn" data-act="open-calendar">Show in calendar</button></div>`}
  </div></div>`;
}

// ------------------------------------------------------------ notifications (event and task reminders)
const seenNotifications = new Set();
async function pollNotifications() {
  try {
    const { notifications } = await api('/notifications?unread=1');
    const btn = $('#bell-btn');
    btn.dataset.count = notifications.length || '';
    btn.classList.toggle('has', notifications.length > 0);
    for (const n of notifications) {
      if (seenNotifications.has(n.id)) continue;
      seenNotifications.add(n.id);
      if (seenNotifications.size === 1 && notifications.length > 3) continue; // first load: don't flood
      toast(`\u{1F514} ${n.title}${n.body ? ` · ${n.body.replace(/Starts (\S+)/, (_, d) => `Starts ${new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`)}` : ''}`);
      if (window.Notification?.permission === 'granted' && document.hidden) new Notification(n.title, { body: n.body, tag: `arzio-${n.id}` });
    }
  } catch { /* offline or signed out */ }
}
$('#bell-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const anchor = e.currentTarget;
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  const { notifications } = await api('/notifications');
  const items = notifications.slice(0, 10).map((n) => [`${n.is_read ? '' : '● '}${n.title}${n.body ? ` — ${n.body.replace(/Starts (\S+)/, (_, d) => `starts ${new Date(d).toLocaleString()}`)}` : ''}`, () => {
    if (n.link.eventId) showView('calendar', { date: n.link.start });
    else if (n.link.taskId) showView('tasks');
  }]);
  popMenu(anchor, items.length ? items : [['No reminders yet', () => {}]]);
  await api('/notifications/read', { method: 'POST', body: {} });
  pollNotifications();
});

// ------------------------------------------------------------ appearance, layout and reading settings
const ui = () => { try { return JSON.parse(state.me?.ui_json || '{}'); } catch { return {}; } };
const ACCENTS = { blue: '#0f6cbd', teal: '#03787c', green: '#107c10', purple: '#5c2e91', pink: '#bf0077', orange: '#ca5010', gray: '#5a5a5a' };
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyUi() {
  const u = ui();
  const root = document.documentElement;
  root.dataset.theme = (u.theme || 'light') === 'system' ? (darkQuery.matches ? 'dark' : 'light') : (u.theme || 'light');
  root.dataset.density = u.density || 'comfortable';
  root.dataset.pane = u.readingPane || 'right';
  root.dataset.textsize = u.textSize || 'medium';
  root.classList.toggle('no-avatars', u.senderImages === false);
  root.classList.toggle('no-preview', u.previewText === false);
  root.classList.toggle('no-folder-pane', u.folderPane === false);
  const accent = ACCENTS[u.accent] || ACCENTS.blue;
  root.style.setProperty('--brand', accent);
  root.style.setProperty('--brand-dark', `color-mix(in srgb, ${accent} 82%, black)`);
  root.style.setProperty('--brand-light', root.dataset.theme === 'dark' ? `color-mix(in srgb, ${accent} 28%, #1f1f1f)` : `color-mix(in srgb, ${accent} 10%, white)`);
  renderFavorites();
}
darkQuery.addEventListener?.('change', () => { if (state.me) applyUi(); });

async function saveUi(patch) {
  const { ui: next } = await api('/me/ui', { method: 'PATCH', body: patch });
  state.me.ui_json = JSON.stringify(next);
  applyUi();
  return next;
}

function appearanceSettings(body) {
  const u = ui();
  const radio = (name, value, label, cur) => `<label class="check"><input type="radio" name="${name}" value="${value}" ${cur === value ? 'checked' : ''}> ${label}</label>`;
  body.innerHTML = `<form class="appearance">
    <h3>Theme</h3>
    <div class="row">${radio('theme', 'light', 'Light', u.theme || 'light')}${radio('theme', 'dark', 'Dark', u.theme)}${radio('theme', 'system', 'Use my device setting', u.theme)}</div>
    <div class="swatches">${Object.entries(ACCENTS).map(([k, v]) => `<label title="${k}"><input type="radio" name="accent" value="${k}" ${(u.accent || 'blue') === k ? 'checked' : ''}><span style="background:${v}"></span></label>`).join('')}</div>
    <h3>Layout</h3>
    <div class="row">
      <label>Reading pane<select name="readingPane">${[['right', 'Show on the right'], ['bottom', 'Show on the bottom'], ['off', 'Hide (open messages full page)']].map(([v, l]) => `<option value="${v}" ${(u.readingPane || 'right') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Density<select name="density">${[['roomy', 'Roomy'], ['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([v, l]) => `<option value="${v}" ${(u.density || 'comfortable') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Text size<select name="textSize">${[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']].map(([v, l]) => `<option value="${v}" ${(u.textSize || 'medium') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="conversations" ${u.conversations !== false ? 'checked' : ''}> Group messages by conversation</label>
    <label class="check"><input type="checkbox" name="senderImages" ${u.senderImages !== false ? 'checked' : ''}> Show sender pictures in the message list</label>
    <label class="check"><input type="checkbox" name="previewText" ${u.previewText !== false ? 'checked' : ''}> Show a preview of the message text</label>
    <h3>Keyboard shortcuts</h3>
    <label>Shortcut set<select name="shortcuts">${[['outlook', 'Outlook'], ['gmail', 'Gmail'], ['off', 'Turn off keyboard shortcuts']].map(([v, l]) => `<option value="${v}" ${(u.shortcuts || 'outlook') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p><button type="button" class="link-btn" id="show-keys">See all keyboard shortcuts</button></p>
    <p class="form-error"></p><div class="actions"><button class="btn" type="button" data-close>Close</button><button class="btn primary">Save</button></div></form>`;
  const f = $('form', body);
  $('#show-keys', f).onclick = () => showShortcuts(f.shortcuts.value);
  // Preview theme changes straight away
  f.onchange = () => {
    const root = document.documentElement;
    const t = f.theme.value;
    root.dataset.theme = t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t;
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await saveUi({ theme: f.theme.value, accent: f.accent.value, readingPane: f.readingPane.value, density: f.density.value, textSize: f.textSize.value,
        conversations: f.conversations.checked, senderImages: f.senderImages.checked, previewText: f.previewText.checked, shortcuts: f.shortcuts.value });
      toast('Settings saved.'); closeModal();
      if (state.view === 'mail') renderList();
    } catch (ex) { $('.form-error', f).textContent = ex.message; }
  };
}

// ------------------------------------------------------------ favorites (top of the folder pane)
function favLabel(key) {
  const [kind, val] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'folder') { const f = state.folders.find((x) => x.id === Number(val)); return f ? { label: `${FOLDER_ICONS[f.role] || '\u{1F4C1}'} ${f.name}`, count: f.role === 'drafts' ? f.total : f.unread } : null; }
  if (kind === 'smart') return { label: { flagged: '⚑ Flagged', snoozed: '⏰ Snoozed', mentions: '@ Mentions me', scheduled: '\u{1F552} Scheduled' }[val] || val };
  return null;
}
function renderFavorites() {
  const box = $('#favorites');
  if (!box || !state.me) return;
  const favs = (ui().favorites || []).map((k) => [k, favLabel(k)]).filter(([, v]) => v);
  box.classList.toggle('hidden', !favs.length);
  box.innerHTML = favs.length ? `<li class="fav-head">Favorites</li>${favs.map(([k, v]) => `<li><button data-fav="${esc(k)}"><span>${esc(v.label)}</span>${v.count ? `<span class="count">${v.count}</span>` : ''}</button></li>`).join('')}` : '';
}
async function toggleFavorite(key) {
  const favs = ui().favorites || [];
  await saveUi({ favorites: favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key] });
  toast(favs.includes(key) ? 'Removed from Favorites.' : 'Added to Favorites.');
}
$('#favorites').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fav]');
  if (!b) return;
  const k = b.dataset.fav;
  if (k.startsWith('folder:')) selectFolder(Number(k.slice(7)));
  else $(`[data-smart="${k.slice(6)}"]`)?.click();
});
$('#favorites').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-fav]');
  if (!b) return;
  e.preventDefault();
  popMenu(b, [['Remove from Favorites', () => toggleFavorite(b.dataset.fav)]]);
});
$$('[data-smart]').forEach((b) => b.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const key = `smart:${b.dataset.smart}`;
  popMenu(b, [[(ui().favorites || []).includes(key) ? 'Remove from Favorites' : 'Add to Favorites', () => toggleFavorite(key)]]);
}));

// ------------------------------------------------------------ reactions (like Outlook: one per person)
const REACTIONS = ['👍', '❤️', '🎉', '😆', '😮', '😢'];
async function loadReactions(thread) {
  try {
    const { reactions } = await api('/reactions/lookup', { method: 'POST', body: { ids: thread.map((m) => m.id) } });
    for (const [id, list] of Object.entries(reactions)) renderReactions(Number(id), list);
  } catch { /* reactions are optional */ }
}
function renderReactions(id, list) {
  const el = $(`[data-reactions="${id}"]`);
  if (!el) return;
  el.innerHTML = `${list.map((r) => `<button class="reaction ${r.mine ? 'mine' : ''}" data-act="react:${id}:${r.emoji}" title="${esc(r.names.join(', '))}">${r.emoji} ${r.count}</button>`).join('')}
    <button class="reaction add" data-act="react-pick:${id}" title="React" aria-label="Add a reaction">\u{1F642}+</button>`;
}

// ------------------------------------------------------------ print
function printMessage(message, thread) {
  const items = thread.length > 1 ? thread : [message];
  const frame = document.createElement('iframe');
  frame.className = 'print-frame';
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(message.subject || '')}</title><style>
    body{font-family:Segoe UI,system-ui,sans-serif;font-size:13px;color:#000;margin:24px}h1{font-size:20px}
    .m{border-top:1px solid #999;padding:12px 0}.h{margin-bottom:10px}.h div{margin:2px 0}img{max-width:100%}pre{white-space:pre-wrap;font-family:inherit}
  </style></head><body><h1>${esc(message.subject || '(no subject)')}</h1>
  ${items.map((m) => `<div class="m"><div class="h"><div><b>From:</b> ${esc(fmtAddr({ name: m.from_name, address: m.from_addr }))}</div><div><b>Sent:</b> ${esc(fmtDate(m.date, true))}</div><div><b>To:</b> ${esc(people(m.to))}</div>${m.cc?.length ? `<div><b>Cc:</b> ${esc(people(m.cc))}</div>` : ''}<div><b>Subject:</b> ${esc(m.subject || '')}</div>${(m.attachments || []).filter((a) => !a.inline).length ? `<div><b>Attachments:</b> ${m.attachments.filter((a) => !a.inline).map((a) => esc(a.filename)).join(', ')}</div>` : ''}</div>
    ${m.html_body ? cleanForEditor(m.html_body) : `<pre>${esc(m.text_body)}</pre>`}</div>`).join('')}</body></html>`);
  doc.close();
  setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 60000); }, 300);
}

// ------------------------------------------------------------ Immersive Reader
function openImmersive(message) {
  const text = message.text_body || '';
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const ov = document.createElement('div');
  ov.className = 'immersive';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'Immersive Reader');
  ov.innerHTML = `<div class="ir-bar">
      <strong>\u{1F4D6} Immersive Reader</strong><span class="grow"></span>
      <button class="btn" data-ir="play">▶ Read aloud</button>
      <label>Text size <input type="range" min="16" max="40" value="24" data-ir="size"></label>
      <label>Spacing <select data-ir="spacing"><option value="1.6">Normal</option><option value="2.1" selected>Wide</option><option value="2.6">Wider</option></select></label>
      <label>Font <select data-ir="font"><option value="Calibri, Segoe UI, sans-serif">Sans</option><option value="Georgia, serif">Serif</option><option value="Comic Sans MS, cursive">Comic</option></select></label>
      <label>Theme <select data-ir="theme"><option value="paper">Paper</option><option value="sepia">Sepia</option><option value="night">Night</option></select></label>
      <label class="check"><input type="checkbox" data-ir="focus"> Line focus</label>
      <button class="btn" data-ir="close" aria-label="Close Immersive Reader">✕ Close</button>
    </div>
    <article class="ir-text" tabindex="0"><h1>${esc(message.subject || '')}</h1><p class="ir-from">${esc(message.from_name || message.from_addr)}</p>${paras.map((p, i) => `<p data-p="${i}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</article>`;
  document.body.appendChild(ov);
  const art = $('.ir-text', ov);
  const apply = () => {
    art.style.fontSize = `${$('[data-ir="size"]', ov).value}px`;
    art.style.lineHeight = $('[data-ir="spacing"]', ov).value;
    art.style.fontFamily = $('[data-ir="font"]', ov).value;
    ov.dataset.theme = $('[data-ir="theme"]', ov).value;
    ov.classList.toggle('line-focus', $('[data-ir="focus"]', ov).checked);
  };
  apply();
  ov.oninput = apply;
  ov.onchange = apply;
  let speaking = false;
  const stop = () => { speechSynthesis?.cancel(); speaking = false; $('[data-ir="play"]', ov).textContent = '▶ Read aloud'; $$('[data-p]', ov).forEach((p) => p.classList.remove('reading')); };
  const close = () => { stop(); ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  ov.onclick = (e) => {
    const b = e.target.closest('[data-ir]');
    if (!b) return;
    if (b.dataset.ir === 'close') close();
    if (b.dataset.ir === 'play') {
      if (!('speechSynthesis' in window)) { toast('Read aloud is not available in this browser.'); return; }
      if (speaking) { stop(); return; }
      speaking = true; b.textContent = '⏸ Stop';
      const ps = $$('[data-p]', ov);
      ps.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p.textContent);
        u.onstart = () => { ps.forEach((x) => x.classList.remove('reading')); p.classList.add('reading'); p.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
        if (i === ps.length - 1) u.onend = stop;
        speechSynthesis.speak(u);
      });
    }
  };
  art.focus();
}

// ------------------------------------------------------------ keyboard shortcuts (Outlook or Gmail style)
const SHORTCUTS = {
  outlook: [['N', 'New message'], ['R', 'Reply'], ['Shift+R', 'Reply all'], ['Shift+F', 'Forward'], ['Ctrl+Enter', 'Send'], ['Delete', 'Delete'], ['E', 'Archive'], ['Q', 'Mark as read'], ['U', 'Mark as unread'], ['Insert', 'Flag or unflag'],
    ['↓ / ↑', 'Next or previous message'], ['Enter', 'Open message'], ['Esc', 'Close'], ['/', 'Search'], ['Ctrl+P', 'Print'], ['Ctrl+B / I / U / K', 'Bold, italic, underline, link (in a message)'], ['?', 'Show shortcuts']],
  gmail: [['C', 'Compose'], ['R', 'Reply'], ['A', 'Reply all'], ['F', 'Forward'], ['Ctrl+Enter', 'Send'], ['#', 'Delete'], ['E', 'Archive'], ['Shift+I', 'Mark as read'], ['Shift+U', 'Mark as unread'], ['S', 'Flag or unflag'],
    ['J / K', 'Next or previous message'], ['O / Enter', 'Open message'], ['U / Esc', 'Back to the list'], ['/', 'Search'], ['Ctrl+P', 'Print'], ['?', 'Show shortcuts']],
};
function showShortcuts(set = ui().shortcuts || 'outlook') {
  if (set === 'off') { modal('<h2>Keyboard shortcuts</h2><p>Keyboard shortcuts are turned off. Turn them on in Settings, Appearance &amp; layout.</p><div class="actions"><button class="btn" data-close>Close</button></div>'); return; }
  modal(`<h2>Keyboard shortcuts (${set === 'gmail' ? 'Gmail' : 'Outlook'})</h2><table class="keys">${SHORTCUTS[set].map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>
    <p class="muted small">Change the set in Settings, Appearance &amp; layout.</p><div class="actions"><button class="btn" data-close>Close</button></div>`);
}
function moveSelection(step) {
  const i = state.messages.findIndex((m) => m.id === state.selectedId);
  const next = state.messages[i < 0 ? 0 : i + step];
  if (next) { openMessage(next.id); $(`.msg[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
}
document.addEventListener('keydown', (e) => {
  if (!state.me || e.defaultPrevented) return;
  const set = ui().shortcuts || 'outlook';
  if (set === 'off') return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"]') || !$('#modal').classList.contains('hidden') || $('.immersive')) return;
  const reading = !$('#reader').classList.contains('hidden') && state.current;
  const act = (a) => { const b = $(`#reader [data-act="${a}"]`); if (b) { e.preventDefault(); b.click(); } };
  const key = e.key;
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'p' && reading) { e.preventDefault(); printMessage(state.current.message, state.current.thread); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (key === '?') { e.preventDefault(); showShortcuts(set); return; }
  if (key === '/') { e.preventDefault(); $('#search-input').focus(); return; }
  if (set === 'outlook') {
    if (key === 'n') { e.preventDefault(); $('#new-mail-btn').click(); return; }
    if (key === 'ArrowDown' && state.view === 'mail') { e.preventDefault(); moveSelection(1); return; }
    if (key === 'ArrowUp' && state.view === 'mail') { e.preventDefault(); moveSelection(-1); return; }
    if (!reading) return;
    if (key === 'r') act('reply');
    else if (key === 'R') act('replyall');
    else if (key === 'F') act('forward');
    else if (key === 'Delete') act('delete');
    else if (key === 'e') act('archive');
    else if (key === 'q') { e.preventDefault(); api(`/messages/${state.current.message.id}`, { method: 'PATCH', body: { is_read: true } }).then(() => { toast('Marked as read.'); refresh(true); }); }
    else if (key === 'u') act('unread');
    else if (key === 'Insert') act('flag');
    else if (key === 'Escape') closeReader();
  } else {
    if (key === 'c') { e.preventDefault(); $('#new-mail-btn').click(); return; }
    if (key === 'j' && state.view === 'mail') { e.preventDefault(); moveSelection(1); return; }
    if (key === 'k' && state.view === 'mail') { e.preventDefault(); moveSelection(-1); return; }
    if (key === 'o' && !reading && state.messages.length) { e.preventDefault(); openMessage((state.messages.find((m) => m.id === state.selectedId) || state.messages[0]).id); return; }
    if (!reading) return;
    if (key === 'r') act('reply');
    else if (key === 'a') act('replyall');
    else if (key === 'f') act('forward');
    else if (key === '#') act('delete');
    else if (key === 'e') act('archive');
    else if (key === 'I') { e.preventDefault(); api(`/messages/${state.current.message.id}`, { method: 'PATCH', body: { is_read: true } }).then(() => { toast('Marked as read.'); refresh(true); }); }
    else if (key === 'U') act('unread');
    else if (key === 's') act('flag');
    else if (key === 'u' || key === 'Escape') closeReader();
  }
});

// ------------------------------------------------------------ shared calendars
const SHARE_ROLES = { freebusy: 'Can view when I’m busy', view: 'Can view all details', edit: 'Can edit' };
const OTHER_COLORS = ['#ca5010', '#107c10', '#8764b8', '#c239b3', '#038387', '#986f0b'];
const shownCalendars = () => { try { return JSON.parse(localStorage.getItem('arzio-shown-calendars') || '[]'); } catch { return []; } };

async function shareCalendarDialog(pane) {
  const { given } = await api('/calendar/shares');
  const m = modal(`<h2>Share your calendar</h2>
    <form id="share-form" class="row"><label>Person<input name="email" placeholder="name@${esc(state.service.domain)}" required></label>
    <label>Permission<select name="role">${Object.entries(SHARE_ROLES).map(([k, l]) => `<option value="${k}" ${k === 'view' ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn primary">Share</button></form>
    <p class="form-error"></p>
    ${given.length ? `<table class="people"><thead><tr><th>Shared with</th><th>Permission</th><th></th></tr></thead><tbody>${given.map((g) => `<tr><td>${esc(g.name)} <span class="muted small">${esc(g.email)}</span></td><td>${SHARE_ROLES[g.role]}</td><td><button class="link-btn" data-unshare="${g.id}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Your calendar is not shared with anyone yet.</p>'}
    <div class="actions"><button class="btn" data-close>Close</button></div>`);
  attachAutocomplete($('#share-form input[name="email"]', m));
  $('#share-form', m).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/calendar/shares', { method: 'POST', body: { email: (f.email.value.match(/<([^>]+)>/)?.[1] || f.email.value).replace(/[,;\s]+$/, '').trim(), role: f.role.value } });
      toast('Calendar shared. They have been sent an email.'); shareCalendarDialog(pane);
    } catch (ex) { $('.form-error', m).textContent = ex.message; }
  };
  m.onclick = async (e) => {
    const b = e.target.closest('[data-unshare]');
    if (b) { await api(`/calendar/shares/${b.dataset.unshare}`, { method: 'DELETE' }); shareCalendarDialog(pane); }
  };
}

async function otherCalendarsDialog(pane) {
  const { received } = await api('/calendar/shares');
  const shown = shownCalendars();
  const m = modal(`<h2>People's calendars</h2>
    ${received.length ? `<form>${received.map((r, i) => `<label class="check"><input type="checkbox" value="${r.owner_id}" ${shown.includes(r.owner_id) ? 'checked' : ''}> <span class="cal-dot" style="background:${OTHER_COLORS[i % OTHER_COLORS.length]}"></span> ${esc(r.name)} <span class="muted small">${esc(r.email)} · ${SHARE_ROLES[r.role]}</span></label>`).join('')}</form>`
      : '<p class="muted">Nobody has shared a calendar with you yet. When someone does, it appears here.</p>'}
    <div class="actions"><button class="btn" data-close>Close</button></div>`);
  m.onchange = () => {
    localStorage.setItem('arzio-shown-calendars', JSON.stringify($$('input[type="checkbox"]:checked', m).map((x) => Number(x.value))));
    VIEWS.calendar(pane);
  };
}

async function sharedEvents(from, to) {
  const shown = shownCalendars();
  const { received } = await api('/calendar/shares').catch(() => ({ received: [] }));
  cal.editable = received.filter((r) => r.role === 'edit');
  const out = [];
  await Promise.all(received.map(async (r, i) => {
    if (!shown.includes(r.owner_id)) return;
    try {
      const { events, role } = await api(`/calendar/shared/${r.owner_id}/events?from=${from.toISOString()}&to=${to.toISOString()}`);
      for (const e of events) out.push({ ...e, owner: { id: r.owner_id, name: r.name, role }, color: OTHER_COLORS[i % OTHER_COLORS.length], my_status: 'organizer' });
    } catch { /* access removed */ }
  }));
  return { events: out, received };
}

function showSharedEvent(e, pane) {
  const canEdit = e.owner.role === 'edit';
  const m = modal(`<h2>${esc(e.title || '(no title)')}</h2>
    <p class="muted small">${esc(e.owner.name)}'s calendar</p>
    <p>${esc(fmtWhen(e.start_at, e.end_at, e.all_day))}</p>
    ${e.location ? `<p>\u{1F4CD} ${esc(e.location)}</p>` : ''}
    ${e.description ? `<p class="pre">${esc(e.description)}</p>` : ''}
    ${e.busy_only ? '<p class="muted small">Only free/busy times are shared.</p>' : ''}
    <div class="actions"><span class="grow"></span>${canEdit ? '<button class="btn" data-se="edit">Edit</button><button class="btn danger" data-se="delete">Delete</button>' : ''}<button class="btn" data-close>Close</button></div>`);
  m.onclick = async (ev) => {
    const b = ev.target.closest('[data-se]');
    if (!b) return;
    try {
      if (b.dataset.se === 'edit') { closeModal(); editEvent(e, pane, { owner: e.owner }); }
      if (b.dataset.se === 'delete' && confirm(`Delete this event from ${e.owner.name}'s calendar?`)) { await api(`/calendar/shared/${e.owner.id}/events/${e.id}`, { method: 'DELETE' }); closeModal(); VIEWS.calendar(pane); }
    } catch (ex) { toast(ex.message); }
  };
}

// ------------------------------------------------------------ Calendar
const cal = { view: 'week', date: new Date() };
const HOUR_PX = 44;
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const toLocalInput = (d) => { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const timeLabel = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const STATUS_CLASS = { 'needs-action': 'pending', tentative: 'tentative', declined: 'declined' };

function calRange() {
  if (cal.view === 'day') { const s = dayStart(cal.date); return [s, addDays(s, 1)]; }
  if (cal.view === 'week') { const s = addDays(dayStart(cal.date), -dayStart(cal.date).getDay()); return [s, addDays(s, 7)]; }
  const first = new Date(cal.date.getFullYear(), cal.date.getMonth(), 1);
  const s = addDays(first, -first.getDay());
  return [s, addDays(s, 42)];
}

VIEWS.calendar = async (pane, opts = {}) => {
  if (opts.date) cal.date = new Date(opts.date);
  if (window.innerWidth < 760 && cal.view === 'week') cal.view = 'day';
  const [from, to] = calRange();
  const [{ events: mine }, shared] = await Promise.all([api(`/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`), sharedEvents(from, to)]);
  const events = [...mine, ...shared.events];
  cal.shared = shared.events;
  const title = cal.view === 'month' ? cal.date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : cal.view === 'day' ? cal.date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : `${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(to, -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  pane.innerHTML = `<div class="cal-head">
      <button class="btn primary" data-cal="new">+ New event</button>
      <button class="btn" data-cal="today">Today</button>
      <button class="icon-btn" data-cal="prev" aria-label="Previous">‹</button><button class="icon-btn" data-cal="next" aria-label="Next">›</button>
      <h2>${esc(title)}</h2>
      <span class="grow"></span>
      <div class="seg">${['day', 'week', 'month'].map((v) => `<button data-calview="${v}" class="${cal.view === v ? 'active' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <button class="btn" data-cal="others" title="Calendars other people shared with you">\u{1F465} People's calendars</button>
      <button class="btn" data-cal="share" title="Share your calendar">Share</button>
      <label class="btn" title="Import an .ics file">Import<input type="file" accept=".ics,text/calendar" hidden id="ics-file"></label>
    </div>
    <div class="cal-body">${cal.view === 'month' ? monthGrid(from, events) : timeGrid(from, cal.view === 'day' ? 1 : 7, events)}</div>`;
  const body = $('.cal-body', pane);
  if (cal.view !== 'month') body.scrollTop = HOUR_PX * 7.5;
  const nav = (n) => {
    if (cal.view === 'month') cal.date = new Date(cal.date.getFullYear(), cal.date.getMonth() + n, 1);
    else cal.date = addDays(cal.date, n * (cal.view === 'day' ? 1 : 7));
    VIEWS.calendar(pane);
  };
  pane.onclick = (e) => {
    const b = e.target.closest('[data-cal], [data-calview], [data-ev], [data-slot], [data-day]');
    if (!b) return;
    if (b.dataset.cal === 'new') editEvent({}, pane);
    if (b.dataset.cal === 'share') shareCalendarDialog(pane);
    if (b.dataset.cal === 'others') otherCalendarsDialog(pane);
    if (b.dataset.ev && b.dataset.owner) { e.stopPropagation(); showSharedEvent(cal.shared.find((x) => String(x.id) === b.dataset.ev && String(x.owner.id) === b.dataset.owner), pane); return; }
    if (b.dataset.cal === 'today') { cal.date = new Date(); VIEWS.calendar(pane); }
    if (b.dataset.cal === 'prev') nav(-1);
    if (b.dataset.cal === 'next') nav(1);
    if (b.dataset.calview) { cal.view = b.dataset.calview; VIEWS.calendar(pane); }
    if (b.dataset.ev) { e.stopPropagation(); showEvent(Number(b.dataset.ev), pane); return; }
    if (b.dataset.slot) { const s = new Date(b.dataset.slot); editEvent({ start_at: s.toISOString(), end_at: new Date(s.getTime() + 3600e3).toISOString() }, pane); }
    if (b.dataset.day) { cal.date = new Date(b.dataset.day); cal.view = 'day'; VIEWS.calendar(pane); }
  };
  $('#ics-file', pane).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { const r = await api('/calendar/import', { method: 'POST', body: { ics: await f.text() } }); toast(`Imported ${r.imported} event(s).`); VIEWS.calendar(pane); } catch (ex) { toast(ex.message); }
  };
};

function evChip(e, extraStyle = '') {
  const cls = ['ev', STATUS_CLASS[e.my_status] || '', e.show_as === 'free' ? 'free' : ''].join(' ');
  return `<div class="${cls}${e.owner ? ' shared' : ''}" data-ev="${e.id}" ${e.owner ? `data-owner="${e.owner.id}"` : ''} style="${extraStyle}${e.color ? `--ev:${esc(e.color)};` : ''}" title="${esc(e.owner ? `${e.owner.name}: ${e.title}` : e.title)}">
    <strong>${e.owner ? `<span class="owner">${esc(e.owner.name.split(' ')[0])}:</span> ` : ''}${esc(e.title || '(no title)')}</strong>${e.all_day ? '' : ` <span>${timeLabel(e.start_at)}</span>`}${e.location ? `<div class="small">${esc(e.location)}</div>` : ''}</div>`;
}

function timeGrid(from, days, events) {
  const cols = [...Array(days)].map((_, i) => addDays(from, i));
  const today = dayStart(new Date()).getTime();
  const head = cols.map((d) => `<div class="cal-dayhead ${dayStart(d).getTime() === today ? 'today' : ''}" data-day="${d.toISOString()}">${d.toLocaleDateString(undefined, { weekday: 'short' })} <b>${d.getDate()}</b></div>`).join('');
  const allDay = cols.map((d) => {
    const list = events.filter((e) => e.all_day && new Date(e.start_at) < addDays(d, 1) && new Date(e.end_at) > d);
    return `<div class="cal-allday-cell">${list.map((e) => evChip(e)).join('')}</div>`;
  }).join('');
  const hours = [...Array(24)].map((_, h) => `<div class="cal-hour">${h ? new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }) : ''}</div>`).join('');
  const colHtml = cols.map((d) => {
    const dayEnd = addDays(d, 1);
    const list = events.filter((e) => !e.all_day && new Date(e.start_at) < dayEnd && new Date(e.end_at) > d)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    // simple overlap layout: place each event in the first free lane
    const lanes = [];
    const placed = list.map((e) => {
      const s = Math.max(new Date(e.start_at), d);
      const en = Math.min(new Date(e.end_at), dayEnd);
      let lane = lanes.findIndex((end) => end <= s);
      if (lane < 0) { lane = lanes.length; lanes.push(en); } else lanes[lane] = en;
      return { e, s, en, lane };
    });
    const n = Math.max(1, lanes.length);
    const slots = [...Array(48)].map((_, i) => `<div class="cal-slot" data-slot="${new Date(d.getTime() + i * 1800e3).toISOString()}"></div>`).join('');
    const evs = placed.map(({ e, s, en, lane }) => {
      const top = ((s - d) / 3600e3) * HOUR_PX;
      const h = Math.max(20, ((en - s) / 3600e3) * HOUR_PX - 2);
      return evChip(e, `position:absolute;top:${top}px;height:${h}px;left:${(lane / n) * 100}%;width:calc(${100 / n}% - 4px);`);
    }).join('');
    const nowLine = dayStart(d).getTime() === today ? `<div class="now-line" style="top:${((Date.now() - d) / 3600e3) * HOUR_PX}px"></div>` : '';
    return `<div class="cal-col">${slots}${evs}${nowLine}</div>`;
  }).join('');
  return `<div class="cal-grid" style="--days:${days}">
    <div></div>${head}
    <div class="cal-allday-label small muted">All day</div>${allDay}
    <div class="cal-hours">${hours}</div>${colHtml}</div>`;
}

function monthGrid(from, events) {
  const month = cal.date.getMonth();
  const today = dayStart(new Date()).getTime();
  const names = [...Array(7)].map((_, i) => `<div class="cal-dayhead">${addDays(from, i).toLocaleDateString(undefined, { weekday: 'short' })}</div>`).join('');
  const cells = [...Array(42)].map((_, i) => {
    const d = addDays(from, i);
    const list = events.filter((e) => new Date(e.start_at) < addDays(d, 1) && new Date(e.end_at) > d);
    const more = list.length > 3 ? `<div class="small muted">+${list.length - 3} more</div>` : '';
    return `<div class="cal-cell ${d.getMonth() !== month ? 'other' : ''} ${d.getTime() === today ? 'today' : ''}" data-slot="${new Date(d.getTime() + 9 * 3600e3).toISOString()}">
      <div class="cal-date" data-day="${d.toISOString()}">${d.getDate()}</div>${list.slice(0, 3).map((e) => evChip(e)).join('')}${more}</div>`;
  }).join('');
  return `<div class="cal-month">${names}${cells}</div>`;
}

async function showEvent(id, pane) {
  const { event: e } = await api(`/calendar/events/${id}`);
  const org = e.my_status === 'organizer';
  const statusIcon = { accepted: '✔', tentative: '?', declined: '✖', 'needs-action': '…' };
  const m = modal(`<h2>${esc(e.title || '(no title)')}</h2>
    <p>${esc(fmtWhen(e.start_at, e.end_at, e.all_day))}${e.recurrence !== 'none' ? ` · repeats ${esc(e.recurrence)}` : ''}</p>
    ${e.location ? `<p>\u{1F4CD} ${esc(e.location)}</p>` : ''}
    ${e.online_url ? `<p>\u{1F517} <a href="${esc(e.online_url)}" target="_blank" rel="noopener noreferrer">Join online</a></p>` : ''}
    ${e.description ? `<p class="pre">${esc(e.description)}</p>` : ''}
    <p class="muted small">Organizer: ${esc(org ? 'You' : e.organizer_name || e.organizer_email)}</p>
    ${e.attendees.length ? `<ul class="attendees">${e.attendees.map((a) => `<li title="${esc(a.status)}">${statusIcon[a.status] || '…'} ${esc(a.name || a.email)}</li>`).join('')}</ul>` : ''}
    <div id="brief-out"></div>
    <p class="form-error"></p>
    <div class="actions">
      ${state.me.ai_enabled ? '<button class="btn ai" data-e="brief">✨ Prepare me</button>' : ''}
      <span class="grow"></span>
      ${org ? '<button class="btn" data-e="edit">Edit</button>' : `<button class="btn" data-e="accepted">Accept</button><button class="btn" data-e="tentative">Tentative</button><button class="btn" data-e="declined">Decline</button>`}
      <button class="btn danger" data-e="delete">${org && e.attendees.length ? 'Cancel meeting' : 'Delete'}</button>
      <button class="btn" data-close>Close</button>
    </div>`);
  m.onclick = async (ev) => {
    const b = ev.target.closest('[data-e]');
    if (!b) return;
    const err = $('.form-error', m);
    try {
      if (b.dataset.e === 'edit') { closeModal(); editEvent(e, pane); }
      if (['accepted', 'tentative', 'declined'].includes(b.dataset.e)) { await api(`/calendar/events/${e.id}/respond`, { method: 'POST', body: { status: b.dataset.e } }); closeModal(); toast('Response sent.'); VIEWS.calendar(pane); }
      if (b.dataset.e === 'delete') {
        if (!confirm(org && e.attendees.length ? 'Cancel this meeting and tell the attendees?' : 'Delete this event?')) return;
        await api(`/calendar/events/${e.id}`, { method: 'DELETE' }); closeModal(); VIEWS.calendar(pane);
      }
      if (b.dataset.e === 'brief') {
        busy(b, true, 'Preparing…');
        const r = await api(`/calendar/events/${e.id}/brief`, { method: 'POST', body: {} });
        $('#brief-out', m).innerHTML = `<div class="ai-card"><p>${esc(r.brief)}</p>${r.openQuestions?.length ? `<p><strong>Open questions</strong></p><ul>${r.openQuestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${r.sources.length ? `<p class="small muted">Based on: ${r.sources.map((s) => esc(s.subject)).join(' · ')}</p>` : ''}</div>`;
        busy(b, false);
      }
    } catch (ex) { busy(b, false); err.textContent = ex.message; }
  };
}

function editEvent(e, pane, opts = {}) {
  const editable = (cal.editable || []);
  const start = e.start_at ? new Date(e.start_at) : (() => { const d = new Date(); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0); return d; })();
  const end = e.end_at ? new Date(e.end_at) : new Date(start.getTime() + 3600e3);
  const reminders = [[null, 'None'], [0, 'At start'], [5, '5 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];
  const m = modal(`<h2>${e.id ? 'Edit event' : 'New event'}${opts.owner ? ` <span class="muted small">in ${esc(opts.owner.name)}'s calendar</span>` : ''}</h2><form id="ev-form">
    ${!e.id && editable.length ? `<label>Calendar<select name="owner"><option value="">My calendar</option>${editable.map((r) => `<option value="${r.owner_id}">${esc(r.name)}</option>`).join('')}</select></label>` : ''}
    <label>Title<input name="title" value="${esc(e.title || '')}" required></label>
    <label>Invite attendees<input name="attendees" value="${esc((e.attendees || []).map((a) => a.email).join(', '))}" placeholder="name@example.com, …"></label>
    <div class="row"><label>Start<input type="datetime-local" name="start" value="${toLocalInput(start)}" required></label><label>End<input type="datetime-local" name="end" value="${toLocalInput(end)}" required></label></div>
    <label class="check"><input type="checkbox" name="all_day" ${e.all_day ? 'checked' : ''}> All day</label>
    <button type="button" class="link-btn" id="sched-btn">Scheduling assistant: see when people are free</button>
    <div id="sched-out"></div>
    <div class="row"><label>Location<input name="location" value="${esc(e.location || '')}"></label><label>Online meeting link<input name="online_url" value="${esc(e.online_url || '')}" placeholder="https://…"></label></div>
    <div class="row">
      <label>Repeat<select name="recurrence">${['none', 'daily', 'weekly', 'monthly', 'yearly'].map((r) => `<option value="${r}" ${(e.recurrence || 'none') === r ? 'selected' : ''}>${r === 'none' ? 'Does not repeat' : r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></label>
      <label>Until<input type="date" name="recur_until" value="${e.recur_until ? e.recur_until.slice(0, 10) : ''}"></label>
      <label>Reminder<select name="reminder_minutes">${reminders.map(([v, l]) => `<option value="${v ?? ''}" ${(e.id ? e.reminder_minutes : 15) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Show as<select name="show_as">${['busy', 'tentative', 'free', 'oof'].map((v) => `<option value="${v}" ${(e.show_as || 'busy') === v ? 'selected' : ''}>${{ busy: 'Busy', tentative: 'Tentative', free: 'Free', oof: 'Away' }[v]}</option>`).join('')}</select></label>
    </div>
    <label>Description<textarea name="description" rows="4">${esc(e.description || '')}</textarea></label>
    <p class="form-error"></p>
    <div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">${e.id ? 'Save' : (e.attendees?.length ? 'Send' : 'Save')}</button></div></form>`);
  const f = $('#ev-form', m);
  const attendeesInput = f.attendees;
  attachAutocomplete(attendeesInput);
  f.attendees.oninput = () => { $('.btn.primary', f).textContent = e.id ? (attendeesInput.value.trim() ? 'Send update' : 'Save') : (attendeesInput.value.trim() ? 'Send' : 'Save'); };
  f.attendees.oninput();
  $('#sched-btn', f).onclick = async () => {
    const day = dayStart(new Date(f.start.value));
    const emails = f.attendees.value.split(/[,;]+/).map((x) => (x.match(/<([^>]+)>/)?.[1] || x).trim()).filter(Boolean);
    const { busy: bz } = await api('/calendar/freebusy', { method: 'POST', body: { emails, from: day.toISOString(), to: addDays(day, 1).toISOString() } });
    const pct = (d) => Math.max(0, Math.min(100, ((new Date(d) - day) / 86400e3) * 100));
    const sel = [pct(new Date(f.start.value)), pct(new Date(f.end.value))];
    $('#sched-out', f).innerHTML = `<div class="sched">${Object.entries(bz).map(([who, list]) => `<div class="sched-row"><span class="sched-name">${who === state.me.email ? 'You' : esc(who)}</span><div class="sched-bar">
      <div class="sched-sel" style="left:${sel[0]}%;width:${sel[1] - sel[0]}%"></div>
      ${list === null ? '<span class="small muted" style="padding-left:6px">Availability not shared</span>' : list.map((b) => `<div class="sched-busy ${b.status}" style="left:${pct(b.start)}%;width:${pct(b.end) - pct(b.start)}%" title="${timeLabel(b.start)} – ${timeLabel(b.end)}"></div>`).join('')}
      </div></div>`).join('')}<div class="sched-row"><span class="sched-name"></span><div class="sched-scale small muted"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span></span></div></div></div>`;
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const allDay = f.all_day.checked;
    let s = new Date(f.start.value);
    let en = new Date(f.end.value);
    if (allDay) { s = new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate())); en = new Date(Date.UTC(en.getFullYear(), en.getMonth(), en.getDate()) + 86400e3); }
    const body = {
      title: f.title.value, start_at: s.toISOString(), end_at: en.toISOString(), all_day: allDay,
      attendees: f.attendees.value.split(/[,;]+/).map((x) => (x.match(/<([^>]+)>/)?.[1] || x).trim()).filter(Boolean),
      location: f.location.value, online_url: f.online_url.value, recurrence: f.recurrence.value,
      recur_until: f.recur_until.value ? new Date(`${f.recur_until.value}T23:59:59`).toISOString() : null,
      reminder_minutes: f.reminder_minutes.value === '' ? null : Number(f.reminder_minutes.value), show_as: f.show_as.value, description: f.description.value,
    };
    try {
      const owner = opts.owner?.id || (f.owner && f.owner.value) || '';
      const base = owner ? `/calendar/shared/${owner}/events` : '/calendar/events';
      await api(e.id ? `${base}/${e.id}` : base, { method: e.id ? 'PUT' : 'POST', body });
      closeModal();
      toast(body.attendees.length ? 'Invitations sent.' : 'Saved.');
      cal.date = s;
      if (state.view === 'calendar') VIEWS.calendar(pane);
    } catch (ex) { $('.form-error', f).textContent = ex.message; }
  };
}

// ------------------------------------------------------------ To Do
const todo = { list: 'Tasks' };
VIEWS.tasks = async (pane) => {
  const { tasks, lists, flagged } = await api('/tasks');
  const listNames = [...new Set(['Tasks', ...lists.map((l) => l.name)])];
  const openCount = (n) => lists.find((l) => l.name === n)?.open || 0;
  const shown = todo.list === '__important' ? tasks.filter((t) => t.important) : todo.list === '__flagged' ? [] : tasks.filter((t) => t.list_name === todo.list);
  const due = (t) => (t.due_at ? `<span class="small ${!t.completed && new Date(t.due_at) < dayStart(new Date()) ? 'overdue' : 'muted'}">Due ${new Date(t.due_at).toLocaleDateString()}</span>` : '');
  const row = (t) => `<li class="task ${t.completed ? 'done' : ''}" data-task="${t.id}">
      <input type="checkbox" data-t="toggle" ${t.completed ? 'checked' : ''} aria-label="Complete">
      <div class="task-main" data-t="edit"><div>${esc(t.title)}</div><div>${due(t)}${t.reminder_at && !t.completed ? ` <span class="small muted">\u{1F514} ${new Date(t.reminder_at).toLocaleString()}</span>` : ''}${t.message_id ? ' <span class="small muted">\u{2709} from email</span>' : ''}${todo.list === '__important' ? ` <span class="small muted">${esc(t.list_name)}</span>` : ''}</div></div>
      <button class="icon-btn star ${t.important ? 'on' : ''}" data-t="star" aria-label="Important">${t.important ? '★' : '☆'}</button></li>`;
  const open = shown.filter((t) => !t.completed);
  const done = shown.filter((t) => t.completed);
  pane.innerHTML = `<div class="todo">
    <aside class="todo-lists">
      <button data-list="__important" class="${todo.list === '__important' ? 'active' : ''}">★ Important <span>${tasks.filter((t) => t.important && !t.completed).length || ''}</span></button>
      <button data-list="__flagged" class="${todo.list === '__flagged' ? 'active' : ''}">⚑ Flagged email <span>${flagged.length || ''}</span></button>
      <hr>
      ${listNames.map((n) => `<button data-list="${esc(n)}" class="${todo.list === n ? 'active' : ''}">☰ ${esc(n)} <span>${openCount(n) || ''}</span></button>`).join('')}
      <button class="link-btn" data-t="newlist">+ New list</button>
    </aside>
    <section class="todo-main">
      <h2>${esc(todo.list === '__important' ? 'Important' : todo.list === '__flagged' ? 'Flagged email' : todo.list)}</h2>
      ${todo.list === '__flagged' ? `<ul class="tasks">${flagged.map((m) => `<li class="task" data-mail="${m.id}"><span>⚑</span><div class="task-main"><div>${esc(m.subject || '(no subject)')}</div><div class="small muted">${esc(m.from_name || m.from_addr)} · ${fmtDate(m.date)}</div></div></li>`).join('') || '<li class="muted">Flag an email and it shows up here.</li>'}</ul>`
        : `<form id="task-add" class="task-add"><input name="title" placeholder="+ Add a task" autocomplete="off"><input type="date" name="due" aria-label="Due date"><button class="btn primary">Add</button></form>
      <ul class="tasks">${open.map(row).join('') || '<li class="muted">Nothing to do here.</li>'}</ul>
      ${done.length ? `<details><summary>Completed (${done.length})</summary><ul class="tasks">${done.map(row).join('')}</ul></details>` : ''}`}
    </section></div>`;
  const add = $('#task-add', pane);
  if (add) {
    add.onsubmit = async (e) => {
      e.preventDefault();
      if (!add.title.value.trim()) return;
      await api('/tasks', { method: 'POST', body: { title: add.title.value, list_name: todo.list.startsWith('__') ? 'Tasks' : todo.list, important: todo.list === '__important', due_at: add.due.value ? new Date(`${add.due.value}T17:00:00`).toISOString() : null } });
      VIEWS.tasks(pane).then(() => $('#task-add input', pane)?.focus());
    };
  }
  pane.onclick = async (e) => {
    const l = e.target.closest('[data-list]');
    if (l) { todo.list = l.dataset.list; return VIEWS.tasks(pane); }
    const mail = e.target.closest('[data-mail]');
    if (mail) { showMailView(); return openMessage(Number(mail.dataset.mail)); }
    const act = e.target.closest('[data-t]')?.dataset.t;
    if (act === 'newlist') { const n = prompt('List name'); if (n?.trim()) { todo.list = n.trim(); VIEWS.tasks(pane); } return; }
    const li = e.target.closest('[data-task]');
    if (!li || !act) return;
    const t = tasks.find((x) => x.id === Number(li.dataset.task));
    try {
      if (act === 'toggle') await api(`/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } });
      if (act === 'star') await api(`/tasks/${t.id}`, { method: 'PATCH', body: { important: !t.important } });
      if (act === 'edit') return editTask(t, pane, listNames);
      VIEWS.tasks(pane);
    } catch (ex) { toast(ex.message); }
  };
};

function editTask(t, pane, listNames) {
  const m = modal(`<h2>Task</h2><form>
    <label>Title<input name="title" value="${esc(t.title)}" required></label>
    <div class="row"><label>Due<input type="date" name="due" value="${t.due_at ? toLocalInput(t.due_at).slice(0, 10) : ''}"></label>
    <label>Remind me<input type="datetime-local" name="reminder" value="${t.reminder_at ? toLocalInput(t.reminder_at) : ''}"></label>
    <label>List<select name="list_name">${listNames.map((n) => `<option ${n === t.list_name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
    <label>Notes<textarea name="notes" rows="4">${esc(t.notes)}</textarea></label>
    ${t.message_id ? '<button type="button" class="link-btn" id="task-mail">Open the email</button>' : ''}
    <p class="form-error"></p>
    <div class="actions"><button type="button" class="btn danger" id="task-del">Delete</button><span class="grow"></span><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  const f = $('form', m);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { title: f.title.value, notes: f.notes.value, list_name: f.list_name.value, due_at: f.due.value ? new Date(`${f.due.value}T17:00:00`).toISOString() : null, reminder_at: f.reminder.value ? new Date(f.reminder.value).toISOString() : null } });
      closeModal(); VIEWS.tasks(pane);
    } catch (ex) { $('.form-error', f).textContent = ex.message; }
  };
  $('#task-del', f).onclick = async () => { await api(`/tasks/${t.id}`, { method: 'DELETE' }); closeModal(); VIEWS.tasks(pane); };
  const open = $('#task-mail', f);
  if (open) open.onclick = () => { closeModal(); showMailView(); openMessage(t.message_id); };
}

// ------------------------------------------------------------ Organization admin center
const ADMIN_TABS = [['users', 'Users'], ['shared', 'Shared mailboxes'], ['groups', 'Groups'], ['domains', 'Domains'], ['mailflow', 'Mail flow & DLP'],
  ['trace', 'Message trace'], ['compliance', 'Retention & eDiscovery'], ['audit', 'Audit log'], ['reports', 'Reports'], ['billing', 'Billing']];
// ------------------------------------------------------------ plans and billing
const money = (minor, cur) => { try { return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency: cur, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100); } catch { return `${cur} ${(minor / 100).toFixed(2)}`; } };
const FEATURE_LABELS = { custom_domain: 'Your own domain', shared_mailboxes: 'Shared mailboxes', groups: 'Groups', compliance: 'DLP, retention, litigation hold, eDiscovery', priority_support: 'Priority support' };
function planCards(o, { business }) {
  const cur = o.subscription?.plan || o.plan.code;
  const ai = (n) => (n < 0 ? 'Unlimited AI' : n === 0 ? 'No AI' : `${n} AI requests a day`);
  return `<div class="plans">${o.plans.map((p) => `<div class="plan ${p.code === cur ? 'current' : ''}">
    <h4>${esc(p.name)}</h4>
    <div class="price">${p.price_month ? `${money(p.price_month, o.currency)}<span>/${business ? 'user/' : ''}month</span>` : 'Free'}</div>
    ${p.price_year ? `<div class="muted small">or ${money(p.price_year, o.currency)} a year${business ? ' per user' : ''}, plus ${esc(o.tax.name)}</div>` : '<div class="muted small">&nbsp;</div>'}
    <p class="small">${esc(p.description)}</p>
    <ul class="small"><li>${fmtBytes(p.storage_mb * 1048576)} mailbox</li><li>${p.sends_per_day.toLocaleString()} emails a day</li><li>${ai(p.ai_per_day)}</li>${p.features.filter((f) => FEATURE_LABELS[f]).map((f) => `<li>${FEATURE_LABELS[f]}</li>`).join('')}</ul>
    ${p.code === cur ? '<span class="tag">Current plan</span>' : `<button class="btn ${p.price_month ? 'primary' : ''}" data-plan="${p.code}">${p.price_month ? 'Choose' : 'Switch to Free'}</button>`}
  </div>`).join('')}</div>`;
}
function invoiceTable(invoices) {
  if (!invoices.length) return '<p class="muted">No invoices yet.</p>';
  return `<table><thead><tr><th>Invoice</th><th>Date</th><th>For</th><th>Total</th><th></th></tr></thead><tbody>${invoices.map((i) => `<tr><td>${esc(i.number)}</td><td>${fmtDate(`${i.created_at.replace(' ', 'T')}Z`, true)}</td><td class="small">${esc(i.description)}</td><td>${money(i.total, i.currency)}</td><td><a href="/api/billing/invoices/${i.id}" target="_blank" rel="noopener">View</a></td></tr>`).join('')}</tbody></table>`;
}
function subLine(o) {
  const s = o.subscription;
  if (!s) return `You are on <strong>${esc(o.plan.name)}</strong>.`;
  const end = s.currentPeriodEnd ? fmtDate(s.currentPeriodEnd, true) : '';
  const status = s.status === 'past_due' ? ' <span class="overdue">Payment failed. Update your payment method to keep your plan.</span>' : '';
  return `You are on <strong>${esc(s.planName)}</strong>${s.seats > 1 ? ` for ${s.seats} users` : ''}, billed ${s.interval === 'year' ? 'yearly' : 'monthly'}${s.provider === 'manual' ? ' by invoice' : ''}.
    ${end ? (s.cancelAtPeriodEnd ? `It ends on ${end}.` : `Renews on ${end}.`) : ''}${status}`;
}
// Wires plan buttons. post(path, body) -> { url } | { subscription }
function wirePlans(root, o, { business, base, onDone, err }) {
  const interval = () => ($('[name=interval]:checked', root)?.value || 'month');
  $$('[data-plan]', root).forEach((b) => {
    b.onclick = async () => {
      err.textContent = '';
      try {
        const body = { plan: b.dataset.plan, interval: interval() };
        if (business) {
          const n = prompt('How many users (seats)?', String(Math.max(o.usage.users, o.subscription?.seats || 1)));
          if (!n) return;
          body.seats = Number(n);
        }
        const r = await api(`${base}/checkout`, { method: 'POST', body });
        if (r.url) { location.href = r.url; return; }
        toast('Plan changed.'); onDone();
      } catch (ex) { err.textContent = ex.message; }
    };
  });
  const c = $('[data-cancel-plan]', root);
  if (c) c.onclick = async () => {
    if (!confirm('Cancel your plan? You keep it until the end of the paid period.')) return;
    try { await api(`${base}/cancel`, { method: 'POST', body: {} }); toast('Your plan will end at the end of the period.'); onDone(); } catch (ex) { err.textContent = ex.message; }
  };
}
function billingIntro(o) {
  const used = o.usage.aiPerDay < 0 ? `${o.usage.aiToday} AI requests today` : `${o.usage.aiToday} of ${o.usage.aiPerDay} AI requests used today`;
  return `<p>${subLine(o)}</p><p class="muted small">${used}. Mailbox size ${fmtBytes(o.usage.storageBytes)}, up to ${o.usage.sendsPerDay.toLocaleString()} emails a day.</p>
    ${o.canPayOnline ? '' : '<p class="muted small">Online payment is not set up on this server yet. Contact support to upgrade.</p>'}
    <div class="row interval"><label class="check"><input type="radio" name="interval" value="month" checked> Monthly</label><label class="check"><input type="radio" name="interval" value="year"> Yearly (2 months free)</label></div>`;
}

const adminState = { tab: 'users' };
async function openOrgAdmin() { showView('admin'); }

VIEWS.admin = async (pane, opts = {}) => {
  if (opts.tab) adminState.tab = opts.tab;
  const tab = adminState.tab;
  const [{ org }, { domains }] = await Promise.all([api('/org'), api('/org/domains')]);
  const verified = domains.filter((d) => d.verified);
  const domainSelect = verified.length ? `<select name="domain">${verified.map((d) => `<option>${esc(d.name)}</option>`).join('')}</select>` : '';
  pane.innerHTML = `<h2>${esc(org.name)} · Admin center</h2>
    <div class="tabbar">${ADMIN_TABS.filter(([k]) => k !== 'billing' || state.service?.billing).map(([k, l]) => `<button data-atab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="admin-body"></div><p class="form-error" id="admin-err"></p>`;
  $$('[data-atab]', pane).forEach((b) => { b.onclick = () => VIEWS.admin(pane, { tab: b.dataset.atab }); });
  const body = $('#admin-body', pane);
  const err = $('#admin-err', pane);
  const reload = () => VIEWS.admin(pane);
  const guard = (fn) => async (e) => { if (e?.type === 'submit') e.preventDefault(); err.textContent = ''; try { await fn(e); } catch (ex) { err.textContent = ex.message; } };
  const when = (t) => (t ? fmtDate(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`, true) : '');
  const needDomain = '<p class="muted">Verify a domain first (Domains tab).</p>';

  if (tab === 'users') {
    const { users } = await api('/org/users');
    body.innerHTML = `<p class="muted">${users.length} of ${org.max_users || '∞'} users</p>
      <table class="people"><thead><tr><th>Address</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td><td>${u.role === 'org_admin' ? 'Admin' : 'User'}</td><td>${u.is_disabled ? 'Disabled' : 'Active'}</td>
        <td><button class="link-btn" data-u="${u.id}" data-op="${u.is_disabled ? 'enable' : 'disable'}">${u.is_disabled ? 'Enable' : 'Disable'}</button>
        <button class="link-btn" data-u="${u.id}" data-op="reset">Reset password</button>
        <button class="link-btn" data-u="${u.id}" data-op="${u.role === 'org_admin' ? 'demote' : 'promote'}">${u.role === 'org_admin' ? 'Make user' : 'Make admin'}</button></td></tr>`).join('')}
      </tbody></table>
      <h3>Add user</h3>
      ${verified.length ? `<form id="add-user" class="row"><label>Name<input name="name" required></label><label>Username<input name="username" required></label>
        <label>Domain${domainSelect}</label><label>Temporary password<input name="password" minlength="8" required></label><button class="btn primary">Add</button></form>` : needDomain}`;
    body.onclick = guard(async (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const op = b.dataset.op;
      const payload = op === 'disable' ? { is_disabled: true } : op === 'enable' ? { is_disabled: false } : op === 'promote' ? { role: 'org_admin' } : op === 'demote' ? { role: 'user' } : {};
      if (op === 'reset') { const p = prompt('New temporary password (8+ characters):'); if (!p) return; payload.password = p; }
      await api(`/org/users/${b.dataset.u}`, { method: 'PATCH', body: payload });
      reload();
    });
    const f = $('#add-user', body);
    if (f) f.onsubmit = guard(async () => { await api('/org/users', { method: 'POST', body: { name: f.name.value, username: f.username.value, domain: f.domain.value, password: f.password.value } }); toast('User added.'); reload(); });
  }

  if (tab === 'shared') {
    const { mailboxes } = await api('/org/shared-mailboxes');
    const permLabel = { full: 'Full access', send_as: 'Read and send as', send_on_behalf: 'Read and send on behalf', read: 'Read only' };
    body.innerHTML = `<p class="muted">Shared mailboxes (like info@ or support@) have no password. Members open them from the mailbox list in their sidebar.</p>
      ${mailboxes.map((b) => `<div class="card-row"><div><strong>${esc(b.name)}</strong> <span class="muted">${esc(b.email)}</span>
        <div class="small">${b.members.map((m) => `${esc(m.email)} (${permLabel[m.permission]})`).join(', ') || '<span class="muted">No members</span>'}</div></div>
        <button class="btn" data-members="${b.id}">Members</button></div>`).join('') || '<p class="muted">No shared mailboxes yet.</p>'}
      <h3>New shared mailbox</h3>
      ${verified.length ? `<form id="add-shared"><div class="row"><label>Display name<input name="name" placeholder="Acme Support" required></label><label>Address<input name="username" placeholder="support" required></label><label>Domain${domainSelect}</label></div>
        <label>Members (one per line: email, and optionally full / send_as / send_on_behalf / read)<textarea name="members" rows="3" placeholder="ann@${esc(verified[0].name)} send_as"></textarea></label>
        <button class="btn primary">Create</button></form>` : needDomain}`;
    const parse = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [email, permission] = l.split(/[\s,]+/); return { email, permission: permission || 'full' }; });
    const f = $('#add-shared', body);
    if (f) f.onsubmit = guard(async () => { await api('/org/shared-mailboxes', { method: 'POST', body: { name: f.name.value, username: f.username.value, domain: f.domain.value, members: parse(f.members.value) } }); toast('Shared mailbox created.'); reload(); });
    body.onclick = guard(async (e) => {
      const b = e.target.closest('[data-members]');
      if (!b) return;
      const box = mailboxes.find((x) => x.id === Number(b.dataset.members));
      const v = prompt(`Members of ${box.email}, one per line as "email permission" (full, send_as, send_on_behalf, read). Separate with ; here:`, box.members.map((m) => `${m.email} ${m.permission}`).join('; '));
      if (v === null) return;
      await api(`/org/shared-mailboxes/${box.id}/members`, { method: 'PUT', body: { members: parse(v.replace(/;/g, '\n')) } });
      reload();
    });
  }

  if (tab === 'groups') {
    const { groups } = await api('/org/groups');
    body.innerHTML = `<p class="muted">Mail sent to a group address goes to every member.</p>
      ${groups.map((g) => `<div class="card-row"><div><strong>${esc(g.name)}</strong> <span class="muted">${esc(g.address)}</span> ${g.allow_external ? '<span class="tag">Accepts outside mail</span>' : ''}
        <div class="small">${g.members.map((m) => esc(m.email)).join(', ') || '<span class="muted">No members</span>'}</div></div>
        <div><button class="btn" data-gedit="${g.id}">Edit members</button> <button class="btn" data-gext="${g.id}">${g.allow_external ? 'Internal only' : 'Allow outside senders'}</button> <button class="btn danger" data-gdel="${g.id}">Delete</button></div></div>`).join('') || '<p class="muted">No groups yet.</p>'}
      <h3>New group</h3>
      ${verified.length ? `<form id="add-group"><div class="row"><label>Name<input name="name" placeholder="Sales team" required></label><label>Address<input name="username" placeholder="sales" required></label><label>Domain${domainSelect}</label></div>
        <label>Members (comma separated emails)<input name="members" required></label><label class="check"><input type="checkbox" name="allow_external"> People outside the organization can email this group</label>
        <button class="btn primary">Create</button></form>` : needDomain}`;
    const split = (v) => v.split(/[,;\s]+/).filter(Boolean);
    const f = $('#add-group', body);
    if (f) f.onsubmit = guard(async () => { await api('/org/groups', { method: 'POST', body: { name: f.name.value, username: f.username.value, domain: f.domain.value, members: split(f.members.value), allow_external: f.allow_external.checked } }); toast('Group created.'); reload(); });
    body.onclick = guard(async (e) => {
      const ed = e.target.closest('[data-gedit]');
      const ext = e.target.closest('[data-gext]');
      const del = e.target.closest('[data-gdel]');
      const g = groups.find((x) => x.id === Number((ed || ext || del)?.dataset.gedit || (ed || ext || del)?.dataset.gext || (ed || ext || del)?.dataset.gdel));
      if (!g) return;
      if (ed) { const v = prompt(`Members of ${g.address} (comma separated):`, g.members.map((m) => m.email).join(', ')); if (v === null) return; await api(`/org/groups/${g.id}`, { method: 'PUT', body: { members: split(v) } }); }
      if (ext) await api(`/org/groups/${g.id}`, { method: 'PUT', body: { allow_external: !g.allow_external } });
      if (del) { if (!confirm(`Delete ${g.address}?`)) return; await api(`/org/groups/${g.id}`, { method: 'DELETE' }); }
      reload();
    });
  }

  if (tab === 'domains') {
    body.innerHTML = `${domains.map((d) => `<div style="margin-bottom:14px"><strong>${esc(d.name)}</strong> ${d.verified ? '<span class="tag cat">Verified</span>' : `<span class="tag high">Not verified</span> <button class="btn" data-verify="${d.id}">Check DNS</button>`}
      <table><thead><tr><th>Type</th><th>Host</th><th>Value</th><th>Purpose</th></tr></thead><tbody>${d.dns.map((r) => `<tr><td>${r.type}</td><td><code>${esc(r.host)}</code></td><td><code class="wrap">${esc(r.value)}</code></td><td>${esc(r.purpose)}</td></tr>`).join('')}</tbody></table></div>`).join('')}
      <form id="add-domain" class="row"><label>Add a domain<input name="name" placeholder="example.com" required></label><button class="btn">Add domain</button></form>`;
    body.onclick = guard(async (e) => { const b = e.target.closest('[data-verify]'); if (!b) return; await api(`/org/domains/${b.dataset.verify}/verify`, { method: 'POST', body: {} }); toast('Domain verified.'); reload(); });
    $('#add-domain', body).onsubmit = guard(async (e) => { await api('/org/domains', { method: 'POST', body: { name: e.target.name.value } }); reload(); });
  }

  if (tab === 'mailflow') {
    const [{ rules }, { types }] = await Promise.all([api('/org/transport-rules'), api('/org/sensitive-types')]);
    const label = Object.fromEntries(types.map((t) => [t.id, t.label]));
    const desc = (r) => {
      const c = [];
      if (r.match.externalRecipients) c.push('sent outside the organization');
      if (r.match.recipientDomain) c.push(`sent to @${r.match.recipientDomain}`);
      if (r.match.subjectContains) c.push(`subject contains "${r.match.subjectContains}"`);
      if (r.match.bodyContains) c.push(`body contains "${r.match.bodyContains}"`);
      if (r.match.sensitiveInfo?.length) c.push(`contains ${r.match.sensitiveInfo.map((k) => label[k] || k).join(' or ')}`);
      const a = r.action === 'block' ? 'block it' : r.action === 'bcc' ? `send a copy to ${r.value}` : 'add the disclaimer';
      return `If ${c.join(' and ') || 'any message'}: ${a}`;
    };
    body.innerHTML = `<p class="muted">Rules run on every message your people send, from the web, mail apps and AI agents. Data loss prevention (DLP) rules look for sensitive information such as card numbers.</p>
      ${rules.map((r) => `<div class="card-row"><div><strong>${esc(r.name)}</strong> ${r.enabled ? '' : '<span class="tag">Off</span>'}<div class="small">${esc(desc(r))}</div></div>
        <div><button class="btn" data-rtoggle="${r.id}">${r.enabled ? 'Turn off' : 'Turn on'}</button> <button class="btn danger" data-rdel="${r.id}">Delete</button></div></div>`).join('') || '<p class="muted">No rules yet.</p>'}
      <h3>New rule</h3>
      <form id="add-rule">
        <label>Name<input name="name" placeholder="Block card numbers going outside" required></label>
        <fieldset><legend>When a message…</legend>
          <label class="check"><input type="checkbox" name="externalRecipients"> is sent to someone outside the organization</label>
          <div class="row"><label>Recipient domain is<input name="recipientDomain" placeholder="competitor.com"></label><label>Subject contains<input name="subjectContains"></label><label>Body contains<input name="bodyContains"></label></div>
          <div class="muted small">Contains sensitive information (DLP):</div>
          <div class="row">${types.map((t) => `<label class="check"><input type="checkbox" name="si" value="${t.id}"> ${esc(t.label)}</label>`).join('')}</div>
        </fieldset>
        <div class="row"><label>Then<select name="action"><option value="block">Block the message</option><option value="bcc">Send a copy (Bcc) to</option><option value="disclaimer">Add a disclaimer</option></select></label>
        <label>Block message / copy address / disclaimer text<input name="value"></label></div>
        <button class="btn primary">Create rule</button></form>`;
    const f = $('#add-rule', body);
    f.onsubmit = guard(async () => {
      await api('/org/transport-rules', { method: 'POST', body: { name: f.name.value, action: f.action.value, value: f.value.value,
        match: { externalRecipients: f.externalRecipients.checked, recipientDomain: f.recipientDomain.value, subjectContains: f.subjectContains.value, bodyContains: f.bodyContains.value, sensitiveInfo: $$('[name=si]:checked', f).map((x) => x.value) } } });
      toast('Rule created.'); reload();
    });
    body.onclick = guard(async (e) => {
      const t = e.target.closest('[data-rtoggle]');
      const d = e.target.closest('[data-rdel]');
      if (t) { const r = rules.find((x) => x.id === Number(t.dataset.rtoggle)); await api(`/org/transport-rules/${r.id}`, { method: 'PUT', body: { ...r, enabled: !r.enabled } }); reload(); }
      if (d && confirm('Delete this rule?')) { await api(`/org/transport-rules/${d.dataset.rdel}`, { method: 'DELETE' }); reload(); }
    });
  }

  if (tab === 'trace') {
    body.innerHTML = `<form id="trace-form" class="row"><label>Sender, recipient or subject<input name="q" value="${esc(opts.q || '')}"></label>
      <label>Period<select name="days">${[1, 7, 30, 90].map((d) => `<option value="${d}" ${(opts.days || 7) === d ? 'selected' : ''}>Last ${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></label><button class="btn primary">Search</button></form>
      <div id="trace-out" class="muted">Loading…</div>`;
    const run = async (q = '', days = 7) => {
      const { trace } = await api(`/org/message-trace?q=${encodeURIComponent(q)}&days=${days}`);
      $('#trace-out', body).innerHTML = trace.length ? `<table class="people"><thead><tr><th>Time</th><th>Direction</th><th>From</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
        ${trace.map((t) => `<tr><td class="small">${esc(when(t.time))}</td><td>${esc(t.direction)}</td><td>${esc(t.from)}</td><td>${esc(t.to)}</td><td>${esc(t.subject)}</td><td title="${esc(t.detail || '')}">${esc(t.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No messages found.</p>';
    };
    $('#trace-form', body).onsubmit = guard((e) => run(e.target.q.value, e.target.days.value));
    run();
  }

  if (tab === 'compliance') {
    const c = await api('/org/compliance');
    body.innerHTML = `<h3>Retention</h3>
      <form id="ret-form" class="row"><label>Delete mail older than<select name="retention_days">${[[0, 'Keep forever'], [90, '90 days'], [365, '1 year'], [730, '2 years'], [1825, '5 years'], [2555, '7 years']].map(([v, l]) => `<option value="${v}" ${c.retention_days === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn">Save</button></form>
      <h3>Litigation hold</h3>
      <p>${c.litigation_hold ? '<span class="tag high">On</span> Nothing in this organization is permanently deleted. Mail people delete is kept, hidden, for eDiscovery. Retention is paused.' : '<span class="tag">Off</span> Turn on to preserve all mail during a legal matter or investigation.'}</p>
      <button class="btn ${c.litigation_hold ? '' : 'danger'}" id="hold-btn">${c.litigation_hold ? 'Release hold' : 'Place organization on hold'}</button>
      <h3>eDiscovery search</h3>
      <form id="ed-form"><div class="row"><label>Keywords<input name="q" placeholder="invoice Globex"></label><label>Mailbox (optional)<input name="mailbox" placeholder="name@${esc(verified[0]?.name || 'example.com')}"></label>
        <label>From<input type="date" name="from"></label><label>To<input type="date" name="to"></label></div>
        <button class="btn primary">Search all mailboxes</button> <button class="btn" type="button" id="ed-export">Export results (.mbox)</button></form>
      <div id="ed-out"></div><p class="muted small">Every search and export is recorded in the audit log.</p>`;
    $('#ret-form', body).onsubmit = guard(async (e) => { await api('/org/compliance', { method: 'PATCH', body: { retention_days: Number(e.target.retention_days.value) } }); toast('Retention saved.'); });
    $('#hold-btn', body).onclick = guard(async () => {
      if (!confirm(c.litigation_hold ? 'Release the litigation hold? Deleted mail can then be purged.' : 'Place the whole organization on litigation hold?')) return;
      await api('/org/compliance', { method: 'PATCH', body: { litigation_hold: !c.litigation_hold } }); reload();
    });
    const crit = () => { const f = $('#ed-form', body); return { q: f.q.value, mailbox: f.mailbox.value || undefined, from: f.from.value || undefined, to: f.to.value ? `${f.to.value}T23:59:59` : undefined }; };
    $('#ed-form', body).onsubmit = guard(async () => {
      const r = await api('/org/ediscovery/search', { method: 'POST', body: crit() });
      $('#ed-out', body).innerHTML = `<p>${r.count} item(s)${r.count > 200 ? ', showing the first 200' : ''}.</p><table class="people"><thead><tr><th>Mailbox</th><th>From</th><th>Subject</th><th>Date</th><th></th></tr></thead><tbody>
        ${r.results.map((x) => `<tr><td>${esc(x.mailbox)}</td><td>${esc(x.from)}</td><td>${esc(x.subject)}</td><td class="small">${esc(fmtDate(x.date))}</td><td>${x.held ? '<span class="tag high">Deleted, held</span>' : x.deleted ? '<span class="tag">Deleted Items</span>' : ''}</td></tr>`).join('')}</tbody></table>`;
    });
    $('#ed-export', body).onclick = guard(async () => {
      const res = await fetch('/api/org/ediscovery/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(crit()) });
      if (!res.ok) throw new Error((await res.json()).error);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `ediscovery-${new Date().toISOString().slice(0, 10)}.mbox`;
      a.click();
    });
  }

  if (tab === 'audit') {
    body.innerHTML = `<form id="audit-form" class="row"><label>Activity<select name="action"><option value="">All</option><option value="admin.">Admin changes</option><option value="security.">Security</option><option value="imap.">Mail app sign-ins</option><option value="mail.sent">Mail sent</option><option value="mailflow.">Mail flow rule matches</option><option value="import.">Imports</option></select></label>
      <label>User<input name="user" placeholder="name@domain"></label><button class="btn primary">Filter</button></form><div id="audit-out"></div>`;
    const run = async (action = '', user = '') => {
      const { entries } = await api(`/org/audit?action=${encodeURIComponent(action)}&user=${encodeURIComponent(user)}`);
      $('#audit-out', body).innerHTML = `<table class="people"><thead><tr><th>Time</th><th>User</th><th>Activity</th><th>Details</th></tr></thead><tbody>
        ${entries.map((e) => `<tr><td class="small">${esc(when(e.created_at))}</td><td>${esc(e.user_email || '')}</td><td><code>${esc(e.action)}</code></td><td class="small"><code class="wrap">${esc(JSON.stringify(e.details)).slice(0, 300)}</code></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</tbody></table>`;
    };
    $('#audit-form', body).onsubmit = guard((e) => run(e.target.action.value, e.target.user.value));
    run();
  }

  if (tab === 'billing') {
    const o = await api('/org/billing');
    body.innerHTML = `${billingIntro(o)}<p class="muted small">${o.usage.users} of ${o.usage.seats} seats used. Shared mailboxes are free.</p>
      ${o.subscription ? `<form id="seat-form" class="row"><label>Seats<input name="seats" type="number" min="${o.usage.users}" value="${o.subscription.seats}"></label><button class="btn">Change seats</button></form>` : ''}
      ${planCards(o, { business: true })}
      ${o.subscription && !o.subscription.cancelAtPeriodEnd && o.subscription.provider !== 'manual' ? '<p><button class="link-btn" data-cancel-plan>Cancel plan</button></p>' : ''}
      <h3>Invoices</h3>${invoiceTable(o.invoices)}`;
    wirePlans(body, o, { business: true, base: '/org/billing', onDone: reload, err });
    const sf = $('#seat-form', body);
    if (sf) sf.onsubmit = guard(async () => { await api('/org/billing/seats', { method: 'PUT', body: { seats: Number(sf.seats.value) } }); toast('Seats updated.'); reload(); });
  }

  if (tab === 'reports') {
    const r = await api('/org/reports');
    const people = r.users.filter((u) => u.mailbox_type !== 'shared');
    body.innerHTML = `<div class="stats">
        <div><b>${r.sent7d}</b><span>sent, last 7 days</span></div><div><b>${r.received7d}</b><span>received</span></div>
        <div><b>${r.junk7d}</b><span>caught as junk</span></div><div><b>${r.failed7d}</b><span>failed deliveries</span></div>
        <div><b>${r.mfaUsers} / ${people.length}</b><span>users with two-step verification</span></div></div>
      <h3>Mailbox usage</h3><table class="people"><thead><tr><th>Mailbox</th><th>Type</th><th>Used</th><th>Two-step</th><th>Last activity</th></tr></thead><tbody>
      ${r.users.map((u) => `<tr><td>${esc(u.email)}</td><td>${u.mailbox_type === 'shared' ? 'Shared' : 'User'}${u.is_disabled ? ' (disabled)' : ''}</td><td>${fmtBytes(u.bytes)} <span class="muted small">(${((u.bytes / r.quotaBytes) * 100).toFixed(1)}%)</span></td><td>${u.mailbox_type === 'shared' ? '' : u.totp_enabled ? '✔' : '<span class="overdue">Off</span>'}</td><td class="small">${esc(when(u.last_activity))}</td></tr>`).join('')}</tbody></table>`;
  }
};


boot();

// ------------------------------------------------------------ the ribbon (File, Home, Send / Receive, Folder, View, Help)
// Line icons drawn on a 24px grid, in the spirit of Outlook's ribbon.
const ICONS = {
  mailNew: '<rect x="2.5" y="5" width="15" height="11" rx="1.5"/><path d="M3 6l7 5 7-5"/><path d="M19 13v8M15 17h8" class="ac"/>',
  items: '<rect x="3" y="6" width="13" height="10" rx="1.5"/><path d="M3.5 7l6 4.5 6-4.5"/><rect x="9" y="11" width="12" height="10" rx="1.5" class="fill"/><path d="M9 14h12M12 9.5v3M18 9.5v3"/>',
  ignore: '<rect x="3" y="4" width="13" height="9" rx="1.5"/><path d="M3.5 5l6 4.5 6-4.5"/><circle cx="17" cy="17" r="4.5" class="rd"/><path d="M13.8 20.2l6.4-6.4" class="rd"/>',
  cleanup: '<rect x="3" y="4" width="13" height="9" rx="1.5"/><path d="M3.5 5l6 4.5 6-4.5"/><path d="M14 21l4-7M17 14l3 1.5M12 21h8" class="rd"/>',
  junk: '<rect x="3" y="4" width="13" height="9" rx="1.5"/><path d="M3.5 5l6 4.5 6-4.5"/><circle cx="17" cy="17" r="4.5" class="rd"/><path d="M17 14.5v3M17 19.5v.1" class="rd"/>',
  trash: '<path d="M4 6h16M9 6V4h6v2M6 6l1 15h10l1-15M10 10v8M14 10v8"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1" class="ac"/><path d="M5 9v11h14V9M10 13h4"/>',
  reply: '<rect x="3" y="7" width="15" height="11" rx="1.5"/><path d="M3.5 8l7 5 7-5"/><path d="M14 4H8a3 3 0 0 0-3 3v1M8 2L5 4.5 8 7" class="pu" transform="translate(0 -0.5)"/>',
  replyAll: '<rect x="5" y="8" width="15" height="11" rx="1.5"/><path d="M5.5 9l7 5 7-5"/><path d="M8 2L5 4.5 8 7M11 2L8 4.5 11 7M8 4.5h8" class="pu"/>',
  forward: '<rect x="3" y="7" width="15" height="11" rx="1.5"/><path d="M3.5 8l7 5 7-5"/><path d="M13 4.5h9M19 1.5l3 3-3 3" class="ac"/>',
  meeting: '<rect x="3" y="5" width="18" height="15" rx="1.5"/><path d="M3 9h18M8 3v4M16 3v4"/><path d="M8 13h3M8 16h6" class="ac"/>',
  attachFwd: '<path d="M8 12V6a3 3 0 0 1 6 0v9a5 5 0 0 1-10 0V8"/><path d="M14 19h8M19 16l3 3-3 3" class="ac"/>',
  more: '<circle cx="5" cy="12" r="1.3" class="fill"/><circle cx="12" cy="12" r="1.3" class="fill"/><circle cx="19" cy="12" r="1.3" class="fill"/>',
  move: '<rect x="3" y="6" width="13" height="12" rx="1.5"/><path d="M3.5 7l6 4.5 6-4.5"/><path d="M14 15h8M19 12l3 3-3 3" class="ac"/>',
  rules: '<rect x="3" y="4" width="13" height="10" rx="1.5"/><path d="M3.5 5l6 4.5 6-4.5"/><path d="M12 18h9M12 21h6M18 15.5l3 2.5-3 2.5" class="ac"/>',
  save: '<path d="M5 3h11l4 4v14H5z"/><path d="M8 3v6h8V3M8 21v-7h9v7" class="ac"/>',
  unread: '<rect x="3" y="6" width="18" height="13" rx="1.5"/><path d="M3.5 7l8.5 6 8.5-6"/><circle cx="19.5" cy="5.5" r="2.5" class="acf"/>',
  read: '<path d="M3 10l9-6 9 6v10H3z"/><path d="M3.5 10.5l8.5 5.5 8.5-5.5"/>',
  tag: '<rect x="3" y="3" width="8" height="8" rx="1" class="cb"/><rect x="13" y="3" width="8" height="8" rx="1" class="cg"/><rect x="3" y="13" width="8" height="8" rx="1" class="co"/><rect x="13" y="13" width="8" height="8" rx="1" class="cp"/>',
  flag: '<path d="M6 21V4M6 4h11l-2.5 4.5L17 13H6" class="rd"/>',
  groupAdd: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0M10.5 14.5a5.5 5.5 0 0 1 9 2"/><path d="M19 16v6M16 19h6" class="ac"/>',
  groups: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0M10.5 19a5.5 5.5 0 0 1 11 0"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  book: '<rect x="5" y="3" width="15" height="18" rx="1.5"/><circle cx="12.5" cy="10" r="2.5"/><path d="M8.5 17a4 4 0 0 1 8 0M3 7h3M3 12h3M3 17h3"/>',
  filter: '<path d="M3 4h18l-7 8.5V20l-4-2v-5.5z"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" class="ac"/>',
  translate: '<path d="M3 5h10M8 3v2M5 5c1 4 4 7 7 8M11 5c-1 4-4 7-7 8" class="ac"/><path d="M12 21l4.5-10L21 21M13.5 18h6"/>',
  sparkle: '<path d="M12 3l2 5.5L19.5 11 14 13l-2 6-2-6-5.5-2L10 8.5z" class="ac"/><path d="M19 3v3M17.5 4.5h3"/>',
  insights: '<path d="M12 21s-8-4.5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 6.5-8 11-8 11z" class="pu"/><path d="M8 12h2l1.5-3 2 5 1.5-2H16"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z" class="ac"/>',
  check: '<path d="M4 12.5l5 5L20 6.5" class="gr"/>',
  folderAdd: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M12 10v6M9 13h6" class="ac"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  rename: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4" class="ac"/>',
  folderDel: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9.5 10.5l5 5M14.5 10.5l-5 5" class="rd"/>',
  markRead: '<path d="M3 10l9-6 9 6v10H3z"/><path d="M8 14l3 3 5-6" class="gr"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" class="ac"/>',
  outbox: '<path d="M3 13h5l1.5 3h5L16 13h5v7H3z"/><path d="M12 3v9M8.5 6.5L12 3l3.5 3.5" class="ac"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M9 9v11"/>',
  conversations: '<path d="M3 5h13v9H8l-4 3v-3H3z"/><path d="M18 9h3v9h-1v3l-3.5-3H10v-2" class="ac"/>',
  sort: '<path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M14 6h7M14 11h5M14 16h3"/>',
  pane: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16"/><path d="M14.5 8h4M14.5 11h4M14.5 14h3" class="ac"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M9 4v16"/><path d="M5 8h2M5 11h2M5 14h2" class="ac"/>',
  preview: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M6 8h8M6 11h12M6 14h10M6 17h7"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  textsize: '<path d="M3 19l5-13 5 13M4.8 14.5h6.4M14 19l3.5-8.5L21 19M15 16.5h5" />',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="1.5"/><path d="M6 10h.1M10 10h.1M14 10h.1M18 10h.1M7 14h10"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.7M12 17h.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.1"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3.5 6l8.5 6 8.5-6"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/>',
  whatsnew: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4" class="ac"/>',
};
const icon = (name) => `<svg class="ri" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.bolt}</svg>`;

// ribbon state: tab, filter, multi-selection
const RB = { tab: 'home', filter: null, quickSteps: null };
state.multi = new Set();

const FILTERS = [['', 'All'], ['unread', 'Unread'], ['attachments', 'Has Files'], ['tome', 'To Me'], ['flagged', 'Flagged'], ['mentions', 'Mentions Me'], ['important', 'High Importance'], ['categorized', 'Categorized'], ['week', 'This Week']];
const SORTS_UI = [['date', 'Date (newest on top)'], ['date-asc', 'Date (oldest on top)'], ['from', 'From'], ['subject', 'Subject'], ['size', 'Size'], ['importance', 'Importance'], ['flag', 'Flag Status']];
const CATEGORY_PRESETS = [['Blue category', '\u{1F535}'], ['Green category', '\u{1F7E2}'], ['Orange category', '\u{1F7E0}'], ['Purple category', '\u{1F7E3}'], ['Red category', '\u{1F534}'], ['Yellow category', '\u{1F7E1}']];

// Ribbon layout: tab -> groups -> items. A plain item is a large button,
// { stack: [...] } is a column of small buttons, { gallery } is the Quick Steps box.
// needs: 'one' = an open message, 'any' = at least one selected message.
const RIBBON = {
  home: [
    { label: 'New', items: [
      { id: 'newmail', icon: 'mailNew', label: 'New Email' },
      { id: 'newitems', icon: 'items', label: 'New Items', menu: true },
    ] },
    { label: 'Delete', compact: true, items: [
      { stack: [
        { id: 'ignore', icon: 'ignore', label: 'Ignore', needs: 'one' },
        { id: 'cleanup', icon: 'cleanup', label: 'Clean Up', menu: true },
        { id: 'junk', icon: 'junk', label: 'Junk', menu: true, needs: 'any' },
      ] },
      { id: 'delete', icon: 'trash', label: 'Delete', needs: 'any' },
      { id: 'archive', icon: 'archive', label: 'Archive', needs: 'any' },
    ] },
    { label: 'Respond', compact: true, items: [
      { id: 'reply', icon: 'reply', label: 'Reply', needs: 'one' },
      { id: 'replyall', icon: 'replyAll', label: 'Reply All', needs: 'one' },
      { id: 'forward', icon: 'forward', label: 'Forward', needs: 'one' },
      { stack: [
        { id: 'meeting', icon: 'meeting', label: 'Meeting', needs: 'one', title: 'Reply with a meeting invitation' },
        { id: 'fwdattach', icon: 'attachFwd', label: 'As Attachment', needs: 'any', title: 'Forward as an attachment' },
        { id: 'respondmore', icon: 'more', label: 'More', menu: true, needs: 'one' },
      ] },
    ] },
    { label: 'Quick Steps', collapse: 4, launcher: 'managesteps', items: [{ gallery: true }] },
    { label: 'Move', collapse: 6, items: [{ stack: [
      { id: 'move', icon: 'move', label: 'Move', menu: true, needs: 'any' },
      { id: 'rules', icon: 'rules', label: 'Rules', menu: true },
      { id: 'savefile', icon: 'save', label: 'Save as File', needs: 'one', title: 'Save this message as an .eml file' },
    ] }] },
    { label: 'Tags', collapse: 5, items: [
      { id: 'unreadread', icon: 'unread', label: 'Unread/ Read', needs: 'any' },
      { stack: [
        { id: 'categorize', icon: 'tag', label: 'Categorize', menu: true, needs: 'any' },
        { id: 'followup', icon: 'flag', label: 'Follow Up', menu: true, needs: 'any' },
      ] },
    ] },
    { label: 'Groups', collapse: 8, items: [{ stack: [
      { id: 'newgroup', icon: 'groupAdd', label: 'New Group' },
      { id: 'browsegroups', icon: 'groups', label: 'Browse Groups' },
    ] }] },
    { label: 'Find', collapse: 7, items: [{ stack: [
      { search: true },
      { id: 'addressbook', icon: 'book', label: 'Address Book' },
      { id: 'filter', icon: 'filter', label: 'Filter Email', menu: true },
    ] }] },
    { label: 'Speech', items: [{ id: 'readaloud', icon: 'speaker', label: 'Read Aloud', needs: 'one' }] },
    { label: 'Language', items: [{ id: 'translate', icon: 'translate', label: 'Translate', menu: true, needs: 'one' }] },
    { label: 'Arzio AI', collapse: 9, items: [{ stack: [
      { id: 'summarize', icon: 'sparkle', label: 'Summarize', needs: 'one' },
      { id: 'aidraft', icon: 'reply', label: 'Draft Reply', needs: 'one' },
      { id: 'ask', icon: 'sparkle', label: 'Ask Arzio' },
    ] }] },
    { label: 'Insights', items: [{ id: 'insights', icon: 'insights', label: 'Insights' }] },
  ],
  send: [
    { label: 'Send & Receive', items: [
      { id: 'sendreceive', icon: 'sync', label: 'Send/Receive All Folders' },
      { stack: [
        { id: 'updatefolder', icon: 'folder', label: 'Update Folder' },
        { id: 'outbox', icon: 'outbox', label: 'Outbox (scheduled)' },
      ] },
    ] },
    { label: 'Preferences', items: [
      { id: 'ooo', icon: 'mail', label: 'Automatic Replies' },
      { id: 'undosend', icon: 'reset', label: 'Undo Send', title: 'Choose how long you can undo a sent message' },
    ] },
  ],
  folder: [
    { label: 'New', items: [{ id: 'newfolder', icon: 'folderAdd', label: 'New Folder' }] },
    { label: 'Actions', items: [{ stack: [
      { id: 'renamefolder', icon: 'rename', label: 'Rename Folder', needsFolder: 'custom' },
      { id: 'deletefolder', icon: 'folderDel', label: 'Delete Folder', needsFolder: 'custom' },
    ] }] },
    { label: 'Clean Up', items: [
      { id: 'markallread', icon: 'markRead', label: 'Mark All as Read', needsFolder: 'any' },
      { stack: [
        { id: 'cleanupfolder', icon: 'cleanup', label: 'Clean Up Folder', needsFolder: 'any' },
        { id: 'emptyfolder', icon: 'trash', label: 'Delete All', needsFolder: 'any' },
      ] },
    ] },
    { label: 'Favorites', items: [{ id: 'favorite', icon: 'star', label: 'Show in Favorites', needsFolder: 'any' }] },
    { label: 'Properties', items: [{ id: 'folderprops', icon: 'info', label: 'Folder Properties', needsFolder: 'any' }] },
  ],
  view: [
    { label: 'Current View', items: [
      { id: 'changeview', icon: 'layout', label: 'Change View', menu: true },
      { id: 'resetview', icon: 'reset', label: 'Reset View' },
    ] },
    { label: 'Messages', items: [
      { id: 'conversations', icon: 'conversations', label: 'Show as Conversations', toggle: () => ui().conversations !== false },
      { stack: [
        { id: 'sortby', icon: 'sort', label: 'Arrange By', menu: true },
        { id: 'preview', icon: 'preview', label: 'Message Preview', menu: true },
      ] },
    ] },
    { label: 'Layout', items: [
      { id: 'folderpane', icon: 'sidebar', label: 'Folder Pane', toggle: () => ui().folderPane !== false },
      { id: 'readingpane', icon: 'pane', label: 'Reading Pane', menu: true },
      { stack: [
        { id: 'ribbonmode', icon: 'layout', label: 'Ribbon Layout', menu: true },
        { id: 'textsize', icon: 'textsize', label: 'Text Size', menu: true },
      ] },
    ] },
    { label: 'Appearance', items: [
      { id: 'darkmode', icon: 'moon', label: 'Dark Mode', toggle: () => document.documentElement.dataset.theme === 'dark' },
      { id: 'appearance', icon: 'gear', label: 'Appearance Settings' },
    ] },
    { label: 'Window', items: [{ id: 'reminders', icon: 'bell', label: 'Reminders Window' }] },
  ],
  help: [
    { label: 'Help', items: [
      { id: 'shortcuts', icon: 'keyboard', label: 'Keyboard Shortcuts' },
      { id: 'whatsnew', icon: 'whatsnew', label: "What's New" },
      { id: 'about', icon: 'help', label: 'About Arzio Mail' },
    ] },
    { label: 'Options', items: [{ id: 'options', icon: 'gear', label: 'Settings' }] },
  ],
};
const RIBBON_TABS = [['file', 'File'], ['home', 'Home'], ['send', 'Send / Receive'], ['folder', 'Folder'], ['view', 'View'], ['help', 'Help']];

function rbButton(it, size) {
  const on = it.toggle ? it.toggle() : false;
  return `<button type="button" class="rb ${size}${on ? ' on' : ''}" data-rb="${it.id}" title="${esc(it.title || it.label.replace('/ ', '/'))}"${it.needs ? ` data-needs="${it.needs}"` : ''}${it.needsFolder ? ` data-folder-needs="${it.needsFolder}"` : ''}${it.toggle ? ` aria-pressed="${on}"` : ''}>${icon(it.icon)}<span class="rl">${esc(it.label)}${it.menu ? '<i class="caret"></i>' : ''}</span></button>`;
}
function quickStepsGallery() {
  const steps = RB.quickSteps || [];
  return `<div class="qs-gallery"><div class="qs-items">${steps.slice(0, 3).map((s, i) => `<button type="button" class="qs" data-qs="${i}" title="${esc(s.name)}">${icon(s.icon === 'forward' ? 'forward' : s.icon === 'mail' ? 'mail' : s.icon === 'check' ? 'check' : s.icon === 'reply' ? 'reply' : s.icon === 'move' ? 'move' : 'bolt')}<span>${esc(s.name)}</span></button>`).join('')}</div>
    <button type="button" class="qs-more" data-rb="quicksteps" title="All Quick Steps">▾</button></div>`;
}
function renderRibbon() {
  const box = $('#ribbon');
  if (!box || !state.me) return;
  const mode = ui().ribbon || 'classic';
  box.classList.toggle('simplified', mode === 'simplified');
  $('#ribbon-tabs').innerHTML = RIBBON_TABS.map(([k, l]) => `<button type="button" role="tab" class="rtab${RB.tab === k ? ' active' : ''}${k === 'file' ? ' file' : ''}" data-rtab="${k}" aria-selected="${RB.tab === k}">${l}</button>`).join('')
    + `<button type="button" class="rb-collapse" data-rb="ribbonflip" title="${mode === 'simplified' ? 'Classic ribbon' : 'Simplified ribbon'}">${mode === 'simplified' ? '⌄' : '⌃'}</button>`;
  const groups = RIBBON[RB.tab] || RIBBON.home;
  const body = $('#ribbon-body');
  const draw = (collapsed) => { body.innerHTML = groups.map((g, gi) => (collapsed.has(gi) ? collapsedGroup(g, gi) : `<div class="rgroup${g.compact ? ' compact' : ''}"><div class="rg-items">${g.items.map((it) => {
    if (it.gallery) return quickStepsGallery();
    if (it.stack) return `<div class="rstack">${it.stack.map((s) => (s.search ? '<input class="rb-search" id="rb-people" type="search" placeholder="Search People" aria-label="Search People">' : rbButton(s, 'small'))).join('')}</div>`;
    return rbButton(it, 'big');
  }).join('')}</div><div class="rg-label">${esc(g.label)}${g.launcher ? `<button type="button" class="launcher" data-rb="${g.launcher}" title="Manage ${esc(g.label)}">↘</button>` : ''}</div></div>`)).join(''); };
  // Like Outlook, groups fold into a single drop-down button when the window is too narrow
  const order = groups.map((g, i) => [g.collapse || 0, i]).filter(([c]) => c).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const collapsed = new Set();
  draw(collapsed);
  while (body.scrollWidth > body.clientWidth + 1 && order.length) { collapsed.add(order.shift()); draw(collapsed); }
  ribbonSync();
}
const groupItems = (g) => g.items.flatMap((it) => (it.stack ? it.stack : it.gallery ? [{ id: 'quicksteps', label: 'Quick Steps' }] : [it]));
function collapsedGroup(g, gi) {
  const first = groupItems(g).find((x) => x.icon) || { icon: 'bolt' };
  return `<div class="rgroup folded"><div class="rg-items"><button type="button" class="rb big" data-rgroup="${gi}" title="${esc(g.label)}">${icon(first.icon)}<span class="rl">${esc(g.label)}<i class="caret"></i></span></button></div><div class="rg-label">${esc(g.label)}</div></div>`;
}
function openFoldedGroup(btn) {
  const g = (RIBBON[RB.tab] || RIBBON.home)[Number(btn.dataset.rgroup)];
  const items = groupItems(g).map((it) => (it.search ? { id: 'searchpeople', label: 'Search People\u2026' } : it));
  popMenu(btn, items.map((it) => [`${it.label.replace('/ ', '/')}${it.menu ? ' \u25B8' : ''}`, async () => {
    if (it.id === 'searchpeople') return searchPeople(prompt('Search People') || '');
    if (!(await ensureTarget(needsOf(it.id), DESTRUCTIVE.has(it.id)))) return;
    return RB_COMMANDS[it.id](btn);
  }]));
}
function ribbonSync() {
  const box = $('#ribbon');
  if (!box || !state.me) return;
  const inMail = state.view === 'mail';
  const one = inMail && !!state.current && state.current.message.id === state.selectedId && state.multi.size <= 1;
  const any = inMail && (state.multi.size > 0 || !!state.selectedId);
  const f = currentFolder();
  // Every button stays active. Without a selection, a button picks the message
  // or folder to work on itself (see ensureTarget), so it only shows a hint here.
  $$('[data-needs]', box).forEach((b) => b.classList.toggle('idle', b.dataset.needs === 'one' ? !one : !any));
  $$('[data-folder-needs]', box).forEach((b) => b.classList.toggle('idle', !inMail || !f || !!state.q || !!state.smart));
}

// Make sure a ribbon command has something to work on: open the mail view and the
// Inbox if needed, and open the top message when nothing is selected.
async function ensureTarget(needs, destructive = false) {
  if (!needs) return true;
  const inbox = state.folders.find((f) => f.role === 'inbox');
  if (state.view !== 'mail') { showMailView(); if (!state.folderId && inbox) state.folderId = inbox.id; await loadList(); }
  if (needs === 'folder') {
    if (!currentFolder() || state.q || state.smart) {
      state.q = ''; state.smart = null; $('#search-input').value = '';
      if (!currentFolder() && inbox) state.folderId = inbox.id;
      renderFolders(); await loadList();
    }
    return !!currentFolder();
  }
  if (needs === 'any' && (state.multi.size || state.selectedId)) return true;
  if (needs === 'one' && curMsg() && state.multi.size <= 1) return true;
  if (needs === 'one' && state.multi.size > 1) { const first = state.messages.find((m) => state.multi.has(m.id)); await openMessage(first.id); return true; }
  if (state.selectedId) { await openMessage(state.selectedId); return true; }
  if (!state.messages.length && inbox && state.folderId !== inbox.id) { selectFolder(inbox.id); await loadList(); }
  const top = state.messages[0];
  if (!top) { toast('There are no messages here yet. New mail will show up in the Inbox.'); return false; }
  await openMessage(top.id);
  if (destructive) { toast(`Selected "${top.subject || '(no subject)'}". Press the button again to go ahead, or pick another message.`); return false; }
  toast(`Working on "${top.subject || '(no subject)'}". Select another message to change it.`);
  return true;
}
// Buttons that remove mail never act on a message you did not pick
const DESTRUCTIVE = new Set(['delete', 'archive']);
const needsOf = (id) => {
  for (const groups of Object.values(RIBBON)) for (const g of groups) for (const it of g.items) for (const x of (it.stack || [it])) if (x.id === id) return x.needs || (x.needsFolder ? 'folder' : null);
  return null;
};

// Which messages a ribbon command works on: the multi-selection, else the open message
const targetIds = () => (state.multi.size ? [...state.multi] : state.selectedId ? [state.selectedId] : []);
const curMsg = () => (state.current && state.current.message.id === state.selectedId ? state.current.message : null);
function afterBulk(ids) {
  state.messages = state.messages.filter((m) => !ids.includes(m.id));
  if (ids.includes(state.selectedId)) { state.selectedId = null; closeReader(); }
  state.multi.clear();
  renderList(); loadFolders();
}
async function bulk(action, extra = {}) {
  const ids = targetIds();
  if (!ids.length) return;
  await api('/messages/bulk', { method: 'POST', body: { ids, action, ...extra } });
  return ids;
}

// Standard folders (Inbox, Sent…) can't be renamed or deleted, so ask which of your own folders to use
async function ownFolder(title) {
  const f = currentFolder();
  if (f && !f.role) return f;
  if (!state.folders.some((x) => !x.role)) {
    if (confirm('Standard folders like Inbox and Sent Items can\'t be renamed or deleted, and you have no folders of your own yet. Create one now?')) $('#new-folder-btn').click();
    return null;
  }
  return pickFolder(title, { only: 'custom' });
}
function pickFolder(title, { exclude, only } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><div class="folder-pick">${state.folders.filter((f) => f.id !== exclude && (only !== 'custom' || !f.role)).map((f) => `<button type="button" class="btn" data-pick="${f.id}">${FOLDER_ICONS[f.role] || '\u{1F4C1}'} ${esc(f.name)}</button>`).join('')}</div>
      <div class="actions"><button type="button" class="link-btn" data-newf>+ New folder</button><button class="btn" type="button" data-close>Cancel</button></div>`);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    m.onclick = async (e) => {
      const b = e.target.closest('[data-pick],[data-newf],[data-close]');
      if (!b) return;
      if (b.dataset.close !== undefined) return finish(null);
      if (b.dataset.newf !== undefined) {
        const name = prompt('New folder name');
        if (!name?.trim()) return;
        try { const { folder } = await api('/folders', { method: 'POST', body: { name } }); await loadFolders(); closeModal(); finish(folder); } catch (ex) { toast(ex.message); }
        return;
      }
      closeModal(); finish(state.folders.find((f) => f.id === Number(b.dataset.pick)));
    };
    $('#modal').addEventListener('click', function off(e) { if (e.target.id === 'modal') { finish(null); $('#modal').removeEventListener('click', off); } });
  });
}

// Follow Up dates, worked out in the user's own time zone
function followUpDate(kind) {
  const d = new Date(); d.setHours(17, 0, 0, 0);
  if (kind === 'tomorrow') d.setDate(d.getDate() + 1);
  if (kind === 'thisweek') { while (d.getDay() !== 5 && d.getDay() !== 0 && d.getDay() !== 6) d.setDate(d.getDate() + 1); if (d.getDay() !== 5) d.setDate(d.getDate() + 2); }
  if (kind === 'nextweek') { d.setDate(d.getDate() + 7); while (d.getDay() !== 5) d.setDate(d.getDate() + (d.getDay() === 6 ? -1 : d.getDay() === 0 ? -2 : 1)); }
  return d.toISOString();
}
async function followUp(state_, due_at) {
  const ids = targetIds();
  for (const id of ids) {
    const { message } = await api(`/messages/${id}/followup`, { method: 'POST', body: { state: state_, due_at } });
    Object.assign(state.messages.find((x) => x.id === id) || {}, { is_flagged: message.is_flagged, flag_due_at: message.flag_due_at, flag_completed_at: message.flag_completed_at });
    if (state.current?.message.id === id) Object.assign(state.current.message, message);
  }
  renderList();
  if (curMsg()) renderReader(state.current.message, state.current.thread);
  toast(state_ === 'complete' ? 'Marked complete.' : state_ === 'clear' ? 'Flag cleared.' : due_at ? `Flagged. Due ${fmtDate(due_at, true)}.` : 'Flagged.');
}
async function setCategory(name, mode = 'toggle') {
  for (const id of targetIds()) {
    const m = state.messages.find((x) => x.id === id) || (state.current?.message.id === id ? state.current.message : null);
    const cur = m?.categories || [];
    const next = mode === 'clear' ? [] : cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name];
    const { message } = await api(`/messages/${id}`, { method: 'PATCH', body: { categories: next } });
    if (m) m.categories = message.categories;
    if (state.current?.message.id === id) state.current.message.categories = message.categories;
  }
  renderList();
  if (curMsg()) renderReader(state.current.message, state.current.thread);
}

// ------------------------------------------------------------ Quick Steps
async function loadQuickSteps() {
  try { RB.quickSteps = (await api('/me/quick-steps')).steps; } catch { RB.quickSteps = []; }
}
const STEP_LABELS = { move: 'Move to folder', archive: 'Archive', delete: 'Delete', read: 'Mark as read', unread: 'Mark as unread', flag: 'Flag', pin: 'Pin', category: 'Categorize', forward: 'Forward to', reply: 'Reply', replyall: 'Reply all', newmail: 'New email to' };
const stepNeedsValue = (a) => ['move', 'category', 'forward', 'newmail'].includes(a.type) && !a.value;
async function saveQuickSteps(steps) { RB.quickSteps = (await api('/me/quick-steps', { method: 'PUT', body: { steps } })).steps; renderRibbon(); }

function editQuickStep(idx, { firstRun = false } = {}) {
  const steps = RB.quickSteps.map((s) => ({ ...s, actions: s.actions.map((a) => ({ ...a })) }));
  const s = idx === null ? { name: '', icon: 'bolt', actions: [{ type: 'move', value: null }] } : steps[idx];
  return new Promise((resolve) => {
    const row = (a, i) => `<div class="row qs-row" data-i="${i}"><label>Action<select name="type">${Object.entries(STEP_LABELS).map(([k, l]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="qs-val">${a.type === 'move' ? `Folder<select name="value"><option value="">Choose a folder</option>${state.folders.map((f) => `<option value="${f.id}" ${String(a.value) === String(f.id) ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>` : ['category', 'forward', 'newmail'].includes(a.type) ? `${a.type === 'category' ? 'Category' : 'To'}<input name="value" value="${esc(a.value || '')}" placeholder="${a.type === 'category' ? 'e.g. Blue category' : 'name@example.com'}">` : '<span class="muted small">No options</span>'}</label>
      <button type="button" class="link-btn" data-rm="${i}">Remove</button></div>`;
    const draw = () => {
      const m = modal(`<h2>${firstRun ? 'First Time Setup' : idx === null ? 'New Quick Step' : 'Edit Quick Step'}</h2>
        ${firstRun ? '<p class="muted">Choose what this Quick Step should do. You only have to do this once.</p>' : ''}
        <form id="qs-form"><label>Name<input name="name" value="${esc(s.name)}" required maxlength="60"></label>
        <div id="qs-actions">${s.actions.map(row).join('')}</div>
        <button type="button" class="link-btn" id="qs-add">+ Add action</button>
        <p class="form-error"></p>
        <div class="actions">${idx !== null && !firstRun ? '<button type="button" class="btn danger" id="qs-del">Delete</button>' : ''}<button class="btn" type="button" data-close>Cancel</button><button class="btn primary">${firstRun ? 'Save and run' : 'Save'}</button></div></form>`);
      const f = $('#qs-form', m);
      const read = () => { s.name = f.name.value; s.actions = $$('.qs-row', f).map((r) => ({ type: $('[name="type"]', r).value, value: $('[name="value"]', r)?.value || null })); };
      f.onchange = (e) => { if (e.target.name === 'type') { read(); draw(); } };
      $('#qs-add', f).onclick = () => { read(); s.actions.push({ type: 'read', value: null }); draw(); };
      f.onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { read(); s.actions.splice(Number(b.dataset.rm), 1); draw(); } };
      const del = $('#qs-del', f);
      if (del) del.onclick = async () => { steps.splice(idx, 1); await saveQuickSteps(steps); closeModal(); resolve(null); };
      f.onsubmit = async (e) => {
        e.preventDefault(); read();
        if (s.actions.some(stepNeedsValue)) { $('.form-error', f).textContent = 'Fill in the folder, category or address for each action.'; return; }
        const moveTo = s.actions.find((a) => a.type === 'move');
        if (s.name === 'Move to: ?' && moveTo) s.name = `Move to: ${state.folders.find((x) => String(x.id) === String(moveTo.value))?.name || '?'}`;
        if (idx === null) steps.push(s); else steps[idx] = s;
        try { await saveQuickSteps(steps); closeModal(); resolve(idx === null ? steps.length - 1 : idx); } catch (ex) { $('.form-error', f).textContent = ex.message; }
      };
    };
    draw();
  });
}
function manageQuickSteps() {
  const m = modal(`<h2>Manage Quick Steps</h2><div class="qs-manage">${RB.quickSteps.map((s, i) => `<div class="rule-row"><strong>${esc(s.name)}</strong><div class="small muted">${s.actions.map((a) => `${STEP_LABELS[a.type]}${a.value ? ` ${esc(a.type === 'move' ? state.folders.find((f) => String(f.id) === String(a.value))?.name || '?' : a.value)}` : ''}`).join(', ')}</div>
    <button class="link-btn" data-edit="${i}">Edit</button>${i > 0 ? `<button class="link-btn" data-up="${i}">Move up</button>` : ''}</div>`).join('') || '<p class="muted">No Quick Steps.</p>'}</div>
    <div class="actions"><button class="link-btn" id="qs-reset">Reset to defaults</button><button class="btn" id="qs-new">New Quick Step</button><button class="btn" data-close>Close</button></div>`);
  m.onclick = async (e) => {
    const b = e.target.closest('[data-edit],[data-up],#qs-new,#qs-reset');
    if (!b) return;
    if (b.id === 'qs-new') { await editQuickStep(null); return manageQuickSteps(); }
    if (b.id === 'qs-reset') { RB.quickSteps = (await api('/me/quick-steps', { method: 'PUT', body: { reset: true } })).steps; renderRibbon(); return manageQuickSteps(); }
    if (b.dataset.edit) { await editQuickStep(Number(b.dataset.edit)); return manageQuickSteps(); }
    if (b.dataset.up) { const i = Number(b.dataset.up); const s = [...RB.quickSteps]; [s[i - 1], s[i]] = [s[i], s[i - 1]]; await saveQuickSteps(s); manageQuickSteps(); }
  };
}
async function runQuickStep(idx) {
  let step = RB.quickSteps[idx];
  if (!step) return;
  if (step.actions.some(stepNeedsValue)) {
    const saved = await editQuickStep(idx, { firstRun: true });
    if (saved === null || saved === undefined) return;
    step = RB.quickSteps[saved];
  }
  const ids = targetIds();
  const m = curMsg();
  const compose = step.actions.filter((a) => ['forward', 'reply', 'replyall', 'newmail'].includes(a.type));
  const rest = step.actions.filter((a) => !compose.includes(a));
  let removed = false;
  if (ids.length) {
    for (const a of rest) {
      if (a.type === 'move') { await api('/messages/bulk', { method: 'POST', body: { ids, action: 'move', folder_id: Number(a.value) } }); removed = true; }
      else if (['archive', 'delete'].includes(a.type)) { await api('/messages/bulk', { method: 'POST', body: { ids, action: a.type } }); removed = true; }
      else if (['read', 'unread', 'flag'].includes(a.type)) await api('/messages/bulk', { method: 'POST', body: { ids, action: a.type } });
      else if (a.type === 'pin') for (const id of ids) await api(`/messages/${id}`, { method: 'PATCH', body: { is_pinned: true } });
      else if (a.type === 'category') await setCategory(a.value, 'add');
    }
  }
  if (removed) afterBulk(ids); else if (ids.length) { await loadList(); loadFolders(); }
  for (const a of compose) {
    if (a.type === 'newmail') openComposer('new', null, { prefill: { to: a.value } });
    else if (m) openComposer(a.type, m, a.type === 'forward' ? { prefill: { to: a.value } } : {});
  }
  if (!compose.length) toast(`${step.name}: done.`);
}

// ------------------------------------------------------------ groups, people and the address book
function groupDialog(g = {}) {
  const m = modal(`<h2>${g.id ? 'Edit group' : 'New group'}</h2><form id="grp-form">
    <label>Group name<input name="name" value="${esc(g.name || '')}" required maxlength="80"></label>
    <label>Description<input name="description" value="${esc(g.description || '')}"></label>
    <label>Members (separate with commas)<textarea name="members" rows="4" placeholder="name@example.com, …">${esc((g.members || []).map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(', '))}</textarea></label>
    <p class="muted small">A contact group lets you email everyone at once. Pick it in the Address Book or from Browse Groups.</p>
    <p class="form-error"></p><div class="actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">${g.id ? 'Save' : 'Create'}</button></div></form>`);
  const f = $('#grp-form', m);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const members = f.members.value.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => { const mm = x.match(/^(.*)<([^>]+)>$/); return mm ? { name: mm[1].trim().replace(/^"|"$/g, ''), email: mm[2].trim() } : { email: x }; });
    try {
      await api(g.id ? `/contact-lists/${g.id}` : '/contact-lists', { method: g.id ? 'PUT' : 'POST', body: { name: f.name.value, description: f.description.value, members } });
      closeModal(); toast(g.id ? 'Group saved.' : 'Group created.');
    } catch (ex) { $('.form-error', f).textContent = ex.message; }
  };
}
async function browseGroups() {
  const { org, lists } = await api('/groups/directory');
  const m = modal(`<h2>Browse Groups</h2>
    <h3>My contact groups</h3>${lists.length ? `<table class="people">${lists.map((l) => `<tr><td><strong>${esc(l.name)}</strong><div class="small muted">${l.members.length} member${l.members.length === 1 ? '' : 's'}${l.description ? ` · ${esc(l.description)}` : ''}</div></td>
      <td><button class="link-btn" data-mail-list="${l.id}">Email group</button><button class="link-btn" data-edit-list="${l.id}">Edit</button><button class="link-btn" data-del-list="${l.id}">Delete</button></td></tr>`).join('')}</table>` : '<p class="muted">No contact groups yet.</p>'}
    ${org.length ? `<h3>Your organization's groups</h3><table class="people">${org.map((g) => `<tr><td><strong>${esc(g.name)}</strong> ${g.is_member ? '<span class="tag">Member</span>' : ''}<div class="small muted">${esc(g.address)} · ${g.member_count} members${g.description ? ` · ${esc(g.description)}` : ''}</div></td>
      <td><button class="link-btn" data-mailto="${esc(g.address)}">Email group</button></td></tr>`).join('')}</table>` : ''}
    <div class="actions"><button class="btn" id="grp-new">New group</button><button class="btn" data-close>Close</button></div>`);
  m.onclick = async (e) => {
    const b = e.target.closest('[data-mail-list],[data-edit-list],[data-del-list],[data-mailto],#grp-new');
    if (!b) return;
    const l = lists.find((x) => String(x.id) === (b.dataset.mailList || b.dataset.editList || b.dataset.delList));
    if (b.id === 'grp-new') return groupDialog();
    if (b.dataset.mailto) { closeModal(); showMailView(); return openComposer('new', null, { prefill: { to: b.dataset.mailto } }); }
    if (b.dataset.mailList) { closeModal(); showMailView(); return openComposer('new', null, { prefill: { to: l.members.map((x) => fmtAddr({ name: x.name, address: x.email })).join(', ') } }); }
    if (b.dataset.editList) return groupDialog(l);
    if (b.dataset.delList && confirm(`Delete the group "${l.name}"? The contacts themselves are kept.`)) { await api(`/contact-lists/${l.id}`, { method: 'DELETE' }); browseGroups(); }
  };
}
async function addressBook(q = '', picked = new Map()) {
  const r = await api(`/address-book?q=${encodeURIComponent(q)}`);
  const rows = [
    ...r.lists.map((l) => ({ key: `list:${l.id}`, name: l.name, email: `${l.members.length} members`, kind: 'Contact group', addrs: l.members.map((x) => fmtAddr({ name: x.name, address: x.email })) })),
    ...r.groups.map((g) => ({ key: g.email, name: g.name, email: g.email, kind: 'Group', addrs: [fmtAddr({ name: g.name, address: g.email })] })),
    ...r.directory.map((p) => ({ key: p.email, name: p.name, email: p.email, kind: 'Organization', addrs: [fmtAddr({ name: p.name, address: p.email })] })),
    ...r.contacts.filter((c) => !r.directory.some((p) => p.email === c.email)).map((c) => ({ key: c.email, name: c.name, email: c.email, kind: [c.job_title, c.company].filter(Boolean).join(', ') || 'Contact', addrs: [fmtAddr({ name: c.name, address: c.email })] })),
  ];
  const m = modal(`<h2>Address Book</h2>
    <input id="ab-q" type="search" placeholder="Search by name, email or company" value="${esc(q)}" class="ab-search">
    <div class="ab-list">${rows.map((x) => `<label class="ab-row"><input type="checkbox" data-key="${esc(x.key)}" ${picked.has(x.key) ? 'checked' : ''}><span class="lavatar">${esc(initials(x.name, x.email))}</span><span><strong>${esc(x.name || x.email)}</strong><span class="small muted"> ${esc(x.email)}</span><br><span class="small muted">${esc(x.kind)}</span></span></label>`).join('') || '<p class="muted">Nobody found. Save people in People, or create a contact group.</p>'}</div>
    <div class="actions"><span class="muted small" id="ab-count">${picked.size} selected</span><button class="btn" data-close>Cancel</button><button class="btn primary" id="ab-to">Email selected</button></div>`);
  let t;
  $('#ab-q', m).oninput = (e) => { clearTimeout(t); t = setTimeout(() => addressBook(e.target.value, picked).then(() => { const i = $('#ab-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }), 250); };
  m.onchange = (e) => {
    const k = e.target.dataset?.key;
    if (!k) return;
    const row = rows.find((x) => x.key === k);
    if (e.target.checked) picked.set(k, row.addrs); else picked.delete(k);
    $('#ab-count', m).textContent = `${picked.size} selected`;
  };
  $('#ab-to', m).onclick = () => {
    const to = [...picked.values()].flat();
    if (!to.length) return toast('Pick at least one person or group.');
    closeModal(); showMailView();
    if (state.composer && !$('#composer').classList.contains('hidden')) { const i = $('#c-to'); i.value = [i.value.trim().replace(/,$/, ''), ...to].filter(Boolean).join(', '); }
    else openComposer('new', null, { prefill: { to: to.join(', ') } });
  };
}
async function searchPeople(q) {
  if (!q.trim()) return addressBook();
  const r = await api(`/address-book?q=${encodeURIComponent(q)}`);
  const people_ = [...r.directory, ...r.contacts.filter((c) => !r.directory.some((p) => p.email === c.email))];
  const m = modal(`<h2>People matching "${esc(q)}"</h2>${people_.map((p) => `<div class="person-card"><span class="avatar">${esc(initials(p.name, p.email))}</span><div><strong>${esc(p.name || p.email)}</strong><div class="small muted">${esc(p.email)}${p.job_title || p.company ? ` · ${esc([p.job_title, p.company].filter(Boolean).join(', '))}` : ''}${p.phone ? ` · ${esc(p.phone)}` : ''}</div></div>
      <div class="pc-actions"><button class="btn small" data-mail="${esc(p.email)}">Email</button><button class="btn small" data-meet="${esc(p.email)}">Meeting</button><button class="btn small" data-find="${esc(p.email)}">Find mail</button></div></div>`).join('') || '<p class="muted">Nobody found.</p>'}
    ${r.lists.map((l) => `<div class="person-card"><span class="avatar">\u{1F465}</span><div><strong>${esc(l.name)}</strong><div class="small muted">Contact group · ${l.members.length} members</div></div><div class="pc-actions"><button class="btn small" data-mail="${esc(l.members.map((x) => x.email).join(', '))}">Email</button></div></div>`).join('')}
    <div class="actions"><button class="btn" data-close>Close</button></div>`);
  m.onclick = (e) => {
    const b = e.target.closest('[data-mail],[data-meet],[data-find]');
    if (!b) return;
    closeModal();
    if (b.dataset.mail) { showMailView(); openComposer('new', null, { prefill: { to: b.dataset.mail } }); }
    if (b.dataset.meet) editEvent({ attendees: [{ email: b.dataset.meet }] }, $('#full-pane'));
    if (b.dataset.find) { showMailView(); $('#search-input').value = b.dataset.find; $('#search-form').requestSubmit(); }
  };
}

// ------------------------------------------------------------ Read Aloud
const speech = { on: false, paused: false, rate: 1 };
function readAloud() {
  const m = curMsg();
  if (!m) return;
  if (!('speechSynthesis' in window)) return toast('This browser cannot read aloud.');
  stopReading();
  const body = m.text_body || '';
  const qi = quoteIndex(body);
  const own = qi > 0 ? body.slice(0, qi) : body;
  const text = `From ${m.from_name || m.from_addr}. ${m.subject || 'No subject'}. ${own.replace(/^>.*$/gm, '').replace(/https?:\/\/\S+/g, 'link')}`;
  const parts = text.match(/[^.!?\n]+[.!?\n]*|\S+/g) || [text];
  speech.on = true; speech.paused = false;
  let bar = $('#read-aloud');
  if (!bar) { bar = document.createElement('div'); bar.id = 'read-aloud'; bar.className = 'read-aloud'; document.body.appendChild(bar); }
  bar.innerHTML = `${icon('speaker')}<span>Reading "${esc(m.subject || '(no subject)')}"</span>
    <button class="btn small" data-ra="pause">⏸ Pause</button><select data-ra="rate" aria-label="Reading speed">${[0.75, 1, 1.25, 1.5].map((r) => `<option value="${r}" ${r === speech.rate ? 'selected' : ''}>${r}x</option>`).join('')}</select><button class="btn small" data-ra="stop">⏹ Stop</button>`;
  bar.classList.remove('hidden');
  bar.onclick = (e) => {
    const b = e.target.closest('button[data-ra]');
    if (!b) return;
    if (b.dataset.ra === 'stop') return stopReading();
    if (speech.paused) { speechSynthesis.resume(); speech.paused = false; b.textContent = '⏸ Pause'; } else { speechSynthesis.pause(); speech.paused = true; b.textContent = '▶ Resume'; }
  };
  $('select', bar).onchange = (e) => { speech.rate = Number(e.target.value); readAloud(); };
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    u.rate = speech.rate;
    if (i === parts.length - 1) u.onend = () => stopReading();
    speechSynthesis.speak(u);
  });
}
function stopReading() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speech.on = false;
  $('#read-aloud')?.classList.add('hidden');
}

// ------------------------------------------------------------ Insights
async function showInsights() {
  const r = await api('/insights');
  const tile = (n, label, warn) => `<div class="ins-tile${warn ? ' warn' : ''}"><strong>${n}</strong><span>${esc(label)}</span></div>`;
  const max = Math.max(1, ...r.topSenders.map((s) => s.n));
  modal(`<h2>${icon('insights')} Insights</h2><p class="muted">Your week in mail and meetings. Only you can see this.</p>
    <div class="ins-grid">${tile(r.week.received, 'messages received in the last 7 days')}${tile(r.week.sent, 'messages you sent')}${tile(r.week.unread, 'unread in your Inbox', r.week.unread > 20)}
    ${tile(r.week.flagged, 'flagged for follow-up')}${tile(r.week.overdue, 'follow-ups past due', r.week.overdue > 0)}${tile(r.week.needsReply, 'probably need a reply')}</div>
    <h3>Your calendar this week</h3>
    <div class="ins-grid">${tile(r.meetings.count, 'meetings')}${tile(`${r.meetings.hours} h`, 'in meetings')}${tile(`${r.meetings.focusHours} h`, 'left for focus work (of a 40-hour week)')}</div>
    <h3>Who you hear from most (30 days)</h3>
    ${r.topSenders.length ? r.topSenders.map((s) => `<div class="ins-bar"><span>${esc(s.name || s.email)}</span><div><i style="width:${Math.round((s.n / max) * 100)}%"></i></div><b>${s.n}</b></div>`).join('') : '<p class="muted">Nothing yet.</p>'}
    <div class="actions">${r.week.overdue ? '<button class="btn" id="ins-flagged">Show flagged mail</button>' : ''}<button class="btn" data-close>Close</button></div>`);
  $('#ins-flagged')?.addEventListener('click', () => { closeModal(); $('[data-smart="flagged"]').click(); });
}

// ------------------------------------------------------------ commands
async function saveAsFile(id) {
  const res = await fetch(`/api/messages/${id}/eml`, { credentials: 'same-origin', headers: state.mailbox ? { 'x-arzio-mailbox': String(state.mailbox.id) } : {} });
  if (!res.ok) throw new Error('Could not save the message.');
  const name = decodeURIComponent((res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'message.eml');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob()); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function meetingFrom(m) {
  const me = state.me.email;
  const seen = new Set([me]);
  const att = [{ address: m.from_addr, name: m.from_name }, ...(m.to || []), ...(m.cc || [])].filter((p) => p.address && !seen.has(p.address) && seen.add(p.address));
  editEvent({ title: (m.subject || '').replace(/^(re|fw|fwd):\s*/i, ''), attendees: att.map((p) => ({ email: p.address, name: p.name })), description: `${(m.text_body || '').slice(0, 1500)}` }, $('#full-pane'));
}
function forwardAsAttachment() {
  const ids = targetIds();
  const first = state.messages.find((x) => x.id === ids[0]) || curMsg();
  openComposer('new', null, { prefill: { subject: ids.length > 1 ? 'Fw: messages' : `Fw: ${first?.subject || ''}`, attachMessages: ids } });
}
async function setFilter(v) {
  RB.filter = v || null;
  showMailView();
  state.selectedId = null; closeReader();
  await loadList();
}

const RB_COMMANDS = {
  newmail: () => $('#new-mail-btn').click(),
  newitems: (b) => popMenu(b, [
    ['✉ Email message', () => $('#new-mail-btn').click()],
    ['\u{1F4C5} Meeting or event', () => editEvent({}, $('#full-pane'))],
    ['☑ Task', () => showView('tasks')],
    ['\u{1F464} Contact', async () => { await showView('people'); $('#new-contact')?.click(); }],
    ['\u{1F465} Contact group', () => groupDialog()],
    ['\u{1F4C1} Folder', () => $('#new-folder-btn').click()],
    ['⚡ Quick Step', async () => { await editQuickStep(null); }],
    ['⚙ Rule', () => openSettings('rules')],
  ]),
  ignore: async () => {
    const m = curMsg();
    const inTrash = currentFolder()?.role === 'trash';
    if (inTrash) {
      if (!confirm('Stop ignoring this conversation? Its messages go back to the Inbox.')) return;
      const r = await api(`/messages/${m.id}/ignore`, { method: 'POST', body: { ignore: false } });
      toast(`No longer ignored. ${r.moved} message(s) moved to the Inbox.`); refresh(); closeReader(); return;
    }
    if (!confirm('Ignore this conversation? Its messages, and any replies that come later, go to Deleted Items.')) return;
    const r = await api(`/messages/${m.id}/ignore`, { method: 'POST', body: { ignore: true } });
    toast(`Conversation ignored. ${r.moved} message(s) moved to Deleted Items.`);
    state.selectedId = null; closeReader(); refresh();
  },
  cleanup: (b) => popMenu(b, [
    ['Clean Up Conversation', async () => {
      const m = curMsg();
      if (!m) return toast('Open a conversation first.');
      const r = await api(`/messages/${m.id}/cleanup`, { method: 'POST', body: {} });
      toast(r.removed ? `Cleaned up ${r.removed} redundant message(s).` : 'Nothing to clean up: no message is fully quoted by a later one.');
      if (r.removed) openMessage(m.id).catch(() => closeReader());
      loadList(); loadFolders();
    }],
    ['Clean Up Folder', () => RB_COMMANDS.cleanupfolder()],
  ]),
  junk: (b) => {
    const ids = targetIds();
    const m = curMsg() || state.messages.find((x) => x.id === ids[0]);
    const inJunk = currentFolder()?.role === 'junk';
    const domain = m?.from_addr?.includes('@') ? `@${m.from_addr.split('@')[1]}` : null;
    popMenu(b, [
      ['Block Sender', async () => { for (const id of ids) await api(`/messages/${id}/report`, { method: 'POST', body: { junk: true } }); toast('Sender blocked. Their mail goes to Junk Email.'); afterBulk(ids); }],
      ['Never Block Sender', async () => { await api('/senders', { method: 'POST', body: { address: m.from_addr, kind: 'safe' } }); toast(`${m.from_addr} is now a safe sender.`); }],
      ...(domain ? [[`Never Block Sender's Domain (${domain})`, async () => { await api('/senders', { method: 'POST', body: { address: domain, kind: 'safe' } }); toast(`${domain} is now a safe domain.`); }]] : []),
      ...(inJunk ? [['Not Junk', async () => { for (const id of ids) await api(`/messages/${id}/report`, { method: 'POST', body: { junk: false } }); toast('Moved to the Inbox. Sender marked safe.'); afterBulk(ids); }]]
        : [['Move to Junk Email', async () => { await bulk('junk'); toast('Moved to Junk Email.'); afterBulk(ids); }]]),
      ['Junk Email Options…', () => openSettings('junk')],
    ]);
  },
  delete: async () => {
    const ids = targetIds();
    const perm = currentFolder()?.role === 'trash';
    if (perm && !confirm(`Permanently delete ${ids.length} message(s)? This can't be undone.`)) return;
    await bulk('delete');
    toast(perm ? 'Permanently deleted.' : 'Moved to Deleted Items.'); afterBulk(ids);
  },
  archive: async () => { const ids = await bulk('archive'); toast('Archived.'); afterBulk(ids); },
  reply: () => openComposer('reply', curMsg()),
  replyall: () => openComposer('replyall', curMsg()),
  forward: () => openComposer('forward', curMsg()),
  meeting: () => meetingFrom(curMsg()),
  fwdattach: () => forwardAsAttachment(),
  respondmore: (b) => popMenu(b, [
    ['Reply All with Meeting', () => meetingFrom(curMsg())],
    ['Forward as Attachment', () => forwardAsAttachment()],
    ['Draft a reply with Arzio AI', () => openComposer('reply', curMsg(), { ai: true })],
    ['Add to To Do', async () => { const m = curMsg(); await api('/tasks', { method: 'POST', body: { title: m.subject || '(no subject)', notes: `From ${m.from_name || m.from_addr}`, message_id: m.id } }); toast('Added to To Do.'); }],
    ['Print', () => printMessage(curMsg(), state.current.thread)],
  ]),
  quicksteps: (b) => popMenu(b, [
    ...RB.quickSteps.map((s, i) => [`⚡ ${s.name}`, () => runQuickStep(i)]),
    ['+ New Quick Step', async () => { await editQuickStep(null); }],
    ['Manage Quick Steps…', () => manageQuickSteps()],
  ]),
  managesteps: () => manageQuickSteps(),
  move: (b) => {
    const ids = targetIds();
    const f = currentFolder();
    const quick = state.folders.filter((x) => x.id !== f?.id && !['drafts', 'sent'].includes(x.role)).slice(0, 10);
    popMenu(b, [
      ...quick.map((x) => [`${FOLDER_ICONS[x.role] || '\u{1F4C1}'} ${x.name}`, async () => { await bulk('move', { folder_id: x.id }); toast(`Moved to ${x.name}.`); afterBulk(ids); }]),
      ['Other Folder…', async () => { const x = await pickFolder('Move to folder', { exclude: f?.id }); if (x) { await api('/messages/bulk', { method: 'POST', body: { ids, action: 'move', folder_id: x.id } }); toast(`Moved to ${x.name}.`); afterBulk(ids); } }],
    ]);
  },
  rules: (b) => {
    const m = curMsg();
    popMenu(b, [
      ...(m ? [[`Always Move Messages From: ${m.from_name || m.from_addr}`, async () => {
        const x = await pickFolder(`Move mail from ${m.from_addr} to`);
        if (!x) return;
        await api('/rules', { method: 'POST', body: { name: `From ${m.from_addr}`, conditions: [{ field: 'from', op: 'contains', value: m.from_addr }], actions: [{ type: 'move', value: String(x.id) }, { type: 'stop' }] } });
        const r = await api('/rules/run', { method: 'POST', body: {} });
        toast(`Rule created. Checked ${r.processed} message(s) in the Inbox.`); refresh();
      }], ['Create Rule…', () => openSettings('rules', { from: m.from_addr, subject: m.subject })]] : []),
      ['Manage Rules & Alerts', () => openSettings('rules')],
    ]);
  },
  savefile: () => saveAsFile(curMsg().id),
  unreadread: async () => {
    const ids = targetIds();
    const msgs = ids.map((id) => state.messages.find((x) => x.id === id)).filter(Boolean);
    const makeRead = msgs.some((x) => !x.is_read);
    await bulk(makeRead ? 'read' : 'unread');
    msgs.forEach((x) => { x.is_read = makeRead; });
    if (!makeRead && ids.includes(state.selectedId)) { state.selectedId = null; closeReader(); }
    renderList(); loadFolders();
    toast(makeRead ? 'Marked as read.' : 'Marked as unread.');
  },
  categorize: (b) => {
    const ids = targetIds();
    const used = new Set(CATEGORY_PRESETS.map(([n]) => n));
    const extra = [...new Set(state.messages.flatMap((x) => x.categories || []))].filter((c) => !used.has(c));
    const has = (c) => ids.every((id) => (state.messages.find((x) => x.id === id)?.categories || []).includes(c));
    popMenu(b, [
      ...CATEGORY_PRESETS.map(([n, dot]) => [`${has(n) ? '✔ ' : ''}${dot} ${n}`, () => setCategory(n)]),
      ...extra.map((n) => [`${has(n) ? '✔ ' : ''}\u{1F3F7} ${n}`, () => setCategory(n)]),
      ['New Category…', async () => { const n = prompt('Name the new category'); if (n?.trim()) await setCategory(n.trim().slice(0, 40), 'add'); }],
      ['Clear All Categories', () => setCategory('', 'clear')],
    ]);
  },
  followup: (b) => popMenu(b, [
    ['\u{1F6A9} Today', () => followUp('flagged', followUpDate('today'))],
    ['\u{1F6A9} Tomorrow', () => followUp('flagged', followUpDate('tomorrow'))],
    ['\u{1F6A9} This Week', () => followUp('flagged', followUpDate('thisweek'))],
    ['\u{1F6A9} Next Week', () => followUp('flagged', followUpDate('nextweek'))],
    ['\u{1F6A9} No Date', () => followUp('flagged', null)],
    ['✔ Mark Complete', () => followUp('complete')],
    ['Clear Flag', () => followUp('clear')],
  ], { datetime: (when) => followUp('flagged', when) }),
  newgroup: () => groupDialog(),
  browsegroups: () => browseGroups(),
  addressbook: () => addressBook(),
  filter: (b) => popMenu(b, FILTERS.map(([v, l]) => [`${(RB.filter || '') === v ? '✔ ' : ''}${l}`, () => setFilter(v)])),
  readaloud: () => (speech.on ? stopReading() : readAloud()),
  translate: (b) => readerAction('translate', curMsg(), state.current.thread, b),
  summarize: (b) => readerAction('summarize', curMsg(), state.current.thread, $('#reader [data-act="summarize"]') || b),
  aidraft: () => openComposer('reply', curMsg(), { ai: true }),
  ask: () => $('#ask-btn').click(),
  insights: () => showInsights(),
  // Send / Receive
  sendreceive: async () => { await refresh(); pollNotifications?.(); toast('All folders are up to date.'); },
  updatefolder: async () => { await loadList(); toast('Folder updated.'); },
  outbox: () => { showMailView(); $('[data-smart="scheduled"]').click(); },
  ooo: () => openSettings('ooo'),
  undosend: () => openSettings('general'),
  // Folder
  newfolder: () => $('#new-folder-btn').click(),
  renamefolder: async () => { const f = await ownFolder('Rename which folder?'); if (!f) return; const name = prompt('Folder name', f.name); if (name?.trim()) { await api(`/folders/${f.id}`, { method: 'PATCH', body: { name } }); await loadFolders(); renderRibbon(); } },
  deletefolder: async () => {
    const f = await ownFolder('Delete which folder?');
    if (!f) return;
    if (!confirm(`Delete "${f.name}"? Its messages move to Deleted Items.`)) return;
    await api(`/folders/${f.id}`, { method: 'DELETE' }); state.folderId = null; await loadFolders(); selectFolder(state.folders[0].id);
  },
  markallread: async () => {
    const f = currentFolder();
    const r = await api(`/messages?folder=${f.id}&unread=1&limit=200`);
    if (r.messages.length) await api('/messages/bulk', { method: 'POST', body: { ids: r.messages.map((m) => m.id), action: 'read' } });
    toast(`Marked ${r.messages.length} message(s) as read.`); refresh();
  },
  cleanupfolder: async () => {
    const f = currentFolder();
    if (!confirm(`Clean up "${f.name}"? Messages fully quoted by a later reply in the same conversation move to Deleted Items. Flagged and pinned messages are kept.`)) return;
    const r = await api(`/folders/${f.id}/cleanup`, { method: 'POST', body: {} });
    toast(r.removed ? `Cleaned up ${r.removed} redundant message(s).` : 'Nothing to clean up.'); refresh();
  },
  emptyfolder: async () => {
    const f = currentFolder();
    const perm = ['trash', 'junk'].includes(f.role);
    if (!confirm(perm ? `Permanently delete everything in ${f.name}? This can't be undone.` : `Move everything in ${f.name} to Deleted Items?`)) return;
    let total = 0;
    for (;;) {
      const r = await api(`/messages?folder=${f.id}&limit=200`);
      if (!r.messages.length) break;
      if (perm) for (const m of r.messages) await api(`/messages/${m.id}`, { method: 'DELETE' });
      else await api('/messages/bulk', { method: 'POST', body: { ids: r.messages.map((m) => m.id), action: 'delete' } });
      total += r.messages.length;
      if (r.messages.length < 200 || total > 5000) break;
    }
    if (f.role === 'junk') { const r = await api(`/messages?folder=${f.id}&limit=200`); for (const m of r.messages) await api(`/messages/${m.id}`, { method: 'DELETE' }); }
    toast(`Deleted ${total} message(s).`); closeReader(); refresh();
  },
  favorite: async () => { await toggleFavorite(`folder:${currentFolder().id}`); },
  folderprops: () => {
    const f = currentFolder();
    modal(`<h2>${esc(f.name)} properties</h2><table><tr><th>Type</th><td>${f.role ? 'Standard folder' : 'Your folder'}</td></tr><tr><th>Items</th><td>${f.total}</td></tr><tr><th>Unread</th><td>${f.unread}</td></tr>
      <tr><th>In Favorites</th><td>${(ui().favorites || []).includes(`folder:${f.id}`) ? 'Yes' : 'No'}</td></tr></table><div class="actions"><button class="btn" data-close>Close</button></div>`);
  },
  // View
  changeview: (b) => popMenu(b, [['roomy', 'Preview (roomy)'], ['comfortable', 'Single (comfortable)'], ['compact', 'Compact']].map(([v, l]) => [`${(ui().density || 'comfortable') === v ? '✔ ' : ''}${l}`, () => saveUi({ density: v })])),
  resetview: async () => { await saveUi({ density: 'comfortable', readingPane: 'right', conversations: true, previewText: true, senderImages: true, sort: 'date', folderPane: true, textSize: 'medium' }); RB.filter = null; loadList(); toast('View reset.'); },
  conversations: async () => { await saveUi({ conversations: ui().conversations === false }); renderRibbon(); if (curMsg()) openMessage(state.selectedId); },
  sortby: (b) => popMenu(b, SORTS_UI.map(([v, l]) => [`${(ui().sort || 'date') === v ? '✔ ' : ''}${l}`, async () => { await saveUi({ sort: v }); loadList(); }])),
  preview: (b) => popMenu(b, [
    [`${ui().previewText !== false ? '✔ ' : ''}Show message preview text`, async () => { await saveUi({ previewText: ui().previewText === false }); renderList(); }],
    [`${ui().senderImages !== false ? '✔ ' : ''}Show sender pictures`, async () => { await saveUi({ senderImages: ui().senderImages === false }); renderList(); }],
  ]),
  folderpane: async () => { await saveUi({ folderPane: ui().folderPane === false }); renderRibbon(); },
  readingpane: (b) => popMenu(b, [['right', 'Right'], ['bottom', 'Bottom'], ['off', 'Off']].map(([v, l]) => [`${(ui().readingPane || 'right') === v ? '✔ ' : ''}${l}`, () => saveUi({ readingPane: v })])),
  ribbonmode: (b) => popMenu(b, [['classic', 'Classic ribbon'], ['simplified', 'Simplified ribbon']].map(([v, l]) => [`${(ui().ribbon || 'classic') === v ? '✔ ' : ''}${l}`, async () => { await saveUi({ ribbon: v }); renderRibbon(); }])),
  ribbonflip: async () => { await saveUi({ ribbon: (ui().ribbon || 'classic') === 'classic' ? 'simplified' : 'classic' }); renderRibbon(); },
  textsize: (b) => popMenu(b, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']].map(([v, l]) => [`${(ui().textSize || 'medium') === v ? '✔ ' : ''}${l}`, () => saveUi({ textSize: v })])),
  darkmode: async () => { await saveUi({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }); renderRibbon(); },
  appearance: () => openSettings('appearance'),
  reminders: () => $('#bell-btn').click(),
  // Help
  shortcuts: () => showShortcuts(),
  whatsnew: () => modal(`<h2>What's new</h2><ul class="whatsnew">
    <li><strong>The ribbon.</strong> Home, Send / Receive, Folder, View and Help tabs, with a Classic or Simplified layout.</li>
    <li><strong>Quick Steps.</strong> One click to move, file, forward to your manager or email your team.</li>
    <li><strong>Ignore and Clean Up.</strong> Silence a conversation, or remove messages that a later reply already quotes.</li>
    <li><strong>Follow Up dates.</strong> Flag for today, tomorrow, this week or next week, then mark complete.</li>
    <li><strong>Contact groups, Address Book and Search People.</strong></li>
    <li><strong>Read Aloud, Filter Email, Arrange By and Insights.</strong></li>
    <li><strong>Select several messages</strong> with Ctrl+click or Shift+click and act on them together.</li></ul>
    <div class="actions"><button class="btn" data-close>Close</button></div>`),
  about: () => modal(`<h2>About ${esc(state.service?.name || 'Arzio Mail')}</h2><p>${esc(state.service?.name || 'Arzio Mail')} is mail, calendar, people and tasks in one place, with AI that helps you read and write.</p>
    <p class="muted small">Signed in as ${esc(state.me.email)}.</p><div class="actions"><button class="btn" data-close>Close</button></div>`),
  options: () => openSettings(),
};

function fileMenu(anchor) {
  popMenu(anchor, [
    ['ℹ Info: account and storage', () => openSettings('general')],
    ['\u{1F4BE} Save As (.eml)', async () => { if (await ensureTarget('one')) await saveAsFile(curMsg().id); }],
    ['\u{1F5A8} Print', async () => { if (await ensureTarget('one')) printMessage(curMsg(), state.current.thread); }],
    ['✉ Automatic Replies', () => openSettings('ooo')],
    ['⚙ Rules and Alerts', () => openSettings('rules')],
    ['\u{1F6E0} Options', () => openSettings()],
    ['⏻ Sign out', () => $('[data-action="logout"]').click()],
  ]);
}

$('#ribbon')?.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-rtab]');
  if (tab) {
    if (tab.dataset.rtab === 'file') return fileMenu(tab);
    RB.tab = tab.dataset.rtab; renderRibbon(); return;
  }
  const folded = e.target.closest('[data-rgroup]');
  if (folded) return openFoldedGroup(folded);
  const qs = e.target.closest('[data-qs]');
  if (qs) {
    try {
      const step = RB.quickSteps[Number(qs.dataset.qs)];
      if (step && !step.actions.every((a) => a.type === 'newmail') && !(await ensureTarget('any', step.actions.some((a) => ['move', 'archive', 'delete'].includes(a.type))))) return;
      await runQuickStep(Number(qs.dataset.qs));
    } catch (ex) { toast(ex.message); }
    return;
  }
  const b = e.target.closest('[data-rb]');
  if (!b) return;
  const cmd = RB_COMMANDS[b.dataset.rb];
  if (!cmd) return;
  e.stopPropagation();
  try { if (await ensureTarget(needsOf(b.dataset.rb), DESTRUCTIVE.has(b.dataset.rb))) await cmd(b); } catch (ex) { toast(ex.message); }
});
$('#ribbon')?.addEventListener('keydown', (e) => {
  if (e.target.id === 'rb-people' && e.key === 'Enter') { e.preventDefault(); searchPeople(e.target.value).catch((ex) => toast(ex.message)); }
});

// Ctrl/Cmd+click and Shift+click select several messages, like Outlook
$('#msg-list').addEventListener('click', (e) => {
  const li = e.target.closest('.msg[data-id]');
  if (!li || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const id = Number(li.dataset.id);
  if (!state.multi.size && state.selectedId) state.multi.add(state.selectedId);
  if (e.shiftKey && state.multi.size) {
    const ids = state.messages.map((m) => m.id);
    const anchor = ids.indexOf([...state.multi].pop());
    const at = ids.indexOf(id);
    for (const x of ids.slice(Math.min(anchor, at), Math.max(anchor, at) + 1)) state.multi.add(x);
  } else if (state.multi.has(id)) state.multi.delete(id); else state.multi.add(id);
  if (state.multi.size === 1) { const only = [...state.multi][0]; state.multi.clear(); openMessage(only); return; }
  state.selectedId = null;
  closeReader();
  $('#empty-state p').textContent = state.multi.size ? `${state.multi.size} items selected` : 'Select an item to read';
  renderList();
}, true);
$('#filter-chip').addEventListener('click', (e) => { if (e.target.closest('[data-clear-filter]')) setFilter(null); });
let ribbonResize;
window.addEventListener('resize', () => { clearTimeout(ribbonResize); ribbonResize = setTimeout(() => { if (state.me) renderRibbon(); }, 150); });
