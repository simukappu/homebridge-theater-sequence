// One function per step. Each reads the device state first, sends at most one
// command (never retried), and confirms arrival where the device can report it.
// A step returns { outcome, detail } with outcome one of:
//   reached   sent, and the device reported the target state
//   already   the device was already there; nothing sent
//   accepted  sent and accepted, but the device cannot report arrival (IR)
//   skipped   deliberately not sent (unknown/unsafe state, missing precondition)
// and throws for failures (not delivered, or not confirmed in time).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `read` until `done(value)` or the deadline; returns the last value.
// Reads never change device state, so a failed read (e.g. an ADCP timeout while
// the projector is starting up) is tolerated and polled again until the
// deadline. Commands are never repeated here.
async function waitFor(read, done, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let v;
  let lastError;
  for (;;) {
    try {
      v = await read();
      lastError = undefined;
      if (done(v)) return { ok: true, value: v };
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) return { ok: false, value: v, error: lastError };
    await sleep(pollMs);
  }
}

const lastSeen = (w, describe) => (w.error ? `last read failed: ${w.error.message}` : describe(w.value));

// ---- projector (ADCP) ------------------------------------------------------

const isErr = (reply) => /^err/i.test(reply);

export async function projectorPower(ctx, on) {
  const { adcp, timing } = ctx;
  const status = async () => (await adcp.send('power_status ?')).toLowerCase();
  const target = on ? 'on' : 'standby';
  // Transitional states: startup (towards on), cooling* (towards standby).
  const heading = (ps) => (on ? ps.startsWith('startup') : ps.includes('cooling'));
  let ps = await status();
  if (ps === target) return { outcome: 'already', detail: `power_status ${ps}` };
  if (!heading(ps)) {
    const r = await adcp.send(on ? 'power "on"' : 'power "off"');
    if (isErr(r)) {
      ps = await status();
      if (ps !== target && !heading(ps)) throw new Error(`projector replied ${r} (power_status ${ps})`);
    }
  }
  const w = await waitFor(status, (v) => v === target, { timeoutMs: timing.projectorMs, pollMs: timing.pollMs });
  if (!w.ok) throw new Error(`not ${target} after ${timing.projectorMs} ms (${lastSeen(w, (v) => `power_status ${v}`)})`);
  return { outcome: 'reached', detail: `power_status ${w.value}` };
}

// ---- screen (SwitchBot IR) -------------------------------------------------

export async function screenButton(ctx, button) {
  await ctx.switchbot.pressButton(ctx.config.screen.deviceId, button);
  // The cloud accepted it; whether the IR reached the screen cannot be read.
  return { outcome: 'accepted', detail: `SwitchBot accepted "${button}"` };
}

// ---- shutter (Somfy gateway, RTS) ---------------------------------------------

export async function shutterCommand(ctx, name) {
  const { somfy, timing, config } = ctx;
  const r = await somfy.command(config.shutter.deviceURL, name, { acceptMs: timing.shutterAcceptMs });
  // RTS is one-way: the gateway's later COMPLETED is a fixed timer (~30 s), not arrival.
  return { outcome: 'accepted', detail: `Somfy gateway transmitting "${name}" (${r.state}); RTS reports no position` };
}

// ---- AVR (Denon, main zone only) -------------------------------------------

export async function avrPower(ctx, on) {
  const { denon, timing } = ctx;
  let s = await denon.status();
  const isOn = (v) => v.power === 'ON';
  if (isOn(s) === on) return { outcome: 'already', detail: `main zone ${s.power}` };
  await denon.setMainZonePower(on);
  const w = await waitFor(() => denon.status(), (v) => isOn(v) === on, { timeoutMs: timing.avrPowerMs, pollMs: timing.pollMs });
  if (!w.ok) throw new Error(`main zone not ${on ? 'ON' : 'off'} after ${timing.avrPowerMs} ms (${lastSeen(w, (v) => `main zone ${v?.power}`)})`);
  if (on) ctx.avrPoweredOnAt = Date.now();
  return { outcome: 'reached', detail: `main zone ${w.value.power}` };
}

// The HTTP status page can lag behind the AVR (seen 2026-09-25: NET for 3+
// minutes after the AVR had switched to BD), so an HTTP value that already
// equals the target is re-checked over telnet before it is believed — both for
// "already there" (else nothing would be sent) and for "reached". A telnet
// answer overrides HTTP; if telnet is unavailable, HTTP stands and the reason
// is kept in the detail.
async function readAvr(denon, code, notes) {
  const v = await denon.status();
  if (v.via !== 'http' || v.input !== code) return v;
  try {
    return { ...(await denon.telnetStatus()), via: 'telnet' };
  } catch (e) {
    notes.telnet = `telnet unavailable: ${e.message}`;
    return v;
  }
}

const viaText = (v, notes) => (v.via === 'http' ? `http; ${notes.telnet ?? v.telnetError ?? 'telnet unavailable'}` : (v.via ?? '?'));

export async function avrInput(ctx, code) {
  const { denon, timing } = ctx;
  const notes = {};
  let s = await readAvr(denon, code, notes);
  // In standby, SI<code> powers the zone on without changing the input.
  if (s.power !== 'ON') return { outcome: 'skipped', detail: `main zone is ${s.power}; input not sent` };
  if (s.input === code) return { outcome: 'already', detail: `input ${code} (read via ${viaText(s, notes)})` };
  // An AVR that was switched on moments ago may not take the selection yet.
  if (ctx.avrPoweredOnAt) {
    const wait = ctx.avrPoweredOnAt + timing.avrSettleMs - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await denon.selectInput(code);
  const w = await waitFor(() => readAvr(denon, code, notes), (v) => v.input === code, { timeoutMs: timing.avrInputMs, pollMs: timing.pollMs });
  if (!w.ok) throw new Error(`input not ${code} after ${timing.avrInputMs} ms (${lastSeen(w, (v) => `input ${v?.input} via ${v?.via ?? '?'}`)})`);
  return { outcome: 'reached', detail: `input ${code} (read via ${viaText(w.value, notes)})` };
}

// ---- recorder (Sony BDZ over LAN) --------------------------------------------

const ON = 'PowerOn';
const INTERNAL = 'PowerInternalOn';
// Seen right after POWER switched it off (2026-09-25): PowerTransingInternalOn,
// on the way to PowerInternalOn. Transitional values are waited through.

export async function recorderPower(ctx, on) {
  const { bdz, timing } = ctx;
  let s = await bdz.playStatus();

  if (!s) {
    // No answer: standby (still answers SSDP as Telepathy) or unreachable.
    if (!(await bdz.isInStandby())) throw new Error('recorder does not answer (not even SSDP): unreachable or unplugged');
    if (!on) return { outcome: 'already', detail: 'standby' };
    await bdz.wake();
    const w = await waitFor(() => bdz.playStatus(), (v) => !!v, { timeoutMs: timing.recorderWakeMs, pollMs: timing.pollMs });
    if (!w.ok) throw new Error(`no answer ${timing.recorderWakeMs} ms after Wake-on-LAN`);
    s = w.value;
  }

  if (on) {
    if (s.power === ON) return { outcome: 'already', detail: ON };
    if (s.power !== INTERNAL) return { outcome: 'skipped', detail: `unknown powerstatus ${s.power}; POWER (a toggle) not sent` };
  } else {
    // Switching off while recording is fine on this recorder (it keeps
    // recording in standby; user, 2026-09-26), so reservations are not checked.
    if (s.power === INTERNAL) return { outcome: 'already', detail: INTERNAL };
    if (s.power !== ON) return { outcome: 'skipped', detail: `unknown powerstatus ${s.power}; POWER (a toggle) not sent` };
  }

  await bdz.pressPower();
  // Off is reached at PowerInternalOn (or silence: already back in standby).
  const want = (v) => (on ? v?.power === ON : !v || v.power === INTERNAL);
  const w = await waitFor(() => bdz.playStatus(), want, { timeoutMs: timing.recorderPowerMs, pollMs: timing.pollMs });
  if (!w.ok) throw new Error(`powerstatus not ${on ? ON : 'off'} after ${timing.recorderPowerMs} ms (${lastSeen(w, (v) => `powerstatus ${v?.power ?? 'no answer'}`)})`);
  return { outcome: 'reached', detail: w.value ? w.value.power : 'no answer (standby)' };
}
