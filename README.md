# Switch Sim

A phone app for practicing networking. Build a small network, cable it, give PCs IP
addresses, ping between them through switches, and configure the switches from their
consoles (Cisco IOS-style commands: modes, abbreviations, `?` help, Tab completion).
Works offline.

## Using it

- **Add devices:** tap **Switch** or **PC**. Drag to move, drag the background to pan,
  pinch to zoom, **Fit** to see everything, **Clear** to start over.
- **Cable them:** tap **Cable**, then two devices. Ports are picked automatically
  (`Fa0/1`, `Fa0/2`, ... on switches, `Fa0` on PCs). Tap a cable to delete it.
- **PCs:** select one and tap **Open** (or double-tap it).
  - *Settings*: IP address, subnet mask (left empty, it defaults from the address) and
    default gateway.
  - *Prompt*: `ipconfig` (`/all` for the MAC), `ping <ip>` (`-n count` too), `arp -a`, `arp -d`, `help`.
- **Switches:** select one and tap **Console** (or double-tap it). Besides the basics
  (`enable`, `configure terminal`, `hostname`, `enable secret`, `copy running-config
  startup-config`, `reload`), there are now `show mac address-table`,
  `show interfaces status` and `clear mac address-table dynamic`.

Try it: add two PCs and a switch, cable PC1 to the switch and PC2 to the switch, give them
`192.168.1.10` and `192.168.1.20`, then `ping 192.168.1.20` from PC1. The first reply is slower
because of ARP. Open the switch and run `show mac address-table` to see it learned both PCs.
Run `clear mac address-table dynamic`, ping again, and watch it relearn.

## What is simulated

- Switches learn source MAC addresses per port, forward known unicast out one port, and flood
  broadcasts and unknown unicast. The table is lost on `reload`, and entries for a port are
  forgotten when its cable is removed.
- PCs use ARP, then ICMP echo. Different subnet with no gateway gives "Destination host
  unreachable"; with a gateway but no router, requests time out (routers arrive in stage 4).
- A frame is handled once per switch, so a cable loop cannot flood forever. There is no
  spanning tree.
- Not yet: VLANs, trunks, port shutdown, routers.

## How it is built

- `app/src/main/assets/` is the actual app, plain HTML/JS:
  - `engine.js` the simulated IOS switch (one instance per switch)
  - `netsim.js` IP rules, MAC learning and flooding, ARP, ping
  - `pcshell.js` the PC command prompt
  - `network.js` devices, ports, cables, PC settings (no drawing code)
  - `topology.js` the canvas: drawing, touch gestures, cable mode, selection bar
  - `terminal.js` the console component shared by switches and PCs
  - `app.js`, `index.html`, `style.css`
- `app/src/main/java/.../MainActivity.java` is a thin Android WebView around those files.
- `.github/workflows/build.yml` runs the tests, then builds a debug APK.

## Update your existing repo from Termux

```sh
cd ~
rm -rf ~/switch-sim-new && mkdir ~/switch-sim-new
unzip -o ~/storage/downloads/switch-sim.zip -d ~/switch-sim-new
cp -r ~/switch-sim-new/switch-sim/. ~/switch-sim/
rm -f ~/switch-sim/app/src/main/assets/lesson1.js      # the lesson was removed
cd ~/switch-sim
git add -A
git commit -m "Stage 2: PC addressing and ping"
git push
```

Then open the repo's **Actions** tab, wait for **Build APK**, and download
`SwitchSim-debug-apk` from the Artifacts. Installing over the old app keeps your saved
topology and switch configurations.

## Develop faster (no APK needed)

```sh
cd app/src/main/assets
python -m http.server 8080                 # open http://localhost:8080 in the phone browser
cd ../../../.. && for t in engine network netsim; do node tests/$t.test.js; done
```

## Roadmap

1. Topology canvas (done)
2. PCs with IP settings and ping through switches with MAC learning (done)
3. VLANs and trunks (`vlan`, `switchport mode`, `show vlan brief`) that actually affect traffic
4. Routers, static routes, inter-VLAN routing
5. Packet animation, saved topologies, labs that check the whole network

## Notes

- The `enable secret` hash in `show running-config` is simulated, not a real hash.
- Topology and configurations are saved in the WebView's local storage. ARP caches and MAC
  tables are not saved (like a power cycle).
- Switch table output is spaced a little tighter than a real switch so it fits a phone screen.
- The debug APK is signed with a debug key, which is fine for your own phone.
