'use strict';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const labels = { chat: 'Conversation', memory: 'Memory', schedules: 'Follow-ups', inbox: 'Inbox' };
const providerLabel = (id) => ({ openai: 'OpenAI', lmstudio: 'LM Studio' }[id] || id);
let state = null;
let view = 'chat';
let memoryView = 'preferences';
let messages = [];
let hasEarlier = false;
let refreshVersion = 0;
let historyGeneration = 0;
let loadingHistory = false;
let sending = false;
let editingMemory;
let jobProfile;
let jobRequestId;
let confirmation;
let switchingTo = null;
let polling = false;
const rendered = new Map();
const drafts = new Map();

function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + id);
  svg.append(use);
  return svg;
}

function action(label, className, handler) {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function dateText(value) {
  if (value == null) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : String(value);
}

function activeProfile() {
  return state?.profiles.find((p) => p.id === state.activeProfile);
}

function changed(key, data, update) {
  const signature = JSON.stringify(data);
  if (rendered.get(key) === signature) return;
  update();
  rendered.set(key, signature);
}

function showError(target, message) {
  target.textContent = message || '';
  target.hidden = !message;
}

function notice(message) {
  $('#notice-text').textContent = message || '';
  $('#notice').hidden = !message;
}

function setBusy(form, busy) {
  form.setAttribute('aria-busy', String(busy));
  $$('button, input, textarea, select', form).forEach((input) => { input.disabled = busy; });
}

async function api(path, { method = 'GET', body, profile = state?.activeProfile } = {}) {
  const headers = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Clockwork-Request'] = '1';
    if (profile) headers['X-Clockwork-Profile'] = profile;
  }
  let response;
  try {
    response = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('Clockwork is unreachable. Check the connection to your server and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : 'Request failed (HTTP ' + response.status + ').');
    error.status = response.status;
    throw error;
  }
  return data;
}

function closeNav(restoreFocus = false) {
  const wasOpen = $('#rail').classList.contains('open');
  $('#rail').classList.remove('open');
  $('#open-nav').setAttribute('aria-expanded', 'false');
  $('#nav-scrim').hidden = true;
  $('.main').inert = false;
  if (restoreFocus && wasOpen) $('#open-nav').focus();
}

function showLogin(message = '') {
  const wasOpen = !$('#login').hidden;
  state = null;
  refreshVersion++;
  historyGeneration++;
  rendered.clear();
  drafts.clear();
  messages = [];
  hasEarlier = false;
  sending = false;
  editingMemory = null;
  jobProfile = null;
  confirmation = null;
  switchingTo = null;
  closeNav();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  for (const id of ['transcript', 'memory-list', 'job-list', 'run-list', 'approval-list', 'notification-list']) {
    document.getElementById(id).replaceChildren();
  }
  $('#message').value = '';
  $('#memory-form').reset();
  $('#job-form').reset();
  $('#confirm-copy').textContent = '';
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#login').hidden = false;
  document.title = 'Sign in · Clockwork';
  if (message || !wasOpen) showError($('#login-error'), message);
  if (!wasOpen) $('#password').focus();
}

function go(next, focus = false) {
  view = next;
  closeNav();
  Object.keys(labels).forEach((key) => { $('#view-' + key).hidden = key !== next; });
  $$('nav [data-view]').forEach((item) => {
    if (item.dataset.view === next) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  $('#view-heading').textContent = labels[next];
  document.title = labels[next] + ' · Clockwork';
  render();
  if (focus) $('#view-heading').focus();
}

function mergePage(latest, earlier) {
  if (!latest.length || !messages.length) {
    messages = latest;
    hasEarlier = earlier;
    return;
  }
  const start = messages.findIndex((message) => message.id === latest[0].id);
  if (start < 0) {
    messages = latest;
    hasEarlier = earlier;
  } else {
    messages = [...messages.slice(0, start), ...latest];
    if (start === 0) hasEarlier = earlier;
  }
}

async function refresh({ report = true } = {}) {
  const version = ++refreshVersion;
  try {
    const data = await api('/api/state');
    if (version !== refreshVersion) return;
    const prior = state;
    if (!prior || prior.activeProfile !== data.activeProfile) {
      messages = [];
      historyGeneration++;
      rendered.clear();
      // A different tab can switch the active provider while a form is being edited.
      if (prior) {
        drafts.set(prior.activeProfile, $('#message').value);
        $('#message').value = drafts.get(data.activeProfile) || '';
        $$('dialog[open]').forEach((dialog) => dialog.close());
        if (data.activeProfile !== switchingTo) notice('The active profile changed. Check the provider before sending your next message.');
      }
    }
    state = data;
    mergePage(data.messages || [], Boolean(data.hasEarlier));
    $('#boot').hidden = true;
    $('#login').hidden = true;
    $('#app').hidden = false;
    if (!prior) go('chat');
    else render();
    if (!prior) $('#message').focus();
  } catch (error) {
    if (version !== refreshVersion) return;
    if (error.status === 401 || !state) showLogin(error.status === 401 ? '' : error.message);
    else if (report) notice(error.message);
  }
}

async function mutate(path, body, { method = 'POST', profile = state?.activeProfile, dialog, button } = {}) {
  if (button?.disabled) return false;
  if (button) button.disabled = true;
  const form = dialog?.querySelector('form');
  if (form) {
    if (form.getAttribute('aria-busy') === 'true') return false;
    setBusy(form, true);
    showError($('.dialog-error', form), '');
  }
  try {
    await api(path, { method, body, profile });
    if (dialog?.open) dialog.close();
    notice('');
    await refresh();
    return true;
  } catch (error) {
    await refresh({ report: false });
    if (state) {
      if (dialog?.open) showError($('.dialog-error', dialog), error.message);
      else notice(error.message);
    }
    return false;
  } finally {
    if (button) button.disabled = false;
    if (form) setBusy(form, false);
  }
}

function empty(list, glyph, copy) {
  const row = el('div', 'empty');
  row.append(icon(glyph), el('p', '', copy));
  list.append(row);
}

function listRows(selector, records, glyph, emptyText, make) {
  const list = $(selector);
  list.replaceChildren(...records.map(make));
  if (!records.length) empty(list, glyph, emptyText);
}

function record(title, status) {
  const row = el('article', 'record');
  const heading = el('div', 'record-head');
  heading.append(el('h3', '', title));
  if (status) heading.append(el('span', 'status ' + status, status));
  row.append(heading);
  return row;
}

function rowActions(row, ...buttons) {
  const actions = el('div', 'row-actions');
  actions.append(...buttons);
  row.append(actions);
}

function renderChat() {
  const scroller = $('#chat-scroll');
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 110;
  changed('messages', messages, () => {
    const transcript = $('#transcript');
    // Keep existing log nodes when a new turn arrives so screen readers announce only the addition.
    const nodes = new Map([...transcript.children].map((node) => [node.dataset.key, node]));
    const ordered = messages.map((message) => {
      const key = String(message.id);
      if (nodes.has(key)) return nodes.get(key);
      const kind = message.role === 'error' ? 'error-row' : message.role;
      const article = el('article', 'message ' + kind);
      article.dataset.key = key;
      const who = message.role === 'user' ? 'You' : message.role === 'error' ? 'Provider error' : 'Clockwork';
      const metadata = el('div', 'message-meta');
      const source = state.profiles.find((p) => p.id === message.profileId);
      const detail = [source && message.role !== 'user' ? source.label : '', dateText(message.createdAt)].filter(Boolean).join(' · ');
      metadata.append(el('strong', '', who), el('span', '', detail));
      article.append(metadata, el('div', 'message-content', message.content));
      return article;
    });
    // In the common polling case the existing prefix is untouched.
    for (let i = 0; i < ordered.length; i++) {
      if (transcript.children[i] !== ordered[i]) transcript.insertBefore(ordered[i], transcript.children[i] || null);
    }
    while (transcript.children.length > ordered.length) transcript.lastChild.remove();
    $('#welcome').hidden = messages.length > 0;
    if (atEnd && !loadingHistory) scroller.scrollTop = scroller.scrollHeight;
  });
  $('#history-nav').hidden = !hasEarlier;
  $('#waiting').hidden = !(sending || state.chatting);
  $('.send').disabled = sending || state.chatting;
  $('#profile').disabled = sending || state.chatting;
}

function renderMemory() {
  const preferences = memoryView === 'preferences';
  $$('[data-memory]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.memory === memoryView)));
  $('#memory-heading').textContent = preferences ? 'Saved preferences' : 'Commitments';
  $('#memory-description').textContent = preferences ? 'Preferences you explicitly saved for future conversations.' : 'Track the commitments you want Clockwork to remember.';
  $('#add-memory span').textContent = preferences ? 'Add preference' : 'Add commitment';
  const scope = activeProfile()?.scope || '';
  $('#scope-label').textContent = 'Memory scope · ' + scope;
  changed('memory-list', [memoryView, scope, state[memoryView]], () => {
    listRows('#memory-list', state[memoryView], preferences ? 'bookmark' : 'task',
      preferences ? 'No saved preferences in this scope.' : 'No commitments in this scope.', (item) => {
        const row = el('article', 'record' + (item.done ? ' done' : ''));
        row.append(el('p', 'saved-text', item.text));
        if (preferences) {
          rowActions(row, action('Edit', 'secondary', () => openMemory('preference', item)),
            action('Remove', 'secondary', () => confirmAction('Remove preference?', item.text, 'Remove', true,
              (dialog, profile) => mutate('/api/preferences/' + encodeURIComponent(item.id), undefined, { method: 'DELETE', dialog, profile }))));
        } else {
          rowActions(row, action(item.done ? 'Reopen' : 'Mark complete', 'secondary', (e) =>
            mutate('/api/commitments/' + encodeURIComponent(item.id), { done: !item.done }, { method: 'PATCH', button: e.currentTarget })));
        }
        return row;
      });
  });
}

function renderSchedules() {
  changed('jobs', state.jobs, () => listRows('#job-list', state.jobs, 'calendar', 'No follow-ups scheduled yet.', (job) => {
    const row = record(job.goal, job.status);
    const profile = state.profiles.find((p) => p.id === job.profileId);
    const rule = { always: 'Notify after each run', never: 'Keep quiet', nonempty: 'Notify when items are found' }[job.condition] || job.condition;
    row.append(el('p', 'meta', [job.recurrence, String(job.localTime).replace('T', ' '), job.timezone].join(' · ')));
    row.append(el('p', 'meta', [rule, job.budgetSeconds + 's budget', profile?.label || job.profileId].join(' · ')));
    if (job.nextAt) row.append(el('p', 'meta', 'Next run in your browser’s time zone · ' + dateText(job.nextAt)));
    if (job.tool) {
      const details = el('details');
      details.append(el('summary', '', 'Allowed tool · ' + job.tool.name), el('pre', '', JSON.stringify(job.tool.args, null, 2)));
      row.append(details);
    }
    if (job.status === 'active' || job.status === 'paused') {
      const transition = job.status === 'active' ? 'pause' : 'resume';
      const path = '/api/jobs/' + encodeURIComponent(job.id) + '/';
      rowActions(row, action(transition === 'pause' ? 'Pause' : 'Resume', 'secondary', (e) =>
        mutate(path + transition, {}, { button: e.currentTarget })),
      action('Cancel schedule', 'secondary', () => confirmAction('Cancel this schedule?', job.goal, 'Cancel schedule', true,
        (dialog, profileId) => mutate(path + 'cancel', {}, { dialog, profile: profileId }))));
    }
    return row;
  }));
  changed('runs', state.runs, () => listRows('#run-list', state.runs, 'history', 'Completed and attempted runs will appear here.', (run) => {
    const row = record(run.goal, run.status);
    const attempts = run.attempts + (run.attempts === 1 ? ' attempt' : ' attempts');
    row.append(el('p', 'meta', 'Scheduled ' + dateText(run.scheduledAt) + ' · ' + attempts));
    if (run.finishedAt) row.append(el('p', 'meta', 'Finished ' + dateText(run.finishedAt)));
    if (run.detail) row.append(el('p', 'saved-text', run.detail));
    return row;
  }));
}

function renderInbox() {
  changed('approvals', state.approvals, () => listRows('#approval-list', state.approvals, 'lock', 'No action approvals to review.', (approval) => {
    const row = record(approval.tool, approval.status);
    const profile = state.profiles.find((p) => p.id === approval.profileId);
    row.append(el('p', 'meta', [profile?.label || approval.profileId, dateText(approval.createdAt)].join(' · ')),
      el('p', 'meta', 'Destination'), el('pre', '', reviewValue(approval.destination)),
      el('p', 'meta', 'Arguments'), el('pre', '', reviewValue(approval.args)));
    if (approval.status === 'pending') {
      const path = '/api/approvals/' + encodeURIComponent(approval.id) + '/';
      rowActions(row, action('Approve action', 'primary', (e) => mutate(path + 'approve', {}, { button: e.currentTarget })),
        action('Reject', 'secondary', (e) => mutate(path + 'reject', {}, { button: e.currentTarget })));
    }
    return row;
  }));
  changed('notifications', state.notifications, () => listRows('#notification-list', state.notifications, 'inbox', 'No follow-up notifications yet.', (notification) => {
    const row = record(notification.goal);
    row.append(el('p', 'meta', dateText(notification.createdAt)));
    if (notification.body && notification.body !== notification.goal) row.append(el('p', 'saved-text', notification.body));
    return row;
  }));
}

// Make direction controls visible when showing the precise action under review.
function reviewValue(value) {
  return JSON.stringify(value, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function render() {
  if (!state) return;
  changed('profiles', [state.profiles, state.activeProfile, state.localOnly], () => {
    const select = $('#profile');
    select.replaceChildren(...state.profiles.map((profile) => {
      const option = new Option(profile.label, profile.id);
      option.disabled = state.localOnly && profile.provider !== 'lmstudio';
      return option;
    }));
    select.value = state.activeProfile;
    const profile = activeProfile();
    $('#provider-name').textContent = providerLabel(profile.provider) + (state.localOnly ? ' · Local only' : '');
    $('#provider-model').textContent = profile.model;
    $('.provider').title = [profile.label, providerLabel(profile.provider), profile.model, profile.nativeTools ? 'Native tools enabled' : 'Chat only'].join(' · ');
  });
  $('#profile').disabled = Boolean(sending || state.chatting);
  const pending = state.approvals.filter((a) => a.status === 'pending').length;
  $('#approval-count').textContent = String(pending);
  $('#approval-count').setAttribute('aria-label', pending + ' pending approvals');
  $('#approval-count').hidden = !pending;
  if (view === 'chat') renderChat();
  if (view === 'memory') renderMemory();
  if (view === 'schedules') renderSchedules();
  if (view === 'inbox') renderInbox();
}

function showDialog(id) {
  const dialog = $(id);
  const form = $('form', dialog);
  setBusy(form, false);
  showError($('.dialog-error', dialog), '');
  dialog.showModal();
  return dialog;
}

function confirmAction(title, copy, label, destructive, callback) {
  const profile = state.activeProfile;
  confirmation = (dialog) => callback(dialog, profile);
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = copy;
  $('#confirm-submit').textContent = label;
  $('#confirm-submit').className = destructive ? 'danger' : 'primary';
  showDialog('#confirm-dialog');
}

function openMemory(kind, item = null) {
  const isPreference = kind === 'preference';
  editingMemory = { kind, id: item?.id, profile: state.activeProfile };
  $('#memory-title').textContent = item ? 'Edit preference' : isPreference ? 'Save a preference' : 'Track a commitment';
  $('#memory-label').textContent = isPreference ? 'Preference' : 'Commitment';
  $('#memory-text').value = item?.text || '';
  $('#memory-submit').textContent = item ? 'Save changes' : isPreference ? 'Save preference' : 'Save commitment';
  showDialog('#memory-dialog');
  $('#memory-text').focus();
}

function localDateValue(date) {
  const two = (part) => String(part).padStart(2, '0');
  return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate()) + 'T' + two(date.getHours()) + ':' + two(date.getMinutes());
}

function updateJobTool() {
  const selected = jobProfile?.tools.find((tool) => tool.name === $('#job-tool').value);
  $('#tool-inputs').hidden = !selected;
  $('#job-condition option[value="nonempty"]').disabled = !selected;
  if (!selected && $('#job-condition').value === 'nonempty') $('#job-condition').value = 'always';
  $('#tool-description').textContent = selected?.description || '';
  $('#job-schema').textContent = selected ? JSON.stringify(selected.inputSchema, null, 2) : '';
  $('#job-args').value = '{}';
}

function openJob() {
  jobProfile = activeProfile();
  jobRequestId = crypto.randomUUID();
  $('#job-form').reset();
  $('#job-time').value = localDateValue(new Date(Date.now() + 3600000));
  $('#job-zone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  $('#job-tool').replaceChildren(new Option('None · reminder only', ''), ...jobProfile.tools
    .filter((tool) => tool.effect === 'read').map((tool) => new Option(tool.name, tool.name)));
  $('#job-profile').textContent = 'Scheduled with ' + jobProfile.label + ' · ' + providerLabel(jobProfile.provider);
  updateJobTool();
  showDialog('#job-dialog');
  $('#job-goal').focus();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  showError($('#login-error'), '');
  setBusy(form, true);
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await refresh();
  } catch (error) {
    showError($('#login-error'), error.message);
  } finally {
    setBusy(form, false);
    if (!state) $('#password').focus();
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
    showLogin();
  } catch (error) {
    await refresh({ report: false });
    if (state) notice(error.message);
  }
});

$('#profile').addEventListener('change', (event) => {
  const next = state.profiles.find((p) => p.id === event.currentTarget.value);
  $('#profile').value = state.activeProfile;
  if (!next || next.id === state.activeProfile) return;
  const principal = providerLabel(next.provider) + ' (' + next.model + ')';
  confirmAction('Switch agent profile?', 'Your next chat sends conversation history and saved memory from the ' + next.scope +
    ' scope to ' + principal + '. Existing follow-ups keep their scheduled profile.',
    'Switch to ' + next.label, false, async (dialog, profile) => {
      switchingTo = next.id;
      try { await mutate('/api/profile', { id: next.id }, { dialog, profile }); }
      finally { switchingTo = null; }
    });
});

$('#older').addEventListener('click', async () => {
  if (!messages.length || loadingHistory) return;
  loadingHistory = true;
  $('#older').disabled = true;
  const generation = historyGeneration;
  const oldest = messages[0].id;
  const scroller = $('#chat-scroll');
  try {
    const query = new URLSearchParams({ before: oldest, profile: state.activeProfile });
    const page = await api('/api/history?' + query);
    if (generation !== historyGeneration || oldest !== messages[0]?.id) return;
    const priorHeight = scroller.scrollHeight;
    messages = [...page.messages, ...messages];
    hasEarlier = page.hasEarlier;
    renderChat();
    scroller.scrollTop += scroller.scrollHeight - priorHeight;
  } catch (error) {
    await refresh({ report: false });
    if (state) notice(error.message);
  } finally {
    loadingHistory = false;
    $('#older').disabled = false;
  }
});

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state || sending || state.chatting) return;
  const input = $('#message');
  const content = input.value.trim();
  if (!content) { input.focus(); return; }
  const prior = new Set(messages.map((m) => m.id));
  const profile = state.activeProfile;
  sending = true;
  input.value = '';
  notice('');
  render();
  try {
    await api('/api/chat', { method: 'POST', body: { text: content }, profile });
    await refresh();
  } catch (error) {
    await refresh({ report: false });
    if (state) {
      const saved = messages.some((m) => !prior.has(m.id) && m.role === 'user' && m.content === content);
      if (!saved && state.activeProfile === profile && !input.value) input.value = content;
      if (!saved && state.activeProfile !== profile && !drafts.get(profile)) drafts.set(profile, content);
      notice(error.message);
    }
  } finally {
    sending = false;
    render();
  }
});

$('#message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

$('#memory-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const draft = editingMemory;
  if (!draft) return;
  const text = $('#memory-text').value.trim();
  if (!text) return showError($('#memory-dialog .dialog-error'), 'Enter the text you want to save.');
  const list = draft.kind === 'preference' ? 'preferences' : 'commitments';
  const edit = draft.id != null;
  const ok = await mutate('/api/' + list + (edit ? '/' + encodeURIComponent(draft.id) : ''), { text }, {
    method: edit ? 'PATCH' : 'POST', dialog: $('#memory-dialog'), profile: draft.profile
  });
  if (ok && state) { memoryView = list; go('memory', true); }
});

$('#job-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!jobProfile) return;
  const tool = $('#job-tool').value;
  let args = {};
  try {
    if (tool) args = JSON.parse($('#job-args').value);
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error();
  } catch {
    return showError($('#job-dialog .dialog-error'), 'Enter a valid JSON object for the tool arguments.');
  }
  const spec = {
    requestId: jobRequestId, goal: $('#job-goal').value.trim(), profileId: jobProfile.id,
    allowedTools: tool ? [tool] : [], budgetSeconds: Number($('#job-budget').value),
    timezone: $('#job-zone').value.trim(), localTime: $('#job-time').value,
    recurrence: $('#job-recurrence').value, condition: $('#job-condition').value,
    tool: tool ? { name: tool, args } : null
  };
  const ok = await mutate('/api/jobs', spec, { dialog: $('#job-dialog'), profile: jobProfile.id });
  if (ok && state) go('schedules', true);
});

$('#confirm-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (confirmation) confirmation($('#confirm-dialog'));
});
$('#job-tool').addEventListener('change', updateJobTool);
$('#add-memory').addEventListener('click', () => openMemory(memoryView === 'preferences' ? 'preference' : 'commitment'));
$('#new-job').addEventListener('click', openJob);
$('#dismiss-notice').addEventListener('click', () => notice(''));
$$('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach((dialog) => dialog.addEventListener('cancel', (event) => {
  if ($('form', dialog).getAttribute('aria-busy') === 'true') event.preventDefault();
}));
$$('[data-shortcut]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.shortcut === 'job') openJob();
  else openMemory(button.dataset.shortcut);
}));
$$('[data-memory]').forEach((button) => button.addEventListener('click', () => {
  memoryView = button.dataset.memory;
  renderMemory();
}));
$$('[data-view]').forEach((button) => button.addEventListener('click', () => go(button.dataset.view, true)));
$('#open-nav').addEventListener('click', () => {
  $('#rail').classList.add('open');
  $('#nav-scrim').hidden = false;
  $('#open-nav').setAttribute('aria-expanded', 'true');
  $('.main').inert = true;
  $('#close-nav').focus();
});
$('#close-nav').addEventListener('click', () => closeNav(true));
$('#nav-scrim').addEventListener('click', () => closeNav(true));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#rail').classList.contains('open')) closeNav(true);
});
window.matchMedia('(min-width: 761px)').addEventListener('change', (event) => { if (event.matches) closeNav(); });
async function poll() {
  if (document.hidden || !state || polling) return;
  polling = true;
  try { await refresh(); } finally { polling = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
setInterval(poll, 5000);
refresh();
