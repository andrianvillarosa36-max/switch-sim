/*
 * Simulated Cisco IOS router (three Gigabit interfaces).
 *
 * Modes: user, privileged, global config, config-if, config-subif.
 * Interfaces start shut down, like a real router. Subinterfaces
 * ("interface g0/0.10" + "encapsulation dot1Q 10") give router-on-a-stick.
 * Routing: connected networks plus static routes (longest prefix wins).
 *
 * The forwarding itself lives in netsim.js; this file is the console.
 * It implements the same small interface as SwitchSim, so TerminalView can
 * show it: prompt, secretInput, pending, exec(), help(), complete(), dirty,
 * startup, takeJob().
 */
(function (root) {
  'use strict';

  var K = root.SwitchSim.cli;
  var PORTS = ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'GigabitEthernet0/2'];

  var pad = K.pad;
  function short(name) { return name.replace('GigabitEthernet', 'Gi'); }
  function N() { return root.Netsim; }

  /* ---------- config ---------- */

  function defaultPort() { return { ip: '', mask: '', shutdown: true, description: '' }; }
  function defaultSub() { return { vid: 0, ip: '', mask: '', shutdown: false, description: '' }; }
  function defaultConfig() { return { hostname: 'Router', secret: null, password: null, ports: {}, subifs: {}, routes: [] }; }
  function clone(c) { return JSON.parse(JSON.stringify(c)); }
  function sameConfig(a, b) { return K.stable(a) === K.stable(b); }

  function setPort(cfg, name, patch) {
    var cur = Object.assign({}, cfg.ports[name], patch), d = defaultPort(), out = {};
    Object.keys(cur).forEach(function (k) { if (K.stable(cur[k]) !== K.stable(d[k])) out[k] = cur[k]; });
    if (Object.keys(out).length) cfg.ports[name] = out; else delete cfg.ports[name];
  }

  function validIp(s) { return typeof s === 'string' && N().parseIp(s) !== null; }

  function sanitize(s) {
    var c = Object.assign(defaultConfig(), s), d = defaultPort(), out = {}, subs = {}, routes = [];
    Object.keys(s.ports || {}).forEach(function (n) {
      if (PORTS.indexOf(n) === -1 || !s.ports[n]) return;
      var p = s.ports[n], q = {};
      if (validIp(p.ip) && validIp(p.mask)) { q.ip = p.ip; q.mask = p.mask; }
      if (p.shutdown === false) q.shutdown = false;
      if (typeof p.description === 'string') q.description = p.description.slice(0, 240);
      Object.keys(q).forEach(function (k) { if (K.stable(q[k]) === K.stable(d[k])) delete q[k]; });
      if (Object.keys(q).length) out[n] = q;
    });
    Object.keys(s.subifs || {}).forEach(function (n) {
      var m = /^(GigabitEthernet\d\/\d)\.(\d{1,4})$/.exec(n), p = s.subifs[n];
      if (!m || PORTS.indexOf(m[1]) === -1 || !p) return;
      var q = defaultSub();
      if (Number.isInteger(p.vid) && p.vid >= 1 && p.vid <= 4094) q.vid = p.vid;
      if (validIp(p.ip) && validIp(p.mask)) { q.ip = p.ip; q.mask = p.mask; }
      if (p.shutdown === true) q.shutdown = true;
      if (typeof p.description === 'string') q.description = p.description.slice(0, 240);
      subs[n] = q;
    });
    (Array.isArray(s.routes) ? s.routes : []).forEach(function (r) {
      if (r && validIp(r.net) && validIp(r.mask) && validIp(r.nh)) routes.push({ net: r.net, mask: r.mask, nh: r.nh });
    });
    c.ports = out; c.subifs = subs; c.routes = routes;
    return c;
  }

  function parseName(text) {
    var m = /^([a-z]+)(\d+\/\d+)(?:\.(\d{1,4}))?$/i.exec(String(text).replace(/\s+/g, ''));
    if (!m || 'gigabitethernet'.indexOf(m[1].toLowerCase()) !== 0) return null;
    var port = 'GigabitEthernet' + m[2];
    if (PORTS.indexOf(port) === -1) return null;
    var sub = m[3] ? Number(m[3]) : null;
    if (sub !== null && (sub < 1 || sub > 9999)) return null;
    return { port: port, sub: sub, name: sub === null ? port : port + '.' + sub };
  }

  function bits(maskText) { return N().maskBits(N().parseIp(maskText)); }

  function configBody(c) {
    var L = ['!', 'version 15.4', 'no service timestamps log datetime msec', 'no service password-encryption', '!', 'hostname ' + c.hostname, '!'];
    if (c.secret !== null) L.push('enable secret 5 ' + K.fakeHash(c.secret));
    if (c.password !== null) L.push('enable password ' + c.password);
    if (c.secret !== null || c.password !== null) L.push('!');
    function iface(name, p, sub) {
      L.push('interface ' + name);
      if (p.description) L.push(' description ' + p.description);
      if (sub) L.push(p.vid ? ' encapsulation dot1Q ' + p.vid : ' no encapsulation');
      L.push(p.ip ? ' ip address ' + p.ip + ' ' + p.mask : ' no ip address');
      if (p.shutdown) L.push(' shutdown');
      L.push('!');
    }
    PORTS.forEach(function (n) {
      iface(n, Object.assign(defaultPort(), c.ports[n]), false);
      Object.keys(c.subifs).filter(function (s) { return s.indexOf(n + '.') === 0; }).sort().forEach(function (s) { iface(s, c.subifs[s], true); });
    });
    c.routes.forEach(function (r) { L.push('ip route ' + r.net + ' ' + r.mask + ' ' + r.nh); });
    if (c.routes.length) L.push('!');
    L.push('end');
    return L;
  }

  /* ---------- handlers ---------- */

  function bad(rt, token) {
    return [new Array(rt.prompt.length + token.index + 1).join(' ') + '^', "% Invalid input detected at '^' marker.", ''];
  }

  var LOGOUT = function (rt) {
    rt.mode = 'user';
    return ['', rt.running.hostname + ' con0 is now available', '', 'Press RETURN to get started.', ''];
  };

  function askPassword(rt, tries) {
    rt.pending = {
      prompt: 'Password: ', secret: true,
      submit: function (r, text) {
        var real = r.running.secret !== null ? r.running.secret : r.running.password;
        if (text === real) { r.mode = 'priv'; return []; }
        if (tries + 1 >= 3) return ['% Bad secrets', ''];
        askPassword(r, tries + 1);
        return [];
      }
    };
  }

  function cmdEnable(rt) {
    if (rt.running.secret === null && rt.running.password === null) { rt.mode = 'priv'; return []; }
    askPassword(rt, 0);
    return [];
  }

  function cmdHostname(rt, args) {
    var name = args[0];
    if (name.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) {
      return ['% Hostname contains one or more illegal characters.'];
    }
    rt.running.hostname = name;
    return [];
  }

  function cmdInterface(rt, args, at) {
    var p = parseName(args.join(''));
    if (!p) return bad(rt, at[0]);
    if (p.sub !== null && !rt.running.subifs[p.name]) rt.running.subifs[p.name] = defaultSub();
    rt.curIf = p.name;
    rt.mode = p.sub === null ? 'config-if' : 'config-subif';
    return [];
  }

  function cmdNoInterface(rt, args, at) {
    var p = parseName(args.join(''));
    if (!p) return bad(rt, at[0]);
    if (p.sub === null) return ['% Not all config may be removed and may reappear after reactivating the logical-interface/sub-interface'];
    delete rt.running.subifs[p.name];
    if (rt.portsChanged) rt.portsChanged();
    return [];
  }

  function patchIf(rt, patch) {
    if (rt.mode === 'config-subif') rt.running.subifs[rt.curIf] = Object.assign({}, rt.running.subifs[rt.curIf], patch);
    else setPort(rt.running, rt.curIf, patch);
    if (rt.portsChanged) rt.portsChanged();
  }

  function curCfg(rt) { return rt.mode === 'config-subif' ? rt.running.subifs[rt.curIf] : rt.portCfg(rt.curIf); }

  function ifaceUp(rt, name) {
    var i = (rt.ifaces ? rt.ifaces() : []).filter(function (x) { return x.name === name; })[0];
    return !!(i && i.up);
  }

  function cmdIpAddress(rt, args, at) {
    var n = N(), ip = n.parseIp(args[0]), mask = n.parseIp(args[1]);
    if (ip === null) return bad(rt, at[0]);
    var b = mask === null ? -1 : n.maskBits(mask);
    if (b < 8 || b > 30) return bad(rt, at[1]);
    if (n.networkOf(ip, mask) === ip || n.broadcastOf(ip, mask) === ip) return ['Bad mask /' + b + ' for address ' + args[0]];
    if (rt.mode === 'config-subif' && !curCfg(rt).vid) {
      return ['% Configuring IP routing on a LAN subinterface is only allowed if that', 'subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,', 'or ISL vLAN.'];
    }
    var mine = n.networkOf(ip, mask), clash = null;
    allLogical(rt).forEach(function (l) {
      if (l.name === rt.curIf || !l.ip) return;
      var lm = n.parseIp(l.mask), lb = n.maskBits(lm), m = Math.min(b, lb);
      var sh = Math.pow(2, 32 - m);
      if (Math.floor(mine / sh) === Math.floor(n.networkOf(n.parseIp(l.ip), lm) / sh)) clash = l.name;
    });
    if (clash) return ['% ' + n.ipStr(mine) + ' overlaps with ' + clash];
    patchIf(rt, { ip: n.ipStr(ip), mask: n.ipStr(mask) });
    return [];
  }

  function allLogical(rt) {
    var out = [];
    PORTS.forEach(function (p) { var c = rt.portCfg(p); out.push({ name: p, ip: c.ip, mask: c.mask }); });
    Object.keys(rt.running.subifs).forEach(function (s) { var c = rt.running.subifs[s]; out.push({ name: s, ip: c.ip, mask: c.mask }); });
    return out;
  }

  function cmdNoIpAddress(rt) { patchIf(rt, { ip: '', mask: '' }); return []; }

  function cmdShutdown(rt, down) {
    var n = rt.curIf, was = ifaceUp(rt, n), out = [];
    patchIf(rt, { shutdown: down });
    var now = ifaceUp(rt, n);
    if (down) {
      out.push('%LINK-5-CHANGED: Interface ' + n + ', changed state to administratively down');
      if (was) out.push('%LINEPROTO-5-UPDOWN: Line protocol on Interface ' + n + ', changed state to down');
    } else if (!was && now) {
      out.push('%LINK-3-UPDOWN: Interface ' + n + ', changed state to up');
      out.push('%LINEPROTO-5-UPDOWN: Line protocol on Interface ' + n + ', changed state to up');
    }
    return out;
  }

  function cmdDescription(rt, args) { patchIf(rt, { description: args.join(' ').slice(0, 240) }); return []; }

  function cmdEncapsulation(rt, args, at) {
    if (rt.mode !== 'config-subif') return bad(rt, at[0]);
    var v = /^\d{1,4}$/.test(args[0]) ? Number(args[0]) : 0;
    if (v < 1 || v > 4094) return bad(rt, at[0]);
    patchIf(rt, { vid: v });
    return [];
  }

  function routeArgs(rt, args, at) {
    var n = N(), net = n.parseIp(args[0]), mask = n.parseIp(args[1]), nh = n.parseIp(args[2]);
    if (net === null) return { err: bad(rt, at[0]) };
    if (mask === null || n.maskBits(mask) < 0) return { err: bad(rt, at[1]) };
    if (nh === null) return { err: bad(rt, at[2]) };
    if (n.networkOf(net, mask) !== net) return { err: ['%Inconsistent address and mask'] };
    return { route: { net: n.ipStr(net), mask: n.ipStr(mask), nh: n.ipStr(nh) } };
  }

  function sameRoute(a, b) { return a.net === b.net && a.mask === b.mask && a.nh === b.nh; }

  function cmdIpRoute(rt, args, at) {
    var r = routeArgs(rt, args, at);
    if (r.err) return r.err;
    if (!rt.running.routes.some(function (x) { return sameRoute(x, r.route); })) rt.running.routes.push(r.route);
    return [];
  }

  function cmdNoIpRoute(rt, args, at) {
    var r = routeArgs(rt, args, at);
    if (r.err) return r.err;
    rt.running.routes = rt.running.routes.filter(function (x) { return !sameRoute(x, r.route); });
    return [];
  }

  function cmdShowRun(rt) {
    var body = configBody(rt.running);
    return ['Building configuration...', '', 'Current configuration : ' + body.join('\n').length + ' bytes'].concat(body);
  }

  function cmdShowStart(rt) {
    if (!rt.startup) return ['startup-config is not present'];
    var body = configBody(rt.startup);
    return ['Using ' + body.join('\n').length + ' out of 262144 bytes'].concat(body);
  }

  function cmdShowRoute(rt) {
    var n = N(), ifs = (rt.ifaces ? rt.ifaces() : []).filter(function (i) { return i.up && i.ip; }), rows = [];
    ifs.forEach(function (i) {
      var m = n.parseIp(i.mask), net = n.networkOf(n.parseIp(i.ip), m);
      rows.push({ key: net, line: 'C  ' + n.ipStr(net) + '/' + n.maskBits(m) + ' is directly connected, ' + short(i.name) });
      rows.push({ key: net + 0.5, line: 'L  ' + i.ip + '/32 is directly connected, ' + short(i.name) });
    });
    var gateway = null;
    rt.running.routes.forEach(function (r) {
      var nh = n.parseIp(r.nh);
      var reachable = ifs.some(function (i) { var m = n.parseIp(i.mask); return n.networkOf(n.parseIp(i.ip), m) === n.networkOf(nh, m); });
      if (!reachable) return;
      var isDefault = r.net === '0.0.0.0' && r.mask === '0.0.0.0';
      if (isDefault) gateway = r.nh;
      rows.push({ key: n.parseIp(r.net) + 0.25, line: (isDefault ? 'S* ' : 'S  ') + r.net + '/' + bits(r.mask) + ' [1/0] via ' + r.nh });
    });
    rows.sort(function (a, b) { return a.key - b.key; });
    var L = ['Codes: C - connected, S - static, L - local', '', gateway ? 'Gateway of last resort is ' + gateway + ' to network 0.0.0.0' : 'Gateway of last resort is not set', ''];
    return L.concat(rows.map(function (r) { return r.line; }));
  }

  function cmdShowIfBrief(rt) {
    var L = ['Interface  IP-Address     Status   Proto'];
    (rt.ifaces ? rt.ifaces() : []).forEach(function (i) {
      var status = i.shutdown ? 'adm down' : i.up ? 'up' : 'down';
      L.push(pad(short(i.name), 11) + pad(i.ip || 'unassigned', 15) + pad(status, 9) + (i.up ? 'up' : 'down'));
    });
    return L;
  }

  function cmdShowArp(rt) {
    var n = N(), arp = rt.arp ? rt.arp() : {}, ips = Object.keys(arp);
    if (!ips.length) return [];
    var ifs = rt.ifaces ? rt.ifaces() : [];
    var L = ['Address        Hardware Addr  Interface'];
    ips.forEach(function (ip) {
      var ip4 = n.parseIp(ip);
      var out = ifs.filter(function (i) { return i.ip && n.networkOf(n.parseIp(i.ip), n.parseIp(i.mask)) === n.networkOf(ip4, n.parseIp(i.mask)); })[0];
      L.push(pad(ip, 15) + pad(arp[ip], 15) + (out ? short(out.name) : ''));
    });
    return L;
  }

  function cmdClearArp(rt) { if (rt.clearArp) rt.clearArp(); return []; }

  function cmdPing(rt, args, at) {
    var n = N(), dest = n.parseIp(args[0]);
    if (dest === null) return ['% Unrecognized host or address, or protocol not running.'];
    var target = n.ipStr(dest), marks = '', oks = [], i;
    for (i = 0; i < 5; i++) {
      var r = rt.ping ? rt.ping(target) : { ok: false, text: '' };
      // like a real router, the first echo is lost while ARP resolves the next hop
      if (r.ok && !r.arpUsed) { marks += '!'; oks.push(Math.max(1, r.ms)); }
      else marks += /unreachable/.test(r.text || '') ? 'U' : '.';
    }
    var pct = Math.round(oks.length * 100 / 5);
    var stats = 'Success rate is ' + pct + ' percent (' + oks.length + '/5)';
    if (oks.length) {
      var min = Math.min.apply(null, oks), max = Math.max.apply(null, oks);
      var avg = Math.round(oks.reduce(function (a, b) { return a + b; }, 0) / oks.length);
      stats += ', round-trip min/avg/max = ' + min + '/' + avg + '/' + max + ' ms';
    }
    rt._job = [{ t: marks, delay: 1500 }, { t: stats, delay: 0 }];
    return ['Type escape sequence to abort.', 'Sending 5, 100-byte ICMP Echos to ' + target + ', timeout is 2 seconds:'];
  }

  function cmdCopyRunStart(rt) {
    rt.pending = {
      prompt: 'Destination filename [startup-config]? ', secret: false,
      submit: function (r, text) {
        var t = text.trim().toLowerCase();
        if (t !== '' && t !== 'startup-config') return ['% Only startup-config is supported as a destination in this simulator.'];
        r.startup = clone(r.running);
        return ['Building configuration...', '[OK]'];
      }
    };
    return [];
  }

  function cmdWrite(rt) { rt.startup = clone(rt.running); return ['Building configuration...', '[OK]']; }

  function cmdErase(rt) {
    rt.pending = {
      prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', secret: false,
      submit: function (r, text) {
        var t = text.trim().toLowerCase();
        if (t === '' || t === 'y' || t === 'yes' || t === 'confirm') { r.startup = null; return ['[OK]', 'Erase of nvram: complete']; }
        return [];
      }
    };
    return [];
  }

  function askReloadConfirm(rt) {
    rt.pending = {
      prompt: 'Proceed with reload? [confirm]', secret: false,
      submit: function (r, text) {
        var t = text.trim().toLowerCase();
        if (t === '' || t === 'y' || t === 'yes' || t === 'confirm') {
          r.running = clone(r.startup || defaultConfig());
          r.mode = 'user';
          if (r.clearArp) r.clearArp();
          if (r.portsChanged) r.portsChanged();
          return ['', '*** System restarted (simulated) ***', '', 'Press RETURN to get started.', ''];
        }
        return [];
      }
    };
  }

  function askReloadSave(rt) {
    rt.pending = {
      prompt: 'System configuration has been modified. Save? [yes/no]: ', secret: false,
      submit: function (r, text) {
        var t = text.trim().toLowerCase();
        if (t === 'y' || t === 'yes') { r.startup = clone(r.running); askReloadConfirm(r); return ['Building configuration...', '[OK]']; }
        if (t === 'n' || t === 'no') { askReloadConfirm(r); return []; }
        askReloadSave(r);
        return ["% Please answer 'yes' or 'no'."];
      }
    };
  }

  function cmdReload(rt) { if (rt.dirty) askReloadSave(rt); else askReloadConfirm(rt); return []; }

  /* ---------- command tables ---------- */

  var USER_CMDS = [
    { p: 'enable', run: cmdEnable, desc: 'Turn on privileged commands' },
    { p: 'exit', run: LOGOUT, desc: 'Exit from the EXEC' }
  ];

  var PRIV_CMDS = [
    { p: 'clear', desc: 'Reset functions' },
    { p: 'clear arp-cache', run: cmdClearArp, desc: 'Clear the entire ARP cache' },
    { p: 'configure', run: function (rt) { rt.mode = 'config'; return ['Enter configuration commands, one per line.  End with CNTL/Z.']; }, desc: 'Enter configuration mode' },
    { p: 'configure terminal', run: function (rt) { rt.mode = 'config'; return ['Enter configuration commands, one per line.  End with CNTL/Z.']; }, desc: 'Configure from the terminal' },
    { p: 'copy', desc: 'Copy from one file to another' },
    { p: 'copy running-config', desc: 'Copy from the current system configuration' },
    { p: 'copy running-config startup-config', run: cmdCopyRunStart, desc: 'Copy to the startup configuration' },
    { p: 'disable', run: function (rt) { rt.mode = 'user'; return []; }, desc: 'Turn off privileged commands' },
    { p: 'erase', desc: 'Erase a filesystem' },
    { p: 'erase startup-config', run: cmdErase, desc: 'Erase the contents of the startup configuration' },
    { p: 'exit', run: LOGOUT, desc: 'Exit from the EXEC' },
    { p: 'ping <ip>', run: cmdPing, desc: 'Send echo messages', arg: 'Ping destination address' },
    { p: 'reload', run: cmdReload, desc: 'Halt and perform a cold restart' },
    { p: 'show', desc: 'Show running system information' },
    { p: 'show arp', run: cmdShowArp, desc: 'ARP table' },
    { p: 'show ip', desc: 'IP information' },
    { p: 'show ip arp', run: cmdShowArp, desc: 'IP ARP table' },
    { p: 'show ip interface', desc: 'IP interface status and configuration' },
    { p: 'show ip interface brief', run: cmdShowIfBrief, desc: 'Brief summary of IP status and configuration' },
    { p: 'show ip route', run: cmdShowRoute, desc: 'IP routing table' },
    { p: 'show running-config', run: cmdShowRun, desc: 'Current operating configuration' },
    { p: 'show startup-config', run: cmdShowStart, desc: 'Contents of the startup configuration' },
    { p: 'write', run: cmdWrite, desc: 'Write running configuration to memory' },
    { p: 'write memory', run: cmdWrite, desc: 'Write to NV memory' }
  ];

  var CONFIG_CMDS = [
    { p: 'enable', desc: 'Modify enable password parameters' },
    { p: 'enable password <password>', run: function (rt, a) { rt.running.password = a[0]; return []; }, desc: 'Assign the privileged level password (plain text)', arg: 'The password string' },
    { p: 'enable secret <password>', run: function (rt, a) { rt.running.secret = a[0]; return []; }, desc: 'Assign the privileged level secret', arg: 'The secret string' },
    { p: 'end', run: function (rt) { rt.mode = 'priv'; return []; }, desc: 'Exit from configure mode' },
    { p: 'exit', run: function (rt) { rt.mode = 'priv'; return []; }, desc: 'Exit from configure mode' },
    { p: 'hostname <name>', run: cmdHostname, desc: "Set the system's network name", arg: "This system's network name" },
    { p: 'interface <type>', run: cmdInterface, desc: 'Select an interface to configure', arg: 'Interface, for example g0/0 or g0/0.10' },
    { p: 'interface <type> <number>', run: cmdInterface, arg: 'Interface number, for example 0/0' },
    { p: 'ip', desc: 'Global IP configuration subcommands' },
    { p: 'ip route <net> <mask> <next-hop>', run: cmdIpRoute, desc: 'Establish static routes', arg: 'Destination prefix, mask and next-hop address' },
    { p: 'no', desc: 'Negate a command or set its defaults' },
    { p: 'no enable', desc: 'Modify enable password parameters' },
    { p: 'no enable password', run: function (rt) { rt.running.password = null; return []; }, desc: 'Assign the privileged level password (plain text)' },
    { p: 'no enable secret', run: function (rt) { rt.running.secret = null; return []; }, desc: 'Assign the privileged level secret' },
    { p: 'no hostname', run: function (rt) { rt.running.hostname = 'Router'; return []; }, desc: "Set the system's network name" },
    { p: 'no interface <type>', run: cmdNoInterface, desc: 'Delete a subinterface', arg: 'Subinterface, for example g0/0.10' },
    { p: 'no ip', desc: 'Global IP configuration subcommands' },
    { p: 'no ip route <net> <mask> <next-hop>', run: cmdNoIpRoute, desc: 'Establish static routes', arg: 'Destination prefix, mask and next-hop address' }
  ];

  var IF_CMDS = [
    { p: 'description', desc: 'Interface specific description' },
    { p: 'encapsulation', desc: 'Set encapsulation type for an interface' },
    { p: 'encapsulation dot1q <vid>', run: cmdEncapsulation, desc: 'IEEE 802.1Q Virtual LAN', arg: 'IEEE 802.1Q VLAN ID' },
    { p: 'end', run: function (rt) { rt.mode = 'priv'; return []; }, desc: 'Exit from configure mode' },
    { p: 'exit', run: function (rt) { rt.mode = 'config'; return []; }, desc: 'Exit from interface configuration mode' },
    { p: 'ip', desc: 'Interface Internet Protocol config commands' },
    { p: 'ip address <ip> <mask>', run: cmdIpAddress, desc: 'Set the IP address of an interface', arg: 'IP address, then subnet mask' },
    { p: 'no', desc: 'Negate a command or set its defaults' },
    { p: 'no description', run: function (rt) { patchIf(rt, { description: '' }); return []; }, desc: 'Interface specific description' },
    { p: 'no ip', desc: 'Interface Internet Protocol config commands' },
    { p: 'no ip address', run: cmdNoIpAddress, desc: 'Set the IP address of an interface' },
    { p: 'no shutdown', run: function (rt) { return cmdShutdown(rt, false); }, desc: 'Shutdown the selected interface' },
    { p: 'shutdown', run: function (rt) { return cmdShutdown(rt, true); }, desc: 'Shutdown the selected interface' }
  ];
  (function () {
    var tail = '';
    for (var k = 1; k <= 8; k++) { tail += ' <w>'; IF_CMDS.push({ p: 'description' + tail, run: cmdDescription, arg: 'Up to 240 characters describing this interface' }); }
  })();

  var TRIES = {
    user: K.buildTrie(USER_CMDS), priv: K.buildTrie(PRIV_CMDS), config: K.buildTrie(CONFIG_CMDS),
    'config-if': K.buildTrie(IF_CMDS), 'config-subif': K.buildTrie(IF_CMDS)
  };
  var SUB_MODES = { 'config-if': true, 'config-subif': true };
  var SUFFIX = { user: '>', priv: '#', config: '(config)#', 'config-if': '(config-if)#', 'config-subif': '(config-subif)#' };

  /* ---------- the router ---------- */

  function RouterSim(saved) {
    this.running = defaultConfig();
    this.startup = null;
    this.mode = 'user';
    this.pending = null;
    this.curIf = PORTS[0];
    this._job = null;
    this.ifaces = null;        // set by the network: () => logical interfaces with link state
    this.arp = null;           // set by the network: () => { ip: mac }
    this.clearArp = null;      // set by the network
    this.ping = null;          // set by the network: (ip) => ping result
    this.portsChanged = null;  // set by the network
    if (saved) this.load(saved);
  }

  RouterSim.PORTS = PORTS;

  RouterSim.prototype.load = function (s) {
    if (s.running) this.running = sanitize(s.running);
    if (s.startup) this.startup = sanitize(s.startup);
  };
  RouterSim.prototype.toJSON = function () { return { running: this.running, startup: this.startup }; };
  RouterSim.prototype.portCfg = function (name) { return Object.assign(defaultPort(), this.running.ports[name]); };
  RouterSim.prototype.takeJob = function () { var j = this._job; this._job = null; return j; };

  Object.defineProperty(RouterSim.prototype, 'prompt', {
    get: function () { return this.pending ? this.pending.prompt : this.running.hostname + SUFFIX[this.mode]; }
  });
  Object.defineProperty(RouterSim.prototype, 'secretInput', { get: function () { return !!(this.pending && this.pending.secret); } });
  Object.defineProperty(RouterSim.prototype, 'dirty', {
    get: function () { return !sameConfig(this.running, this.startup || defaultConfig()); }
  });

  RouterSim.prototype.syntaxError = function (res, line) {
    if (res.error === 'ambiguous') return ['% Ambiguous command:  "' + line.trim() + '"'];
    return bad(this, res.token);
  };

  RouterSim.prototype.exec = function (line) {
    if (this.pending) { var p = this.pending; this.pending = null; return p.submit(this, line) || []; }
    if (line.trim() === '') return [];
    if (/\?\s*$/.test(line)) return this.help(line);
    var tokens = K.tokenize(line), res = K.walk(TRIES[this.mode], tokens);
    if (res.error === 'invalid' && SUB_MODES[this.mode]) {
      var g = K.walk(TRIES.config, tokens);
      if (!g.error) res = g;
    }
    if (res.error) return this.syntaxError(res, line);
    if (!res.node.run) return ['% Incomplete command.'];
    return res.node.run(this, res.args, res.argTokens) || [];
  };

  RouterSim.prototype.help = function (line) {
    var body = line.replace(/\?\s*$/, ''), atStart = body.length === 0 || /\s$/.test(body);
    var tokens = K.tokenize(body), prefix = atStart ? '' : tokens.pop().text.toLowerCase();
    var res = K.walk(TRIES[this.mode], tokens);
    if (res.error) return this.syntaxError(res, body);
    var n = res.node, words = Object.keys(n.kids).sort().filter(function (w) { return w.indexOf(prefix) === 0; });
    if (prefix) return words.length ? [words.join('  ')] : ['% Unrecognized command'];
    var rows = words.map(function (w) { return '  ' + pad(w, 14) + n.kids[w].desc; });
    if (n.arg) rows.push('  ' + pad('WORD', 14) + n.arg.desc);
    if (n.run) rows.push('  ' + pad('<cr>', 14));
    return rows;
  };

  RouterSim.prototype.complete = function (line) {
    if (this.pending) return line;
    var tokens = K.tokenize(line);
    if (!tokens.length || /\s$/.test(line)) return line;
    var last = tokens.pop(), res = K.walk(TRIES[this.mode], tokens);
    if (res.error) return line;
    var low = last.text.toLowerCase();
    var words = Object.keys(res.node.kids).filter(function (w) { return w.indexOf(low) === 0; });
    return words.length === 1 ? line.slice(0, last.index) + words[0] + ' ' : line;
  };

  root.RouterSim = RouterSim;
  if (typeof module !== 'undefined' && module.exports) module.exports = { RouterSim: RouterSim };
})(typeof window !== 'undefined' ? window : globalThis);
