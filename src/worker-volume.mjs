import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// An accidental swap of workspace mounts must fail before the worker serves
// files. The workspace API excludes dotfiles from listing, reading and editing.
export function bindWorkspace(directory, agentId) {
  mkdirSync(directory, {recursive:true, mode:0o700});
  const marker = join(directory, '.clockwork-agent-id');
  function verify() {
    if (readFileSync(marker, 'utf8') !== agentId) {
      throw new Error('This workspace volume is bound to a different agent.');
    }
  }
  try { verify(); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (readdirSync(directory).some(name => name !== '.clockwork-agent-id')) {
    throw new Error('Refusing to bind a nonempty workspace without its agent identity file.');
  }
  try { writeFileSync(marker, agentId, {flag:'wx', mode:0o600, flush:true}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    verify();
  }
}
