import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { API_BASE } from '../src/drivers/switchbot-api.js';
import { TheaterSequencePlatform } from '../src/platform.js';
import { BusyError, SequenceRunner } from '../src/sequence.js';
import { CONFIG, FAST_TIMING, fakeBdz, fakeDenon, fakeProjector, fakeSwitchBot } from './fakes.mjs';

const require = createRequire(import.meta.url);
const hap = require('@homebridge/hap-nodejs');
const { PlatformAccessory } = await import(new URL('../node_modules/homebridge/dist/platformAccessory.js', import.meta.url));

class MatterBusy extends Error {}
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function drivers(over = {}) {
  return {
    adcp: fakeProjector(), switchbot: fakeSwitchBot(), denon: fakeDenon(), bdz: fakeBdz(), ...over,
  };
}

function fakeMatter() {
  const m = {
    registered: new Map(),
    unregistered: [],
    deviceTypes: { OnOffOutlet: { name: 'OnOffPlugInUnit' } },
    clusterNames: { OnOff: 'onOff' },
    status: { Busy: MatterBusy },
    async registerPlatformAccessories(_p, _n, accs) { for (const a of accs) m.registered.set(a.UUID, { accessory: a, clusters: structuredClone(a.clusters) }); },
    async unregisterPlatformAccessories(_p, _n, accs) { m.unregistered.push(...accs.map((a) => a.UUID)); },
    async updateAccessoryState(uuid, cluster, attrs) { Object.assign(m.registered.get(uuid).clusters[cluster], attrs); },
    async command(uuid, name) {
      const r = m.registered.get(uuid);
      await r.accessory.handlers.onOff[name]();
      r.clusters.onOff.onOff = name === 'on';
    },
  };
  return m;
}

// real: use the platform's own createDrivers() (secrets files) instead of fakes.
async function launch({ drv = drivers(), config = {}, cachedHap = [], matterEnabled = true, real = false } = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'theater-'));
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => storage };
  api.registered = [];
  api.unregistered = [];
  api.registerPlatformAccessories = (_p, _n, accs) => api.registered.push(...accs);
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = (_p, _n, accs) => api.unregistered.push(...accs.map((a) => a.UUID));
  api.isMatterEnabled = () => matterEnabled;
  api.matter = matterEnabled ? fakeMatter() : undefined;
  const lines = [];
  const log = {};
  for (const l of ['info', 'warn', 'error', 'debug']) log[l] = (...a) => lines.push([l, a.join(' ')]);
  const platform = new TheaterSequencePlatform(log, {
    name: 'Theater', startName: 'Theater Start', stopName: 'Theater Stop', resetMs: 200, timing: FAST_TIMING, ...CONFIG, ...config,
  }, api, { driverFactory: real ? undefined : () => drv });
  for (const a of cachedHap) platform.configureAccessory(a);
  api.emit('didFinishLaunching');
  await settle(50);
  const button = (name) => platform.buttons.find((b) => b.name === name);
  const hapOn = (name) => button(name).hapService.getCharacteristic(hap.Characteristic.On);
  const matterPress = (name) => api.matter.command(button(name).matterUuid, 'on');
  const finished = () => platform.runner.running?.promise ?? Promise.resolve();
  const result = () => JSON.parse(fs.readFileSync(path.join(storage, 'theater-sequence-last.json'), 'utf8'));
  return { api, drv, platform, lines, button, hapOn, matterPress, finished, result, storage };
}

test('start from Alexa (Matter): steps run in the decided order and are recorded', async () => {
  const t = await launch();
  await t.matterPress('start');
  await t.finished();
  const r = t.result();
  assert.deepEqual(r.steps.map((s) => s.step), ['screen-down', 'projector-on', 'avr-on', 'recorder-on', 'avr-input']);
  assert.equal(r.source, 'Matter');
  assert.equal(r.steps[1].background, true);
  assert.deepEqual(r.steps.map((s) => s.outcome), ['accepted', 'reached', 'reached', 'reached', 'reached']);
  assert.equal(r.ok, true);
  assert.deepEqual(t.drv.switchbot.pressed.map((p) => p.button), ['Down']);
  assert.deepEqual(t.drv.denon.sent, ['ZMON', 'SIBD']);
  assert.deepEqual(t.drv.bdz.sent, ['WOL', 'POWER']);
});

test('stop from iPhone (HomeKit): screen up first, then recorder, AVR, projector', async () => {
  const drv = drivers({
    adcp: fakeProjector({ state: 'on' }), denon: fakeDenon({ power: 'ON', input: 'BD' }), bdz: fakeBdz({ state: 'on' }),
  });
  const t = await launch({ drv });
  await t.hapOn('stop').handleSetRequest(true);
  await t.finished();
  const r = t.result();
  assert.deepEqual(r.steps.map((s) => s.step), ['screen-up', 'recorder-off', 'avr-off', 'projector-off']);
  assert.deepEqual(r.steps.map((s) => s.outcome), ['accepted', 'reached', 'reached', 'reached']);
  assert.equal(r.source, 'HomeKit');
  assert.ok(t.lines.some(([, m]) => /Sequence "stop" started via HomeKit/.test(m)));
  assert.deepEqual(t.drv.switchbot.pressed.map((p) => p.button), ['Up']);
});

test('start: AVR and recorder do not wait for the projector warm-up; the sequence still waits for it', async () => {
  const drv = drivers({ adcp: fakeProjector({ transitionMs: 300 }) });
  const t = await launch({ drv });
  const t0 = Date.now();
  await t.matterPress('start');
  // AVR power-on is sent well before the projector reaches "on".
  while (!drv.denon.sent.includes('ZMON')) await settle(5);
  assert.ok(Date.now() - t0 < 200, 'AVR started without waiting ~300 ms for the projector');
  assert.notEqual(drv.adcp.state, 'on');
  await t.finished();
  const r = t.result();
  assert.equal(r.steps[1].outcome, 'reached', 'projector arrival still confirmed');
  assert.ok(r.ms >= 300, 'sequence ended only after the projector got there');
  assert.equal(r.ok, true);
});

test('a failed step is recorded and the rest still run', async () => {
  const t = await launch({ drv: drivers({ switchbot: fakeSwitchBot({ fail: true }) }) });
  await t.matterPress('start');
  await t.finished();
  const r = t.result();
  assert.equal(r.steps[0].outcome, 'failed');
  assert.deepEqual(r.steps.slice(1).map((s) => s.outcome), ['reached', 'reached', 'reached', 'reached']);
  assert.equal(r.ok, false);
  assert.ok(t.lines.some(([l, m]) => l === 'warn' && /screen-down: failed/.test(m)));
});

test('one sequence at a time, whichever side presses: Matter Busy / HomeKit RESOURCE_BUSY', async () => {
  const t = await launch();
  await t.matterPress('start');
  await assert.rejects(t.matterPress('stop'), MatterBusy);
  // hap-nodejs rejects with the HAP status code itself.
  await assert.rejects(t.hapOn('start').handleSetRequest(true), (e) => e === hap.HAPStatus.RESOURCE_BUSY);
  await t.finished();
  assert.deepEqual(t.drv.switchbot.pressed.map((p) => p.button), ['Down'], 'ran once');
  await t.matterPress('stop'); // accepted once the first finished
  await t.finished();
  assert.equal(t.result().sequence, 'stop');
});

test('the press returns once accepted, not after the whole sequence', async () => {
  const t = await launch({ drv: drivers({ adcp: fakeProjector({ transitionMs: 300 }) }) });
  const t0 = Date.now();
  await t.matterPress('start');
  assert.ok(Date.now() - t0 < 100, 'Matter handler returned immediately');
  assert.ok(t.platform.runner.running, 'sequence still running');
  await t.finished();
});

test('buttons fall back to off on both protocols', async () => {
  const t = await launch();
  await t.matterPress('start');
  await t.hapOn('start').handleSetRequest(true).catch(() => {});
  await t.finished();
  await settle(300);
  assert.equal(t.api.matter.registered.get(t.button('start').matterUuid).clusters.onOff.onOff, false);
  assert.equal(t.hapOn('start').value, false);
});

test('HomeKit accessory: restored from cache (not re-registered); stale cached accessories removed', async () => {
  const first = await launch();
  const acc = first.api.registered[0];
  assert.ok(acc, 'registered on first launch');
  const stale = new PlatformAccessory('old', hap.uuid.generate('old'));
  const t = await launch({ cachedHap: [acc, stale] });
  assert.deepEqual(t.api.registered, [], 'cached accessory reused');
  assert.deepEqual(t.api.unregistered, [stale.UUID]);
  assert.ok('configureAccessory' in t.platform);
});

test('Matter disabled: HomeKit switches still work', async () => {
  const t = await launch({ matterEnabled: false });
  await t.hapOn('start').handleSetRequest(true);
  await t.finished();
  assert.equal(t.result().ok, true);
  assert.ok(t.lines.some(([l, m]) => l === 'warn' && /only the HomeKit switches/.test(m)));
});

test('secrets: missing file -> nothing published; values never logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theater-secrets-'));
  const missing = await launch({ real: true, config: fullConfig(dir, false) });
  assert.ok(missing.lines.some(([l, m]) => l === 'error' && /secrets file not found/.test(m)));
  assert.equal(missing.api.registered.length, 0);

  const cfg = fullConfig(dir, true);
  const ok = await launch({ real: true, config: cfg });
  assert.ok(ok.platform.runner, 'drivers created from the secrets files');
  const logged = ok.lines.map(([, m]) => m).join('\n');
  for (const s of ['adcp-secret-DO-NOT-LOG', 'sb-token-DO-NOT-LOG', 'sb-secret-DO-NOT-LOG']) assert.ok(!logged.includes(s));
});

test('screen.apiBase override: only https:, or http: to a loopback host; anything else is ignored with a warning', async () => {
  const cfg = fullConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'theater-apibase-')), true);
  const used = async (apiBase) => {
    const t = await launch({ real: true, config: { ...cfg, screen: { ...cfg.screen, apiBase } } });
    const warned = t.lines.some(([l, m]) => l === 'warn' && /Ignoring screen\.apiBase/.test(m));
    return { base: t.platform.runner.drivers.switchbot.base, warned };
  };
  for (const ok of ['https://api.example.test', 'http://127.0.0.1:8081', 'http://[::1]:8081', 'http://localhost:8081']) {
    assert.deepEqual(await used(ok), { base: ok, warned: false }, ok);
  }
  for (const bad of ['http://192.0.2.9:8081', 'http://localhost.example.test', 'ftp://127.0.0.1', 'not a url']) {
    assert.deepEqual(await used(bad), { base: API_BASE, warned: true }, bad);
  }
});

test('the result file is written owner-only (mode 600)', async () => {
  const t = await launch();
  await t.matterPress('start');
  await t.finished();
  assert.equal(fs.statSync(path.join(t.storage, 'theater-sequence-last.json')).mode & 0o777, 0o600);
});

function fullConfig(dir, write) {
  const adcp = path.join(dir, 'adcp.json');
  const sb = path.join(dir, 'sb.json');
  if (write) {
    fs.writeFileSync(adcp, JSON.stringify({ password: 'adcp-secret-DO-NOT-LOG' }), { mode: 0o600 });
    fs.writeFileSync(sb, JSON.stringify({ token: 'sb-token-DO-NOT-LOG', secret: 'sb-secret-DO-NOT-LOG' }), { mode: 0o600 });
  }
  return {
    projector: { host: '192.0.2.1', passwordFile: adcp },
    screen: { ...CONFIG.screen, credentialsFile: sb },
    avr: { host: '192.0.2.2', inputCode: 'BD' },
    recorder: { host: '192.0.2.3', mac: '00:00:5e:00:53:01', broadcast: '192.0.2.255' },
  };
}

test('SequenceRunner rejects unknown steps in configured sequences', () => {
  assert.throws(() => new SequenceRunner({ log: {}, drivers: {}, config: {}, timing: FAST_TIMING, sequences: { start: ['shutter-close'] } }), /unknown step "shutter-close"/);
  assert.throws(() => new SequenceRunner({ log: {}, drivers: {}, config: {}, timing: FAST_TIMING, sequences: { start: ['shutter-close&'] } }), /unknown step "shutter-close&"/);
  assert.doesNotThrow(() => new SequenceRunner({ log: {}, drivers: {}, config: {}, timing: FAST_TIMING, sequences: { start: ['projector-on&'] } }));
  assert.ok(new BusyError('start').message.includes('start'));
});
