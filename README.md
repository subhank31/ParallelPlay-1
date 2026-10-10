# Parallel Playout

Two Macs play the same local file. This Mac is the control surface. The picture is shown by a native AVPlayer window, not in the control page.

```bash
npm start
```

The installer is `dist/Parallel Playout.pkg` (`npm run build:pkg`). `dist/Parallel Playout.dmg` is the same app without the setup steps.

## Installing on a Mac

Use the installer for a new Mac and for every update. Copy `Parallel Playout.pkg` to the Mac and run, in Terminal:

```bash
sudo installer -pkg "Parallel Playout.pkg" -target /
```

Double-clicking the package also works. The first time, macOS says it is from an unidentified developer: open System Settings › Privacy & Security and click **Open Anyway**.

The installer:

- quits the running app and keeps the previous one as `~/ParallelPlayout-prev.zip`
- installs to `/Applications` and checks the code signature
- lets the Master through the macOS Firewall for this build (rules follow the signature, so every update adds it again)
- removes the old `com.srisathyasai.parallelplayout.*` LaunchAgent that force-quit the app every minute
- turns off system sleep and turns on restart after a power failure (`pmset`)
- opens the app, which adds itself to Login Items and keeps the displays awake while it runs

Role, pairing and media folder are kept across updates. Install log: `/Library/Logs/ParallelPlayout-install.log`.

Left for the operator, once per Mac (macOS does not allow an installer to do these):

1. Choose the role, and in Settings the **local** copy of the media folder.
2. Pair: on the Master, connect to the Slave; on the Slave, click **Accept**.
3. On the Master, allow **Local Network** access when macOS asks. If the Slave cannot be reached ("No route to host"), turn Parallel Playout on in System Settings › Privacy & Security › Local Network.
4. If the media is on an external drive, allow access when macOS asks.

Settings › System check shows anything still missing; problems also appear as a banner on every page.

## If the Master crashes

The Slave keeps playing. Its controls unlock as soon as the Master is gone (a Master that goes silent without closing the connection is dropped after 7 seconds).

When the Master app starts again, it only watches: a banner shows what the Slave is playing, its controls are locked, and nothing is sent to the Slave. Press **Sync**: the Master measures the clock offset, starts its own player at exactly the Slave's position, takes over the Slave's playlist, and is in control again. The Slave is never paused, reloaded, or moved. If the Master does not have the file, Sync still hands control back and says so.

## Roles

The same app is Master or Slave. The choice is stored in `~/Library/Application Support/Parallel Playout/`. `PLAYOUT_ROLE=master` or `PLAYOUT_ROLE=slave` overrides it for one launch.

The slave listens on `0.0.0.0:47631`. The **Master always initiates** the TCP connection and pairing; the Slave only listens and shows Accept/Reject. Commands are JSON lines over TCP (not TLS or WebSocket). Each Mac keeps its own copy of the media; the Master sends relative paths and playlist metadata so the Slave can find matching files locally.

## What the controls do

Open a file or playlist on the Master. Play, pause, stop, seek, and rate on the Master are mirrored to the paired Slave, which shows the same playlist. While the Master is connected the Slave's controls are locked.

Pause sends the master’s position. The slave keeps the file it already has loaded and pauses there. If the slave is more than 50 ms away, it seeks first. Play resumes from that position. Stop returns the current item to 00:00 on both machines. Play after stop starts from the beginning.

Sync clock measures the offset between the two machines. It does not start both pictures on the same frame. Schedule playback asks the slave to press play about one second later.

## Layout

| Path                                  | Role                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `main.js`, `preload.js`, `index.html` | Electron window and operator UI                                |
| `player-session.js`, `player-ipc.js`  | Local AVPlayer helper                                          |
| `native/PlayoutEngine/`               | Swift AVPlayer process                                         |
| `link/`                               | Master/slave commands, pairing, clock estimate, scheduled play |
