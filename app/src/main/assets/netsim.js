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
  var MAX_DEPTH = 6;

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

  function findEntry(table, mac) {
    for (var i = 0; i < table.length; i++) if (table[i].mac === mac) return table[i];
    return null;
  }

  // A switch learns which port a source address lives behind.
  function learn(sw, mac, port) {
    if (mac === BCAST) return;
    var e = findEntry(sw.macTable, mac);
    if (e) e.port = port; else sw.macTable.push({ vlan: 1, mac: mac, port: port });
  }

  // Which ports a switch sends a frame out of.
  function egress(net, dev, dst, ingress) {
    var connected = net.usedPorts(dev.id);
    if (dst !== BCAST) {
      var e = findEntry(dev.sw.macTable, dst);
      if (e) return (e.port !== ingress && connected.indexOf(e.port) !== -1) ? [e.port] : [];
    }
    return connected.filter(function (p) { return p !== ingress; });   // broadcast or unknown unicast: flood
  }

  // Put a frame on the cable at (srcDev, srcPort). Returns the PCs it reaches.
  // Each switch handles a given frame once, so loops cannot storm (there is no
  // spanning tree yet).
  function transmit(net, srcDev, srcPort, frame) {
    var first = linkAt(net, srcDev.id, srcPort);
    if (!first) return [];
    var out = [], seen = {}, steps = 0;
    var queue = [{ peer: otherEnd(first, srcDev.id), hops: 0 }];
    while (queue.length && steps++ < 500) {
      var it = queue.shift(), d = net.get(it.peer.dev);
      if (!d) continue;
      if (d.type === 'pc') {
        if (d.id !== srcDev.id) out.push({ dev: d, hops: it.hops });
        continue;
      }
      if (seen[d.id]) continue;
      seen[d.id] = true;
      learn(d.sw, frame.src, it.peer.port);
      egress(net, d, frame.dst, it.peer.port).forEach(function (p) {
        var l = linkAt(net, d.id, p);
        if (l) queue.push({ peer: otherEnd(l, d.id), hops: it.hops + 1 });
      });
    }
    return out;
  }

  /* ---------- hosts: ARP and ICMP ---------- */

  function sendFrame(net, host, frame, ctx, depth) {
    if (depth > MAX_DEPTH) return;
    transmit(net, host, PC_PORT, frame).forEach(function (dl) {
      receive(net, dl.dev, frame, frame.hops + dl.hops, ctx, depth);
    });
  }

  function receive(net, pc, frame, hops, ctx, depth) {
    if (frame.dst !== BCAST && frame.dst !== pc.mac) return;
    if (!pc.cfg.ip || frame.dstIp !== pc.cfg.ip) return;
    var reply = { src: pc.mac, dst: frame.src, srcIp: pc.cfg.ip, dstIp: frame.srcIp, hops: hops };
    if (frame.type === 'arp-req') {
      pc.arp[frame.srcIp] = frame.src;                    // the target learns the asker
      reply.type = 'arp-rep';
      sendFrame(net, pc, reply, ctx, depth + 1);
    } else if (frame.type === 'arp-rep') {
      pc.arp[frame.srcIp] = frame.src;
    } else if (frame.type === 'icmp-req') {
      reply.type = 'icmp-rep';
      sendFrame(net, pc, reply, ctx, depth + 1);
    } else if (frame.type === 'icmp-rep' && pc.id === ctx.origin) {
      ctx.reply = { hops: hops, from: frame.srcIp };
    }
  }

  // One echo request from pc to destStr (a valid dotted IP).
  // Returns { ok:true, ms, ttl, from } or { ok:false, text }.
  function pingOnce(net, pc, destStr) {
    var cfg = pc.cfg, ip = cfg.ip ? parseIp(cfg.ip) : null, dest = parseIp(destStr);
    if (ip === null || dest === null) return { ok: false, text: 'Request timed out.' };
    var destIp = ipStr(dest);
    if (dest === ip) return { ok: true, ms: 0, ttl: 128, from: destIp };

    var hop = sameSubnet(ip, dest, parseIp(cfg.mask)) ? destIp : (cfg.gateway || null);
    if (hop === null) return { ok: false, text: 'Reply from ' + cfg.ip + ': Destination host unreachable.' };

    var ctx = { origin: pc.id, reply: null }, usedArp = false;
    if (!pc.arp[hop]) {
      usedArp = true;
      sendFrame(net, pc, { type: 'arp-req', src: pc.mac, dst: BCAST, srcIp: cfg.ip, dstIp: hop, hops: 0 }, ctx, 0);
      if (!pc.arp[hop]) return { ok: false, text: 'Request timed out.' };
    }
    sendFrame(net, pc, { type: 'icmp-req', src: pc.mac, dst: pc.arp[hop], srcIp: cfg.ip, dstIp: destIp, hops: 0 }, ctx, 0);
    if (!ctx.reply) return { ok: false, text: 'Request timed out.' };

    var ms = Math.floor(ctx.reply.hops / 4);
    if (usedArp) ms += 10 + ctx.reply.hops;               // the first packet also pays for ARP
    return { ok: true, ms: ms, ttl: 128, from: ctx.reply.from };
  }

  root.Netsim = {
    BCAST: BCAST, PC_PORT: PC_PORT,
    parseIp: parseIp, ipStr: ipStr, maskBits: maskBits, sameSubnet: sameSubnet,
    classfulMask: classfulMask, normalize: normalize, validateConfig: validateConfig,
    pingOnce: pingOnce
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Netsim;
})(typeof window !== 'undefined' ? window : globalThis);
