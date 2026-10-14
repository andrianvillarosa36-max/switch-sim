/*
 * Simulated Cisco IOS switch console (a 24-port Fast Ethernet + 2 Gigabit switch).
 *
 * Modes: user, privileged, global config, config-vlan, config-if, config-if-range.
 * Config (saved by "copy running-config startup-config"): hostname, enable
 * secret/password and per-port settings. The VLAN database is separate and
 * survives a reload, like vlan.dat on a real switch.
 *
 * To add commands, add an entry to a *_CMDS list below. Pattern syntax: words
 * are keywords, <name> is a free-text argument. A handler is run(sw, args,
 * argTokens) and returns an array of output lines.
 *
 * Runs in the Android WebView and in Node (see tests/engine.test.js).
 */
(function (root) {
  'use strict';

  /* ---------- ports and config helpers ---------- */

  var PORTS = (function () {
    var list = [], i;
    for (i = 1; i <= 24; i++) list.push('FastEthernet0/' + i);
    list.push('GigabitEthernet0/1', 'GigabitEthernet0/2');
    return list;
  })();

  var RESERVED = { 1002: 'fddi-default', 1003: 'token-ring-default', 1004: 'fddinet-default', 1005: 'trnet-default' };

  function pad(s, n) { while (s.length < n) s += ' '; return s; }
  function padLeft(s, n) { while (s.length < n) s = ' ' + s; return s; }
  function padCol(s, n) { return s.length >= n ? s + ' ' : pad(s, n); }
  function shortPort(n) { return n.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi'); }

  // Per-port defaults. A port only appears in config.ports when it differs.
  function defaultPort() {
    return { mode: 'auto', accessVlan: 1, native: 1, allowed: 'all', shutdown: false, description: '' };
  }
  function defaultConfig() { return { hostname: 'Switch', secret: null, password: null, ports: {} }; }
  function clone(c) {
    return { hostname: c.hostname, secret: c.secret, password: c.password, ports: JSON.parse(JSON.stringify(c.ports || {})) };
  }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function sameConfig(a, b) { return stable(clone(a)) === stable(clone(b)); }

  function setPort(cfg, name, patch) {
    var cur = Object.assign({}, cfg.ports[name], patch), d = defaultPort(), out = {};
    Object.keys(cur).forEach(function (k) { if (stable(cur[k]) !== stable(d[k])) out[k] = cur[k]; });
    if (Object.keys(out).length) cfg.ports[name] = out; else delete cfg.ports[name];
  }

  // Keep only well-formed saved port settings.
  function sanitizePorts(obj) {
    var out = {}, d = defaultPort();
    Object.keys(obj || {}).forEach(function (name) {
      if (PORTS.indexOf(name) === -1 || !obj[name] || typeof obj[name] !== 'object') return;
      var p = obj[name], q = {};
      if (['access', 'trunk', 'desirable', 'auto'].indexOf(p.mode) !== -1) q.mode = p.mode;
      if (Number.isInteger(p.accessVlan) && p.accessVlan >= 1 && p.accessVlan <= 4094) q.accessVlan = p.accessVlan;
      if (Number.isInteger(p.native) && p.native >= 1 && p.native <= 4094) q.native = p.native;
      if (typeof p.allowed === 'string' && (p.allowed === 'all' || p.allowed === '' || parseRanges(p.allowed))) q.allowed = p.allowed;
      if (p.shutdown === true) q.shutdown = true;
      if (typeof p.description === 'string') q.description = p.description.slice(0, 240);
      Object.keys(q).forEach(function (k) { if (stable(q[k]) === stable(d[k])) delete q[k]; });
      if (Object.keys(q).length) out[name] = q;
    });
    return out;
  }

  /* ---------- VLAN lists ("10,20,30-32") ---------- */

  function parseRanges(text) {
    var marks = new Uint8Array(4095), parts = String(text).split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(parts[i]);
      if (!m) return null;
      var lo = Number(m[1]), hi = m[2] ? Number(m[2]) : lo;
      if (lo < 1 || hi > 4094 || lo > hi) return null;
      for (var v = lo; v <= hi; v++) marks[v] = 1;
    }
    return marks;
  }
  function marksToStr(marks) {
    var out = [], v = 1;
    while (v <= 4094) {
      if (marks[v]) {
        var s = v;
        while (v + 1 <= 4094 && marks[v + 1]) v++;
        out.push(s === v ? String(s) : s + '-' + v);
      }
      v++;
    }
    return out.join(',');
  }
  function allowedMarks(str) {
    if (str === 'all') return parseRanges('1-4094');
    return str === '' ? new Uint8Array(4095) : parseRanges(str);
  }
  function normAllowed(marks) { var s = marksToStr(marks); return s === '1-4094' ? 'all' : s; }
  function allows(cfg, vid) {
    if (cfg.allowed === 'all') return true;
    var m = allowedMarks(cfg.allowed);
    return !!(m && m[vid]);
  }

  /* ---------- interface names ---------- */

  function resolvePort(text) {
    var m = /^([a-z]+)(\d+\/\d+)$/i.exec(String(text).replace(/\s+/g, ''));
    if (!m) return null;
    var t = m[1].toLowerCase(), full = null;
    if (t.length >= 2 && 'fastethernet'.indexOf(t) === 0) full = 'FastEthernet' + m[2];
    else if (t.length >= 2 && 'gigabitethernet'.indexOf(t) === 0) full = 'GigabitEthernet' + m[2];
    return full && PORTS.indexOf(full) !== -1 ? full : null;
  }

  // "fa0/1 - 4", "fa0/1-fa0/4", "fa0/1 - 2 , fa0/5" -> ['FastEthernet0/1', ...] or null
  function resolveRange(text) {
    var out = [], parts = String(text).replace(/\s+/g, '').split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = /^([a-z]+)(\d+)\/(\d+)-(?:([a-z]+)?(?:(\d+)\/)?)?(\d+)$/i.exec(parts[i]);
      var names = [];
      if (m) {
        if (m[4] && resolvePort(m[4] + '0/1') !== resolvePort(m[1] + '0/1')) return null;
        if (m[5] && m[5] !== m[2]) return null;
        var lo = Number(m[3]), hi = Number(m[6]);
        if (lo > hi) return null;
        for (var n = lo; n <= hi; n++) {
          var p = resolvePort(m[1] + m[2] + '/' + n);
          if (!p) return null;
          names.push(p);
        }
      } else {
        var single = resolvePort(parts[i]);
        if (!single) return null;
        names.push(single);
      }
      names.forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
    }
    return out.length ? out : null;
  }

  /* ---------- config text ---------- */

  // Fake "type 5" hash: looks right, is not a real hash.
  function fakeHash(pw) {
    var alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    var h = 2166136261;
    for (var i = 0; i < pw.length; i++) { h ^= pw.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    var out = '';
    for (var j = 0; j < 22; j++) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      out += alphabet.charAt(h >>> 26);
    }
    return '$1$mERr$' + out;
  }

  function configBody(c) {
    var L = [
      '!', 'version 15.0',
      'no service timestamps log datetime msec',
      'no service timestamps debug datetime msec',
      'no service password-encryption',
      '!', 'hostname ' + c.hostname, '!'
    ];
    if (c.secret !== null) L.push('enable secret 5 ' + fakeHash(c.secret));
    if (c.password !== null) L.push('enable password ' + c.password);
    if (c.secret !== null || c.password !== null) L.push('!');
    PORTS.forEach(function (name) {
      var p = Object.assign(defaultPort(), c.ports[name]);
      L.push('interface ' + name);
      if (p.description) L.push(' description ' + p.description);
      if (p.accessVlan !== 1) L.push(' switchport access vlan ' + p.accessVlan);
      if (p.native !== 1) L.push(' switchport trunk native vlan ' + p.native);
      if (p.allowed !== 'all') L.push(' switchport trunk allowed vlan ' + (p.allowed || 'none'));
      if (p.mode === 'access') L.push(' switchport mode access');
      if (p.mode === 'trunk') L.push(' switchport mode trunk');
      if (p.mode === 'desirable') L.push(' switchport mode dynamic desirable');
      if (p.shutdown) L.push(' shutdown');
      L.push('!');
    });
    L.push('end');
    return L;
  }

  /* ---------- command tree ---------- */

  function makeNode() { return { kids: {}, arg: null, run: null, desc: '' }; }

  function buildTrie(defs) {
    var rootNode = makeNode();
    defs.forEach(function (d) {
      var n = rootNode, lastKw = null;
      d.p.split(' ').forEach(function (tok) {
        if (tok.charAt(0) === '<') {
          if (!n.arg) n.arg = { node: makeNode(), desc: '' };
          if (d.arg) n.arg.desc = d.arg;
          n = n.arg.node;
        } else {
          if (!n.kids[tok]) n.kids[tok] = makeNode();
          n = n.kids[tok];
          lastKw = n;
        }
      });
      if (d.run) n.run = d.run;
      if (d.desc && lastKw && !lastKw.desc) lastKw.desc = d.desc;
    });
    return rootNode;
  }

  function tokenize(line) {
    var re = /\S+/g, out = [], m;
    while ((m = re.exec(line)) !== null) out.push({ text: m[0], index: m.index });
    return out;
  }

  // IOS rules: an exact keyword wins, otherwise a unique prefix works; several
  // matches is "ambiguous". Anything else fills the free-text argument slot.
  function walk(trie, tokens) {
    var n = trie, args = [], argTokens = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i], low = t.text.toLowerCase();
      var words = Object.keys(n.kids);
      var hits = words.indexOf(low) !== -1 ? [low] : words.filter(function (w) { return w.indexOf(low) === 0; });
      if (hits.length === 1) { n = n.kids[hits[0]]; continue; }
      if (hits.length > 1) return { error: 'ambiguous', token: t };
      if (n.arg) { args.push(t.text); argTokens.push(t); n = n.arg.node; continue; }
      return { error: 'invalid', token: t };
    }
    return { node: n, args: args, argTokens: argTokens };
  }

  /* ---------- command handlers ---------- */

  function bad(sw, token) {
    var caret = new Array(sw.prompt.length + token.index + 1).join(' ') + '^';
    return [caret, "% Invalid input detected at '^' marker.", ''];
  }

  var LOGOUT = function (sw) {
    sw.setMode('user');
    return ['', sw.running.hostname + ' con0 is now available', '', 'Press RETURN to get started.', ''];
  };

  function askPassword(sw, tries) {
    sw.pending = {
      prompt: 'Password: ', secret: true,
      submit: function (s, text) {
        var real = s.running.secret !== null ? s.running.secret : s.running.password;
        if (text === real) { s.setMode('priv'); return []; }
        if (tries + 1 >= 3) return ['% Bad secrets', ''];
        askPassword(s, tries + 1);
        return [];
      }
    };
  }

  function cmdEnable(sw) {
    if (sw.running.secret === null && sw.running.password === null) { sw.setMode('priv'); return []; }
    askPassword(sw, 0);
    return [];
  }

  function cmdDisable(sw) { sw.setMode('user'); return []; }
  function cmdEnterConfig(sw) { sw.setMode('config'); return ['Enter configuration commands, one per line.  End with CNTL/Z.']; }
  function cmdEnd(sw) { sw.flags.end = true; sw.setMode('priv'); return []; }
  function cmdExitSub(sw) { sw.setMode('config'); return []; }       // from config-vlan / config-if
  function cmdExitConfig(sw) { sw.setMode('priv'); return []; }

  function cmdHostname(sw, args) {
    var name = args[0];
    if (name.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) {
      return ['% Hostname contains one or more illegal characters.'];
    }
    sw.running.hostname = name;
    return [];
  }

  function cmdEnableSecret(sw, args) { sw.running.secret = args[0]; return []; }
  function cmdEnablePassword(sw, args) { sw.running.password = args[0]; return []; }
  function cmdNoSecret(sw) { sw.running.secret = null; return []; }
  function cmdNoPassword(sw) { sw.running.password = null; return []; }
  function cmdNoHostname(sw) { sw.running.hostname = 'Switch'; return []; }

  /* --- VLANs --- */

  function vlanId(text) { return /^\d{1,4}$/.test(text) ? Number(text) : 0; }

  function cmdVlan(sw, args, at) {
    var id = vlanId(args[0]);
    if (id < 1 || id > 1001) return bad(sw, at[0]);
    if (id !== 1 && sw.vlans[id] === undefined) sw.vlans[id] = 'VLAN' + padLeft(String(id), 4).replace(/ /g, '0');
    sw.curVlan = id;
    sw.setMode('config-vlan');
    return [];
  }

  function cmdNoVlan(sw, args, at) {
    var id = vlanId(args[0]);
    if (id < 1 || id > 4094) return bad(sw, at[0]);
    if (id === 1 || RESERVED[id]) return ['% Default VLAN ' + id + ' may not be deleted.'];
    delete sw.vlans[id];
    return [];
  }

  function cmdVlanName(sw, args, at) {
    if (sw.curVlan === 1) return ['% Default VLAN 1 may not have its name changed.'];
    if (args[0].length > 32) return bad(sw, at[0]);
    sw.vlans[sw.curVlan] = args[0];
    return [];
  }

  function cmdShowVlan(sw) {
    var info = sw.portInfo ? sw.portInfo() : [];
    var ids = [1].concat(Object.keys(sw.vlans).map(Number).sort(function (a, b) { return a - b; }));
    var nameW = 8;
    ids.forEach(function (id) { nameW = Math.max(nameW, Math.min(16, sw.vlanName(id).length)); });
    nameW += 1;
    var start = 5 + nameW + 7, avail = Math.max(8, 38 - start);
    var L = [
      'VLAN ' + pad('Name', nameW) + 'Status Ports',
      '---- ' + new Array(nameW).join('-') + ' ------ -----'
    ];
    ids.forEach(function (id) {
      var ports = PORTS.filter(function (name) {
        var cfg = sw.portCfg(name), pi = info.filter(function (x) { return x.name === name; })[0];
        return cfg.accessVlan === id && !(pi && pi.oper === 'trunk');
      }).map(shortPort);
      var lines = [], cur = '';
      ports.forEach(function (p) {
        if (cur && (cur + ', ' + p).length > avail) { lines.push(cur + ','); cur = p; }
        else cur = cur ? cur + ', ' + p : p;
      });
      if (cur) lines.push(cur);
      L.push(padCol(String(id), 5) + padCol(sw.vlanName(id), nameW) + pad('active', 7) + (lines[0] || ''));
      for (var i = 1; i < lines.length; i++) L.push(new Array(start + 1).join(' ') + lines[i]);
    });
    Object.keys(RESERVED).forEach(function (id) {
      L.push(padCol(id, 5) + padCol(RESERVED[id], nameW) + 'act/unsup');
    });
    return L;
  }

  /* --- interfaces --- */

  function cmdInterface(sw, args, at) {
    var name = resolvePort(args.join(''));
    if (!name) return bad(sw, at[0]);
    sw.curIfs = [name];
    sw.setMode('config-if');
    return [];
  }

  function cmdInterfaceRange(sw, args, at) {
    var names = resolveRange(args.join(''));
    if (!names) return bad(sw, at[0]);
    sw.curIfs = names;
    sw.setMode('config-if-range');
    return [];
  }

  function applyPorts(sw, patch) {
    sw.curIfs.forEach(function (n) { setPort(sw.running, n, patch); });
    if (sw.portsChanged) sw.portsChanged();
  }

  function modeSetter(mode) { return function (sw) { applyPorts(sw, { mode: mode }); return []; }; }

  function portUp(sw, name) {
    var p = (sw.portInfo ? sw.portInfo() : []).filter(function (x) { return x.name === name; })[0];
    return !!(p && p.up);
  }

  function cmdAccessVlan(sw, args, at) {
    var id = vlanId(args[0]);
    if (id < 1 || id > 4094) return bad(sw, at[0]);
    var out = [];
    if (!sw.vlanExists(id) && id <= 1001) {
      sw.vlans[id] = 'VLAN' + padLeft(String(id), 4).replace(/ /g, '0');
      out.push('% Access VLAN does not exist. Creating vlan ' + id);
    }
    applyPorts(sw, { accessVlan: id });
    return out;
  }

  function cmdNative(sw, args, at) {
    var id = vlanId(args[0]);
    if (id < 1 || id > 4094) return bad(sw, at[0]);
    applyPorts(sw, { native: id });
    return [];
  }

  // switchport trunk allowed vlan [add|remove|all|none|<list>]
  function allowedHandler(op) {
    return function (sw, args, at) {
      var list = null;
      if (op === 'set' || op === 'add' || op === 'remove') {
        list = parseRanges(args[0]);
        if (!list) return bad(sw, at[0]);
      }
      sw.curIfs.forEach(function (n) {
        var cur = allowedMarks(sw.portCfg(n).allowed), next = new Uint8Array(4095), v;
        for (v = 1; v <= 4094; v++) {
          if (op === 'set') next[v] = list[v];
          else if (op === 'add') next[v] = cur[v] || list[v];
          else if (op === 'remove') next[v] = cur[v] && !list[v] ? 1 : 0;
          else if (op === 'all') next[v] = 1;
        }
        setPort(sw.running, n, { allowed: normAllowed(next) });
      });
      if (sw.portsChanged) sw.portsChanged();
      return [];
    };
  }

  function resetter(patch) { return function (sw) { applyPorts(sw, patch); return []; }; }

  function cmdShutdown(sw, down) {
    var L = [];
    sw.curIfs.forEach(function (n) {
      var was = portUp(sw, n);
      setPort(sw.running, n, { shutdown: down });
      if (sw.portsChanged) sw.portsChanged();
      var now = portUp(sw, n);
      if (down) {
        L.push('%LINK-5-CHANGED: Interface ' + n + ', changed state to administratively down');
        if (was) L.push('%LINEPROTO-5-UPDOWN: Line protocol on Interface ' + n + ', changed state to down');
      } else if (!was && now) {
        L.push('%LINK-3-UPDOWN: Interface ' + n + ', changed state to up');
        L.push('%LINEPROTO-5-UPDOWN: Line protocol on Interface ' + n + ', changed state to up');
      }
    });
    return L;
  }

  function cmdDescription(sw, args) { applyPorts(sw, { description: args.join(' ').slice(0, 240) }); return []; }

  /* --- show / copy / reload --- */

  function cmdShowRun(sw) {
    var body = configBody(sw.running);
    return ['Building configuration...', '', 'Current configuration : ' + body.join('\n').length + ' bytes'].concat(body);
  }

  function cmdShowStart(sw) {
    if (!sw.startup) return ['startup-config is not present'];
    var body = configBody(sw.startup);
    return ['Using ' + body.join('\n').length + ' out of 65536 bytes'].concat(body);
  }

  // Column spacing is a little tighter than a real switch so tables fit a phone screen.
  function cmdShowMac(sw) {
    var L = [
      '     Mac Address Table',
      '------------------------------------',
      '',
      'Vlan  Mac Address     Type     Ports',
      '----  --------------  -------  -----'
    ];
    sw.macTable.forEach(function (e) {
      L.push(padLeft(String(e.vlan), 4) + '  ' + pad(e.mac, 16) + pad('DYNAMIC', 9) + shortPort(e.port));
    });
    L.push('Total Mac Addresses for this criterion: ' + sw.macTable.length);
    return L;
  }

  function cmdClearMac(sw) { sw.macTable = []; return []; }

  function cmdShowIfStatus(sw) {
    var L = ['Port   Status      Vlan  Duplex Speed'];
    (sw.portInfo ? sw.portInfo() : []).forEach(function (p) {
      var cfg = sw.portCfg(p.name), gig = p.name.indexOf('Gigabit') === 0;
      var status = cfg.shutdown ? 'disabled' : p.up ? 'connected' : 'notconnect';
      var vlan = p.oper === 'trunk' ? 'trunk' : String(cfg.accessVlan);
      L.push(pad(shortPort(p.name), 7) + pad(status, 12) + pad(vlan, 6) +
        pad(p.up ? 'a-full' : 'auto', 7) + (p.up ? (gig ? 'a-1000' : 'a-100') : 'auto'));
    });
    return L;
  }

  function cmdShowTrunk(sw) {
    var trunks = (sw.portInfo ? sw.portInfo() : []).filter(function (p) { return p.oper === 'trunk' && p.up; });
    if (!trunks.length) return [];
    var L = ['Port   Mode      Status    Native'];
    trunks.forEach(function (p) {
      var cfg = sw.portCfg(p.name);
      var mode = cfg.mode === 'trunk' ? 'on' : cfg.mode === 'desirable' ? 'desirable' : 'auto';
      L.push(pad(shortPort(p.name), 7) + pad(mode, 10) + pad('trunking', 10) + cfg.native);
    });
    function section(title, fn) {
      L.push('', 'Port   ' + title);
      trunks.forEach(function (p) { L.push(pad(shortPort(p.name), 7) + fn(sw.portCfg(p.name))); });
    }
    section('Vlans allowed on trunk', function (cfg) { return cfg.allowed === 'all' ? '1-4094' : (cfg.allowed || 'none'); });
    section('Allowed and active', function (cfg) {
      var out = [1].concat(Object.keys(sw.vlans).map(Number)).sort(function (a, b) { return a - b; })
        .filter(function (v) { return allows(cfg, v); });
      var m = new Uint8Array(4095);
      out.forEach(function (v) { m[v] = 1; });
      return marksToStr(m) || 'none';
    });
    return L;
  }

  function cmdCopyRunStart(sw) {
    sw.pending = {
      prompt: 'Destination filename [startup-config]? ', secret: false,
      submit: function (s, text) {
        var t = text.trim().toLowerCase();
        if (t !== '' && t !== 'startup-config') {
          return ['% Only startup-config is supported as a destination in this simulator.'];
        }
        s.startup = clone(s.running);
        return ['Building configuration...', '[OK]'];
      }
    };
    return [];
  }

  function cmdWrite(sw) {
    sw.startup = clone(sw.running);
    return ['Building configuration...', '[OK]'];
  }

  function cmdErase(sw) {
    sw.pending = {
      prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', secret: false,
      submit: function (s, text) {
        var t = text.trim().toLowerCase();
        if (t === '' || t === 'y' || t === 'yes' || t === 'confirm') {
          s.startup = null;
          return ['[OK]', 'Erase of nvram: complete'];
        }
        return [];
      }
    };
    return [];
  }

  function askReloadConfirm(sw) {
    sw.pending = {
      prompt: 'Proceed with reload? [confirm]', secret: false,
      submit: function (s, text) {
        var t = text.trim().toLowerCase();
        if (t === '' || t === 'y' || t === 'yes' || t === 'confirm') {
          s.running = clone(s.startup || defaultConfig());
          s.macTable = [];
          s.mode = 'user';
          if (s.portsChanged) s.portsChanged();
          return ['', '*** System restarted (simulated) ***', '', 'Press RETURN to get started.', ''];
        }
        return [];
      }
    };
  }

  function askReloadSave(sw) {
    sw.pending = {
      prompt: 'System configuration has been modified. Save? [yes/no]: ', secret: false,
      submit: function (s, text) {
        var t = text.trim().toLowerCase();
        if (t === 'y' || t === 'yes') {
          s.startup = clone(s.running);
          askReloadConfirm(s);
          return ['Building configuration...', '[OK]'];
        }
        if (t === 'n' || t === 'no') { askReloadConfirm(s); return []; }
        askReloadSave(s);
        return ["% Please answer 'yes' or 'no'."];
      }
    };
  }

  function cmdReload(sw) {
    if (sw.dirty) askReloadSave(sw); else askReloadConfirm(sw);
    return [];
  }

  /* ---------- command tables ---------- */

  var USER_CMDS = [
    { p: 'enable', run: cmdEnable, desc: 'Turn on privileged commands' },
    { p: 'exit', run: LOGOUT, desc: 'Exit from the EXEC' }
  ];

  var PRIV_CMDS = [
    { p: 'clear', desc: 'Reset functions' },
    { p: 'clear mac', desc: 'MAC forwarding table' },
    { p: 'clear mac address-table', desc: 'MAC forwarding table' },
    { p: 'clear mac address-table dynamic', run: cmdClearMac, desc: 'Clear the dynamic entries' },
    { p: 'configure', run: cmdEnterConfig, desc: 'Enter configuration mode' },
    { p: 'configure terminal', run: cmdEnterConfig, desc: 'Configure from the terminal' },
    { p: 'copy', desc: 'Copy from one file to another' },
    { p: 'copy running-config', desc: 'Copy from the current system configuration' },
    { p: 'copy running-config startup-config', run: cmdCopyRunStart, desc: 'Copy to the startup configuration' },
    { p: 'disable', run: cmdDisable, desc: 'Turn off privileged commands' },
    { p: 'erase', desc: 'Erase a filesystem' },
    { p: 'erase startup-config', run: cmdErase, desc: 'Erase the contents of the startup configuration' },
    { p: 'exit', run: LOGOUT, desc: 'Exit from the EXEC' },
    { p: 'reload', run: cmdReload, desc: 'Halt and perform a cold restart' },
    { p: 'show', desc: 'Show running system information' },
    { p: 'show interfaces', desc: 'Interface status and configuration' },
    { p: 'show interfaces status', run: cmdShowIfStatus, desc: 'Display interface status' },
    { p: 'show interfaces trunk', run: cmdShowTrunk, desc: 'Display interface trunk information' },
    { p: 'show mac', desc: 'MAC configuration' },
    { p: 'show mac address-table', run: cmdShowMac, desc: 'MAC forwarding table' },
    { p: 'show mac-address-table', run: cmdShowMac, desc: 'MAC forwarding table' },
    { p: 'show running-config', run: cmdShowRun, desc: 'Current operating configuration' },
    { p: 'show startup-config', run: cmdShowStart, desc: 'Contents of the startup configuration' },
    { p: 'show vlan', run: cmdShowVlan, desc: 'VTP VLAN status' },
    { p: 'show vlan brief', run: cmdShowVlan, desc: 'VTP all VLAN status in brief' },
    { p: 'write', run: cmdWrite, desc: 'Write running configuration to memory' },
    { p: 'write memory', run: cmdWrite, desc: 'Write to NV memory' }
  ];

  var CONFIG_CMDS = [
    { p: 'enable', desc: 'Modify enable password parameters' },
    { p: 'enable password <password>', run: cmdEnablePassword, desc: 'Assign the privileged level password (plain text)', arg: 'The password string' },
    { p: 'enable secret <password>', run: cmdEnableSecret, desc: 'Assign the privileged level secret', arg: 'The secret string' },
    { p: 'end', run: cmdEnd, desc: 'Exit from configure mode' },
    { p: 'exit', run: cmdExitConfig, desc: 'Exit from configure mode' },
    { p: 'hostname <name>', run: cmdHostname, desc: "Set the system's network name", arg: "This system's network name" },
    { p: 'interface', desc: 'Select an interface to configure' },
    { p: 'interface <type>', run: cmdInterface, arg: 'Interface type, for example fa0/1' },
    { p: 'interface <type> <number>', run: cmdInterface, arg: 'Interface number, for example 0/1' },
    { p: 'interface range', desc: 'Configure a range of interfaces' },
    { p: 'no', desc: 'Negate a command or set its defaults' },
    { p: 'no enable', desc: 'Modify enable password parameters' },
    { p: 'no enable password', run: cmdNoPassword, desc: 'Assign the privileged level password (plain text)' },
    { p: 'no enable secret', run: cmdNoSecret, desc: 'Assign the privileged level secret' },
    { p: 'no hostname', run: cmdNoHostname, desc: "Set the system's network name" },
    { p: 'no vlan <id>', run: cmdNoVlan, desc: 'Vlan commands', arg: 'ISL VLAN IDs 1-4094' },
    { p: 'vlan <id>', run: cmdVlan, desc: 'Vlan commands', arg: 'ISL VLAN IDs 1-4094' }
  ];
  // interface range <a> [<b> ...]: the range may be typed with spaces ("fa0/1 - 4")
  (function () {
    var tail = '';
    for (var k = 1; k <= 9; k++) {
      tail += ' <r>';
      CONFIG_CMDS.push({ p: 'interface range' + tail, run: cmdInterfaceRange, arg: 'Interface range, for example fa0/1 - 4' });
    }
  })();

  var VLAN_CMDS = [
    { p: 'end', run: cmdEnd, desc: 'Exit from configure mode' },
    { p: 'exit', run: cmdExitSub, desc: 'Apply changes, bump revision number, and exit mode' },
    { p: 'name <name>', run: cmdVlanName, desc: 'Ascii name of the VLAN', arg: 'The ascii name for the VLAN' }
  ];

  var IF_CMDS = [
    { p: 'description', desc: 'Interface specific description' },
    { p: 'end', run: cmdEnd, desc: 'Exit from configure mode' },
    { p: 'exit', run: cmdExitSub, desc: 'Exit from interface configuration mode' },
    { p: 'no', desc: 'Negate a command or set its defaults' },
    { p: 'no description', run: resetter({ description: '' }), desc: 'Interface specific description' },
    { p: 'no shutdown', run: function (sw) { return cmdShutdown(sw, false); }, desc: 'Shutdown the selected interface' },
    { p: 'no switchport', desc: 'Set switching mode characteristics' },
    { p: 'no switchport access', desc: 'Set access mode characteristics of the interface' },
    { p: 'no switchport access vlan', run: resetter({ accessVlan: 1 }), desc: 'Set VLAN when interface is in access mode' },
    { p: 'no switchport mode', run: resetter({ mode: 'auto' }), desc: 'Set trunking mode of the interface' },
    { p: 'no switchport trunk', desc: 'Set trunking characteristics of the interface' },
    { p: 'no switchport trunk allowed', desc: 'Set allowed VLAN characteristics when interface is in trunking mode' },
    { p: 'no switchport trunk allowed vlan', run: resetter({ allowed: 'all' }), desc: 'Set allowed VLANs when interface is in trunking mode' },
    { p: 'no switchport trunk native', desc: 'Set trunking native characteristics when interface is in trunking mode' },
    { p: 'no switchport trunk native vlan', run: resetter({ native: 1 }), desc: 'Set native VLAN when interface is in trunking mode' },
    { p: 'shutdown', run: function (sw) { return cmdShutdown(sw, true); }, desc: 'Shutdown the selected interface' },
    { p: 'switchport', desc: 'Set switching mode characteristics' },
    { p: 'switchport access', desc: 'Set access mode characteristics of the interface' },
    { p: 'switchport access vlan <id>', run: cmdAccessVlan, desc: 'Set VLAN when interface is in access mode', arg: 'VLAN ID of the VLAN when this port is in access mode' },
    { p: 'switchport mode', desc: 'Set trunking mode of the interface' },
    { p: 'switchport mode access', run: modeSetter('access'), desc: 'Set trunking mode to ACCESS unconditionally' },
    { p: 'switchport mode dynamic', desc: 'Set trunking mode to dynamically negotiate access or trunk mode' },
    { p: 'switchport mode dynamic auto', run: modeSetter('auto'), desc: 'Set trunking mode dynamically negotiated; trunk if the neighbor asks' },
    { p: 'switchport mode dynamic desirable', run: modeSetter('desirable'), desc: 'Set trunking mode to actively try to trunk' },
    { p: 'switchport mode trunk', run: modeSetter('trunk'), desc: 'Set trunking mode to TRUNK unconditionally' },
    { p: 'switchport trunk', desc: 'Set trunking characteristics of the interface' },
    { p: 'switchport trunk allowed', desc: 'Set allowed VLAN characteristics when interface is in trunking mode' },
    { p: 'switchport trunk allowed vlan', desc: 'Set allowed VLANs when interface is in trunking mode' },
    { p: 'switchport trunk allowed vlan <list>', run: allowedHandler('set'), arg: 'VLAN IDs of the allowed VLANs, like 10,20,30-40' },
    { p: 'switchport trunk allowed vlan add <list>', run: allowedHandler('add'), desc: 'Add VLANs to the current list', arg: 'VLAN IDs to add' },
    { p: 'switchport trunk allowed vlan all', run: allowedHandler('all'), desc: 'All VLANs' },
    { p: 'switchport trunk allowed vlan none', run: allowedHandler('none'), desc: 'No VLANs' },
    { p: 'switchport trunk allowed vlan remove <list>', run: allowedHandler('remove'), desc: 'Remove VLANs from the current list', arg: 'VLAN IDs to remove' },
    { p: 'switchport trunk native', desc: 'Set trunking native characteristics when interface is in trunking mode' },
    { p: 'switchport trunk native vlan <id>', run: cmdNative, desc: 'Set native VLAN when interface is in trunking mode', arg: 'VLAN ID of the native VLAN when this port is in trunking mode' }
  ];
  (function () {
    var tail = '';
    for (var k = 1; k <= 8; k++) {
      tail += ' <w>';
      IF_CMDS.push({ p: 'description' + tail, run: cmdDescription, arg: 'Up to 240 characters describing this interface' });
    }
  })();

  var TRIES = {
    user: buildTrie(USER_CMDS),
    priv: buildTrie(PRIV_CMDS),
    config: buildTrie(CONFIG_CMDS),
    'config-vlan': buildTrie(VLAN_CMDS),
    'config-if': buildTrie(IF_CMDS),
    'config-if-range': buildTrie(IF_CMDS)
  };

  // Sub-modes fall back to global config commands, like IOS does.
  var SUB_MODES = { 'config-vlan': true, 'config-if': true, 'config-if-range': true };
  var SUFFIX = { user: '>', priv: '#', config: '(config)#', 'config-vlan': '(config-vlan)#', 'config-if': '(config-if)#', 'config-if-range': '(config-if-range)#' };

  /* ---------- the switch ---------- */

  function SwitchSim(saved) {
    this.running = defaultConfig();
    this.startup = null;
    this.vlans = {};          // VLAN database (besides VLAN 1): { id: name }. Survives reload.
    this.flags = { priv: false, config: false, end: false };
    this.mode = 'user';
    this.pending = null;      // a question the switch is waiting on (password, [confirm], ...)
    this.curVlan = 1;         // VLAN being edited in config-vlan mode
    this.curIfs = [];         // interfaces being edited in config-if modes
    this.macTable = [];       // learned addresses: [{ vlan, mac, port }] (cleared on reload)
    this.portInfo = null;     // set by the network: () => [{ name, cabled, up, oper }]
    this.portsChanged = null; // set by the network: called after a port setting changes
    if (saved) this.load(saved);
  }

  SwitchSim.PORTS = PORTS;
  // The command-line machinery, shared with the router (router.js).
  SwitchSim.cli = { buildTrie: buildTrie, tokenize: tokenize, walk: walk, pad: pad, padLeft: padLeft, stable: stable, fakeHash: fakeHash, shortPort: shortPort };
  SwitchSim.allowedMarks = allowedMarks;

  function loadConfig(s) {
    var c = Object.assign(defaultConfig(), s);
    c.ports = sanitizePorts(s.ports);
    return c;
  }

  SwitchSim.prototype.load = function (s) {
    if (s.running) this.running = loadConfig(s.running);
    if (s.startup) this.startup = loadConfig(s.startup);
    if (s.flags) Object.assign(this.flags, s.flags);
    if (s.vlans && typeof s.vlans === 'object') {
      var self = this;
      Object.keys(s.vlans).forEach(function (k) {
        var id = Number(k);
        if (id > 1 && id <= 1001 && typeof s.vlans[k] === 'string') self.vlans[id] = s.vlans[k].slice(0, 32);
      });
    }
  };

  SwitchSim.prototype.toJSON = function () {
    return { running: this.running, startup: this.startup, flags: this.flags, vlans: this.vlans };
  };

  SwitchSim.prototype.setMode = function (m) {
    this.mode = m;
    if (m === 'priv') this.flags.priv = true;
    if (m === 'config') this.flags.config = true;
  };

  SwitchSim.prototype.portCfg = function (name) { return Object.assign(defaultPort(), this.running.ports[name]); };
  SwitchSim.prototype.vlanExists = function (id) { return id === 1 || this.vlans[id] !== undefined; };
  SwitchSim.prototype.vlanName = function (id) { return id === 1 ? 'default' : (this.vlans[id] || ''); };

  Object.defineProperty(SwitchSim.prototype, 'prompt', {
    get: function () {
      if (this.pending) return this.pending.prompt;
      return this.running.hostname + SUFFIX[this.mode];
    }
  });

  Object.defineProperty(SwitchSim.prototype, 'secretInput', {
    get: function () { return !!(this.pending && this.pending.secret); }
  });

  // True when the running-config differs from what would survive a reload.
  Object.defineProperty(SwitchSim.prototype, 'dirty', {
    get: function () { return !sameConfig(this.running, this.startup || defaultConfig()); }
  });

  SwitchSim.prototype.syntaxError = function (res, line) {
    if (res.error === 'ambiguous') return ['% Ambiguous command:  "' + line.trim() + '"'];
    return bad(this, res.token);
  };

  // Run one line. Returns an array of output lines.
  SwitchSim.prototype.exec = function (line) {
    if (this.pending) {
      var p = this.pending;
      this.pending = null;
      return p.submit(this, line) || [];
    }
    if (line.trim() === '') return [];
    if (/\?\s*$/.test(line)) return this.help(line);
    var tokens = tokenize(line);
    var res = walk(TRIES[this.mode], tokens);
    if (res.error === 'invalid' && SUB_MODES[this.mode]) {     // not a command here: try global config
      var g = walk(TRIES.config, tokens);
      if (!g.error) res = g;
    }
    if (res.error) return this.syntaxError(res, line);
    if (!res.node.run) return ['% Incomplete command.'];
    return res.node.run(this, res.args, res.argTokens) || [];
  };

  // Context help, like typing "?" in IOS.
  SwitchSim.prototype.help = function (line) {
    var body = line.replace(/\?\s*$/, '');
    var atWordStart = body.length === 0 || /\s$/.test(body);
    var tokens = tokenize(body);
    var prefix = atWordStart ? '' : tokens.pop().text.toLowerCase();
    var res = walk(TRIES[this.mode], tokens);
    if (res.error) return this.syntaxError(res, body);
    var n = res.node;
    var words = Object.keys(n.kids).sort().filter(function (w) { return w.indexOf(prefix) === 0; });
    if (prefix) return words.length ? [words.join('  ')] : ['% Unrecognized command'];
    var rows = words.map(function (w) { return '  ' + pad(w, 14) + n.kids[w].desc; });
    if (n.arg) rows.push('  ' + pad('WORD', 14) + n.arg.desc);
    if (n.run) rows.push('  ' + pad('<cr>', 14));
    return rows;
  };

  // Tab completion of the last word. Returns the (possibly unchanged) line.
  SwitchSim.prototype.complete = function (line) {
    if (this.pending) return line;
    var tokens = tokenize(line);
    if (!tokens.length || /\s$/.test(line)) return line;
    var last = tokens.pop();
    var res = walk(TRIES[this.mode], tokens);
    if (res.error) return line;
    var low = last.text.toLowerCase();
    var words = Object.keys(res.node.kids).filter(function (w) { return w.indexOf(low) === 0; });
    if (words.length !== 1) return line;
    return line.slice(0, last.index) + words[0] + ' ';
  };

  root.SwitchSim = SwitchSim;
  if (typeof module !== 'undefined' && module.exports) module.exports = { SwitchSim: SwitchSim };
})(typeof window !== 'undefined' ? window : globalThis);
