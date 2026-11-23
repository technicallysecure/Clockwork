import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerEndpoint } from './providers.mjs';

const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const namePattern = /^[a-z][a-z0-9_.-]{0,63}$/;

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Boolean settings must be true or false.');
}

function names(value) {
  return Array.isArray(value) && value.every(name => typeof name === 'string' && namePattern.test(name));
}

function boundedText(value, limit) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

export function loadConfig({root = process.cwd(), env = process.env} = {}) {
  const configDir = path.join(root, 'config');
  const policy = json(path.join(configDir, 'policy.json'));
  const localOnly = bool(env.CLOCKWORK_LOCAL_ONLY, true);
  const extensionPaths = policy.extensions.map(file => {
    if (typeof file !== 'string' || !/^[\w-]+\.mjs$/.test(file)) throw new Error('Invalid extension filename in policy.');
    return path.resolve(root, 'extensions', file);
  });
  const profiles = [];
  const ids = new Set();
  for (const file of readdirSync(path.join(configDir, 'profiles')).filter(file => file.endsWith('.json')).sort()) {
    const p = json(path.join(configDir, 'profiles', file));
    if (typeof p.id !== 'string' || !idPattern.test(p.id) || ids.has(p.id) || !boundedText(p.label, 120) ||
        !boundedText(p.instructions, 12000) || !names(p.tools) || !['lmstudio', 'openai'].includes(p.provider)) {
      throw new Error('Invalid or duplicate profile in ' + file);
    }
    ids.add(p.id);
    const grant = Object.hasOwn(policy.grants, p.id) && policy.grants[p.id];
    if (!grant || !boundedText(p.scope, 64) || grant.scope !== p.scope || !names(grant.tools) || !names(grant.permissions)) {
      throw new Error('Missing or invalid operator grant for profile ' + p.id);
    }
    if (localOnly && p.provider === 'openai') continue;
    // Explicit placeholders keep credentials and unrelated environment variables
    // out of profile text and tool metadata.
    if (p.provider === 'lmstudio') {
      if (p.model === '$CLOCKWORK_LM_MODEL') p.model = env.CLOCKWORK_LM_MODEL || 'local-model';
      if (p.baseUrl === '$CLOCKWORK_LM_BASE_URL') p.baseUrl = env.CLOCKWORK_LM_BASE_URL || 'http://host.docker.internal:1234/v1';
      if (p.nativeTools === '$CLOCKWORK_LM_TOOLS') p.nativeTools = bool(env.CLOCKWORK_LM_TOOLS, false);
    } else {
      if (p.model === '$CLOCKWORK_OPENAI_MODEL') p.model = env.CLOCKWORK_OPENAI_MODEL || 'gpt-4.1-mini';
      if (p.nativeTools === '$CLOCKWORK_OPENAI_TOOLS') p.nativeTools = bool(env.CLOCKWORK_OPENAI_TOOLS, p.model === 'gpt-4.1-mini');
    }
    if (!boundedText(p.model, 256) || !boundedText(p.baseUrl, 1024) || p.model.startsWith('$') ||
        (p.nativeTools !== undefined && typeof p.nativeTools !== 'boolean')) throw new Error('Invalid model settings for ' + p.id);
    providerEndpoint(p, localOnly);
    const {id, label, instructions, scope, provider, model, baseUrl, nativeTools = false, tools} = p;
    profiles.push({id, label, instructions, scope, provider, model, baseUrl, nativeTools, tools});
  }
  const defaultProfile = env.CLOCKWORK_DEFAULT_PROFILE || 'local';
  if (!profiles.some(p => p.id === defaultProfile)) throw new Error('Default profile is unavailable in the selected mode.');
  return {profiles, defaultProfile, localOnly, policy, extensionPaths};
}

export async function loadExtensions(config) {
  const descriptors = [];
  for (const file of config.extensionPaths) descriptors.push((await import(pathToFileURL(file).href)).default);
  return descriptors;
}
