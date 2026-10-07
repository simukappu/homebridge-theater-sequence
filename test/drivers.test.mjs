import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { AdcpClient } from '../src/drivers/adcp-client.js';
import { BdzRecorder } from '../src/drivers/bdz.js';
import { DenonAvr } from '../src/drivers/denon-api.js';

test('BDZ POWER request has the expected shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '<u:X_InputRemoteKeyResponse/>' }; };
  await new BdzRecorder({ host: '192.0.2.3', mac: '00:00:5e:00:53:01', broadcast: '192.0.2.255', fetchImpl }).pressPower();
  const { url, init } = calls[0];
  assert.equal(url, 'http://192.0.2.3:64220/X_PvrControl');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.SOAPACTION, '"urn:schemas-s-bras-org:service:X_PvrControl:1#X_InputRemoteKey"');
  assert.match(init.headers['Content-Type'], /^text\/xml; charset="utf-8"$/);
  assert.match(init.body, /<u:X_InputRemoteKey xmlns:u="urn:schemas-s-bras-org:service:X_PvrControl:1"><RemoteKey>POWER<\/RemoteKey><\/u:X_InputRemoteKey>/);
});

test('BDZ playStatus parses the reply; no answer -> null', async () => {
  const reply = '<Result>&lt;?xml version="1.0"?&gt;&lt;xsrs&gt;&lt;powerstatus&gt;PowerInternalOn&lt;/powerstatus&gt;&lt;playstatus&gt;Stopped&lt;/playstatus&gt;&lt;/xsrs&gt;</Result>';
  const ok = new BdzRecorder({ host: 'h', mac: '00:00:5e:00:53:01', broadcast: 'b', fetchImpl: async () => ({ status: 200, text: async () => reply }) });
  assert.deepEqual(await ok.playStatus(), { power: 'PowerInternalOn', play: 'Stopped' });
  const silent = new BdzRecorder({ host: 'h', mac: '00:00:5e:00:53:01', broadcast: 'b', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(await silent.playStatus(), null);
});

test('BDZ Wake-on-LAN: one 102-byte magic packet to the broadcast address, port 9', async () => {
  const sent = [];
  const dgramImpl = { createSocket: () => ({
    on: () => {}, bind: (cb) => cb(), setBroadcast: () => {}, close: () => {},
    send: (buf, port, addr, cb) => { sent.push({ buf, port, addr }); cb(); },
  }) };
  await new BdzRecorder({ host: 'h', mac: '00:00:5e:00:53:02', broadcast: '192.0.2.255', dgramImpl }).wake();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].buf.length, 102);
  assert.equal(sent[0].port, 9);
  assert.equal(sent[0].addr, '192.0.2.255');
  assert.ok(sent[0].buf.subarray(0, 6).equals(Buffer.alloc(6, 0xff)));
  assert.equal(sent[0].buf.subarray(6, 12).toString('hex'), '00005e005302');
});

test('BDZ socket errors do not escape: SSDP counts them as no answer, Wake-on-LAN fails the step', async () => {
  // Like node:dgram: a failed bind is only reported as an 'error' event (an
  // EventEmitter with no listener would throw it), a failed send to its callback.
  const failing = (where) => {
    const socks = [];
    return { socks, createSocket: () => {
      const s = Object.assign(new EventEmitter(), { closed: false, setBroadcast: () => {}, close: () => { s.closed = true; } });
      s.bind = (cb) => setImmediate(() => (where === 'bind' ? s.emit('error', new Error('bind EADDRINUSE')) : cb()));
      s.send = (_m, _p, _a, cb) => setImmediate(() => cb(where === 'send' ? new Error('send ENETUNREACH') : null));
      socks.push(s);
      return s;
    } };
  };
  for (const where of ['bind', 'send']) {
    const dgramImpl = failing(where);
    const bdz = new BdzRecorder({ host: 'h', mac: '00:00:5e:00:53:02', broadcast: '192.0.2.255', dgramImpl });
    const t0 = Date.now();
    assert.equal(await bdz.isInStandby(5000), false, `${where}: no answer`);
    assert.ok(Date.now() - t0 < 1000, `${where}: did not wait out the SSDP timeout`);
    await assert.rejects(bdz.wake(), new RegExp(where));
    assert.ok(dgramImpl.socks.every((s) => s.closed), `${where}: sockets closed`);
  }
});

test('Denon: only SI<code>, ZMON and ZMOFF can be built', async () => {
  const urls = [];
  const d = new DenonAvr({ host: '192.0.2.2', fetchImpl: async (u) => { urls.push(u); return { status: 200, text: async () => '' }; } });
  await d.setMainZonePower(true);
  await d.setMainZonePower(false);
  await d.selectInput('BD');
  await assert.rejects(d.selectInput('BD&MVUP'), /invalid input code/);
  assert.deepEqual(urls.map((u) => u.split('?')[1]), ['ZMON', 'ZMOFF', 'SIBD']);
});

test('ADCP: nonce + password handshake, then one command', async () => {
  const password = 'adcp-test-password';
  const got = [];
  const server = net.createServer((sock) => {
    const nonce = crypto.randomBytes(8).toString('hex');
    let authed = false;
    let buf = '';
    sock.write(nonce + '\r\n');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!authed) { authed = line === crypto.createHash('sha256').update(nonce + password).digest('hex'); sock.write(authed ? 'OK\r\n' : 'err_auth\r\n'); continue; }
        got.push(line);
        sock.write('"standby"\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = new AdcpClient({ host: '127.0.0.1', port: server.address().port, password, timeout: 2000 });
    assert.equal(await c.send('power_status ?'), 'standby');
    assert.deepEqual(got, ['power_status ?']);
    const bad = new AdcpClient({ host: '127.0.0.1', port: server.address().port, password: 'wrong', timeout: 2000 });
    await assert.rejects(bad.send('power_status ?'), /authentication failed/);
  } finally {
    server.close();
  }
});

test('Denon status: read over telnet (complete lines only), HTTP only as a fallback', async () => {
  // Reply split mid-line, with unrelated lines around it (as seen on the AVC-X6700H).
  const server = net.createServer((sock) => {
    sock.on('data', () => {
      sock.write('SIB');
      setTimeout(() => sock.write('D\rSVOFF\rSYSMI MPEG-2 AAC\r'), 30);
      setTimeout(() => sock.write('ZMON\rSLPOFF\r'), 60);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpCalls = [];
  const fetchImpl = async (u) => { httpCalls.push(u); return { status: 200, text: async () => '<item><Power><value>ON</value></Power><InputFuncSelect><value>NET</value></InputFuncSelect></item>' }; };
  try {
    const d = new DenonAvr({ host: '127.0.0.1', telnetPort: server.address().port, fetchImpl });
    assert.deepEqual(await d.status(), { power: 'ON', input: 'BD', via: 'telnet' }, 'not the stale HTTP value');
    assert.equal(httpCalls.length, 0);
  } finally {
    server.close();
  }
  const refused = new DenonAvr({ host: '127.0.0.1', telnetPort: 1, fetchImpl });
  const fallback = await refused.status();
  assert.deepEqual({ ...fallback, telnetError: undefined }, { power: 'ON', input: 'NET', via: 'http', telnetError: undefined });
  assert.match(fallback.telnetError, /ECONNREFUSED/, 'reason kept');
});
