// Publishes "start" and "stop" buttons for the theater sequence, both as
// Matter On/Off Plug-in Units (for Alexa) and as HomeKit switches (for iPhone:
// Home app and Siri). Whichever is pressed, the single SequenceRunner runs the
// sequence once; a press while one is running is refused. The buttons fall
// back to off after a moment: they report "accepted", not the theater's state.

import fs from 'node:fs';
import path from 'node:path';

import { AdcpClient } from './drivers/adcp-client.js';
import { BdzRecorder } from './drivers/bdz.js';
import { DenonAvr } from './drivers/denon-api.js';
import { SomfyGateway } from './drivers/somfy.js';
import { DEFAULT_CREDENTIALS_PATH, SwitchBotApi, loadCredentials } from './drivers/switchbot-api.js';
import { expandHome, loadSecretFile } from './secrets.js';
import { BusyError, SequenceRunner, defaultSequences } from './sequence.js';

export const PLUGIN_NAME = 'homebridge-theater-sequence';
export const PLATFORM_NAME = 'TheaterSequence';

const NODE_LABEL_MAX_BYTES = 32;
const DEFAULT_TIMING = {
  pollMs: 1000,
  projectorMs: 60000, // warm-up/cool-down measured ~10-18 s
  avrPowerMs: 15000,
  avrSettleMs: 3000, // after the AVR came on in this run, before selecting the input
  avrInputMs: 5000, // input change measured ~1.2 s
  recorderWakeMs: 30000, // Wake-on-LAN -> PowerInternalOn measured ~8 s
  recorderPowerMs: 20000,
  shutterAcceptMs: 10000, // /exec/apply -> IN_PROGRESS measured ~1 s
};
const DEFAULT_ADCP_PASSWORD_FILE = '~/.config/theater-sequence/adcp.json';
const DEFAULT_SOMFY_TOKEN_FILE = '~/.config/theater-sequence/somfy.json';
const DEFAULT_SOMFY_CA_FILE = '~/.config/theater-sequence/overkiz-root-ca-2048.crt';

export class TheaterSequencePlatform {
  constructor(log, config, api, { driverFactory } = {}) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.resetMs = Number.isFinite(this.config.resetMs) ? Math.max(200, this.config.resetMs) : 1000;
    this.cachedHap = new Map();
    this.cachedMatter = new Map();
    this.buttons = []; // { name: 'start'|'stop', label, matterUuid, hapService, resetTimer }
    this.driverFactory = driverFactory || (() => this.createDrivers());

    api.on('didFinishLaunching', () => {
      this.start().catch((e) => this.log.error(`startup failed: ${e.message}`));
    });
    api.on('shutdown', () => {
      for (const b of this.buttons) clearTimeout(b.resetTimer);
    });
  }

  // Cached HomeKit switches. Its presence also makes Homebridge treat this as a
  // dynamic platform, without which cached Matter accessories are dropped.
  configureAccessory(accessory) {
    this.cachedHap.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory) {
    this.cachedMatter.set(accessory.UUID, accessory);
  }

  createDrivers() {
    const c = this.config;
    const need = (obj, keys, what) => {
      for (const k of keys) if (!obj?.[k]) throw new Error(`missing "${what}.${k}" in config`);
    };
    need(c.projector, ['host'], 'projector');
    need(c.screen, ['deviceId', 'downButton', 'upButton'], 'screen');
    need(c.avr, ['host', 'inputCode'], 'avr');
    need(c.recorder, ['host', 'mac', 'broadcast'], 'recorder');
    const { password } = loadSecretFile(c.projector.passwordFile || DEFAULT_ADCP_PASSWORD_FILE, ['password']);
    let somfy;
    if (c.shutter) {
      need(c.shutter, ['host', 'pin', 'deviceURL'], 'shutter');
      const { token } = loadSecretFile(c.shutter.tokenFile || DEFAULT_SOMFY_TOKEN_FILE, ['token']);
      const ca = fs.readFileSync(expandHome(c.shutter.caFile || DEFAULT_SOMFY_CA_FILE));
      somfy = new SomfyGateway({ host: c.shutter.host, pin: c.shutter.pin, token: String(token), ca });
    }
    return {
      somfy,
      adcp: new AdcpClient({ host: c.projector.host, port: c.projector.port || 53595, password, timeout: 5000 }),
      // screen.apiBase and recorder.port exist for testing against local fakes; not in the schema.
      switchbot: new SwitchBotApi(loadCredentials(c.screen.credentialsFile || DEFAULT_CREDENTIALS_PATH),
        apiBaseOption(c.screen.apiBase, this.log)),
      denon: new DenonAvr({ host: c.avr.host, port: c.avr.port || 8080 }),
      bdz: new BdzRecorder({ host: c.recorder.host, mac: c.recorder.mac, broadcast: c.recorder.broadcast, port: c.recorder.port || 64220 }),
    };
  }

  async start() {
    let drivers;
    try {
      drivers = this.driverFactory();
    } catch (e) {
      this.log.error(e.message);
      return;
    }
    this.runner = new SequenceRunner({
      log: this.log,
      drivers,
      config: this.config,
      timing: { ...DEFAULT_TIMING, ...(this.config.timing || {}) },
      sequences: { ...defaultSequences({ shutter: !!drivers.somfy }), ...(this.config.sequences || {}) },
      resultFile: path.join(this.api.user.storagePath(), 'theater-sequence-last.json'),
    });

    const labels = { start: this.config.startName || 'Theater Start', stop: this.config.stopName || 'Theater Stop' };
    this.buttons = ['start', 'stop'].map((name) => ({ name, label: nodeLabel(labels[name], this.log), resetTimer: undefined }));

    if (this.config.homekit !== false) this.setupHomeKit();
    else this.removeStale(this.cachedHap, []);
    await this.setupMatter();
  }

  // Shared by both protocols. Returns once the sequence is accepted.
  press(button, source) {
    clearTimeout(button.resetTimer);
    try {
      const { done } = this.runner.request(button.name, source);
      done.catch((e) => this.log.error(`sequence "${button.name}" crashed: ${e.message}`));
    } finally {
      button.resetTimer = setTimeout(() => this.resetButton(button), this.resetMs);
    }
  }

  resetButton(button) {
    if (button.hapService) button.hapService.updateCharacteristic(this.api.hap.Characteristic.On, false);
    if (button.matterUuid && this.api.matter) {
      this.api.matter.updateAccessoryState(button.matterUuid, this.api.matter.clusterNames.OnOff, { onOff: false })
        .catch((e) => this.log.debug(`onOff reset failed: ${e.message}`));
    }
  }

  setupHomeKit() {
    const { Service, Characteristic, HapStatusError, HAPStatus, uuid } = this.api.hap;
    const accUuid = uuid.generate(`${PLUGIN_NAME}:homekit`);
    this.removeStale(this.cachedHap, [accUuid]);
    let acc = this.cachedHap.get(accUuid);
    const isNew = !acc;
    if (!acc) acc = new this.api.platformAccessory(this.config.name || 'Theater', accUuid, 8 /* Categories.SWITCH */);
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'simukappu')
      .setCharacteristic(Characteristic.Model, 'Theater sequence')
      .setCharacteristic(Characteristic.SerialNumber, accUuid.replace(/-/g, '').slice(0, 16));
    for (const b of this.buttons) {
      const svc = acc.getServiceById(Service.Switch, b.name) || acc.addService(Service.Switch, b.label, b.name);
      if (!svc.testCharacteristic(Characteristic.ConfiguredName)) svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      svc.setCharacteristic(Characteristic.ConfiguredName, b.label);
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((value) => {
          if (!value) return; // off is the resting state
          try {
            this.press(b, 'HomeKit');
          } catch (e) {
            this.log.warn(`HomeKit "${b.label}": ${e.message}`);
            throw new HapStatusError(e instanceof BusyError ? HAPStatus.RESOURCE_BUSY : HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
        });
      b.hapService = svc;
    }
    if (isNew) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    else this.api.updatePlatformAccessories([acc]);
    this.log.info(`HomeKit switches: ${this.buttons.map((b) => `"${b.label}"`).join(', ')}.`);
  }

  async setupMatter() {
    const matter = typeof this.api.isMatterEnabled === 'function' && this.api.isMatterEnabled() ? this.api.matter : undefined;
    if (!matter) {
      this.log.warn('Matter is not enabled for this bridge — only the HomeKit switches are available.');
      return;
    }
    const accessories = this.buttons.map((b) => {
      b.matterUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:matter:${b.name}`);
      return {
        UUID: b.matterUuid,
        displayName: b.label,
        deviceType: matter.deviceTypes.OnOffOutlet,
        manufacturer: 'simukappu',
        model: 'Theater sequence',
        serialNumber: b.matterUuid.replace(/-/g, ''),
        context: {},
        clusters: { onOff: { onOff: false } },
        handlers: {
          onOff: {
            on: async () => {
              try {
                this.press(b, 'Matter');
              } catch (e) {
                this.log.warn(`Matter "${b.label}": ${e.message}`);
                if (e instanceof BusyError) throw new matter.status.Busy(e.message);
                throw e;
              }
            },
            off: async () => {},
            toggle: async () => {}, // matter.js resolves Toggle into on()/off()
          },
        },
      };
    });
    const stale = [...this.cachedMatter.values()].filter((a) => !accessories.some((x) => x.UUID === a.UUID));
    if (stale.length) {
      matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
        .catch((e) => this.log.warn(`could not remove stale Matter buttons: ${e.message}`));
    }
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    for (const b of this.buttons) this.resetButton(b);
    this.log.info(`Matter buttons: ${this.buttons.map((b) => `"${b.label}"`).join(', ')}.`);
  }

  removeStale(cache, keep) {
    const stale = [...cache.values()].filter((a) => !keep.includes(a.UUID));
    if (!stale.length) return;
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    for (const a of stale) cache.delete(a.UUID);
  }
}

// Requests to the SwitchBot base URL carry the signed token, so the override is
// only taken for https:, or for plain http: to a fake on this host.
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost']; // URL.hostname keeps IPv6 brackets

function apiBaseOption(apiBase, log) {
  if (!apiBase) return {};
  let url;
  try { url = new URL(String(apiBase)); } catch { /* reported below */ }
  if (url && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))) {
    return { base: String(apiBase) };
  }
  const got = url ? `${url.protocol}//${url.hostname}` : 'not a valid URL';
  log.warn(`Ignoring screen.apiBase (${got}): only https: URLs, or http: to 127.0.0.1, ::1 or localhost, are accepted.`);
  return {};
}

function nodeLabel(name, log) {
  if (Buffer.byteLength(name, 'utf8') <= NODE_LABEL_MAX_BYTES) return name;
  let out = name;
  while (Buffer.byteLength(out, 'utf8') > NODE_LABEL_MAX_BYTES) out = Array.from(out).slice(0, -1).join('');
  log.warn(`Button name "${name}" exceeds ${NODE_LABEL_MAX_BYTES} bytes — using "${out}".`);
  return out;
}
