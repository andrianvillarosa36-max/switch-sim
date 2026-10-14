/*
 * Simulation core (no drawing code, runs in Node tests too).
 *
 *  - IPv4 helpers and validation of a PC's address settings
 *  - Frame delivery through switches: MAC learning, forwarding, flooding
 *  - ARP and ICMP echo (ping) between PCs
 *
 * Frames are { type, src, dst, srcIp, dstIp, hops } where src/dst are MAC
 * addresses in Cisco dotted format. Everything runs synchronously: a ping
 * returns its result at once and the console paces the output.
 */
(function (root) {
  'use strict';

  var BCAST = 'ffff.ffff.ffff';
  var PC_PORT = 'FastEthernet0';

  /* ---------- IPv4 ---------- */

  // Dotted quad to unsigned number, or null.
  function parseIp(s) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
    if (!m) return null;
    var n = 0;
    for (var i = 1; i <= 4; i++) {
      var o = Number(m[i]);
      if (o > 255) return null;
      n = n * 256 + o;
    }
    return n;
  }

  function ipStr(n) {
    return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
  }

  // Number of leading 1 bits, or -1 when the mask is not contiguous.
  function maskBits(n) {
    var bits = 0, seenZero = false;
    for (var i = 31; i >= 0; i--) {
      var one = Math.floor(n / Math.pow(2, i)) % 2 === 1;
      if (one) { if (seenZero) return -1; bits++; } else { seenZero = true; }
    }
    return bits;
  }

  function networkOf(ip, mask) { return ((ip & mask) >>> 0); }
  function broadcastOf(ip, mask) { return ((ip | ~mask) >>> 0); }
  function sameSubnet(a, b, mask) { return networkOf(a, mask) === networkOf(b, mask); }

  // The classful default mask, used to pre-fill the settings form.
  function classfulMask(ipText) {
    var n = parseIp(ipText);
    if (n === null) return '';
    var first = Math.floor(n / 16777216);
    return first < 128 ? '255.0.0.0' : first < 192 ? '255.255.0.0' : '255.255.255.0';
  }

  function normalize(cfg) {
    function norm(s) { var n = parseIp(s || ''); return n === null ? '' : ipStr(n); }
    return { ip: norm(cfg.ip), mask: norm(cfg.mask), gateway: norm(cfg.gateway) };
  }

  // Returns an error message, or null when the settings are fine.
  // otherIps: addresses already used by other PCs.
  function validateConfig(cfg, otherIps) {
    var ip = String(cfg.ip || '').trim(), mask = String(cfg.mask || '').trim(), gw = String(cfg.gateway || '').trim();
    if (!ip && !mask && !gw) return null;                       // clearing the settings
    if (!ip) return 'Enter an IP address.';
    var n = parseIp(ip);
    if (n === null) return 'Enter a valid IP address, like 192.168.1.10.';
    if (!mask) return 'Enter a subnet mask, like 255.255.255.0.';
    var m = parseIp(mask), bits = m === null ? -1 : maskBits(m);
    if (bits < 8 || bits > 30) return 'Enter a valid subnet mask, like 255.255.255.0.';
    var first = Math.floor(n / 16777216);
    if (first === 0 || first === 127 || first >= 224) return 'Use a host address from 1.x.x.x to 223.x.x.x, not 127.x.x.x.';
    if (networkOf(n, m) === n) return 'That is the network address of the subnet. Use a host address.';
    if (broadcastOf(n, m) === n) return 'That is the broadcast address of the subnet. Use a host address.';
    if ((otherIps || []).indexOf(ipStr(n)) !== -1) return 'Another device already uses that IP address.';
    if (gw) {
      var g = parseIp(gw);
      if (g === null) return 'Enter a valid gateway address, or leave it empty.';
      if (g === n) return 'The gateway cannot be the same as the IP address.';
      if (!sameSubnet(n, g, m)) return 'The gateway must be in the same subnet as the IP address.';
    }
    return null;
  }

  /* ---------- switching ---------- */

  function linkAt(net, devId, port) {
    for (var i = 0; i < net.links.length; i++) {
      var l = net.links[i];
      if ((l.a.dev === devId && l.a.port === port) || (l.b.dev === devId && l.b.port === port)) return l;
    }
    return null;
  }

  function otherEnd(link, devId) { return link.a.dev === devId ? link.b : link.a; }

  function endShut(net, end) {
    var d = net.get(end.dev);
    if (!d) return false;
    if (d.type === 'switch') return !!d.sw.portCfg(end.port).shutdown;
    if (d.type === 'router') return !!d.rt.portCfg(end.port).shutdown;     // router ports start shut down
    return false;
  }

  // A cable carries a link only when neither end is administratively shut down.
  function linkUp(net, link) { return !!link && !endShut(net, link.a) && !endShut(net, link.b); }

  // Operational mode of a switch port: 'access' or 'trunk'. Dynamic modes
  // negotiate with a switch neighbour (like DTP): a dynamic port trunks when
  // the other end is a trunk, or dynamic desirable / auto toward it.
  function operMode(net, dev, port) {
    var mode = dev.sw.portCfg(port).mode;
    if (mode === 'trunk' || mode === 'access') return mode;
    var link = linkAt(net, dev.id, port);
    if (!link || !linkUp(net, link)) return 'access';
    var peer = otherEnd(link, dev.id), pd = net.get(peer.dev);
    if (!pd || pd.type !== 'switch') return 'access';
    var pm = pd.sw.portCfg(peer.port).mode;
    if (pm === 'trunk') return 'trunk';
    if (mode === 'desirable' && (pm === 'desirable' || pm === 'auto')) return 'trunk';
    if (mode === 'auto' && pm === 'desirable') return 'trunk';
    return 'access';
  }

  function findEntry(table, vlan, mac) {
    for (var i = 0; i < table.length; i++) if (table[i].mac === mac && table[i].vlan === vlan) return table[i];
    return null;
  }

  // A switch learns which port a source address lives behind, per VLAN.
  function learn(sw, vlan, mac, port) {
    if (mac === BCAST) return;
    var e = findEntry(sw.macTable, vlan, mac);
    if (e) e.port = port; else sw.macTable.push({ vlan: vlan, mac: mac, port: port });
  }

  // The VLAN a frame belongs to when it arrives, or null when it is dropped.
  function ingressVlan(net, dev, port, tagged, vid) {
    var cfg = dev.sw.portCfg(port);
    if (cfg.shutdown) return null;
    if (operMode(net, dev, port) === 'access') return tagged ? null : cfg.accessVlan;
    if (!tagged) return cfg.native;
    return dev.sw.vlanExists(vid) && sw_allows(cfg, vid) ? vid : null;
  }

  function sw_allows(cfg, vid) {
    if (cfg.allowed === 'all') return true;
    var m = root.SwitchSim.allowedMarks(cfg.allowed);
    return !!(m && m[vid]);
  }

  // Can this port send frames of this VLAN?
  function canSend(net, dev, port, vlan) {
    var link = linkAt(net, dev.id, port);
    if (!link || !linkUp(net, link)) return false;
    var cfg = dev.sw.portCfg(port);
    if (operMode(net, dev, port) === 'access') return cfg.accessVlan === vlan;
    return sw_allows(cfg, vlan);
  }

  // Which ports a switch sends a frame out of.
  function egress(net, dev, vlan, dst, ingress) {
    var cand = net.usedPorts(dev.id).filter(function (p) { return canSend(net, dev, p, vlan); });
    if (dst !== BCAST) {
      var e = findEntry(dev.sw.macTable, vlan, dst);
      if (e) return (e.port !== ingress && cand.indexOf(e.port) !== -1) ? [e.port] : [];
    }
    return cand.filter(function (p) { return p !== ingress; });   // broadcast or unknown unicast: flood the VLAN
  }

  // Put a frame on the cable at (srcDev, srcPort). Returns the PCs it reaches.
  // Each switch handles a given frame once per VLAN, so loops cannot storm
  // (there is no spanning tree yet).
  function transmit(net, srcDev, srcPort, frame, vid) {
    var first = linkAt(net, srcDev.id, srcPort);
    if (!first || !linkUp(net, first)) return [];
    var out = [], seen = {}, steps = 0;
    var queue = [{ peer: otherEnd(first, srcDev.id), hops: 0, tagged: !!vid, vid: vid || 0 }];
    while (queue.length && steps++ < 500) {
      var it = queue.shift(), d = net.get(it.peer.dev);
      if (!d) continue;
      if (d.type !== 'switch') {      // a PC or router: the frame arrives on that port
        if (d.id !== srcDev.id) out.push({ dev: d, port: it.peer.port, tagged: it.tagged, vid: it.vid, hops: it.hops });
        continue;
      }
      var vlan = ingressVlan(net, d, it.peer.port, it.tagged, it.vid);
      if (vlan === null || !d.sw.vlanExists(vlan)) continue;
      var key = d.id + ':' + vlan;
      if (seen[key]) continue;
      seen[key] = true;
      learn(d.sw, vlan, frame.src, it.peer.port);
      egress(net, d, vlan, frame.dst, it.peer.port).forEach(function (p) {
        var l = linkAt(net, d.id, p);
        if (!l) return;
        var tagged = operMode(net, d, p) === 'trunk' && vlan !== d.sw.portCfg(p).native;
        queue.push({ peer: otherEnd(l, d.id), hops: it.hops + 1, tagged: tagged, vid: vlan });
      });
    }
    return out;
  }

  /* ---------- hosts and routers: ARP, ICMP, routing ---------- */

  var MAX_DEPTH = 24;

  function ttl0(dev) { return dev.type === 'router' ? 255 : 128; }

  // Each router port gets its own MAC address (the last group stays unique per device).
  function macOfPort(dev, port) {
    var parts = dev.mac.split('.'), idx = root.RouterSim.PORTS.indexOf(port) + 1;
    var h = ((parseInt(parts[1], 16) + idx * 17) & 0xffff).toString(16);
    while (h.length < 4) h = '0' + h;
    return parts[0] + '.' + h + '.' + parts[2];
  }

  // Every logical interface of a router (physical ports and subinterfaces) with link state.
  function routerIfaces(net, dev) {
    var rt = dev.rt, out = [];
    root.RouterSim.PORTS.forEach(function (p) {
      var pc = rt.portCfg(p), link = linkAt(net, dev.id, p), mac = macOfPort(dev, p);
      var linkOk = !!link && linkUp(net, link) && !pc.shutdown;
      out.push({ name: p, port: p, vid: null, ip: pc.ip, mask: pc.mask, shutdown: pc.shutdown, mac: mac, up: linkOk });
      Object.keys(rt.running.subifs).sort().forEach(function (sub) {
        if (sub.indexOf(p + '.') !== 0) return;
        var c = rt.running.subifs[sub];
        out.push({ name: sub, port: p, vid: c.vid || null, ip: c.ip, mask: c.mask, shutdown: pc.shutdown || c.shutdown, mac: mac, up: linkOk && !c.shutdown && c.vid > 0 });
      });
    });
    return out;
  }

  // The interfaces of a host that can send and receive IP right now.
  function hostIfaces(net, dev) {
    if (dev.type === 'pc') {
      return dev.cfg.ip ? [{ name: PC_PORT, port: PC_PORT, vid: null, ip: dev.cfg.ip, mask: dev.cfg.mask, mac: dev.mac, up: true }] : [];
    }
    if (dev.type === 'router') return routerIfaces(net, dev).filter(function (i) { return i.up && i.ip; });
    return [];
  }

  function matchIface(net, dev, dl) {
    var list = hostIfaces(net, dev);
    for (var i = 0; i < list.length; i++) {
      if (list[i].port === dl.port && (dl.tagged ? list[i].vid === dl.vid : list[i].vid === null)) return list[i];
    }
    return null;
  }

  // Where a router sends a packet: longest prefix wins, connected beats static on a tie.
  function lookup(net, dev, destStr) {
    var dest = parseIp(destStr), ifs = hostIfaces(net, dev), best = null;
    function consider(len, ifc, nh, ad) {
      if (!best || len > best.len || (len === best.len && ad < best.ad)) best = { len: len, ifc: ifc, nextHop: nh, ad: ad };
    }
    ifs.forEach(function (i) {
      var m = parseIp(i.mask);
      if (networkOf(dest, m) === networkOf(parseIp(i.ip), m)) consider(maskBits(m), i, ipStr(dest), 0);
    });
    dev.rt.running.routes.forEach(function (r) {
      var m = parseIp(r.mask), nh = parseIp(r.nh), via = null;
      if (networkOf(dest, m) !== parseIp(r.net)) return;
      ifs.forEach(function (i) {
        var im = parseIp(i.mask);
        if (!via && networkOf(nh, im) === networkOf(parseIp(i.ip), im)) via = i;
      });
      if (via) consider(maskBits(m), via, r.nh, 1);
    });
    return best;
  }

  // A PC sends on-link traffic directly and everything else to its default gateway.
  function pcRoute(dev, ifc, destStr) {
    var dest = parseIp(destStr), m = parseIp(ifc.mask);
    if (sameSubnet(parseIp(ifc.ip), dest, m)) return { ifc: ifc, nextHop: destStr };
    return dev.cfg.gateway ? { ifc: ifc, nextHop: dev.cfg.gateway } : null;
  }

  function sendFrame(net, host, ifc, frame, ctx, depth) {
    if (depth > MAX_DEPTH) return;
    transmit(net, host, ifc.port, frame, ifc.vid).forEach(function (dl) { receive(net, dl, frame, ctx, depth); });
  }

  // Next hop's MAC from the ARP cache, asking for it when it is not there.
  function resolve(net, dev, ifc, nextHop, ctx, depth) {
    if (dev.arp[nextHop]) return dev.arp[nextHop];
    ctx.arpUsed = true;
    sendFrame(net, dev, ifc, { type: 'arp-req', src: ifc.mac, dst: BCAST, srcIp: ifc.ip, dstIp: nextHop, hops: 0 }, ctx, depth + 1);
    return dev.arp[nextHop] || null;
  }

  // Send an IP packet from dev: find the way out, resolve the next hop, put it on the wire.
  function routeOut(net, dev, pkt, ctx, depth, ingress) {
    var r = dev.type === 'router' ? lookup(net, dev, pkt.dstIp) : pcRoute(dev, hostIfaces(net, dev)[0], pkt.dstIp);
    if (!r) {
      if (ingress && pkt.type === 'icmp-req') icmpError(net, dev, 'icmp-unreach', pkt, ingress, ctx, depth);
      return;
    }
    var mac = resolve(net, dev, r.ifc, r.nextHop, ctx, depth);
    if (!mac) return;                                            // ARP got no answer: dropped
    sendFrame(net, dev, r.ifc, { type: pkt.type, src: r.ifc.mac, dst: mac, srcIp: pkt.srcIp, dstIp: pkt.dstIp, ttl: pkt.ttl, hops: pkt.hops }, ctx, depth);
  }

  function icmpError(net, dev, type, pkt, ingress, ctx, depth) {
    routeOut(net, dev, { type: type, srcIp: ingress.ip, dstIp: pkt.srcIp, ttl: 255, hops: pkt.hops }, ctx, depth + 1, null);
  }

  function receive(net, dl, frame, ctx, depth) {
    var dev = dl.dev, ifc = matchIface(net, dev, dl);
    if (!ifc) return;                                            // PCs ignore tagged frames, unconfigured ports ignore everything
    if (frame.dst !== BCAST && frame.dst !== ifc.mac) return;
    var hops = frame.hops + dl.hops;
    if (frame.type === 'arp-req') {
      if (frame.dstIp !== ifc.ip) return;
      dev.arp[frame.srcIp] = frame.src;                          // the target learns the asker
      sendFrame(net, dev, ifc, { type: 'arp-rep', src: ifc.mac, dst: frame.src, srcIp: ifc.ip, dstIp: frame.srcIp, hops: 0 }, ctx, depth + 1);
    } else if (frame.type === 'arp-rep') {
      if (frame.dstIp === ifc.ip) dev.arp[frame.srcIp] = frame.src;
    } else {
      ipInput(net, dev, ifc, frame, hops, ctx, depth);
    }
  }

  function ipInput(net, dev, ifc, frame, hops, ctx, depth) {
    var mine = hostIfaces(net, dev).some(function (i) { return i.ip === frame.dstIp; });
    if (mine) {
      if (frame.type === 'icmp-req') {
        routeOut(net, dev, { type: 'icmp-rep', srcIp: frame.dstIp, dstIp: frame.srcIp, ttl: ttl0(dev), hops: hops }, ctx, depth + 1, null);
      } else if (dev.id === ctx.origin && /^icmp-(rep|unreach|ttl)$/.test(frame.type)) {
        ctx.reply = { type: frame.type, hops: hops, from: frame.srcIp, ttl: frame.ttl };
      }
      return;
    }
    if (dev.type !== 'router') return;                           // PCs do not forward
    if (frame.ttl <= 1) {
      if (frame.type === 'icmp-req') icmpError(net, dev, 'icmp-ttl', frame, ifc, ctx, depth);
      return;
    }
    routeOut(net, dev, { type: frame.type, srcIp: frame.srcIp, dstIp: frame.dstIp, ttl: frame.ttl - 1, hops: hops + 1 }, ctx, depth + 1, ifc);
  }

  // One echo request from a PC or router to destStr (a dotted IP).
  // Returns { ok:true, ms, ttl, from, arpUsed } or { ok:false, text }.
  function pingOnce(net, dev, destStr) {
    var dest = parseIp(destStr), ifs = hostIfaces(net, dev);
    if (dest === null || !ifs.length) return { ok: false, text: 'Request timed out.' };
    var destIp = ipStr(dest);
    if (ifs.some(function (i) { return i.ip === destIp; })) return { ok: true, ms: 0, ttl: ttl0(dev), from: destIp };

    var r = dev.type === 'router' ? lookup(net, dev, destIp) : pcRoute(dev, ifs[0], destIp);
    if (!r) return { ok: false, text: dev.type === 'pc' ? 'Reply from ' + ifs[0].ip + ': Destination host unreachable.' : 'Destination host unreachable.' };

    var ctx = { origin: dev.id, reply: null, arpUsed: false };
    var mac = resolve(net, dev, r.ifc, r.nextHop, ctx, 0);
    if (!mac) return { ok: false, text: 'Request timed out.' };
    sendFrame(net, dev, r.ifc, { type: 'icmp-req', src: r.ifc.mac, dst: mac, srcIp: r.ifc.ip, dstIp: destIp, ttl: ttl0(dev), hops: 0 }, ctx, 0);

    var rep = ctx.reply;
    if (!rep) return { ok: false, text: 'Request timed out.' };
    if (rep.type === 'icmp-unreach') return { ok: false, text: 'Reply from ' + rep.from + ': Destination host unreachable.' };
    if (rep.type === 'icmp-ttl') return { ok: false, text: 'Reply from ' + rep.from + ': TTL expired in transit.' };
    var ms = Math.floor(rep.hops / 4);
    if (ctx.arpUsed) ms += 10 + rep.hops;                        // the first packet also pays for ARP
    return { ok: true, ms: ms, ttl: rep.ttl, from: rep.from, arpUsed: ctx.arpUsed };
  }

  root.Netsim = {
    BCAST: BCAST, PC_PORT: PC_PORT, networkOf: networkOf, broadcastOf: broadcastOf,
    parseIp: parseIp, ipStr: ipStr, maskBits: maskBits, sameSubnet: sameSubnet,
    classfulMask: classfulMask, normalize: normalize, validateConfig: validateConfig,
    pingOnce: pingOnce, linkUp: linkUp, operMode: operMode, linkAt: linkAt,
    routerIfaces: routerIfaces, hostIfaces: hostIfaces
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Netsim;
})(typeof window !== 'undefined' ? window : globalThis);
