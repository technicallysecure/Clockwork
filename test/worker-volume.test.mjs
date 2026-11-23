import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bindWorkspace } from '../src/worker-volume.mjs';

test('workspace binding survives restarts and rejects a swapped mount or incomplete restore', t => {
  const dir = mkdtempSync(join(tmpdir(), 'clockwork-volume-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  bindWorkspace(dir, 'personal');
  writeFileSync(join(dir, 'notes.txt'), 'notes');
  bindWorkspace(dir, 'personal');
  assert.throws(() => bindWorkspace(dir, 'agent-2'), /different agent/);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'notes');
  rmSync(join(dir, '.clockwork-agent-id'));
  assert.throws(() => bindWorkspace(dir, 'agent-2'), /nonempty workspace/);
});
