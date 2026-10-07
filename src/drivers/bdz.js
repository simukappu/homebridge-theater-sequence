// Sony BDZ recorder over the LAN. Two calls, mirroring what the official app sends:
//   X_PvrControl#X_GetPlayStatus        -> powerstatus PowerOn | PowerInternalOn
//                                          (PowerTransingInternalOn while switching off)
//   X_PvrControl#X_InputRemoteKey POWER -> toggles PowerInternalOn <-> PowerOn
// The power key is a toggle, so it is sent only after the power status has
// been read, and the status is read back afterwards (recorderPower() in
// ../steps.js).
//
// In standby the recorder answers neither call, but it still replies to an
// SSDP search; that reply is how standby is told apart from being unreachable.
// Wake-on-LAN only wakes the network side (PowerInternalOn), not PowerOn.

import dgram from 'node:dgram';

const PVR = 'urn:schemas-s-bras-org:service:X_PvrControl:1';
const TELEPATHY_ST = 'urn:schemas-sony-com:service:X_Telepathy:1';
const USER_AGENT = 'homebridge-theater-sequence';

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const tag = (xml, name) => (xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`)) || [])[1];

export class BdzError extends Error {
  constructor(message, { noAnswer = false } = {}) {
    super(message);
    this.name = 'BdzError';
    this.noAnswer = noAnswer;
  }
}

export class BdzRecorder {
  constructor({ host, mac, port = 64220, broadcast, timeoutMs = 3000, fetchImpl = fetch, dgramImpl = dgram }) {
    this.host = host;
    this.mac = mac;
    this.port = port;
    this.broadcast = broadcast;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.dgram = dgramImpl;
  }

  async soap(path, service, action, args = '') {
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${args}</u:${action}></s:Body></s:Envelope>`;
    let res;
    try {
      res = await this.fetch(`http://${this.host}:${this.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"`, 'User-Agent': USER_AGENT },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new BdzError(`no answer to ${action}: ${e.message}`, { noAnswer: true });
    }
    const text = await res.text();
    if (res.status !== 200) throw new BdzError(`${action}: HTTP ${res.status}`);
    return decode(text);
  }

  // { power: 'PowerOn' | 'PowerInternalOn' | ..., play }, or null when the
  // recorder does not answer (standby, or unreachable — see isInStandby()).
  async playStatus() {
    try {
      const xml = await this.soap('/X_PvrControl', PVR, 'X_GetPlayStatus');
      const power = tag(xml, 'powerstatus');
      if (!power) throw new BdzError('X_GetPlayStatus: no powerstatus in reply');
      return { power, play: tag(xml, 'playstatus') };
    } catch (e) {
      if (e.noAnswer) return null;
      throw e;
    }
  }

  // Toggle, exactly as TV SideView sends it. Callers must read the state first.
  async pressPower() {
    await this.soap('/X_PvrControl', PVR, 'X_InputRemoteKey', '<RemoteKey>POWER</RemoteKey>');
  }

  // One Wake-on-LAN magic packet to the subnet broadcast.
  async wake() {
    const mac = Buffer.from(this.mac.split(':').map((h) => parseInt(h, 16)));
    if (mac.length !== 6) throw new BdzError(`invalid MAC "${this.mac}"`);
    const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
    const sock = this.dgram.createSocket('udp4');
    // A socket 'error' (e.g. a failed bind) fails the pending step; without a
    // listener it would be thrown and take the whole bridge down.
    let fail;
    sock.on('error', (e) => fail?.(e));
    try {
      await new Promise((r, j) => { fail = j; sock.bind(r); });
      sock.setBroadcast(true);
      await new Promise((r, j) => { fail = j; sock.send(pkt, 9, this.broadcast, (e) => (e ? j(e) : r())); });
    } finally {
      fail = undefined;
      sock.close();
    }
  }

  // True if the recorder answers an SSDP search for its Telepathy service —
  // it does so in standby, when nothing else answers. A socket error (bind or
  // send) counts as no answer instead of crashing the bridge.
  async isInStandby(waitMs = 3000) {
    const sock = this.dgram.createSocket('udp4');
    const msg = ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${TELEPATHY_ST}`, '', ''].join('\r\n');
    let timer;
    try {
      return await new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
        sock.on('error', () => resolve(false));
        sock.on('message', (_data, rinfo) => {
          if (rinfo.address === this.host) resolve(true);
        });
        sock.bind(() => sock.send(msg, 1900, '239.255.255.250', (e) => { if (e) resolve(false); }));
      });
    } finally {
      clearTimeout(timer);
      sock.close();
    }
  }
}
