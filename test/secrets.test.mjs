import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCredentials } from '../src/drivers/switchbot-api.js';
import { loadSecretFile } from '../src/secrets.js';

// JSON.parse quotes the text around the error, so for a file like these its
// message would carry part of the secret (here "FAKE-SECRE") into the log.
const SECRET = 'FAKE-SECRET-DO-NOT-LOG';

test('malformed secrets files: the error names the file but quotes none of its content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theater-malformed-'));
  const adcp = path.join(dir, 'adcp.json');
  const sb = path.join(dir, 'sb.json');
  fs.writeFileSync(adcp, `{"password": ${SECRET}}`, { mode: 0o600 });
  fs.writeFileSync(sb, `{"token": "t", "secret": ${SECRET}}`, { mode: 0o600 });
  const check = (load, file) => assert.throws(load, (e) => {
    assert.equal(e.message, `${file}: not valid JSON`);
    assert.ok(!e.message.includes(SECRET.slice(0, 5)), 'no part of the secret');
    return true;
  });
  check(() => loadSecretFile(adcp, ['password']), adcp);
  check(() => loadCredentials(sb), sb);
});
