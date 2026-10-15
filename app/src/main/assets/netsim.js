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
  // Returns true when the table changed.
  function learn(sw, vlan, mac, port) {
    if (mac === BCAST) return false;
    var e = findEntry(sw.macTable, vlan, mac);
    if (e) { if (e.port === port) return false; e.port = port; return true; }
    sw.macTable.push({ vlan: vlan, mac: mac, port: port });
    return true;
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

  /* ---------- trace: what happened, for the packet animation ---------- */

  var TRACE_MAX = 600;
  function sp(p) { return p.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi'); }
  function nameOf(net, id) { var d = net.get(id); return d ? d.name : '?'; }

  function frameText(f) {
    switch (f.type) {
      case 'arp-req': return 'ARP request: who has ' + f.dstIp + '? Tell ' + f.srcIp;
      case 'arp-rep': return 'ARP reply: ' + f.srcIp + ' is at ' + f.src;
      case 'icmp-req': return 'Ping request ' + f.srcIp + ' to ' + f.dstIp + ' (TTL ' + f.ttl + ')';
      case 'icmp-rep': return 'Ping reply ' + f.srcIp + ' to ' + f.dstIp + ' (TTL ' + f.ttl + ')';
      case 'icmp-unreach': return 'Destination unreachable, sent by ' + f.srcIp;
      case 'icmp-ttl': return 'TTL expired, sent by ' + f.srcIp;
      default: return f.type;
    }
  }

  // Record an event. rt is the step (relative to the start of this ping).
  function rec(ctx, ev) {
    if (!ctx || !ctx.trace || ctx.trace.length >= TRACE_MAX) return;
    ev.t = ctx.base + ev.rt;
    if (ev.rt > ctx.maxT) ctx.maxT = ev.rt;
    ctx.trace.push(ev);
  }

  function recMove(ctx, net, link, from, to, frame, tagged, vid, rt) {
    if (!ctx || !ctx.trace) return;
    rec(ctx, {
      rt: rt, kind: 'move', link: link.id, from: from, to: to, type: frame.type, tagged: tagged, vid: vid,
      text: nameOf(net, from.dev) + ' to ' + nameOf(net, to.dev) + ': ' + frameText(frame) + (tagged ? ' [VLAN ' + vid + ' tag]' : '')
    });
  }

  function recDrop(ctx, net, devId, rt, why) {
    rec(ctx, { rt: rt, kind: 'drop', dev: devId, text: nameOf(net, devId) + ' dropped it: ' + why });
  }

  function dropReason(net, dev, port, tagged, vid, vlan) {
    if (vlan === null) {
      if (operMode(net, dev, port) === 'access') return 'tagged frame on an access port';
      return dev.sw.vlanExists(vid) ? 'VLAN ' + vid + ' is not allowed on this trunk' : 'VLAN ' + vid + ' does not exist on this switch';
    }
    return 'VLAN ' + vlan + ' does not exist on this switch';
  }

  // Put a frame on the cable at (srcDev, srcPort), tagged with vid if given.
  // Returns the PCs and routers it reaches. Each switch handles a given frame
  // once per VLAN, so loops cannot storm (there is no spanning tree yet).
  function transmit(net, srcDev, srcPort, frame, vid, ctx) {
    var first = linkAt(net, srcDev.id, srcPort);
    if (!first || !linkUp(net, first)) return [];
    var start = ctx ? ctx.clock : 0;
    var out = [], seen = {}, steps = 0, peer0 = otherEnd(first, srcDev.id);
    var queue = [{ peer: peer0, hops: 0, tagged: !!vid, vid: vid || 0, at: start + 1 }];
    recMove(ctx, net, first, { dev: srcDev.id, port: srcPort }, peer0, frame, !!vid, vid || 0, start);
    while (queue.length && steps++ < 500) {
      var it = queue.shift(), d = net.get(it.peer.dev);
      if (!d) continue;
      if (d.type !== 'switch') {      // a PC or router: the frame arrives on that port
        if (d.id !== srcDev.id) out.push({ dev: d, port: it.peer.port, tagged: it.tagged, vid: it.vid, hops: it.hops, arrive: it.at });
        continue;
      }
      var vlan = ingressVlan(net, d, it.peer.port, it.tagged, it.vid);
      if (vlan === null || !d.sw.vlanExists(vlan)) {
        recDrop(ctx, net, d.id, it.at, dropReason(net, d, it.peer.port, it.tagged, it.vid, vlan));
        continue;
      }
      var key = d.id + ':' + vlan;
      if (seen[key]) continue;
      seen[key] = true;
      if (learn(d.sw, vlan, frame.src, it.peer.port)) {
        rec(ctx, { rt: it.at, kind: 'learn', dev: d.id, text: d.name + ' learned ' + frame.src + ' on ' + sp(it.peer.port) + ' (VLAN ' + vlan + ')' });
      }
      egress(net, d, vlan, frame.dst, it.peer.port).forEach(function (p) {
        var l = linkAt(net, d.id, p);
        if (!l) return;
        var tagged = operMode(net, d, p) === 'trunk' && vlan !== d.sw.portCfg(p).native;
        var peer = otherEnd(l, d.id);
        queue.push({ peer: peer, hops: it.hops + 1, tagged: tagged, vid: vlan, at: it.at + 1 });
        recMove(ctx, net, l, { dev: d.id, port: p }, peer, frame, tagged, vlan, it.at);
      });
    }
    return out;
  }

  /* ---------- hosts and routers: ARP, ICMP, routing ---------- */

  var MAX_DEPTH = 24;
  var RIP_MCAST = '0100.5e00.0009';

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

  /* ---------- RIP ---------- */

  function classfulNet(ipText) {
    var n = parseIp(ipText), first = Math.floor(n / 16777216);
    return ipStr(networkOf(n, (first < 128 ? 0xff000000 : first < 192 ? 0xffff0000 : 0xffffff00) >>> 0));
  }

  function ripCfg(dev) { return dev.type === 'router' ? dev.rt.running.rip : null; }
  function ripOn(dev, ifc) {
    var r = ripCfg(dev);
    return !!(r && r.enabled && ifc.ip && r.networks.indexOf(classfulNet(ifc.ip)) !== -1);
  }
  function ripPassive(dev, ifc) { return ripCfg(dev).passive.indexOf(ifc.name) !== -1; }

  // Work out every router's RIP routes. Neighbours are found by delivering a
  // real multicast frame, so VLANs, trunks and shut ports affect adjacency.
  // The simulator converges instantly (a real network needs a few update timers).
  function refreshRip(net) {
    var routers = net.devices.filter(function (d) { var r = ripCfg(d); return r && r.enabled; });
    var tables = {}, edges = [], neighbors = {};
    routers.forEach(function (r) {
      tables[r.id] = {}; neighbors[r.id] = [];
      hostIfaces(net, r).forEach(function (i) {
        if (!ripOn(r, i)) return;
        var m = parseIp(i.mask), key = ipStr(networkOf(parseIp(i.ip), m)) + '/' + i.mask;
        tables[r.id][key] = { net: ipStr(networkOf(parseIp(i.ip), m)), mask: i.mask, metric: 0, connected: true };
      });
    });
    routers.forEach(function (a) {
      hostIfaces(net, a).forEach(function (ia) {
        if (!ripOn(a, ia) || ripPassive(a, ia)) return;
        var probe = { type: 'rip', src: ia.mac, dst: RIP_MCAST, hops: 0 };
        transmit(net, a, ia.port, probe, ia.vid, null).forEach(function (dl) {
          var r = ripCfg(dl.dev);
          if (!r || !r.enabled) return;
          var ib = matchIface(net, dl.dev, dl);
          if (!ib || !ripOn(dl.dev, ib)) return;
          if (!sameSubnet(parseIp(ia.ip), parseIp(ib.ip), parseIp(ia.mask))) return;
          edges.push({ from: a, fromIf: ia, to: dl.dev, toIf: ib });
          if (neighbors[dl.dev.id].indexOf(ia.ip) === -1) neighbors[dl.dev.id].push(ia.ip);
        });
      });
    });
    for (var round = 0; round < 16; round++) {
      var changed = false;
      edges.forEach(function (e) {
        var src = tables[e.from.id];
        Object.keys(src).forEach(function (k) {
          var r = src[k];
          if (!r.connected && r.ifName === e.fromIf.name) return;          // split horizon
          var adv = r.metric + 1;
          if (adv >= 16) return;                                           // 16 means unreachable
          var dst = tables[e.to.id], cur = dst[k];
          if (cur && (cur.connected || cur.metric <= adv)) return;
          dst[k] = { net: r.net, mask: r.mask, metric: adv, nh: e.fromIf.ip, ifName: e.toIf.name };
          changed = true;
        });
      });
      if (!changed) break;
    }
    var routes = {};
    routers.forEach(function (r) {
      routes[r.id] = Object.keys(tables[r.id]).map(function (k) { return tables[r.id][k]; })
        .filter(function (x) { return !x.connected; })
        .sort(function (p, q) { return parseIp(p.net) - parseIp(q.net); });
    });
    net.rip = { routes: routes, neighbors: neighbors };
    return net.rip;
  }

  // Where a router sends a packet: longest prefix wins, then lowest distance
  // (connected 0, static 1, RIP 120).
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
    ((net.rip && net.rip.routes[dev.id]) || []).forEach(function (r) {
      var m = parseIp(r.mask);
      if (networkOf(dest, m) !== parseIp(r.net)) return;
      var via = ifs.filter(function (i) { return i.name === r.ifName; })[0];
      if (via) consider(maskBits(m), via, r.nh, 120);
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
    transmit(net, host, ifc.port, frame, ifc.vid, ctx).forEach(function (dl) {
      var prev = ctx.clock;
      ctx.clock = dl.arrive;                                    // whatever the receiver does starts when the frame arrives
      receive(net, dl, frame, ctx, depth);
      ctx.clock = prev;
    });
  }

  // Next hop's MAC from the ARP cache, asking for it when it is not there.
  function resolve(net, dev, ifc, nextHop, ctx, depth) {
    if (dev.arp[nextHop]) return dev.arp[nextHop];
    ctx.arpUsed = true;
    sendFrame(net, dev, ifc, { type: 'arp-req', src: ifc.mac, dst: BCAST, srcIp: ifc.ip, dstIp: nextHop, hops: 0 }, ctx, depth + 1);
    ctx.clock = Math.max(ctx.clock, ctx.maxT + 1);              // carry on after the ARP exchange
    if (!dev.arp[nextHop]) recDrop(ctx, net, dev.id, ctx.clock, 'no ARP reply from ' + nextHop);
    return dev.arp[nextHop] || null;
  }

  // Send an IP packet from dev: find the way out, resolve the next hop, put it on the wire.
  function routeOut(net, dev, pkt, ctx, depth, ingress) {
    var r = dev.type === 'router' ? lookup(net, dev, pkt.dstIp) : pcRoute(dev, hostIfaces(net, dev)[0], pkt.dstIp);
    if (!r) {
      recDrop(ctx, net, dev.id, ctx.clock, 'no route to ' + pkt.dstIp);
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
      recDrop(ctx, net, dev.id, ctx.clock, 'TTL ran out');
      if (frame.type === 'icmp-req') icmpError(net, dev, 'icmp-ttl', frame, ifc, ctx, depth);
      return;
    }
    routeOut(net, dev, { type: frame.type, srcIp: frame.srcIp, dstIp: frame.dstIp, ttl: frame.ttl - 1, hops: hops + 1 }, ctx, depth + 1, ifc);
  }

  // Start a fresh trace. A console command that sends several pings calls this once.
  function beginTrace(net) { net.trace = []; net.traceClock = 0; }

  function pingCore(net, dev, destStr, ctx) {
    var dest = parseIp(destStr), ifs = hostIfaces(net, dev);
    if (dest === null || !ifs.length) return { ok: false, text: 'Request timed out.' };
    var destIp = ipStr(dest);
    if (ifs.some(function (i) { return i.ip === destIp; })) return { ok: true, ms: 0, ttl: ttl0(dev), from: destIp };

    refreshRip(net);
    var r = dev.type === 'router' ? lookup(net, dev, destIp) : pcRoute(dev, ifs[0], destIp);
    if (!r) return { ok: false, text: dev.type === 'pc' ? 'Reply from ' + ifs[0].ip + ': Destination host unreachable.' : 'Destination host unreachable.' };

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

  // One echo request from a PC or router to destStr (a dotted IP).
  // Returns { ok:true, ms, ttl, from, arpUsed } or { ok:false, text }.
  // Events are appended to net.trace for the packet animation.
  function pingOnce(net, dev, destStr) {
    var ctx = { origin: dev.id, reply: null, arpUsed: false, trace: net.trace || null, base: net.traceClock || 0, clock: 0, maxT: 0 };
    var res = pingCore(net, dev, destStr, ctx);
    if (net.trace && ctx.trace.length) net.traceClock = ctx.base + ctx.maxT + 2;
    return res;
  }

  root.Netsim = {
    BCAST: BCAST, PC_PORT: PC_PORT, networkOf: networkOf, broadcastOf: broadcastOf,
    parseIp: parseIp, ipStr: ipStr, maskBits: maskBits, sameSubnet: sameSubnet,
    classfulMask: classfulMask, normalize: normalize, validateConfig: validateConfig,
    pingOnce: pingOnce, linkUp: linkUp, operMode: operMode, linkAt: linkAt,
    routerIfaces: routerIfaces, hostIfaces: hostIfaces,
    refreshRip: refreshRip, classfulNet: classfulNet, beginTrace: beginTrace
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Netsim;
})(typeof window !== 'undefined' ? window : globalThis);
