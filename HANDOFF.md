# Parallel Playout — handoff

This file is for the next engineer.

## Resolution (9 Oct 2026)

Both problems below are explained. The sections after this one are the original investigation notes.

**Handshake failure: the Slave app was not code signed.** The installed build had only the linker's signature on its executable (`codesign -dv` showed `flags=0x20002(adhoc,linker-signed)`, `Info.plist=not bound`, `Sealed Resources=none`). macOS Application Firewall needs a designated requirement to apply its rules. Without one it drops every inbound flow, even though the app is listed as "Allow incoming connections". The unified log on 184 showed:

```text
socketfilterfw  … code object is not signed at all
socketfilterfw  Designated requirement not obtained for flow, dropping flow
kernel          CFIL: VERDICT DROP RECEIVED … lport 47631
```

After `codesign --force --deep --sign -` on the installed app and clicking Allow at the firewall prompt, 184 answered hello with `needsPairing` and logged `first bytes` from the Master.

- The build signs ad-hoc (`"identity": "-"`). `scripts/verify-signature.js` runs as `afterSign` and fails the build if the bundle has no full signature or designated requirement.
- An ad-hoc signature changes with every build, so macOS asks again whether to allow incoming connections after each new install on the Slave. Click Allow. To stop that, sign with a stable certificate (Developer ID, or a self-signed code-signing certificate) by setting `build.mac.identity` to its name.
- The Slave UI now shows a banner, and the log says so, when the firewall is on and the app is not signed.

**Restart every ~61 s: a LaunchAgent outside this repo.** `~/Library/LaunchAgents/com.srisathyasai.parallelplayout.slave.plist` on 184 (created 8 Oct 16:06) ran `killall -9 "Parallel Playout" PlayoutEngine; sleep 1; open -n -a …` every 60 s (`StartInterval 60`). SIGKILL is why no quit line was logged. Do not reinstall it.

## What the app is

Sri Sathya Sai Parallel Playout. Two Macs play the same local media file in sync.

- The Electron window is the control surface only. The picture is a separate native AVPlayer process (`PlayoutEngine`), not a `<video>` tag.
- The same app is either Master or Slave. The role is stored in `~/Library/Application Support/Parallel Playout/config.json`. `PLAYOUT_ROLE=master` or `PLAYOUT_ROLE=slave` overrides one launch.
- Each Mac keeps its own copy of the media. The Master sends a relative path (and name/size fallback). The Slave resolves the file locally.
- Repo: `/Users/subhank/Documents/Parallel Play`
- Packaged app: `dist/Parallel Playout.dmg`, installed at `/Applications/Parallel Playout.app`
- Dev machine (often Master): `192.168.127.222`, user `subhank`
- Other machine (often Slave): `192.168.127.184`, user `studioadmin`
- Do not use `192.168.127.185`.
- Log on each Mac: `~/Library/Application Support/Parallel Playout/logs/parallel-playout.log`
- A copy of the Slave log is at `/Volumes/1431/Subhank Shares/parallel-playout.log`

Build:

```bash
cd "/Users/subhank/Documents/Parallel Play" && npm run build:dmg && chgrp -R staff dist && chmod -R g+rwX dist
```

`npm start` runs Electron from source. The Slave log above is from the **installed** app, not from `npm start`.

## Layout

| Path | Role |
| --- | --- |
| `main.js`, `preload.js`, `index.html` | Electron window and operator UI |
| `player-session.js`, `player-ipc.js` | Spawns and talks to the AVPlayer helper |
| `native/PlayoutEngine/` | Swift AVPlayer process. Do not change playback behavior. |
| `link/protocol.js` | JSON line codec and command names |
| `link/master-client.js` | Master TCP client |
| `link/slave-server.js` | Slave TCP server |
| `link/link-controller.js` | Roles, pairing, retry, reconnect |
| `link/clock-sync.js`, `link/scheduled-command.js` | Clock offset and scheduled play. Do not change the formulas. |
| `link/firewall.js` | Reads macOS Application Firewall state |

## Protocol (this is the real wire format)

Plain TCP. Newline-delimited JSON. **Not TLS. Not WebSocket.** Port **47631**. The Slave listens on `0.0.0.0:47631`. The Master always connects. The Slave never sends the first hello.

1. Master `net.connect` to `host:47631`.
2. Master writes one line: `JSON.stringify({ type, requestId, payload }) + "\n"`.
   First message is `type: "hello"` with `deviceId`, `deviceName`, `role: "master"`, `port`.
3. Slave reads a line, parses it, and writes a `type: "response"` line.
   If the Master is not paired yet, the payload is `{ authorized: false, paired: false, needsPairing: true, ... }`.
4. Master then writes `type: "pairRequest"`.
5. Slave shows an **in-app** Accept/Reject popup (Electron IPC `pair-request`). No macOS notification and no external prompt.
6. Accept stores the pairing and returns `{ accepted: true }`. Reject returns `PAIR_REJECTED` and closes that socket.
7. After pairing, playback commands (`load`, `play`, `pause`, `stop`, `seek`, `setRate`, …) and `timeSync` / `scheduledPlay` / `sessionSync` require the paired device id.

`encode()` is `JSON.stringify(message) + "\n"` in `link/protocol.js`. Both sides use Node `readline` on the socket.

Master retry while Request Connection is in progress: `link/link-controller.js` `_requestUntilPaired`. The delay grows and then stays at **5 seconds**. That is why the Slave log shows a new TCP connection about every 5 seconds.

## The failure (proven)

Direction that fails: **222 Master → 184 Slave**. The opposite direction has worked before. Loopback and a SlaveServer on 222 answering its own LAN IP both complete hello.

Live probe from 222 to `192.168.127.184:47631` (9 Oct 2026):

- TCP connect succeeded in about 1.5 ms. The client’s peer name was `192.168.127.184:47631`.
- The client wrote a hello line (about 117–134 bytes).
- The Slave sent **0 bytes** back and closed the socket (orderly FIN, `SO_ERROR = 0`) in about 10–12 ms.
- An idle connect that sent nothing was also closed by the Slave in about 12 ms.
- The same hello against `SlaveServer` on 222 returned `needsPairing` JSON.

So the Master **does** write hello. The Slave process **does** accept the TCP connection. The hello never becomes a parsed line, and the Slave never writes a response.

### What the Slave log shows

Source: `/Volumes/1431/Subhank Shares/parallel-playout.log` (copied from studioadmin on 184).

Latest accepts look like this:

```text
[link] connection from unknown:? on 192.168.127.184:47631 (destroyed=false readable=true writable=true pending=false local=192.168.127.184:47631 remote=unknown:? readyState=open)
[link] connection error from unknown:?: syscall=read code=ENOTCONN (destroyed=true readable=false writable=false pending=true local=unknown:? remote=unknown:? readyState=closed)
[link] read error from unknown:?: ENOTCONN
[link] connection from unknown:? ended with no application data after 4 ms (socket error: read ENOTCONN)
```

Facts in that block:

- The listen socket is the Slave app. Local address is `192.168.127.184:47631`.
- At accept, Node reports `readyState=open`, readable, writable, `pending=false`.
- `remoteAddress` / `remotePort` are missing (`unknown:?`). `getpeername` returned nothing.
- 2–6 ms later the failing operation is **`read`**, errno **`ENOTCONN`**.
- Node then destroys the socket. The close reason is set by the error handler (`socket error: read ENOTCONN`), not by an earlier `destroy()` / `end()` in our pairing code.
- No `first bytes` line. `_handleHello` never runs. Accept/Reject never appears.
- The same pattern is in the log from **09:50 UTC**, before the later diagnostic strings. It is not caused by `pauseOnConnect` or the extra logging.

The `read error` line is readline forwarding the same socket `error` event. It is one failure, not two.

### App restart (also unsolved)

`[app] started` is written only from `app.whenReady` in `main.js` after `requestSingleInstanceLock()` succeeds. A second launch of an already-running app does **not** log that line. It logs `second instance launch` and focuses the existing window.

In the Slave log the process is replaced on a metronome of about **61.2 seconds**, for most of 09:49–10:35 UTC. Examples:

```text
10:31:07.465 pid 6707
10:32:08.674 pid 6755
10:33:09.888 pid 6802
10:34:11.072 pid 6831
10:35:12.256 pid 6866
```

There is no crash stack, no `[app] kept running after an error`, and no `second instance` line before these starts. `ENOTCONN` continues for the whole life of one pid, then a new pid appears. The socket errors do not quit the process. Nothing in this repo calls `app.relaunch()` or schedules a 60 second restart. `window-all-closed` does not quit on macOS.

A JavaScript exception is caught in `main.js` and logged as `[app] kept running after an error`. A native crash or `SIGKILL` would produce a new `[app] started` with no quit line. Signal logging (`[app] received SIGTERM` / `[app] quit requested`) was added later and is **not** in the log file above.

The picture window is a different process (`PlayoutEngine`). If only that helper crashes, `player-session.js` restarts it after 400 ms and the log shows `[PlayoutEngine]`, not a new `[app] started`. That is not what this log shows.

## What was already ruled out

- TLS vs plaintext mismatch. Both sides are raw TCP + JSON lines.
- Master never writing hello. A live `MasterClient` from 222 logged `master write hello` and then `DISCONNECTED` with 0 response bytes.
- Slave refusing the JSON schema. The line never arrives at the parser.
- Stale `this.client` on the 5 second retry. The first connection after a fresh `[app] started` fails the same way.
- Hello handshake on this Mac. `node scripts/test-hello-handshake.js` passes (4/4). `test-slave-close.js`, `test-reconnect.js`, and `test-connection-flow.js` have passed here. Those tests use `127.0.0.1`. They do not reproduce 184.
- Immediate TCP RST in a local Electron 44 (Node 24) test. That produces `ECONNRESET` / `read`, and often an empty peer name. The Slave log is `ENOTCONN` / `read`, not `ECONNRESET`.
- This repo killing and relaunching the app every 61 seconds. There is no such timer.

## Code path on the Slave

`link/slave-server.js`

1. `net.createServer({ pauseOnConnect: true })` listens on `0.0.0.0`.
2. `_onConnection` logs the peer (`link/peer.js` uses `socket._getpeername()`, then `remoteAddress`).
3. `_acceptConnection` calls `setKeepAlive`, `setNoDelay`, creates a readline interface, then `socket.resume()`.
4. Readline starts `read()`.
5. `read()` returns `ENOTCONN`. Node destroys the socket (`ErrnoException` syscall `read`).
6. The error handler sets `closeReason`. The close log says `no application data`.

`link/master-client.js` `connect()` then `request('hello', …)` writes the line only after the `connect` event. That write is happening (see the live probe).

`link/link-controller.js` `_connectAndAuthorize` sends hello, then pairRequest only if hello returns `needsPairing`. It never gets that far against 184.

## Constraints

- Keep pairing. Unknown masters may only send `hello` and `pairRequest`. Playback commands require Accept.
- Keep the in-app Accept/Reject UI.
- Do not change playback, pause/resume, media matching, or clock-sync math.
- Do not replace TCP with TLS, WebSocket, or another protocol.
- Success means a real hello **response** from 184 to 222, then Accept, then a ping. A green local test is not that.

## Useful checks on 184

```bash
tail -f "$HOME/Library/Application Support/Parallel Playout/logs/parallel-playout.log"
lsof -nP -iTCP:47631 -sTCP:LISTEN
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
/usr/libexec/ApplicationFirewall/socketfilterfw --getappblocked "/Applications/Parallel Playout.app"
```

From 222, while that tail is running:

```bash
printf '%s\n' '{"type":"hello","requestId":"probe1","payload":{"deviceId":"12345678","deviceName":"Probe","role":"master","port":47631}}' | nc -w 3 192.168.127.184 47631
```

A fixed Slave prints `first bytes` containing `"type":"hello"` and `nc` prints a JSON `response` line. The current Slave closes `nc` with no output.
