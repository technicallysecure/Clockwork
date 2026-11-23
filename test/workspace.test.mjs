import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../src/workspace.mjs';

test('workspaces enforce flat text files, isolate versions and reject out-of-date saves', t => {
  const root = mkdtempSync(join(tmpdir(),'clockwork-files-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const ws = createWorkspace(join(root,'workspace'));
  for (const name of ['../private.txt', '/secret', 'a/b','a\\b','CON.txt','.env']) {
    assert.throws(() => ws.write(name,'text',null),{status:400});
  }
  writeFileSync(join(root,'private.txt'),'operator-only');
  linkSync(join(root,'private.txt'),join(root,'workspace','link.txt'));
  assert.deepEqual(ws.list().files,[]);
  assert.throws(() => ws.read('link.txt'),{status:403});
  assert.throws(() => ws.write('link.txt','replacement',null),{status:403});
  const initial = ws.write('notes.md','first',null);
  assert.deepEqual(ws.read('notes.md'),initial);
  assert.deepEqual(ws.list().files,[{name:'notes.md',size:5}]);
  assert.throws(() => ws.write('notes.md','duplicate',null),{status:409});
  ws.write('notes.md','second',initial.version);
  assert.throws(() => ws.write('notes.md','stale',initial.version),{status:409});
  assert.throws(() => ws.write('long.txt','a'.repeat(32769),null),{status:400});
});
