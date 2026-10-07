# homebridge-theater-sequence

Runs a home theater's **start** and **stop** sequences on the Homebridge host instead of in a voice-assistant routine, and **confirms each step** where the device can report it. Two buttons trigger them — published both as **Matter** On/Off Plug-in Units (e.g. for Alexa) and as **HomeKit** switches (iPhone Home app, Siri). Whichever is pressed, one shared runner executes the sequence once.

Built for one specific setup; the device drivers are small and self-contained:

| Step | Device | Sent | Confirmed by |
|---|---|---|---|
| `projector-on` / `-off` | Sony VPL-XW5000 (ADCP, TCP 53595) | `power "on"` / `power "off"` | `power_status ?` reaching `on` / `standby` |
| `screen-down` / `-up` | Screen via SwitchBot IR ("Others" remote, OpenAPI `customize`) | the learned button | — (IR has no feedback: cloud acceptance only) |
| `avr-on` / `-off` | Denon AVC-X6700H (HTTP 8080, main zone only) | `ZMON` / `ZMOFF` | status `Power` |
| `avr-input` | same | `SI<code>` (direct, never stepping through inputs) | status `InputFuncSelect` |
| `recorder-on` / `-off` | Sony BDZ-FBW2100 (UPnP on the LAN) | Wake-on-LAN, then `X_InputRemoteKey POWER` | `X_GetPlayStatus` `powerstatus` |

Default order — start: `screen-down → projector-on& → avr-on → recorder-on → avr-input` (a trailing `&` starts the step and moves on without waiting for its arrival, which is still confirmed before the sequence ends); stop: `screen-up → recorder-off → avr-off → projector-off` (the screen goes first both ways: it is the most visible sign the sequence was accepted) (overridable with `sequences`).

## Scope and support

This is a reference implementation, built for one specific setup: the devices in the table above, on one home network. It is shared as is and comes with no support; issues and pull requests may go unanswered. If your setup differs, a fork with your own drivers is the expected way to use it.

Use it only with devices you own. It sends power and input commands to devices on the local network, and to the SwitchBot cloud with your own credentials.

## Rules

- **Read first, send at most once, never retry.** A step already at its target sends nothing (`already`). Arrival is polled with a per-step timeout.
- **Toggles are only sent when the state is known.** The recorder's `POWER` key is a toggle (that is what TV SideView sends for both on and off), so it is sent only after reading `powerstatus`.
- **The AVR input is never sent in standby**: on the AVC-X6700H that powers the zone on without changing the input.
- **A failed step does not stop the sequence**; it is recorded, and later steps check their own preconditions.
- **One sequence at a time.** A press while one runs is refused (Matter `Busy`, HomeKit `RESOURCE_BUSY`).
- **The button answers when the sequence is accepted**, not when it ends (a sequence takes 10–60 s, longer than controllers wait). Results: log lines per step and `theater-sequence-last.json` in the Homebridge storage directory. Step outcomes: `reached`, `already`, `accepted` (IR), `skipped`, `failed`.

## Setup

Secrets live in owner-only files (`chmod 600`), not in `config.json`:

```bash
mkdir -p ~/.config/theater-sequence && chmod 700 ~/.config/theater-sequence
(umask 077; ${EDITOR:-nano} ~/.config/theater-sequence/adcp.json)         # {"password": "..."}
# SwitchBot: ~/.config/switchbot-ir/credentials.json  {"token": "...", "secret": "..."}
```

```json
{
  "platform": "TheaterSequence",
  "name": "Theater",
  "startName": "Theater Start",
  "stopName": "Theater Stop",
  "projector": { "host": "192.168.1.50" },
  "screen": { "deviceId": "02-XXXXXXXXXXXX-XXXXXXXX", "downButton": "Down", "upButton": "Up" },
  "avr": { "host": "192.168.1.60", "inputCode": "BD" },
  "recorder": { "host": "192.168.1.70", "mac": "xx:xx:xx:xx:xx:xx", "broadcast": "192.168.1.255" },
  "_bridge": { "username": "…", "port": 51236, "matter": { "port": 5533 } }
}
```

Run it on its own child bridge with Matter enabled; pair the child bridge's Matter code with Alexa and its HomeKit code with the Home app. Optional: `homekit: false`, `timing` (ms: `projectorMs`, `avrPowerMs`, `avrSettleMs`, `avrInputMs`, `recorderWakeMs`, `recorderPowerMs`, `pollMs`), `resetMs`.

## Development

No runtime dependencies. `npm test` covers the drivers, every step against fakes that reproduce the measured device behavior, and the Matter/HomeKit wiring with the real hap-nodejs (dev dependency: `homebridge`).

## License

MIT. `src/drivers/adcp-client.js` is ported from [homebridge-sony-adcp](https://github.com/keremerkan/homebridge-sony-adcp) (MIT) — see `THIRD_PARTY_NOTICES.md`.
