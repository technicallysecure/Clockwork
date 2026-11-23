import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { transaction } from './store.mjs';

// The native Windows build wraps the key for the current Windows user. In the
// Linux container the dedicated directory and key are accessible only to its UID.
function windowsProtect(bytes, method) {
  if (process.platform !== 'win32') return bytes;
  const script = `$ErrorActionPreference='Stop'
    Add-Type -AssemblyName System.Security
    $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
    $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Convert]::ToBase64String($result))`;
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile','-NonInteractive','-Command',script], {
    input:bytes.toString('base64'), encoding:'utf8', windowsHide:true, timeout:10000,
  });
  if (result.status !== 0) throw new Error('Windows could not protect or open the ChatGPT credential key.');
  return Buffer.from(result.stdout, 'base64');
}

export function openPlanVault(directory, agentId) {
  mkdirSync(directory, {recursive:true, mode:0o700});
  if (!lstatSync(directory).isDirectory()) throw new Error('Use a private directory for ChatGPT credentials.');
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const file = join(directory, 'credentials.sqlite');
  const keyFile = join(directory, 'vault.key');
  const db = new DatabaseSync(file);
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), value BLOB NOT NULL)');
  const read = db.prepare('SELECT value FROM vault WHERE id=1');
  const write = db.prepare('INSERT INTO vault(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
  const aad = Buffer.from('Clockwork/ChatGPT/v1/' + agentId);
  let key;
  function save(data) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    write.run(Buffer.concat([iv, cipher.getAuthTag(), body]));
  }
  function load() {
    const bytes = Buffer.from(read.get().value);
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
      cipher.setAAD(aad);
      cipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Cannot open the ChatGPT credential vault for this agent. Restore its original volume and key.');
    }
  }
  try {
    transaction(db, () => {
      if (existsSync(keyFile)) key = windowsProtect(readFileSync(keyFile), 'Unprotect');
      else {
        if (read.get()) throw new Error('Restore the original ChatGPT credential key.');
        key = randomBytes(32);
        writeFileSync(keyFile, windowsProtect(key, 'Protect'), {mode:0o600,flag:'wx',flush:true});
      }
      if (read.get()) load();
      else save({hostId:'urn:uuid:' + randomUUID(), activeId:null, accounts:{}});
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    load,
    update(fn) {
      return transaction(db, () => {
        const state = load();
        const result = fn(state);
        save(state);
        return result;
      });
    },
    close() { db.close(); key.fill(0); },
  };
}
