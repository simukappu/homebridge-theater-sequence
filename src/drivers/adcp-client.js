// Sony ADCP client, ported to JavaScript from homebridge-sony-adcp
// (src/adcp-client.ts at upstream v1.0.7, MIT, Copyright (c) Kerem Erkan;
// see THIRD_PARTY_NOTICES.md). Behavior is unchanged.

import crypto from 'node:crypto';
import net from 'node:net';

const CRLF = '\r\n';

export class AdcpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdcpError';
    this.code = code; // 'timeout' | 'socket' | 'auth' | 'closed'
  }
}

/**
 * Each command opens its own short-lived TCP connection; calls are serialized
 * through a promise chain. Handshake: the projector greets with NOKEY (no auth)
 * or a nonce, answered with sha256(nonce + password) in lowercase hex; a valid
 * hash is acknowledged with a bare OK before the command is sent.
 */
export class AdcpClient {
  constructor({ host, port = 53595, password = '', timeout = 5000 }) {
    this.host = host;
    this.port = port;
    this.password = password || '';
    this.timeout = timeout;
    this.chain = Promise.resolve();
    this.authRequired = null;
  }

  // Resolves with the reply line, trimmed and unquoted; err_* replies (other
  // than err_auth) are returned for the caller to interpret.
  send(command) {
    const run = () => this.exec(command);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  exec(command) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let phase = 'greeting';
      let buf = '';
      let settled = false;
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(val);
      };
      const timer = setTimeout(() => finish(new AdcpError(`ADCP timeout for "${command}"`, 'timeout')), this.timeout);
      const write = (line) => socket.write(line + CRLF);
      const onLine = (raw) => {
        const line = raw.trim();
        if (phase === 'greeting') {
          if (line === '') return;
          if (line.toUpperCase() === 'NOKEY') {
            this.authRequired = false;
            phase = 'reply';
            write(command);
          } else {
            this.authRequired = true;
            if (!this.password) {
              finish(new AdcpError('projector requires ADCP authentication but no password is configured', 'auth'));
              return;
            }
            phase = 'auth';
            write(crypto.createHash('sha256').update(line + this.password).digest('hex'));
          }
          return;
        }
        if (phase === 'auth') {
          if (line.toLowerCase() === 'err_auth') finish(new AdcpError('ADCP authentication failed (wrong password)', 'auth'));
          else if (line.toUpperCase() === 'OK') { phase = 'reply'; write(command); }
          else finish(new AdcpError(`unexpected ADCP auth response "${line}"`, 'auth'));
          return;
        }
        if (line.toLowerCase() === 'err_auth') {
          finish(new AdcpError('ADCP authentication failed (wrong password)', 'auth'));
          return;
        }
        finish(null, line.replace(/^"(.*)"$/, '$1'));
      };
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf(CRLF)) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + CRLF.length);
          onLine(line);
          if (settled) return;
        }
      });
      socket.on('error', (e) => finish(new AdcpError(`ADCP socket error: ${e.message}`, 'socket')));
      socket.on('close', () => finish(new AdcpError('ADCP connection closed before reply', 'closed')));
      socket.connect(this.port, this.host);
    });
  }
}
