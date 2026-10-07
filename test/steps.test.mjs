import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avrInput, avrPower, projectorPower, recorderPower, screenButton } from '../src/steps.js';
import { CONFIG, FAST_TIMING, fakeBdz, fakeDenon, fakeProjector, fakeSwitchBot } from './fakes.mjs';

const ctx = (drivers) => ({ ...drivers, config: CONFIG, timing: FAST_TIMING });
const commands = (p) => p.sent.filter((c) => c !== 'power_status ?');

// ---- projector ---------------------------------------------------------------

test('projector on: sends power "on" once and waits through startup to on', async () => {
  const adcp = fakeProjector();
  const r = await projectorPower(ctx({ adcp }), true);
  assert.equal(r.outcome, 'reached');
  assert.deepEqual(commands(adcp), ['power "on"']);
});

test('projector already on / already heading there: nothing sent', async () => {
  const on = fakeProjector({ state: 'on' });
  assert.equal((await projectorPower(ctx({ adcp: on }), true)).outcome, 'already');
  assert.deepEqual(commands(on), []);
  const cooling = fakeProjector({ state: 'on' });
  await cooling.send('power "off"'); cooling.sent.length = 0; // now cooling1
  assert.equal((await projectorPower(ctx({ adcp: cooling }), false)).outcome, 'reached');
  assert.deepEqual(commands(cooling), [], 'already cooling: waited, did not send again');
});

test('projector: a read timing out during startup is tolerated; the command is not re-sent', async () => {
  const adcp = fakeProjector();
  const send = adcp.send;
  let failNext = 0;
  adcp.send = async (cmd) => {
    if (cmd === 'power_status ?' && adcp.state === 'startup' && failNext++ === 0) throw new Error('ADCP timeout for "power_status ?"');
    return send(cmd);
  };
  const r = await projectorPower(ctx({ adcp }), true);
  assert.equal(r.outcome, 'reached');
  assert.deepEqual(commands(adcp), ['power "on"']);
});

test('projector never answers while waiting: failed with the last read error', async () => {
  const adcp = fakeProjector();
  const send = adcp.send;
  adcp.send = async (cmd) => { if (cmd === 'power_status ?' && adcp.state !== 'standby') throw new Error('ADCP timeout'); return send(cmd); };
  await assert.rejects(projectorPower(ctx({ adcp }), true), /not on after .*last read failed: ADCP timeout/);
});

test('projector rejects the command: failed, not retried', async () => {
  const adcp = fakeProjector({ rejectPower: true });
  await assert.rejects(projectorPower(ctx({ adcp }), true), /replied err_inactive/);
  assert.deepEqual(commands(adcp), ['power "on"']);
});

// ---- screen ------------------------------------------------------------------

test('screen: accepted (IR arrival cannot be read); failure propagates', async () => {
  const switchbot = fakeSwitchBot();
  const r = await screenButton(ctx({ switchbot }), 'Down');
  assert.equal(r.outcome, 'accepted');
  assert.deepEqual(switchbot.pressed, [{ deviceId: CONFIG.screen.deviceId, button: 'Down' }]);
  await assert.rejects(screenButton(ctx({ switchbot: fakeSwitchBot({ fail: true }) }), 'Down'), /171/);
});

// ---- AVR -----------------------------------------------------------------------

test('AVR power on then input BD: ZMON, readback, settle, SIBD, readback', async () => {
  const denon = fakeDenon();
  const c = ctx({ denon });
  assert.equal((await avrPower(c, true)).outcome, 'reached');
  assert.equal((await avrInput(c, 'BD')).outcome, 'reached');
  assert.deepEqual(denon.sent, ['ZMON', 'SIBD']);
  assert.equal(denon.input, 'BD');
});

test('AVR input read via HTTP is re-checked over telnet; telnet disagreeing keeps it unconfirmed', async () => {
  // HTTP says BD (e.g. stale from earlier), telnet says the input never changed.
  const stale = fakeDenon({ power: 'ON', input: 'NET', via: 'http', httpInput: 'BD' });
  stale.selectInput = async (code) => { stale.sent.push(`SI${code}`); }; // AVR ignores it
  await assert.rejects(avrInput(ctx({ denon: stale }), 'BD'), /input not BD .*via telnet/);
  assert.deepEqual(stale.sent, ['SIBD'], 'sent despite the stale HTTP "BD", and not re-sent');
  // Telnet unavailable: the HTTP value stands, and the reason is recorded.
  const busy = fakeDenon({ power: 'ON', input: 'NET', via: 'http', telnet: false });
  const r = await avrInput(ctx({ denon: busy }), 'BD');
  assert.equal(r.outcome, 'reached');
  assert.match(r.detail, /read via http; telnet unavailable: connect ECONNREFUSED/);
});

test('AVR input while the main zone is off: skipped, nothing sent (SI would power it on)', async () => {
  const denon = fakeDenon();
  const r = await avrInput(ctx({ denon }), 'BD');
  assert.equal(r.outcome, 'skipped');
  assert.deepEqual(denon.sent, []);
  assert.equal(denon.power, 'OFF');
});

test('AVR already on the input / already off: nothing sent', async () => {
  const on = fakeDenon({ power: 'ON', input: 'BD' });
  assert.equal((await avrInput(ctx({ denon: on }), 'BD')).outcome, 'already');
  const off = fakeDenon({ power: 'STANDBY' });
  assert.equal((await avrPower(ctx({ denon: off }), false)).outcome, 'already');
  assert.deepEqual([...on.sent, ...off.sent], []);
});

// ---- recorder ------------------------------------------------------------------

test('recorder on from standby: Wake-on-LAN, wait for PowerInternalOn, POWER once, PowerOn', async () => {
  const bdz = fakeBdz({ state: 'standby' });
  const r = await recorderPower(ctx({ bdz }), true);
  assert.equal(r.outcome, 'reached');
  assert.deepEqual(bdz.sent, ['WOL', 'POWER']);
  assert.equal(bdz.state, 'on');
});

test('recorder on from PowerInternalOn: POWER once; already PowerOn: nothing', async () => {
  const internal = fakeBdz({ state: 'internal' });
  assert.equal((await recorderPower(ctx({ bdz: internal }), true)).outcome, 'reached');
  assert.deepEqual(internal.sent, ['POWER']);
  const on = fakeBdz({ state: 'on' });
  assert.equal((await recorderPower(ctx({ bdz: on }), true)).outcome, 'already');
  assert.deepEqual(on.sent, []);
});

test('recorder off: POWER only when PowerOn; waits through PowerTransingInternalOn', async () => {
  const on = fakeBdz({ state: 'on' });
  const r = await recorderPower(ctx({ bdz: on }), false);
  assert.equal(r.outcome, 'reached');
  assert.equal(r.detail, 'PowerInternalOn', 'not the transitional state');
  assert.deepEqual(on.sent, ['POWER']);
  for (const state of ['internal', 'standby']) {
    const b = fakeBdz({ state });
    assert.equal((await recorderPower(ctx({ bdz: b }), false)).outcome, 'already');
    assert.deepEqual(b.sent, [], `${state}: POWER would toggle it on`);
  }
});

test('recorder unreachable (no SSDP either): failed, nothing sent', async () => {
  const bdz = fakeBdz({ state: 'unreachable' });
  await assert.rejects(recorderPower(ctx({ bdz }), true), /unreachable/);
  assert.deepEqual(bdz.sent, []);
});

test('recorder ignores POWER: failed after the timeout, not re-sent', async () => {
  const bdz = fakeBdz({ state: 'internal', ignorePower: true });
  await assert.rejects(recorderPower(ctx({ bdz }), true), /not PowerOn after .*powerstatus PowerInternalOn/);
  assert.deepEqual(bdz.sent, ['POWER']);
});
