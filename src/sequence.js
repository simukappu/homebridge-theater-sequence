// Runs the start/stop sequences one step at a time. Only one sequence runs at
// a time (a request while one is running is refused). A failed step is
// recorded and the sequence continues; steps that depend on an earlier one
// check the device state themselves (e.g. the AVR input needs the zone on).
//
// A step written with a trailing "&" (e.g. "projector-on&") is started and the
// sequence moves on without waiting for it; its arrival is still confirmed,
// and the sequence finishes only when it has. Results keep the written order.

import fs from 'node:fs';

import { avrInput, avrPower, projectorPower, recorderPower, screenButton } from './steps.js';

export const STEPS = {
  'screen-down': (ctx) => screenButton(ctx, ctx.config.screen.downButton),
  'screen-up': (ctx) => screenButton(ctx, ctx.config.screen.upButton),
  'projector-on': (ctx) => projectorPower(ctx, true),
  'projector-off': (ctx) => projectorPower(ctx, false),
  'avr-on': (ctx) => avrPower(ctx, true),
  'avr-off': (ctx) => avrPower(ctx, false),
  'avr-input': (ctx) => avrInput(ctx, ctx.config.avr.inputCode),
  'recorder-on': (ctx) => recorderPower(ctx, true),
  'recorder-off': (ctx) => recorderPower(ctx, false),
};

// Order decided on 2026-09-25 (shutters are not part of it yet). The screen
// goes first both ways: it is the most visible sign the sequence was accepted,
// and it no longer waits behind the projector's cool-down. On start, the AVR
// and recorder need not wait for the projector's ~20 s warm-up (2026-09-26).
export const DEFAULT_SEQUENCES = {
  start: ['screen-down', 'projector-on&', 'avr-on', 'recorder-on', 'avr-input'],
  stop: ['screen-up', 'recorder-off', 'avr-off', 'projector-off'],
};

// "projector-on&" -> { step: 'projector-on', wait: false }
export function parseStep(written) {
  const wait = !written.endsWith('&');
  return { step: wait ? written : written.slice(0, -1), wait };
}

export class BusyError extends Error {
  constructor(running) {
    super(`the "${running}" sequence is still running`);
    this.name = 'BusyError';
  }
}

export class SequenceRunner {
  constructor({ log, drivers, config, timing, sequences = DEFAULT_SEQUENCES, resultFile }) {
    this.log = log;
    this.drivers = drivers;
    this.config = config;
    this.timing = timing;
    this.sequences = sequences;
    this.resultFile = resultFile;
    this.running = null; // { name, promise }
    for (const [name, steps] of Object.entries(sequences)) {
      for (const s of steps) if (!STEPS[parseStep(s).step]) throw new Error(`sequence "${name}": unknown step "${s}"`);
    }
  }

  // Starts a sequence and returns as soon as it is accepted; the returned
  // `done` promise resolves with the result once every step has finished.
  // `source` (e.g. "Matter", "HomeKit") is only recorded, to tell which side pressed.
  request(name, source = 'unknown') {
    if (!this.sequences[name]) throw new Error(`unknown sequence "${name}"`);
    if (this.running) throw new BusyError(this.running.name);
    const done = this.run(name, source).finally(() => { this.running = null; });
    this.running = { name, promise: done };
    return { done };
  }

  async run(name, source) {
    const ctx = { ...this.drivers, config: this.config, timing: this.timing };
    const startedAt = new Date();
    this.log.info(`Sequence "${name}" started via ${source}: ${this.sequences[name].join(' → ')}`);
    const steps = [];
    const background = [];
    for (const [i, written] of this.sequences[name].entries()) {
      const { step, wait } = parseStep(written);
      const t0 = Date.now();
      const running = Promise.resolve()
        .then(() => STEPS[step](ctx))
        .catch((e) => ({ outcome: 'failed', detail: e.message }))
        .then((r) => {
          const entry = { step, ...(wait ? {} : { background: true }), ...r, ms: Date.now() - t0 };
          steps[i] = entry;
          const line = `  ${step}${wait ? '' : ' (background)'}: ${entry.outcome} in ${entry.ms} ms — ${entry.detail}`;
          if (entry.outcome === 'failed') this.log.warn(line);
          else this.log.info(line);
        });
      if (wait) await running;
      else background.push(running);
    }
    await Promise.all(background);
    const failed = steps.filter((s) => s.outcome === 'failed').length;
    const skipped = steps.filter((s) => s.outcome === 'skipped').length;
    const result = { sequence: name, source, startedAt: startedAt.toISOString(), ms: Date.now() - startedAt.getTime(), ok: failed === 0, failed, skipped, steps };
    const summary = `Sequence "${name}" finished in ${result.ms} ms: ${failed} failed, ${skipped} skipped.`;
    if (failed) this.log.warn(summary);
    else this.log.info(summary);
    if (this.resultFile) {
      try {
        fs.writeFileSync(this.resultFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      } catch (e) {
        this.log.warn(`could not write ${this.resultFile}: ${e.message}`);
      }
    }
    return result;
  }
}
