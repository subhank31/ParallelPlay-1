# Parallel Playout

Two Macs play the same local file. This Mac is the control surface. The picture is shown by a native AVPlayer window, not in the control page.

```bash
npm start
```

The packaged app is `dist/Parallel Playout.dmg`.

## Roles

The same app is Master or Slave. The choice is stored in `~/Library/Application Support/Parallel Playout/`. `PLAYOUT_ROLE=master` or `PLAYOUT_ROLE=slave` overrides it for one launch.

The slave listens on `0.0.0.0:47631`. The **Master always initiates** the TCP connection and pairing; the Slave only listens and shows Accept/Reject. Commands are JSON lines over TCP (not TLS or WebSocket). Each Mac keeps its own copy of the media; the Master sends relative paths and playlist metadata so the Slave can find matching files locally.

## What the controls do

Open a file on each Mac. The file stays on that Mac. Play, pause, stop, seek, and rate on the master are mirrored to the paired slave.

Pause sends the master’s position. The slave keeps the file it already has loaded and pauses there. If the slave is more than 50 ms away, it seeks first. Play resumes from that position. Stop returns the current item to 00:00 on both machines. Play after stop starts from the beginning.

Sync clock measures the offset between the two machines. It does not start both pictures on the same frame. Schedule playback asks the slave to press play about one second later.

## Layout

| Path                                  | Role                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `main.js`, `preload.js`, `index.html` | Electron window and operator UI                                |
| `player-session.js`, `player-ipc.js`  | Local AVPlayer helper                                          |
| `native/PlayoutEngine/`               | Swift AVPlayer process                                         |
| `link/`                               | Master/slave commands, pairing, clock estimate, scheduled play |
