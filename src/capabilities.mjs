import { randomUUID } from 'node:crypto';
import { memoryScope } from './context.mjs';

const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeName = name => typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) &&
  !['constructor', 'prototype', '__proto__'].includes(name);
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
// Only trusted tool code may supply a diagnostic for the owner. Network
// exception text and raw server responses stay inside the transport.
export class ToolError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}
const keywords = {
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems'],
  string: ['minLength', 'maxLength'],
  number: ['minimum', 'maximum'],
  integer: ['minimum', 'maximum'],
  boolean: []
};

// A deliberately small JSON Schema dialect. Reject unimplemented keywords at
// registration so a tool can never advertise constraints that we ignore.
function checkSchema(s, depth = 0) {
  const invalid = () => { throw new Error('Unsupported tool schema. See docs/extensions.md.'); };
  if (!plain(s) || depth > 10 || !Object.hasOwn(keywords, s.type) ||
      Object.keys(s).some(k => !['type', 'description', 'enum', ...keywords[s.type]].includes(k))) invalid();
  if (Object.hasOwn(s, 'enum')) {
    if (!Array.isArray(s.enum) || !s.enum.length || ['object', 'array'].includes(s.type)) invalid();
    for (const value of s.enum) {
      try { checkValue({type: s.type}, value); } catch { invalid(); }
    }
  }
  if (s.type === 'object') {
    if (!plain(s.properties) || s.additionalProperties !== false || !Array.isArray(s.required ?? [])) invalid();
    for (const [key, child] of Object.entries(s.properties)) {
      if (!safeName(key)) invalid();
      checkSchema(child, depth + 1);
    }
    if ((s.required ?? []).some(k => !Object.hasOwn(s.properties, k))) invalid();
  }
  if (s.type === 'array') checkSchema(s.items, depth + 1);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (Object.hasOwn(s, key) && (!Number.isSafeInteger(s[key]) || s[key] < 0)) invalid();
  }
  for (const key of ['minimum', 'maximum']) {
    if (Object.hasOwn(s, key) && !Number.isFinite(s[key])) invalid();
  }
}

function checkValue(s, value, at = 'arguments') {
  const invalid = () => { throw fail('Invalid tool ' + at + '.'); };
  if (s.enum && !s.enum.includes(value)) invalid();
  switch (s.type) {
    case 'object':
      if (!plain(value) || (s.required ?? []).some(k => !Object.hasOwn(value, k))) invalid();
      for (const [key, child] of Object.entries(value)) {
        if (!Object.hasOwn(s.properties, key)) invalid();
        checkValue(s.properties[key], child, at + '.' + key);
      }
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? Infinity)) invalid();
      for (const child of value) checkValue(s.items, child, at + '[]');
      break;
    case 'string': {
      if (typeof value !== 'string') invalid();
      const length = [...value].length;
      if (length < (s.minLength ?? 0) || length > (s.maxLength ?? Infinity)) invalid();
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') invalid();
      break;
    default:
      if (!Number.isFinite(value) || (s.type === 'integer' && !Number.isSafeInteger(value)) ||
          value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity)) invalid();
  }
}

function metadata({name, description, inputSchema, permissions, effect, network, ownerInputOnly}) {
  return {name, description, inputSchema, permissions, effect, network, ...(ownerInputOnly ? {ownerInputOnly:true} : {})};
}

function publicApproval(row) {
  return {
    id: row.id, profileId: row.profile_id, tool: row.tool, args: JSON.parse(row.args),
    destination: row.destination, status: row.status, createdAt: row.created_at
  };
}

export function createCapabilities({db, config, getProfile, extensions = [], readCommitments}) {
  const registry = new Map();
  const commitments = {
    name: 'list_commitments', description: 'Read open commitments explicitly saved to this memory scope.',
    effect: 'read', hostedSafe: true, network: false, permissions: ['commitments.read'],
    inputSchema: {type: 'object', properties: {}, required: [], additionalProperties: false},
    async execute(_args, {scope}) {
      const items = await readCommitments(scope);
      return {items, count: items.length};
    }
  };
  for (const tool of [commitments, ...extensions]) {
    if (!safeName(tool?.name) || registry.has(tool.name) || !['read', 'external_write', 'send'].includes(tool.effect) ||
        !Array.isArray(tool.permissions) || !tool.permissions.length ||
        !tool.permissions.every(x => typeof x === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(x)) ||
        typeof tool.network !== 'boolean' || typeof tool.execute !== 'function' ||
        (tool.validateArgs !== undefined && typeof tool.validateArgs !== 'function') ||
        (tool.ownerInputOnly !== undefined && (typeof tool.ownerInputOnly !== 'boolean' || tool.effect !== 'read')) ||
        typeof tool.description !== 'string' || !tool.description.trim() || tool.inputSchema?.type !== 'object' ||
        (tool.effect !== 'read' && typeof tool.destination !== 'function')) {
      throw new Error('Invalid or duplicate tool descriptor.');
    }
    checkSchema(tool.inputSchema);
    registry.set(tool.name, tool);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, scope TEXT NOT NULL, tool TEXT NOT NULL,
    args TEXT NOT NULL, destination TEXT NOT NULL, effect TEXT NOT NULL, version TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const findApproval = db.prepare('SELECT * FROM approvals WHERE id = ?');
  const transition = db.prepare('UPDATE approvals SET status = ? WHERE id = ? AND status = ?');

  function activeProfile(p) {
    const profile = config.profiles.find(item => item.id === p?.id);
    if (!profile || (config.localOnly && profile.provider !== 'lmstudio') ||
        config.policy.grants[profile.id]?.scope !== profile.scope) throw fail('Profile is unavailable.', 403);
    const current = getProfile ? getProfile(profile.id) : profile;
    if (Object.hasOwn(p, 'planAccountId') && p.planAccountId !== current.planAccountId) {
      throw fail('The connected ChatGPT account changed. Review the request again.', 409);
    }
    return current;
  }

  function permitted(profile, tool, allowedTools) {
    const grant = config.policy.grants[profile.id];
    return (profile.provider === 'lmstudio' || tool.hostedSafe === true) &&
      profile.tools.includes(tool.name) && grant.tools.includes(tool.name) &&
      tool.permissions.every(p => grant.permissions.includes(p)) && !(config.localOnly && tool.network) &&
      (allowedTools === undefined || (Array.isArray(allowedTools) && allowedTools.includes(tool.name)));
  }

  function validate(p, name, args, {allowedTools, readOnly = false, ownerInput = false, inputRule} = {}) {
    const profile = activeProfile(p);
    const tool = registry.get(name);
    if (!tool || !permitted(profile, tool, allowedTools) || (readOnly && tool.effect !== 'read') ||
        (tool.ownerInputOnly && ownerInput !== true && inputRule?.(profile, name, args) !== true)) {
      throw fail('Tool unavailable under the current permissions.', 403);
    }
    checkValue(tool.inputSchema, args);
    if (Buffer.byteLength(JSON.stringify(args)) > 16384) throw fail('Tool arguments are too large.');
    tool.validateArgs?.(args);
    return metadata(tool);
  }

  async function run(tool, args, profile, signal, destination) {
    signal?.throwIfAborted();
    try {
      const result = await tool.execute(args, {scope: memoryScope(profile), profile:{
        id:profile.id, provider:profile.provider, planAccountId:profile.planAccountId,
      }, signal, destination});
      const serialized = JSON.stringify(result);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 1024 * 1024) throw fail('Invalid tool result.');
      return JSON.parse(serialized);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw fail('Tool execution failed.', 502);
    }
  }

  function destinationOf(tool, args) {
    let destination;
    try { destination = tool.destination(structuredClone(args)); }
    catch { throw fail('Could not resolve the action destination.'); }
    if (typeof destination !== 'string' || !destination.trim() || destination.length > 1024) throw fail('Invalid action destination.');
    return destination;
  }

  return {
    list(p, allowedTools) {
      const profile = activeProfile(p);
      return [...registry.values()].filter(t => permitted(profile, t, allowedTools)).map(metadata);
    },
    validate,
    async dispatch(p, name, args, options = {}) {
      validate(p, name, args, options);
      options.signal?.throwIfAborted();
      const profile = activeProfile(p);
      const tool = registry.get(name);
      const input = structuredClone(args);
      if (tool.effect === 'read') return run(tool, input, profile, options.signal);
      const id = randomUUID();
      db.prepare(`INSERT INTO approvals
        (id,profile_id,scope,tool,args,destination,effect,version,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',?)`).run(id, profile.id, memoryScope(profile), name, JSON.stringify(input),
        destinationOf(tool, input), tool.effect, String(tool.version ?? 1), new Date().toISOString());
      return {approvalRequired: true, approvalId: id};
    },
    approvals() {
      return db.prepare('SELECT * FROM approvals ORDER BY rowid DESC').all().map(publicApproval);
    },
    async decide(id, decision) {
      if (!['approve', 'deny'].includes(decision)) throw fail('Unknown approval decision.');
      const row = findApproval.get(id);
      if (!row) throw fail('Approval not found.', 404);
      if (row.status !== 'pending') throw fail('Approval has already been decided.', 409);
      if (decision === 'deny') {
        if (!transition.run('denied', id, 'pending').changes) throw fail('Approval has already been decided.', 409);
        return publicApproval(findApproval.get(id));
      }
      const profile = activeProfile({id: row.profile_id});
      const args = JSON.parse(row.args);
      validate(profile, row.tool, args);
      const tool = registry.get(row.tool);
      if (row.scope !== memoryScope(profile) || row.effect !== tool.effect || row.version !== String(tool.version ?? 1) ||
          destinationOf(tool, args) !== row.destination) throw fail('The proposed action has changed.', 409);
      // Consume before execution. A crash across the external boundary requires
      // owner reconciliation; replay could issue the same action twice.
      if (!transition.run('executing', id, 'pending').changes) throw fail('Approval has already been decided.', 409);
      try {
        await run(tool, args, profile, undefined, row.destination);
        transition.run('executed', id, 'executing');
      } catch {
        transition.run('uncertain', id, 'executing');
        throw fail('Action outcome is uncertain. Check the destination before making a new request.', 502);
      }
      return publicApproval(findApproval.get(id));
    }
  };
}
