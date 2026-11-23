import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { badRequest } from './store.mjs';

const maxBytes = 32 * 1024;
const safeName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name) &&
  !name.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function createWorkspace(directory) {
  const root = resolve(directory);
  mkdirSync(root, {recursive:true, mode:0o700});
  function pathFor(name) {
    if (!safeName(name)) throw badRequest('Choose a filename of up to 80 letters, digits, dots, underscores or hyphens.');
    return join(root, name);
  }
  function read(name) {
    const path = pathFor(name);
    let fd;
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.nlink !== 1) throw badRequest('Only regular workspace files can be opened.', 403);
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev) {
        throw badRequest('Workspace file changed. Refresh and try again.', 409);
      }
      if (stat.size > maxBytes) throw badRequest('Workspace files must be at most 32 KiB.', 413);
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size);
        if (!n) break;
        size += n;
      }
      if (size > maxBytes) throw badRequest('Workspace files must be at most 32 KiB.', 413);
      const bytes = buffer.subarray(0, size);
      let text;
      try { text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
      catch { throw badRequest('Workspace editor requires UTF-8 text.'); }
      if (text.includes('\0')) throw badRequest('Workspace editor requires a text file.');
      return {name, text, version:hash(bytes)};
    } catch (err) {
      if (err.code === 'ENOENT') throw badRequest('Workspace file not found.', 404);
      throw err;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  function list() {
    const files = [];
    for (const name of readdirSync(root).sort()) {
      if (!safeName(name)) continue;
      const stat = lstatSync(pathFor(name), {throwIfNoEntry:false});
      if (stat?.isFile() && stat.nlink === 1 && stat.size <= maxBytes) files.push({name, size:stat.size});
    }
    return {files};
  }
  function write(name, text, version) {
    const path = pathFor(name);
    if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > maxBytes) {
      throw badRequest('Supply a text file of at most 32 KiB.');
    }
    if (version !== null && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))) {
      throw badRequest('Include the file version, or null to create a file.');
    }
    let previous = null;
    try { previous = read(name).version; } catch (err) { if (err.status !== 404) throw err; }
    if (previous !== version) throw badRequest('The file has changed. Reopen it before saving.', 409);
    const temp = join(root, '.' + randomUUID() + '.tmp');
    try {
      writeFileSync(temp, text, {flag:'wx', mode:0o600, flush:true});
      renameSync(temp, path);
    } finally {
      try { unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return {name, text, version:hash(Buffer.from(text))};
  }
  return {list, read, write};
}

export function workspaceTools(workspace) {
  const base = {effect:'read', network:false, permissions:['workspace.read']};
  return [
    {...base, name:'list_workspace', description:"List text files in this agent's workspace.",
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      execute() { const {files} = workspace.list(); return {items:files, count:files.length}; }},
    {...base, name:'read_workspace', description:"Read a named text file from this agent's workspace as reference material.",
      inputSchema:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:80}},required:['name'],additionalProperties:false},
      execute({name}) { const file = workspace.read(name); return {name, text:file.text}; }},
  ];
}
