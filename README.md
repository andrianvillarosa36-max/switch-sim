# Switch Sim

A phone app for practicing networking. Build a small network of PCs, switches and routers,
cable it, give PCs IP addresses, ping between them, and configure the switches and routers
from their consoles (Cisco IOS-style commands: modes, abbreviations, `?` help, Tab completion).
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
- **Routers:** add one with **Router** (three Gigabit ports) and tap **Console**. Interfaces start
  shut down, like the real thing.
  - Interfaces: `interface g0/0`, `ip address 192.168.1.1 255.255.255.0`, `no shutdown`,
    `description`, `shutdown`.
  - Router-on-a-stick: `interface g0/0.10`, `encapsulation dot1q 10`, `ip address ...`
    (the address is refused until the encapsulation is set, as on a real router).
  - Routing: `ip route <network> <mask> <next-hop>` (and `no ip route`), including default routes
    (`ip route 0.0.0.0 0.0.0.0 10.0.0.2`).
  - Checking: `show ip route`, `show ip interface brief`, `show ip arp`, `clear arp-cache`,
    `ping <ip>`, `show running-config`, `copy running-config startup-config`, `reload`.
- **RIP:** on a router, `router rip` opens the RIP mode: `version 2`, `network 10.0.0.0`
  (any address is turned into its classful network), `passive-interface g0/0`,
  `no auto-summary`, `no router rip`. Check it with `show ip route` (RIP routes are `R`,
  distance 120, metric = hop count) and `show ip protocols`.
- **Watch the packets:** after a `ping` on a PC or router, tap **Watch** (or **Replay** on the
  canvas). The player steps through the traffic one cable hop at a time: ARP requests
  flooding out of a switch, the switch learning a MAC address, VLAN-tagged frames on trunks,
  routers forwarding with TTL counting down, and where a packet gets dropped and why.
  Use **Play/Pause**, **Back/Next** to step, and **1x** to change the speed (0.5x, 1x, 2x).
  Colours: amber is ARP, blue a ping request, green a reply, red an error; a lavender
  outline means the frame is VLAN-tagged.
- **On the canvas:** trunk links are drawn in lavender, shut-down links are red and dashed,
  and an access port in a non-default VLAN shows it (`Fa0/1 v10`).

VLAN lab: two switches (SW1, SW2), a PC on each, both PCs `192.168.1.x`. On each switch put
`fa0/1` in VLAN 10 (`interface fa0/1`, `switchport mode access`, `switchport access vlan 10`).
Ping fails across the plain cable, because VLAN 10 does not leave the switch. On SW1 set the
uplink to `switchport mode trunk` and the ping works (SW2's default dynamic auto port negotiates
a trunk). Then try `switchport trunk allowed vlan 20` on the trunk, or a different native VLAN
on each side, and see what breaks.

Routing labs:
1. *One router:* PC1 `192.168.1.10` and PC2 `192.168.2.10`, each cabled to a router. Give the router
   `192.168.1.1/24` on `g0/0` and `192.168.2.1/24` on `g0/1` (`no shutdown` on both), set each PC's
   default gateway to its router address, then ping across. The reply TTL is 127.
2. *Two routers:* PC1 - R1 - R2 - PC2 with `10.0.0.0/30` between the routers. Ping fails with
   "Destination host unreachable" until R1 has a route to PC2's network. Add only that route and
   the ping times out instead, because R2 has no route back. Add `ip route 192.168.1.0 255.255.255.0
   10.0.0.1` on R2 and it works (TTL 126).
3. *Inter-VLAN routing:* the VLAN lab above, plus a router cabled to the switch's trunk port, with
   subinterfaces `g0/0.10` and `g0/0.20` using `encapsulation dot1q`. Do not forget
   `no shutdown` on `g0/0` itself.

RIP lab: take the *two routers* lab and enable RIP instead of typing static routes: on each
router `router rip`, `version 2`, then a `network` line for every network it should advertise
(for example `10.0.0.0` and `192.168.1.0`). Add a third router and `show ip route` shows metrics
growing with hops. Try `passive-interface` on one side, or shut an interface, and watch the
routes disappear; with two paths between routers, shut one and see RIP fail over.

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
- Routers: each is a Layer 3 hop. They answer ARP for their own addresses, pick the longest
  matching prefix (connected beats static on a tie), decrement TTL, and ARP for the next hop.
  A static route is only used when its next hop is on a connected network. A router with no route
  sends back "Destination host unreachable". A router ping loses its first echo while ARP resolves
  the next hop (`.!!!!`), as real routers do. A routing loop ends quietly after a bounded number of
  hops rather than counting down TTL.
- RIP: neighbours are found by delivering a real multicast frame, so VLANs, trunks and shut
  ports affect adjacency. The simulator converges instantly (no 30-second timers), uses hop
  count with 16 as unreachable, applies split horizon, and prefers connected, then static (1),
  then RIP (120). `version 1` is accepted but updates always carry masks (like version 2), and
  `auto-summary` is accepted but not simulated.
- The animation replays the last console command's traffic: events are recorded as the
  simulator works, then played back by distance in cable hops. It is not saved.
- Not yet: OSPF/EIGRP, DHCP, ACLs and NAT, switch management IPs (`interface vlan 1`), spanning tree,
  VTP, `show interfaces <port> switchport`.

## How it is built

- `app/src/main/assets/` is the actual app, plain HTML/JS:
  - `engine.js` the simulated IOS switch (one instance per switch): modes, VLAN database, ports
  - `netsim.js` IP rules, per-VLAN switching (access, trunk, negotiation), ARP, routing, RIP,
    ping, and the event trace behind the animation
  - `pcshell.js` the PC command prompt
  - `router.js` the simulated IOS router
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
git commit -m "Packet animation and RIP"
git push
```

Then open the repo's **Actions** tab, wait for **Build APK**, and download
`SwitchSim-debug-apk` from the Artifacts. Installing over the old app keeps your saved
topology and switch configurations.

## Develop faster (no APK needed)

```sh
cd app/src/main/assets
python -m http.server 8080                 # open http://localhost:8080 in the phone browser
cd ../../../.. && for t in engine network netsim vlan router trace rip; do node tests/$t.test.js; done
```

## Roadmap

1. Topology canvas (done)
2. PCs with IP settings and ping through switches with MAC learning (done)
3. VLANs and trunks that actually affect traffic (done)
4. Routers, static routes, inter-VLAN routing (done)
5. Packet animation (done), then saved topologies and labs that check the whole network

## App icon

The launcher icon (a switch with a lavender trunk cable) is an adaptive icon for Android 8+ with
PNG fallbacks for older versions. `icon-512.png` in the project root is a 512px copy you can use
as the GitHub repository picture.

## Notes

- The `enable secret` hash in `show running-config` is simulated, not a real hash.
- Topology and configurations are saved in the WebView's local storage. ARP caches and MAC
  tables are not saved (like a power cycle).
- Switch table output is spaced a little tighter than a real switch so it fits a phone screen.
- The debug APK is signed with a debug key, which is fine for your own phone.
