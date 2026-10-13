/*
 * Simulated Cisco IOS switch console.
 *
 * Scope (Lesson 1): user / privileged / global-config modes, hostname,
 * enable secret + enable password, running-config vs startup-config,
 * reload, and IOS-style abbreviations, "?" help and error messages.
 *
 * To add commands for later lessons, add an entry to USER_CMDS, PRIV_CMDS or
 * CONFIG_CMDS (or a new mode) below. Pattern syntax: words are keywords,
 * <name> is a free-text argument.
 *
 * Runs in the Android WebView and in Node (see tests/engine.test.js).
 */
(function (root) {
  'use strict';

  /* ---------- config helpers ---------- */

  function defaultConfig() { return { hostname: 'Switch', secret: null, password: null }; }
  function clone(c) { return { hostname: c.hostname, secret: c.secret, password: c.password }; }
  function sameConfig(a, b) {
    return a.hostname === b.hostname && a.secret === b.secret && a.password === b.password;
  }
  function pad(s, n) { while (s.length < n) s += ' '; return s; }
  function padLeft(s, n) { while (s.length < n) s = ' ' + s; return s; }
  function shortPort(n) { return n.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi'); }

  // Looks like an IOS "type 5" hash. Simulated only, not a real hash.
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

  // Walk tokens through the tree. IOS rules: an exact keyword wins, otherwise
  // a unique prefix works, several matches is "ambiguous".
  function walk(trie, tokens) {
    var n = trie, args = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i], low = t.text.toLowerCase();
      var words = Object.keys(n.kids);
      var hits = words.indexOf(low) !== -1 ? [low] : words.filter(function (w) { return w.indexOf(low) === 0; });
      if (hits.length === 1) { n = n.kids[hits[0]]; continue; }
      if (hits.length > 1) return { error: 'ambiguous', token: t };
      if (n.arg) { args.push(t.text); n = n.arg.node; continue; }
      return { error: 'invalid', token: t };
    }
    return { node: n, args: args };
  }

  /* ---------- commands ---------- */

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

  function cmdEnterConfig(sw) {
    sw.setMode('config');
    return ['Enter configuration commands, one per line.  End with CNTL/Z.'];
  }

  function cmdEnd(sw) { sw.flags.end = true; sw.setMode('priv'); return []; }
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

  function cmdShowRun(sw) {
    var body = configBody(sw.running);
    return ['Building configuration...', '', 'Current configuration : ' + body.join('\n').length + ' bytes'].concat(body);
  }

  function cmdShowStart(sw) {
    if (!sw.startup) return ['startup-config is not present'];
    var body = configBody(sw.startup);
    return ['Using ' + body.join('\n').length + ' out of 65536 bytes'].concat(body);
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

  // Column spacing is a little tighter than a real switch so the table fits a phone screen.
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
      var gig = p.name.indexOf('Gigabit') === 0, up = p.connected;
      L.push(pad(shortPort(p.name), 7) + pad(up ? 'connected' : 'notconnect', 12) + pad('1', 6) +
        pad(up ? 'a-full' : 'auto', 7) + (up ? (gig ? 'a-1000' : 'a-100') : 'auto'));
    });
    return L;
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
    { p: 'show mac', desc: 'MAC configuration' },
    { p: 'show mac address-table', run: cmdShowMac, desc: 'MAC forwarding table' },
    { p: 'show mac-address-table', run: cmdShowMac, desc: 'MAC forwarding table' },
    { p: 'show running-config', run: cmdShowRun, desc: 'Current operating configuration' },
    { p: 'show startup-config', run: cmdShowStart, desc: 'Contents of the startup configuration' },
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
    { p: 'no', desc: 'Negate a command or set its defaults' },
    { p: 'no enable', desc: 'Modify enable password parameters' },
    { p: 'no enable password', run: cmdNoPassword, desc: 'Assign the privileged level password (plain text)' },
    { p: 'no enable secret', run: cmdNoSecret, desc: 'Assign the privileged level secret' },
    { p: 'no hostname', run: cmdNoHostname, desc: "Set the system's network name" }
  ];

  var TRIES = {
    user: buildTrie(USER_CMDS),
    priv: buildTrie(PRIV_CMDS),
    config: buildTrie(CONFIG_CMDS)
  };

  /* ---------- the switch ---------- */

  function SwitchSim(saved) {
    this.running = defaultConfig();
    this.startup = null;
    this.flags = { priv: false, config: false, end: false };
    this.mode = 'user';       // 'user' | 'priv' | 'config'
    this.pending = null;      // a question the switch is waiting on (password, [confirm], ...)
    this.macTable = [];       // learned addresses: [{ vlan, mac, port }] (cleared on reload)
    this.portInfo = null;     // set by the network: () => [{ name, connected }]
    if (saved) this.load(saved);
  }

  SwitchSim.prototype.load = function (s) {
    if (s.running) this.running = Object.assign(defaultConfig(), s.running);
    if (s.startup) this.startup = Object.assign(defaultConfig(), s.startup);
    if (s.flags) Object.assign(this.flags, s.flags);
  };

  SwitchSim.prototype.toJSON = function () {
    return { running: this.running, startup: this.startup, flags: this.flags };
  };

  SwitchSim.prototype.setMode = function (m) {
    this.mode = m;
    if (m === 'priv') this.flags.priv = true;
    if (m === 'config') this.flags.config = true;
  };

  Object.defineProperty(SwitchSim.prototype, 'prompt', {
    get: function () {
      if (this.pending) return this.pending.prompt;
      var h = this.running.hostname;
      return h + (this.mode === 'user' ? '>' : this.mode === 'priv' ? '#' : '(config)#');
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
    var caret = new Array(this.prompt.length + res.token.index + 1).join(' ') + '^';
    return [caret, "% Invalid input detected at '^' marker.", ''];
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
    var res = walk(TRIES[this.mode], tokenize(line));
    if (res.error) return this.syntaxError(res, line);
    if (!res.node.run) return ['% Incomplete command.'];
    return res.node.run(this, res.args) || [];
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
