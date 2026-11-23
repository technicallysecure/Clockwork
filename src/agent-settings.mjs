import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { deploymentCredential, providerEndpoint } from './providers.mjs';
import { badRequest, requiredText, transaction } from './store.mjs';
import { memoryScope, providerContext } from './context.mjs';

const ephemeralKeys = new WeakMap();
const defaultGoal = 'Help the owner plan and follow through on everyday work.';

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) {
    throw badRequest('Invalid agent settings fields.');
  }
}

// Only the database stores ciphertext. File-backed workers keep a private key
// beside the database on their data volume, outside the agent workspace.
function credentialKey(db, create) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  if (!file) {
    if (create && !ephemeralKeys.has(db)) ephemeralKeys.set(db, randomBytes(32));
    if (!ephemeralKeys.has(db)) throw new Error('Missing in-memory credential key.');
    return ephemeralKeys.get(db);
  }
  const path = file + '.key';
  try {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('Invalid agent credential key.');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
  }
  // The caller holds the SQLite write lock while creating a key. Never
  // silently replace the key of a restored database that already has tokens.
  if (db.prepare('SELECT 1 FROM agent_credentials WHERE sealed IS NOT NULL LIMIT 1').get()) {
    throw new Error('Restore the key file for this agent database.');
  }
  const key = randomBytes(32);
  const temporary = path + '.' + randomUUID();
  writeFileSync(temporary, key, {flag:'wx', mode:0o600, flush:true});
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return key;
}

function seal(db, token, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(db, true), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function unseal(db, sealed, aad) {
  try {
    const value = Buffer.from(sealed);
    const cipher = createDecipheriv('aes-256-gcm', credentialKey(db, false), value.subarray(0, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  } catch {
    throw badRequest('The saved credential could not be opened. Check the agent data volume and its key file.', 503);
  }
}

export function createAgentSettings({db, notebook, config, env, getPlanAccountId = () => null}) {
  const id = env.CLOCKWORK_AGENT_ID ?? 'personal';
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid deployment agent ID.');
  const reserved = env.CLOCKWORK_AGENT_RESERVED === 'true';
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, name TEXT NOT NULL,
      goal TEXT NOT NULL, initialized INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS agent_models (
      profileId TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, baseUrl TEXT NOT NULL,
      nativeTools INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_credentials (
      provider TEXT NOT NULL, origin TEXT NOT NULL, sealed BLOB, PRIMARY KEY(provider,origin)
    );
  `);
  const identity = db.prepare('SELECT * FROM agent_identity WHERE singleton=1');
  transaction(db, () => {
    const saved = identity.get();
    if (saved) {
      if (saved.id !== id) throw new Error('This data volume is already bound to a different agent.');
      return;
    }
    if (id !== 'personal') {
      // The original single-agent volume has no owner tag. Its records must
      // stay with the personal worker during the upgrade.
      const oldRuntime = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_jobs'").get();
      const hasData = db.prepare('SELECT 1 FROM messages UNION ALL SELECT 1 FROM memories UNION ALL SELECT 1 FROM settings LIMIT 1').get();
      if (oldRuntime || hasData) throw new Error('The original Clockwork data volume belongs to the personal agent.');
    }
    const name = reserved ? '' : (id === 'personal' ? 'Personal assistant' : id);
    const goal = reserved ? '' : defaultGoal;
    db.prepare('INSERT INTO agent_identity(singleton,id,name,goal,initialized) VALUES(1,?,?,?,?)')
      .run(id, name, goal, Number(!reserved));
  });

  const readCredential = db.prepare('SELECT sealed FROM agent_credentials WHERE provider=? AND origin=?');
  const readModel = db.prepare('SELECT * FROM agent_models WHERE profileId=? AND provider=?');
  const revisionQuery = db.prepare('SELECT revision FROM agent_identity WHERE singleton=1');
  const revision = () => revisionQuery.get().revision;
  function goalKey(profile) {
    return 'goal/' + memoryScope({...profile, scope:'agent-goal'});
  }
  function goalFor(profile) {
    return profile.provider === 'lmstudio' ? identity.get().goal : notebook.getSetting(goalKey(profile)) ?? defaultGoal;
  }
  function info() {
    const {name, initialized} = identity.get();
    return {id, name, goal:initialized ? goalFor(active()) : '', initialized:Boolean(initialized)};
  }

  function ready() {
    if (!identity.get().initialized) throw badRequest('Create this agent before assigning work.', 409);
  }

  function initialize(input) {
    fields(input, ['name','goal']);
    const name = requiredText(input.name, 'Agent name', 80);
    const goal = requiredText(input.goal, 'Agent goal', 2000);
    const profile = active();
    transaction(db, () => {
      const result = db.prepare('UPDATE agent_identity SET initialized=1,name=?,goal=?,revision=revision+1 WHERE singleton=1 AND initialized=0')
        .run(name, profile.provider === 'lmstudio' ? goal : defaultGoal);
      if (!result.changes) throw badRequest('This agent has already been created.', 409);
      if (profile.provider !== 'lmstudio') notebook.setSetting(goalKey(profile), goal);
    });
    return info();
  }

  function getProfile(profileId) {
    const base = config.profiles.find(p => p.id === profileId);
    if (!base || (config.localOnly && base.provider !== 'lmstudio')) throw badRequest('Profile unavailable in this operating mode.');
    const saved = readModel.get(base.id, base.provider);
    const profile = saved ? {...base, model:saved.model, baseUrl:saved.baseUrl, nativeTools:Boolean(saved.nativeTools)} : base;
    if (saved) providerEndpoint(profile, config.localOnly);
    return profile.provider === 'chatgpt-plan' ? {...profile, planAccountId:getPlanAccountId() ?? null} : profile;
  }

  function active() {
    const previous = notebook.getSetting('profile');
    return getProfile(config.profiles.some(p => p.id === previous) ? previous : config.defaultProfile);
  }

  function selectProfile(profileId) {
    ready();
    getProfile(profileId);
    notebook.setSetting('profile', profileId);
  }

  function mountedCredential(profile, origin) {
    if (id !== 'personal') return undefined;
    const base = config.profiles.find(p => p.id === profile.id && p.provider === profile.provider);
    if (!base || new URL(base.baseUrl).origin !== origin) return undefined;
    return deploymentCredential(env, profile.provider);
  }

  const aad = (provider, origin) => Buffer.from(JSON.stringify([id, provider, origin]));
  function credentialFor(profile) {
    if (profile.provider === 'chatgpt-plan') throw badRequest('ChatGPT plan inference requires its own OAuth grant.', 403);
    const origin = providerEndpoint(profile, config.localOnly).origin;
    const row = readCredential.get(profile.provider, origin);
    if (!row) return mountedCredential(profile, origin);
    return row.sealed === null ? undefined : unseal(db, row.sealed, aad(profile.provider, origin));
  }

  function settings() {
    ready();
    return {
      agent:info(), revision:revision(), activeProfile:active().id, localOnly:config.localOnly,
      profiles:config.profiles.map(base => {
        const profile = getProfile(base.id);
        const {id:profileId, label, scope, provider, model, baseUrl, nativeTools} = profile;
        const origin = new URL(baseUrl).origin;
        const stored = readCredential.get(provider, origin);
        let credentialConfigured = Boolean(stored?.sealed);
        if (!stored) {
          try { credentialConfigured = Boolean(mountedCredential(base, origin)); }
          catch { credentialConfigured = false; } // Still allow the owner to enter a replacement.
        }
        return {id:profileId, label, scope, provider, model, baseUrl, nativeTools, credentialConfigured, goal:goalFor(profile)};
      }),
    };
  }

  function update(input) {
    ready();
    fields(input, ['revision','name','goal','profileId','model','baseUrl','nativeTools','credential']);
    const name = requiredText(input.name, 'Agent name', 80);
    const requestedGoal = requiredText(input.goal, 'Agent goal', 2000);
    const model = requiredText(input.model, 'Model ID', 256);
    const baseUrl = requiredText(input.baseUrl, 'Base URL', 1024);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw badRequest('Provide the settings revision.');
    if (typeof input.nativeTools !== 'boolean') throw badRequest('Choose whether native tool calls are supported.');
    const profile = getProfile(input.profileId);
    const source = active();
    // An older client may resubmit all displayed fields while changing models.
    // An unchanged source goal stays in its original provider/workspace.
    const goal = providerContext(profile) !== providerContext(source) && requestedGoal === goalFor(source)
      ? goalFor(profile) : requestedGoal;
    if (profile.provider === 'chatgpt-plan' && Object.hasOwn(input, 'credential')) {
      throw badRequest('Use Continue with ChatGPT to authorize this provider.');
    }
    let origin;
    try { origin = providerEndpoint({...profile, baseUrl}, config.localOnly).origin; }
    catch (error) { throw badRequest(error.message); }
    if (Object.hasOwn(input, 'credential') && (typeof input.credential !== 'string' || !/^[\x21-\x7e]{0,4096}$/.test(input.credential))) {
      throw badRequest('Enter a credential of up to 4096 printable characters, without spaces or line breaks.');
    }
    transaction(db, () => {
      if (input.revision !== revision()) throw badRequest('Settings changed. Reload before saving.', 409);
      db.prepare(`INSERT INTO agent_models(profileId,provider,model,baseUrl,nativeTools) VALUES(?,?,?,?,?)
        ON CONFLICT(profileId) DO UPDATE SET provider=excluded.provider,model=excluded.model,
        baseUrl=excluded.baseUrl,nativeTools=excluded.nativeTools`)
        .run(profile.id, profile.provider, model, baseUrl, Number(input.nativeTools));
      if (Object.hasOwn(input, 'credential')) {
        const sealed = input.credential ? seal(db, input.credential, aad(profile.provider, origin)) : null;
        db.prepare(`INSERT INTO agent_credentials(provider,origin,sealed) VALUES(?,?,?)
          ON CONFLICT(provider,origin) DO UPDATE SET sealed=excluded.sealed`).run(profile.provider, origin, sealed);
      }
      notebook.setSetting('profile', profile.id);
      const localGoal = profile.provider === 'lmstudio' ? goal : identity.get().goal;
      if (profile.provider !== 'lmstudio') notebook.setSetting(goalKey(profile), goal);
      db.prepare('UPDATE agent_identity SET name=?,goal=?,revision=revision+1 WHERE singleton=1').run(name, localGoal);
    });
    return settings();
  }

  return {info, revision, ready, initialize, active, getProfile, goalFor, credentialFor, selectProfile, settings, update};
}
