import { createHash } from 'node:crypto';

// Legacy rows and files have no reliable provenance, including summaries of
// conversations that previously mixed providers. Keep their original local namespace.
export function providerContext(profile) {
  if (profile.provider === 'chatgpt-plan') return JSON.stringify([profile.provider, profile.planAccountId ?? null]);
  return profile.provider;
}

export function memoryScope(profile) {
  if (profile.provider === 'lmstudio') return profile.scope;
  // Operator profile scopes are at most 64 characters. A longer namespace
  // cannot alias a legacy local scope, even when custom profiles share names.
  const key = JSON.stringify([providerContext(profile), profile.scope]);
  return 'hosted/' + createHash('sha256').update(key).digest('hex');
}
