'use strict';

let directory = null;
let directoryVersion = 0;
let selectedAgent = null;
let agentEpoch = 0;
let slotToCreate = null;
let loadedSettings = null;
let settingsVersion = 0;
let filesVersion = 0;
let fileRequest = 0;
let editingFile = null;
let dispatchVersion = 0;
let pendingDispatch = null;

function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
}

// Retain only a digest and random receipt ID in tab storage. Where Web Crypto
// lacks digest support, keep the pending request in memory for retries.
async function dispatchRequestId(text, recipients) {
  const signature = JSON.stringify([text, [...recipients].sort()]);
  if (!crypto.subtle) {
    if (pendingDispatch?.signature !== signature) pendingDispatch = {signature, id:newRequestId()};
    return pendingDispatch.id;
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
  const digest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
  const previous = sessionStorage.getItem('clockwork-dispatch-receipt')?.split('/');
  if (previous?.[0] === digest && previous[1]) return previous[1];
  const id = newRequestId();
  sessionStorage.setItem('clockwork-dispatch-receipt', digest + '/' + id);
  return id;
}

function forgetDispatchReceipt() {
  pendingDispatch = null;
  sessionStorage.removeItem('clockwork-dispatch-receipt');
}

function draftKey(s) {
  return JSON.stringify([s.agent.id, s.activeProfile, s.settingsRevision]);
}

function agentLabel(agent) {
  const name = agent.name || agent.id;
  return directory?.agents.some(other => other.id !== agent.id && other.name === name) ? name + ' (' + agent.id + ')' : name;
}

function clearAgentState() {
  if (state) drafts.set(draftKey(state), $('#message').value);
  agentEpoch++;
  refreshVersion++;
  historyGeneration++;
  settingsVersion++;
  filesVersion++;
  fileRequest++;
  state = null;
  loadedSettings = null;
  editingMemory = null;
  editingFile = null;
  jobProfile = null;
  slotToCreate = null;
  confirmation = null;
  switchingTo = null;
  messages = [];
  hasEarlier = false;
  loadingHistory = false;
  sending = false;
  rendered.clear();
  $$('dialog[open]').forEach(dialog => dialog.close());
  for (const id of ['transcript', 'memory-list', 'job-list', 'run-list', 'approval-list', 'notification-list',
    'file-list', 'profile', 'settings-profile', 'job-tool']) $('#' + id).replaceChildren();
  for (const id of ['message', 'confirm-copy', 'agent-goal', 'tool-description', 'job-schema', 'settings-status',
    'file-status', 'provider-name', 'provider-model', 'current-agent']) {
    if (id === 'message') $('#message').value = '';
    else $('#' + id).textContent = '';
  }
  for (const id of ['memory-form', 'job-form', 'settings-form', 'file-form', 'new-agent-form']) {
    const form = $('#' + id);
    form.reset();
    setBusy(form, false);
  }
  $('#approval-count').hidden = true;
  $('#settings-form').hidden = true;
  $('#older').disabled = false;
  notice('');
  updateNavigation();
}

function updateNavigation() {
  $$('nav button[data-view]').forEach(button => { button.disabled = !state && button.dataset.view !== 'agents'; });
  $('#profile').disabled = !state;
}

async function loadDirectory() {
  const request = ++directoryVersion;
  try {
    const data = await requestJSON('/api/agents');
    if (request !== directoryVersion) return false;
    directory = data;
    renderDirectory();
    return true;
  } catch (error) {
    if (request !== directoryVersion) return false;
    if (error.status === 401 || !directory) showLogin(error.status === 401 ? '' : error.message);
    else notice(error.message);
    return false;
  }
}

async function startSession() {
  if (!await loadDirectory()) return;
  $('#boot').hidden = true;
  $('#login').hidden = true;
  $('#app').hidden = false;
  const previous = sessionStorage.getItem('clockwork-agent');
  if (previous) {
    const saved = directory.agents.find(a => a.id === previous);
    if (saved && (saved.initialized || !saved.available)) await selectAgent(saved.id, !saved.available);
    else { updateNavigation(); go('agents'); notice('The previously selected agent is unavailable. Choose an agent to continue.'); }
    return;
  }
  const agent = directory.agents.find(a => a.id === directory.defaultAgent && a.initialized)
    || directory.agents.find(a => a.initialized && a.available);
  if (agent) await selectAgent(agent.id);
  else { updateNavigation(); go('agents'); }
}

async function selectAgent(id, offline = false) {
  clearAgentState();
  selectedAgent = id;
  sessionStorage.setItem('clockwork-agent', id);
  go('agents');
  if (offline) { notice('The selected worker is offline. Retry its connection or choose another agent.'); return; }
  notice('Opening agent…');
  const epoch = agentEpoch;
  await refresh();
  if (epoch === agentEpoch && state) { notice(''); renderDirectory(); }
}

function renderDirectory() {
  if (!directory) return;
  const agents = directory.agents.filter(a => a.initialized || !a.available);
  const slots = directory.agents.filter(a => a.available && !a.initialized);
  changed('directory', [directory.agents, selectedAgent, Boolean(state)], () => {
    const picker = $('#agent-picker');
    picker.replaceChildren(...agents.map(a => new Option(agentLabel(a), a.id)));
    picker.value = selectedAgent || '';
    picker.disabled = !agents.length;
    const cards = agents.map(a => {
      const current = a.id === selectedAgent && state;
      const card = el('article', 'agent-card' + (current ? ' current' : ''));
      const header = el('div', 'record-head');
      header.append(el('h3', '', agentLabel(a)));
      if (current || !a.available) header.append(el('span', 'status', !a.available ? 'Offline' : 'Current agent'));
      card.append(header);
      if (a.goal) card.append(el('p', 'saved-text', a.goal));
      rowActions(card, action(!a.available ? 'Retry connection' : 'Open conversation', 'secondary', async () => {
        await selectAgent(a.id);
        if (!state) await loadDirectory();
      }));
      return card;
    });
    $('#agent-list').replaceChildren(...cards);
    $('#slot-info').textContent = slots.length ? '' : 'To add another agent, provision a spare Docker worker and refresh.';
    $('#new-agent').disabled = slots.length === 0;
    const checked = new Set($$('#recipients input:checked').map(input => input.value));
    $('#recipients').replaceChildren(...agents.filter(a => (a.available && a.initialized) || checked.has(a.id)).map(a => {
      const label = el('label', 'check-line');
      const input = el('input');
      input.type = 'checkbox';
      input.value = a.id;
      input.checked = checked.has(a.id);
      label.append(input, el('span', '', agentLabel(a) + (a.available ? '' : ' · Offline')));
      return label;
    }));
  });
}

$('#agent-picker').addEventListener('change', e => selectAgent(e.currentTarget.value));
$('#refresh-agents').addEventListener('click', loadDirectory);
$('#new-agent').addEventListener('click', () => {
  slotToCreate = directory?.agents.find(a => a.available && !a.initialized)?.id;
  if (!slotToCreate) return;
  $('#new-agent-form').reset();
  showDialog('#new-agent-dialog');
  $('#new-agent-name').focus();
});
$('#new-agent-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const epoch = agentEpoch;
  if (!slotToCreate || form.getAttribute('aria-busy') === 'true') return;
  const body = {id:slotToCreate, name:$('#new-agent-name').value.trim(), goal:$('#new-agent-goal').value.trim()};
  setBusy(form, true);
  try {
    const {agent} = await requestJSON('/api/agents', {method:'POST', body});
    if (epoch !== agentEpoch) return;
    $('#new-agent-dialog').close();
    await loadDirectory();
    if (epoch === agentEpoch) await selectAgent(agent.id);
  } catch (error) {
    if (epoch === agentEpoch) showError($('#new-agent-dialog .dialog-error'), error.message);
  } finally {
    if (epoch === agentEpoch) setBusy(form, false);
  }
});

function clearDispatch() {
  dispatchVersion++;
  forgetDispatchReceipt();
  $('#dispatch-form').reset();
  setBusy($('#dispatch-form'), false);
  $('#dispatch-results').replaceChildren();
  $('#dispatch-results').hidden = true;
  showError($('#dispatch-error'), '');
}

$('#dispatch-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.getAttribute('aria-busy') === 'true') return;
  const ids = $$('#recipients input:checked').map(input => input.value);
  if (!ids.length) return showError($('#dispatch-error'), 'Choose at least one recipient.');
  const text = $('#assignment').value.trim();
  if (!text) return showError($('#dispatch-error'), 'Enter an assignment.');
  const version = ++dispatchVersion;
  const epoch = agentEpoch;
  setBusy(form, true);
  showError($('#dispatch-error'), '');
  try {
    const targets = await Promise.all(ids.map(async id => {
      const settings = await workerRequest(id, '/settings');
      if (settings.agent.id !== id) throw new Error('Agent identity mismatch.');
      const profile = settings.profiles.find(p => p.id === settings.activeProfile);
      const name = agentLabel(settings.agent);
      return {id, name, profileId:profile.id, revision:settings.revision,
        description:name + ' · ' + providerLabel(profile.provider) + ' · ' + profile.model};
    }));
    if (epoch !== agentEpoch || version !== dispatchVersion || view !== 'agents') return;
    const copy = targets.map(t => t.description).join('\n') + '\n\nAssignment\n' + text;
    confirmAction('Send this assignment?', copy, 'Send to ' + targets.length + (targets.length === 1 ? ' agent' : ' agents'), false, async dialog => {
      if (version !== dispatchVersion) return;
      dialog.close();
      setBusy(form, true);
      $('#dispatch-results').hidden = false;
      $('#dispatch-results').replaceChildren(el('p', 'meta', 'Waiting for the selected agents…'));
      try {
        const requestId = await dispatchRequestId(text, ids);
        if (version !== dispatchVersion) return;
        const body = {requestId, text, targets:targets.map(({id,profileId,revision}) => ({id,profileId,revision}))};
        const {results} = await requestJSON('/api/dispatch', {method:'POST', body});
        if (version !== dispatchVersion) return;
        $('#dispatch-results').replaceChildren(...results.map(result => {
          const target = targets.find(t => t.id === result.id);
          const row = record(target?.name || result.id, result.ok ? 'completed' : 'failed');
          if (result.error) row.append(el('p', 'saved-text', result.error));
          rowActions(row, action('Open conversation', 'secondary', () => selectAgent(result.id)));
          return row;
        }));
        if (results.every(result => result.ok)) {
          forgetDispatchReceipt();
          $('#assignment').value = '';
        } else {
          $('#dispatch-results').append(el('p', 'meta', 'Review again to retry this assignment with its existing receipt. Change the text or recipient list to send a new assignment.'));
        }
      } catch (error) {
        if (version !== dispatchVersion) return;
        $('#dispatch-results').replaceChildren(el('p', 'error', error.message + ' Review again to retry with the same receipt.'));
      } finally {
        if (version === dispatchVersion) setBusy(form, false);
      }
    });
  } catch (error) {
    if (version === dispatchVersion && epoch === agentEpoch) showError($('#dispatch-error'), error.message);
  } finally {
    if (version === dispatchVersion) setBusy(form, false);
  }
});

async function loadSettings() {
  const version = ++settingsVersion;
  const epoch = agentEpoch;
  loadedSettings = null;
  $('#settings-form').hidden = true;
  $('#settings-credential').value = '';
  $('#settings-status').textContent = 'Loading settings…';
  try {
    const settings = await api('/settings');
    if (version !== settingsVersion || epoch !== agentEpoch || view !== 'settings') return;
    if (settings.agent.id !== selectedAgent) throw new Error('Agent identity mismatch.');
    loadedSettings = settings;
    $('#settings-name').value = settings.agent.name;
    $('#settings-goal').value = settings.agent.goal;
    $('#settings-profile').replaceChildren(...settings.profiles.map(p => new Option(p.label + ' · ' + providerLabel(p.provider), p.id)));
    $('#settings-profile').value = settings.activeProfile;
    $('#settings-policy').textContent = settings.localOnly ? 'This worker is configured for local-only inference.' : '';
    settingsProfileChanged();
    showError($('#settings-error'), '');
    $('#settings-status').textContent = '';
    $('#settings-form').hidden = false;
  } catch (error) {
    if (version === settingsVersion && epoch === agentEpoch) $('#settings-status').textContent = error.message;
  }
}

function settingsProfile() { return loadedSettings?.profiles.find(p => p.id === $('#settings-profile').value); }
function settingsProfileChanged() {
  const profile = settingsProfile();
  if (!profile) return;
  $('#settings-model').value = profile.model;
  $('#settings-url').value = profile.baseUrl;
  $('#settings-tools').checked = profile.nativeTools;
  $('#credential-mode').value = 'keep';
  credentialChanged();
}
function credentialChanged() {
  const mode = $('#credential-mode').value;
  const profile = settingsProfile();
  const sameOrigin = profile && URL.parse($('#settings-url').value)?.origin === URL.parse(profile.baseUrl)?.origin;
  $('#credential-status').textContent = mode === 'clear' ? 'This endpoint will use anonymous access.'
    : mode === 'replace' ? 'The new credential applies to this provider and destination.'
    : sameOrigin ? (profile.credentialConfigured ? 'A credential is configured.' : 'No credential is configured.')
    : 'Only a credential saved for this destination can be used.';
  $('#credential-entry').hidden = mode !== 'replace';
  $('#settings-credential').required = mode === 'replace';
  $('#settings-credential').value = '';
}

$('#settings-profile').addEventListener('change', settingsProfileChanged);
$('#settings-model').addEventListener('input', () => { $('#settings-tools').checked = false; });
$('#settings-url').addEventListener('input', credentialChanged);
$('#credential-mode').addEventListener('change', credentialChanged);
$('#reload-settings').addEventListener('click', loadSettings);
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!loadedSettings) return;
  const original = loadedSettings;
  const epoch = agentEpoch;
  const profile = settingsProfile();
  const body = {revision:original.revision, profileId:profile.id,
    name:$('#settings-name').value.trim(), goal:$('#settings-goal').value.trim(), model:$('#settings-model').value.trim(),
    baseUrl:$('#settings-url').value.trim(), nativeTools:$('#settings-tools').checked};
  const mode = $('#credential-mode').value;
  const endpoint = URL.parse(body.baseUrl);
  if (!endpoint || !['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return showError($('#settings-error'), 'Enter an HTTP or HTTPS endpoint without credentials, a query or a fragment.');
  }
  if (mode !== 'keep') body.credential = mode === 'clear' ? '' : $('#settings-credential').value;
  const copy = 'Save settings for ' + body.name + '. Future turns in the ' + profile.scope + ' scope send conversation history and saved memory to ' +
    providerLabel(profile.provider) + ' (' + body.model + ') at ' + body.baseUrl + '.' +
    (mode === 'keep' ? '' : '\n\n' + (mode === 'clear' ? 'Clear' : 'Replace') + ' the credential for that destination.');
  confirmAction('Apply agent settings?', copy, 'Save settings', false, async dialog => {
    if (epoch !== agentEpoch || loadedSettings !== original) return;
    const ok = await mutate('/settings', body, {method:'PUT', profile:original.activeProfile, revision:original.revision, dialog});
    if (ok) {
      await Promise.all([loadSettings(), loadDirectory()]);
      if (epoch === agentEpoch && view === 'settings') $('#settings-status').textContent = 'Settings saved.';
    }
  });
});

async function loadFiles() {
  const version = ++filesVersion;
  const epoch = agentEpoch;
  $('#file-status').textContent = 'Loading files…';
  try {
    const {files} = await api('/workspace');
    if (version !== filesVersion || epoch !== agentEpoch || view !== 'files') return;
    listRows('#file-list', files, 'folder', 'No workspace files yet.', file => {
      const row = record(file.name);
      row.append(el('p', 'meta', file.size + ' bytes'));
      rowActions(row, action('Open file', 'secondary', () => openFile(file.name)));
      return row;
    });
    $('#file-status').textContent = '';
  } catch (error) {
    if (version === filesVersion && epoch === agentEpoch) $('#file-status').textContent = error.message;
  }
}

async function openFile(name) {
  const epoch = agentEpoch;
  const version = ++fileRequest;
  const profile = state.activeProfile;
  const revision = state.settingsRevision;
  try {
    const file = name ? await api('/workspace/' + encodeURIComponent(name)) : {name:'', text:'', version:null};
    if (version !== fileRequest || epoch !== agentEpoch || view !== 'files') return;
    editingFile = {name, version:file.version, profile, revision};
    $('#file-title').textContent = name ? 'Edit workspace file' : 'New workspace file';
    $('#file-name').value = file.name;
    $('#file-name').readOnly = Boolean(name);
    $('#file-text').value = file.text;
    showDialog('#file-dialog');
    $(name ? '#file-text' : '#file-name').focus();
  } catch (error) {
    if (version === fileRequest && epoch === agentEpoch) $('#file-status').textContent = error.message;
  }
}
$('#refresh-files').addEventListener('click', loadFiles);
$('#new-file').addEventListener('click', () => openFile(null));
$('#file-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!editingFile) return;
  const dialog = $('#file-dialog');
  const filename = editingFile.name || $('#file-name').value.trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(filename)) return showError($('.dialog-error', dialog), 'Use a filename starting with a letter or number, followed by letters, numbers, dots, hyphens or underscores.');
  const text = $('#file-text').value;
  if (new TextEncoder().encode(text).length > 32768) return showError($('.dialog-error', dialog), 'File exceeds 32 KiB.');
  const ok = await mutate('/workspace/' + encodeURIComponent(filename), {text,version:editingFile.version},
    {method:'PUT', dialog, profile:editingFile.profile, revision:editingFile.revision});
  if (ok) await loadFiles();
});
