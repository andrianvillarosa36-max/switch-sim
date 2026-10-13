# Switch Sim

A phone app for practicing network configuration. Build a small network, cable it,
and open a console on each switch. The consoles speak Cisco IOS-style commands
(modes, abbreviations, `?` help, Tab completion). A guided lesson and quiz are included.
Works offline.

## What is in it

- **Network tab**: add switches and PCs, cable them (Cable tool), drag to move, drag the
  background to pan, pinch to zoom, double-tap a switch (or select it and tap Console) to
  open its console. Each switch has its own configuration, saved on the phone.
- **Lesson tab**: the guided Lesson 1 lab on a single practice switch, with progress LEDs.
- **Quiz tab**: questions for the lesson.

PCs can be placed and cabled but are not configurable yet (next stage: IP addresses and ping).
Cables do not change what the switch consoles do yet.

## How it is built

- `app/src/main/assets/` is the actual app, plain HTML/JS:
  - `engine.js` the simulated IOS switch (one instance per switch)
  - `network.js` devices, ports and cables (no drawing code, so it is testable)
  - `topology.js` the canvas: drawing, touch gestures, cable mode, selection bar
  - `terminal.js` the console component used by device consoles and the lesson
  - `lesson1.js`, `app.js`, `index.html`, `style.css`
- `app/src/main/java/.../MainActivity.java` is a thin Android WebView around those files.
- `.github/workflows/build.yml` runs the tests, then builds a debug APK.

## Update your existing repo from Termux

```sh
cd ~
rm -rf ~/switch-sim-new && mkdir ~/switch-sim-new
unzip -o ~/storage/downloads/switch-sim.zip -d ~/switch-sim-new
cp -r ~/switch-sim-new/switch-sim/. ~/switch-sim/
cd ~/switch-sim
git add -A
git commit -m "Network canvas"
git push
```

Then open the repo's **Actions** tab, wait for **Build APK**, and download
`SwitchSim-debug-apk` from the Artifacts. Installing over the old app keeps your saved
lesson progress.

First time setup instead? `pkg install git gh`, `gh auth login`, then
`git init -b main && git add . && git commit -m "Switch Sim" && gh repo create switch-sim --public --source=. --push`.

## Develop faster (no APK needed)

```sh
cd app/src/main/assets
python -m http.server 8080                 # open http://localhost:8080 in the phone browser
cd ../../../.. && node tests/engine.test.js && node tests/network.test.js
```

## Roadmap

1. Topology canvas (done)
2. PCs with IP settings and ping through switches (MAC learning)
3. VLANs and trunks (`vlan`, `switchport mode`, `show vlan brief`) that actually affect traffic
4. Routers, static routes, inter-VLAN routing
5. Packet animation, saved topologies, labs that check the whole network

## Notes

- The `enable secret` hash in `show running-config` is simulated, not a real hash.
- Progress and topology are saved in the WebView's local storage.
- The debug APK is signed with a debug key, which is fine for your own phone.
