// Somfy gateway (TaHoma / Connexoon) through the official local API of the
// TaHoma Developer Mode (https://github.com/Somfy-Developer/Somfy-TaHoma-Developer-Mode):
// HTTPS on port 8443, bearer token generated in the TaHoma app, certificate
// issued by the Overkiz root CA (verified, never skipped).
//
// Only "open" and "close" can be sent. With an RTS (one-way radio) shutter the
// gateway cannot know where the shutter is: measured on a Connexoon on
// 2026-10-13, an execution went IN_PROGRESS ~1 s after /exec/apply and
// COMPLETED ~31.5 s later, while the shutter itself had finished in 5-10 s —
// COMPLETED is the gateway's own timer, not arrival. So callers treat
// IN_PROGRESS as "the gateway is transmitting" and do not wait for COMPLETED.

import https from 'node:https';

const BASE_PATH = '/enduser-mobile-web/1/enduserAPI';
const COMMANDS = new Set(['open', 'close']);
const PIN_RE = /^\d{4}-\d{4}-\d{4}$/;

export class SomfyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SomfyError';
  }
}

export class SomfyGateway {
  // host: the gateway's (reserved) IP. pin: its PIN, used as the TLS name
  // gateway-<pin>.local that the certificate is issued for.
  constructor({ host, pin, token, ca, port = 8443, timeoutMs = 5000, requestImpl = https.request }) {
    if (!PIN_RE.test(String(pin))) throw new SomfyError('invalid Somfy gateway pin (expected 1234-5678-9012)');
    this.host = host;
    this.pin = pin;
    this.token = token;
    this.ca = ca;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.request = requestImpl;
  }

  call(method, path, body) {
    const data = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = this.request({
        host: this.host,
        port: this.port,
        servername: `gateway-${this.pin}.local`,
        ca: this.ca,
        method,
        path: BASE_PATH + path,
        timeout: this.timeoutMs,
        headers: { Authorization: `Bearer ${this.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new SomfyError(`${method} ${path.split('/').slice(0, 3).join('/')}: HTTP ${res.statusCode}`));
            return;
          }
          let json = null;
          try { json = JSON.parse(text); } catch { /* empty or non-JSON body */ }
          resolve(json);
        });
      });
      // Network/TLS errors carry no secrets; the token is only in a header.
      req.on('error', (e) => reject(new SomfyError(`Somfy gateway not reachable: ${e.message}`)));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end(data);
    });
  }

  // Send "open" or "close" to one device and resolve once the gateway reports
  // the execution IN_PROGRESS (transmitting). Rejects on FAILED, or if neither
  // shows up within acceptMs. Sent once, never retried.
  async command(deviceURL, name, { acceptMs = 10000, pollMs = 500 } = {}) {
    if (!COMMANDS.has(name)) throw new SomfyError(`command "${name}" is not allowed`);
    if (!/^[a-z]+:\/\/[\w./-]+$/.test(String(deviceURL))) throw new SomfyError('invalid deviceURL');
    const listener = (await this.call('POST', '/events/register'))?.id;
    if (!listener) throw new SomfyError('could not register an event listener');
    try {
      const applied = await this.call('POST', '/exec/apply', {
        label: `theater ${name}`,
        actions: [{ deviceURL, commands: [{ name }] }],
      });
      const execId = applied?.execId;
      if (!execId) throw new SomfyError('the gateway returned no execId');
      const deadline = Date.now() + acceptMs;
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        const events = (await this.call('POST', `/events/${encodeURIComponent(listener)}/fetch`)) || [];
        for (const e of events) {
          if (e.execId !== execId || e.name !== 'ExecutionStateChangedEvent') continue;
          if (e.newState === 'FAILED') throw new SomfyError(`execution FAILED${e.failureType ? ` (${e.failureType})` : ''}`);
          if (e.newState === 'IN_PROGRESS' || e.newState === 'COMPLETED') return { execId, state: e.newState };
        }
        if (Date.now() >= deadline) throw new SomfyError(`execution not IN_PROGRESS within ${acceptMs} ms`);
      }
    } finally {
      await this.call('POST', `/events/${encodeURIComponent(listener)}/unregister`).catch(() => {});
    }
  }
}
