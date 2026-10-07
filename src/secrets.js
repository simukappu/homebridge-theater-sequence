// Read a small JSON secrets file that only the owner can access. Values are
// returned to the caller and never logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(file) {
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

export function loadSecretFile(file, keys) {
  const resolved = expandHome(file);
  let st;
  try { st = fs.statSync(resolved); } catch {
    throw new Error(`secrets file not found: ${resolved}`);
  }
  if (st.mode & 0o077) throw new Error(`${resolved} must not be accessible by group/others (chmod 600)`);
  const text = fs.readFileSync(resolved, 'utf8');
  let data;
  // JSON.parse's message quotes part of the file (i.e. of the secret); never pass it on.
  try { data = JSON.parse(text); } catch {
    throw new Error(`${resolved}: not valid JSON`);
  }
  for (const k of keys) {
    if (!data[k]) throw new Error(`${resolved} needs "${k}"`);
  }
  return data;
}
