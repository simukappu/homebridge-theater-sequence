// Written first for a standalone Denon input-select plugin (unpublished, since
// retired), then extended with main-zone power (ZMON/ZMOFF) and telnet reads
// for the theater sequence.
// Minimal Denon AVR HTTP client for the main zone: read power and input,
// switch the main zone on/off, and select an input directly. The only commands
// it can build are SI<code>, ZMON and ZMOFF, so it cannot touch other zones,
// volume or speaker settings.
//
// Verified on an AVC-X6700H (CommApiVers 0301): the command endpoint answers
// HTTP 200 with an empty body whether or not anything changed, so success is
// only ever known from reading the status back.
//
// Status is read over the telnet control port (23: "ZM?" / "SI?"). On
// 2026-09-25 the HTTP status page kept reporting input NET for 3+ minutes after
// the AVR had switched to BD (the telnet query answered SIBD, and only then did
// the HTTP page catch up). HTTP status is used only if port 23 is unavailable —
// many Denon models accept a single telnet client at a time.

import net from 'node:net';

// Input function codes are like BD, DVD, SAT/CBL, MPLAY, AUX1.
const INPUT_CODE_RE = /^[A-Z0-9/]{1,10}$/;

export class DenonError extends Error {
  constructor(message, { unreachable = false } = {}) {
    super(message);
    this.name = 'DenonError';
    this.unreachable = unreachable;
  }
}

export function isValidInputCode(code) {
  return INPUT_CODE_RE.test(code);
}

export class DenonAvr {
  constructor({ host, port = 8080, telnetPort = 23, timeoutMs = 3000, fetchImpl = fetch, netImpl = net }) {
    this.host = host;
    this.telnetPort = telnetPort;
    this.net = netImpl;
    this.base = `http://${host}:${port}`;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async get(pathAndQuery) {
    let res;
    try {
      res = await this.fetch(this.base + pathAndQuery, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new DenonError(`AVR not reachable: ${e.message}`, { unreachable: true });
    }
    if (res.status !== 200) throw new DenonError(`HTTP ${res.status} for ${pathAndQuery.split('?')[0]}`);
    return res.text();
  }

  // Main zone power ("ON" / "OFF" / ...) and current input function code, plus
  // where it was read from. Prefers the telnet port (see above).
  async status() {
    try {
      return { ...(await this.telnetStatus()), via: 'telnet' };
    } catch (e) {
      if (e.unreachable) throw e;
      // Keep the reason: an HTTP value may be stale, so callers may re-check.
      return { ...(await this.httpStatus()), via: 'http', telnetError: e.message };
    }
  }

  // One short connection: send ZM? and SI?, collect the ZM*/SI* replies.
  telnetStatus() {
    return new Promise((resolve, reject) => {
      const sock = this.net.connect(this.telnetPort, this.host);
      let buf = '';
      let power;
      let input;
      const done = (err, val) => { clearTimeout(timer); sock.destroy(); if (err) reject(err); else resolve(val); };
      const timer = setTimeout(() => done(new DenonError('telnet status: no ZM/SI reply in time')), this.timeoutMs);
      sock.on('connect', () => sock.write('ZM?\rSI?\r'));
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        // Complete lines only: the last segment may be a fragment ("SIB" of "SIBD").
        for (const line of buf.split('\r').slice(0, -1)) {
          if (/^ZM(ON|OFF)$/.test(line)) power = line.slice(2);
          else if (/^SI[A-Z0-9/]+$/.test(line)) input = line.slice(2);
        }
        if (power && input) done(null, { power, input });
      });
      // Refused/busy port: let the caller fall back to HTTP.
      sock.on('error', (e) => done(new DenonError(`telnet status: ${e.message}`)));
    });
  }

  async httpStatus() {
    const xml = await this.get('/goform/formMainZone_MainZoneXmlStatusLite.xml');
    const value = (tag) => (xml.match(new RegExp(`<${tag}><value>([^<]*)</value>`)) || [])[1];
    const power = value('Power');
    const input = value('InputFuncSelect');
    if (!power || !input) throw new DenonError('unexpected status response');
    return { power, input };
  }

  // Fire-and-forget on the AVR side: resolves when the request was delivered,
  // which says nothing about whether the input changed.
  // Main zone only (ZM*). Like SI, the AVR does not acknowledge it.
  async setMainZonePower(on) {
    await this.get(`/goform/formiPhoneAppDirect.xml?${on ? 'ZMON' : 'ZMOFF'}`);
  }

  async selectInput(code) {
    if (!isValidInputCode(code)) throw new DenonError(`invalid input code "${code}"`);
    await this.get(`/goform/formiPhoneAppDirect.xml?SI${code}`);
  }
}
