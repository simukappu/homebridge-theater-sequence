// Somfy gateway driver and the shutter steps, against a fake https.request that
// reproduces a Connexoon measured on 2026-10-13: /exec/apply answers with an
// execId, the execution is IN_PROGRESS about 1 s later and COMPLETED only
// ~30 s later (a gateway timer: the RTS shutter had long finished).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SomfyGateway } from '../src/drivers/somfy.js';
import { shutterCommand } from '../src/steps.js';
import { defaultSequences, SequenceRunner } from '../src/sequence.js';

const TOKEN = 'somfy-token-DO-NOT-LOG';
const DEVICE = 'rts://0000-0000-0000/1234';

function fakeGateway({ outcome = 'IN_PROGRESS', delayFetches = 1, httpStatus = 200, unreachable = false } = {}) {
  const g = { calls: [], fetches: 0, unregistered: 0 };
  g.request = (opts, onRes) => {
    const req = new EventEmitter();
    req.end = (data) => {
      g.calls.push({ opts, body: data ? JSON.parse(data) : undefined });
      if (unreachable) { setImmediate(() => req.emit('error', new Error('connect EHOSTUNREACH'))); return; }
      let json = null;
      const p = opts.path.replace('/enduser-mobile-web/1/enduserAPI', '');
      if (p === '/events/register') json = { id: 'listener-1' };
      else if (p === '/exec/apply') json = { execId: 'exec-1' };
      else if (p.endsWith('/fetch')) {
        g.fetches++;
        json = g.fetches < delayFetches ? [] : [
          { name: 'ExecutionRegisteredEvent', execId: 'exec-1' },
          { name: 'ExecutionStateChangedEvent', execId: 'other', newState: 'FAILED' },
          ...(outcome ? [{ name: 'ExecutionStateChangedEvent', execId: 'exec-1', oldState: 'INITIALIZED', newState: outcome, failureType: outcome === 'FAILED' ? 'NO_RESPONSE' : undefined }] : []),
        ];
      } else if (p.endsWith('/unregister')) g.unregistered++;
      const res = new EventEmitter();
      res.statusCode = httpStatus;
      res.setEncoding = () => {};
      setImmediate(() => { onRes(res); res.emit('data', json === null ? '' : JSON.stringify(json)); res.emit('end'); });
    };
    req.destroy = (e) => req.emit('error', e);
    return req;
  };
  g.gateway = (o = {}) => new SomfyGateway({ host: '192.0.2.5', pin: '0000-0000-0000', token: TOKEN, ca: 'CA', requestImpl: g.request, ...o });
  return g;
}

const opts = { acceptMs: 300, pollMs: 5 };

test('close: one /exec/apply with the explicit command, TLS name gateway-<pin>.local, CA and token', async () => {
  const g = fakeGateway();
  const r = await g.gateway().command(DEVICE, 'close', opts);
  assert.deepEqual(r, { execId: 'exec-1', state: 'IN_PROGRESS' });
  const applies = g.calls.filter((c) => c.opts.path.endsWith('/exec/apply'));
  assert.equal(applies.length, 1, 'sent once');
  assert.deepEqual(applies[0].body.actions, [{ deviceURL: DEVICE, commands: [{ name: 'close' }] }]);
  for (const c of g.calls) {
    assert.equal(c.opts.servername, 'gateway-0000-0000-0000.local');
    assert.equal(c.opts.ca, 'CA');
    assert.equal(c.opts.port, 8443);
    assert.equal(c.opts.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!('rejectUnauthorized' in c.opts), 'certificate verification is not disabled');
  }
  assert.equal(g.unregistered, 1, 'event listener released');
});

test('only open and close; invalid pin and deviceURL are refused before any request', async () => {
  const g = fakeGateway();
  await assert.rejects(g.gateway().command(DEVICE, 'stop', opts), /not allowed/);
  await assert.rejects(g.gateway().command('rts://x/1?evil=1', 'open', opts), /invalid deviceURL/);
  assert.throws(() => g.gateway({ pin: '0000' }), /invalid Somfy gateway pin/);
  assert.equal(g.calls.length, 0);
});

test('FAILED, no IN_PROGRESS in time, HTTP error, unreachable: rejected, not retried, token never in the message', async () => {
  const cases = [
    [fakeGateway({ outcome: 'FAILED' }), /FAILED \(NO_RESPONSE\)/],
    [fakeGateway({ outcome: null }), /not IN_PROGRESS within 300 ms/],
    [fakeGateway({ httpStatus: 401 }), /HTTP 401/],
    [fakeGateway({ unreachable: true }), /not reachable/],
  ];
  for (const [g, re] of cases) {
    const err = await g.gateway().command(DEVICE, 'open', opts).then(() => null, (e) => e);
    assert.match(err.message, re);
    assert.ok(!err.message.includes(TOKEN));
    assert.ok(g.calls.filter((c) => c.opts.path.endsWith('/exec/apply')).length <= 1);
  }
});

test('shutter step: accepted at IN_PROGRESS (no position for RTS)', async () => {
  const g = fakeGateway({ delayFetches: 3 });
  const ctx = { somfy: g.gateway(), config: { shutter: { deviceURL: DEVICE } }, timing: { shutterAcceptMs: 3000 } };
  const r = await shutterCommand(ctx, 'close');
  assert.equal(r.outcome, 'accepted');
  assert.match(r.detail, /transmitting "close" \(IN_PROGRESS\); RTS reports no position/);
});

test('default sequences: shutter right after the screen, only when configured', () => {
  assert.deepEqual(defaultSequences({ shutter: true }), {
    start: ['screen-down', 'shutter-close', 'projector-on&', 'avr-on', 'recorder-on', 'avr-input'],
    stop: ['screen-up', 'shutter-open', 'recorder-off', 'avr-off', 'projector-off'],
  });
  assert.deepEqual(defaultSequences(), {
    start: ['screen-down', 'projector-on&', 'avr-on', 'recorder-on', 'avr-input'],
    stop: ['screen-up', 'recorder-off', 'avr-off', 'projector-off'],
  });
  assert.doesNotThrow(() => new SequenceRunner({ log: {}, drivers: {}, config: {}, timing: {}, sequences: defaultSequences({ shutter: true }) }));
});
