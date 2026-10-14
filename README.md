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
- **Switches:** select one and tap **Console** (or double-tap it).
  - Basics: `enable`, `configure terminal`, `hostname`, `enable secret`,
    `copy running-config startup-config`, `reload`, `show running-config`.
  - VLANs: `vlan 10` / `name Sales`, `no vlan 10`, `show vlan brief`.
  - Interfaces: `interface fa0/1`, `interface range fa0/1 - 4` (also `fa0/1-4`, `fa0/1 - fa0/4`,
    comma lists), `description`, `shutdown` / `no shutdown`, and global commands still work from
    inside an interface or VLAN, as on a real switch.
  - Switchports: `switchport mode access | trunk | dynamic auto | dynamic desirable`,
    `switchport access vlan 10`, `switchport trunk native vlan 99`,
    `switchport trunk allowed vlan 10,20 | add | remove | all | none`, and the `no` forms.
  - Checking: `show interfaces status`, `show interfaces trunk`, `show mac address-table`,
    `clear mac address-table dynamic`.
- **On the canvas:** trunk links are drawn in lavender, shut-down links are red and dashed,
  and an access port in a non-default VLAN shows it (`Fa0/1 v10`).

VLAN lab: two switches (SW1, SW2), a PC on each, both PCs `192.168.1.x`. On each switch put
`fa0/1` in VLAN 10 (`interface fa0/1`, `switchport mode access`, `switchport access vlan 10`).
Ping fails across the plain cable, because VLAN 10 does not leave the switch. On SW1 set the
uplink to `switchport mode trunk` and the ping works (SW2's default dynamic auto port negotiates
a trunk). Then try `switchport trunk allowed vlan 20` on the trunk, or a different native VLAN
on each side, and see what breaks.

Basic lab: add two PCs and a switch, cable PC1 to the switch and PC2 to the switch, give them
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
- VLANs: ports are access or trunk. MAC learning, forwarding and flooding are per VLAN. Trunks
  tag every VLAN except the native one, honour the allowed list, and only carry VLANs that exist
  on both ends' switches. Default ports are `dynamic auto`, and they negotiate a trunk when the
  neighbour is a trunk or `dynamic desirable` (as DTP does). PCs ignore tagged frames.
- Shutting a port brings the link down at both ends and flushes its MAC entries.
- The VLAN database is kept apart from the config, like vlan.dat: it survives `reload` and is not
  affected by `copy running-config startup-config`.
- Not yet: routers, inter-VLAN routing, switch management IPs (`interface vlan 1`), spanning tree,
  VTP, `show interfaces <port> switchport`.

## How it is built

- `app/src/main/assets/` is the actual app, plain HTML/JS:
  - `engine.js` the simulated IOS switch (one instance per switch): modes, VLAN database, ports
  - `netsim.js` IP rules, per-VLAN switching (access, trunk, negotiation), ARP, ping
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
git commit -m "Stage 3: VLANs and trunks"
git push
```

Then open the repo's **Actions** tab, wait for **Build APK**, and download
`SwitchSim-debug-apk` from the Artifacts. Installing over the old app keeps your saved
topology and switch configurations.

## Develop faster (no APK needed)

```sh
cd app/src/main/assets
python -m http.server 8080                 # open http://localhost:8080 in the phone browser
cd ../../../.. && for t in engine network netsim vlan; do node tests/$t.test.js; done
```

## Roadmap

1. Topology canvas (done)
2. PCs with IP settings and ping through switches with MAC learning (done)
3. VLANs and trunks that actually affect traffic (done)
4. Routers, static routes, inter-VLAN routing
5. Packet animation, saved topologies, labs that check the whole network

## Notes

- The `enable secret` hash in `show running-config` is simulated, not a real hash.
- Topology and configurations are saved in the WebView's local storage. ARP caches and MAC
  tables are not saved (like a power cycle).
- Switch table output is spaced a little tighter than a real switch so it fits a phone screen.
- The debug APK is signed with a debug key, which is fine for your own phone.
