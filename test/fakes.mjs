// In-memory devices reproducing behavior measured on 2026-09-25:
// projector passes startup/cooling before on/standby; the Denon main zone ignores
// SI<code> in standby (it powers on without changing the input); the BDZ
// recorder is silent in standby except for SSDP, Wake-on-LAN brings it to
// PowerInternalOn only, and POWER toggles PowerInternalOn <-> PowerOn.

const later = (ms, fn) => setTimeout(fn, ms);

export function fakeProjector({ state = 'standby', transitionMs = 40, rejectPower = false } = {}) {
  const p = { state, sent: [] };
  p.send = async (cmd) => {
    p.sent.push(cmd);
    if (cmd === 'power_status ?') return p.state;
    if (rejectPower) return 'err_inactive';
    if (cmd === 'power "on"') {
      if (p.state === 'standby') { p.state = 'startup'; later(transitionMs, () => { p.state = 'on'; }); return 'ok'; }
      return 'err_inactive';
    }
    if (cmd === 'power "off"') {
      if (p.state === 'on') { p.state = 'cooling1'; later(transitionMs, () => { p.state = 'standby'; }); return 'ok'; }
      return 'err_inactive';
    }
    return 'err_cmd';
  };
  return p;
}

// httpInput: what the (possibly stale) HTTP page reports; telnet: false = port busy.
export function fakeDenon({ power = 'OFF', input = 'NET', delayMs = 20, unreachable = false, via = 'telnet', httpInput, telnet = true } = {}) {
  const d = { power, input, sent: [], via, httpInput, telnet };
  const check = () => { if (d.unreachable) { const e = new Error('AVR not reachable'); e.unreachable = true; throw e; } };
  d.unreachable = unreachable;
  d.telnetStatus = async () => { check(); if (!d.telnet) throw new Error('connect ECONNREFUSED'); return { power: d.power, input: d.input }; };
  d.status = async () => {
    check();
    if (d.via === 'telnet' && d.telnet) return { power: d.power, input: d.input, via: 'telnet' };
    return { power: d.power, input: d.httpInput ?? d.input, via: 'http', telnetError: 'connect ECONNREFUSED' };
  };
  d.setMainZonePower = async (on) => { check(); d.sent.push(on ? 'ZMON' : 'ZMOFF'); later(delayMs, () => { d.power = on ? 'ON' : 'STANDBY'; }); };
  d.selectInput = async (code) => {
    check();
    d.sent.push(`SI${code}`);
    if (d.power !== 'ON') later(delayMs, () => { d.power = 'ON'; });
    else later(delayMs, () => { d.input = code; });
  };
  return d;
}

export function fakeSwitchBot({ fail = false } = {}) {
  const s = { pressed: [] };
  s.pressButton = async (deviceId, button) => {
    s.pressed.push({ deviceId, button });
    if (fail) throw new Error('HTTP 200, statusCode 171, hub offline');
    return { statusCode: 100 };
  };
  return s;
}

// state: 'standby' | 'internal' | 'transing' | 'on' | 'unreachable'
export function fakeBdz({ state = 'standby', delayMs = 20, ignorePower = false } = {}) {
  const b = { state, sent: [] };
  const power = { internal: 'PowerInternalOn', transing: 'PowerTransingInternalOn', on: 'PowerOn' };
  b.playStatus = async () => (power[b.state] ? { power: power[b.state], play: 'Stopped' } : null);
  b.isInStandby = async () => b.state === 'standby';
  b.wake = async () => { b.sent.push('WOL'); if (b.state === 'standby') later(delayMs, () => { b.state = 'internal'; }); };
  b.pressPower = async () => {
    b.sent.push('POWER');
    if (ignorePower) return;
    if (b.state === 'internal') later(delayMs, () => { b.state = 'on'; });
    // As observed: PowerOn -> PowerTransingInternalOn -> PowerInternalOn.
    else if (b.state === 'on') { b.state = 'transing'; later(delayMs, () => { b.state = 'internal'; }); }
  };
  return b;
}

export const FAST_TIMING = {
  pollMs: 5,
  projectorMs: 500,
  avrPowerMs: 300,
  avrSettleMs: 30,
  avrInputMs: 300,
  recorderWakeMs: 300,
  recorderPowerMs: 300,
};

export const CONFIG = {
  screen: { deviceId: '02-000000000000-00000001', downButton: 'Down', upButton: 'Up' },
  avr: { inputCode: 'BD' },
};
