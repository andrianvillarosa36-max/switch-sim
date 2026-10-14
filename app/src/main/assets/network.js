/*
 * The network model: devices, their ports, and the cables between them.
 * No drawing code lives here, so it runs in Node tests too. Later stages
 * (PC addressing, ping, VLANs) extend this model.
 *
 * Device: { id, type: 'switch' | 'pc' | 'router', name, x, y, ... }
 *   switch: sw (SwitchSim), term (console state)
 *   router: rt (RouterSim), mac, arp (cache, not saved), term
 *   pc:     cfg { ip, mask, gateway }, mac, arp (cache, not saved),
 *           shell (command prompt), term (console state)
 *   term - { sw, log, hist, hi }: the thing a console is attached to
 * Link:   { id, a: { dev, port }, b: { dev, port } }
 */
(function (root) {
  'use strict';

  var SWITCH_PORTS = root.SwitchSim.PORTS.slice();   // the switch model defines its own ports
  var PC_PORTS = ['FastEthernet0'];
  var ROUTER_PORTS = root.RouterSim.PORTS.slice();
  var TYPES = { 'switch': SWITCH_PORTS, 'pc': PC_PORTS, 'router': ROUTER_PORTS };
  var PREFIX = { 'switch': 'SW', 'pc': 'PC', 'router': 'R' };

  function portsOf(type) { return TYPES[type] || []; }
  function shortPort(name) { return name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi'); }

  // A console's state: the shell (switch or PC) plus scrollback and command history.
  function target(sw) { return { sw: sw, log: [], hist: [], hi: 0 }; }

  function hex4(n) { var h = (n & 0xffff).toString(16); while (h.length < 4) h = '0' + h; return h; }

  // A stable, unique MAC address per device (the last group is the device number).
  function macFor(id) {
    var n = parseInt(String(id).slice(1), 10) || 0;
    return '0001.' + hex4(Math.imul(n + 7, 2654435761) >>> 16) + '.' + hex4(n);
  }

  function Network(data) {
    this.devices = [];
    this.links = [];
    this.nextId = 1;
    if (data) this.load(data);
  }

  Network.portsOf = portsOf;
  Network.shortPort = shortPort;
  Network.target = target;

  Network.prototype.get = function (id) {
    for (var i = 0; i < this.devices.length; i++) if (this.devices[i].id === id) return this.devices[i];
    return null;
  };

  Network.prototype.getLink = function (id) {
    for (var i = 0; i < this.links.length; i++) if (this.links[i].id === id) return this.links[i];
    return null;
  };

  Network.prototype.linksOf = function (devId) {
    return this.links.filter(function (l) { return l.a.dev === devId || l.b.dev === devId; });
  };

  Network.prototype.freshName = function (type) {
    var prefix = PREFIX[type] || 'DEV', n = 1, taken = {};
    this.devices.forEach(function (d) { taken[d.name.toLowerCase()] = true; });
    while (taken[(prefix + n).toLowerCase()]) n++;
    return prefix + n;
  };

  Network.prototype.add = function (type, x, y) {
    if (!TYPES[type]) throw new Error('Unknown device type: ' + type);
    var d = { id: 'd' + (this.nextId++), type: type, name: this.freshName(type), x: x, y: y };
    this._equip(d, null);
    this.devices.push(d);
    return d;
  };

  // Give a device its simulated internals. data = saved state or null.
  Network.prototype._equip = function (d, data) {
    var self = this;
    if (d.type === 'switch') {
      d.sw = new root.SwitchSim(data && data.sw);
      d.sw.portInfo = function () { return self.portStates(d.id); };
      d.sw.portsChanged = function () { self.purgeTables(); };
      d.term = target(d.sw);
    } else if (d.type === 'router') {
      d.mac = macFor(d.id);
      d.arp = {};
      d.rt = new root.RouterSim(data && data.rt);
      d.rt.ifaces = function () { return root.Netsim.routerIfaces(self, d); };
      d.rt.arp = function () { return d.arp; };
      d.rt.clearArp = function () { d.arp = {}; };
      d.rt.ping = function (ip) { return root.Netsim.pingOnce(self, d, ip); };
      d.rt.portsChanged = function () { self.purgeTables(); };
      d.term = target(d.rt);
    } else {
      d.cfg = { ip: '', mask: '', gateway: '' };
      d.mac = macFor(d.id);
      d.arp = {};
      d.shell = new root.PcShell(this, d);
      d.term = target(d.shell);
    }
  };

  // Ports of a switch: cabled (a cable is plugged in), up (the link works: no
  // end is shut down) and oper (operational mode, 'access' or 'trunk').
  Network.prototype.portStates = function (devId) {
    var d = this.get(devId), self = this, N = root.Netsim;
    if (!d || d.type !== 'switch') return [];
    return portsOf(d.type).map(function (p) {
      var link = N.linkAt(self, devId, p);
      return { name: p, cabled: !!link, up: !!link && N.linkUp(self, link), oper: N.operMode(self, d, p) };
    });
  };

  // Forget MAC addresses learned on ports whose link is not up any more
  // (cable removed, or either end shut down).
  Network.prototype.purgeTables = function () {
    var self = this;
    this.devices.forEach(function (d) {
      if (d.type !== 'switch') return;
      var up = self.portStates(d.id).filter(function (p) { return p.up; }).map(function (p) { return p.name; });
      d.sw.macTable = d.sw.macTable.filter(function (e) { return up.indexOf(e.port) !== -1; });
    });
  };

  // Short label for a port end on the canvas, e.g. "Fa0/1 v10" for an access port in VLAN 10.
  Network.prototype.portLabel = function (devId, port) {
    var d = this.get(devId), label = shortPort(port);
    if (d && d.type === 'switch') {
      var cfg = d.sw.portCfg(port);
      if (cfg.accessVlan !== 1 && root.Netsim.operMode(this, d, port) === 'access') label += ' v' + cfg.accessVlan;
    }
    return label;
  };

  // Apply a PC's IP settings. Returns an error message, or null on success.
  Network.prototype.setPcConfig = function (id, cfg) {
    var d = this.get(id);
    if (!d || d.type !== 'pc') return 'Device not found.';
    var others = [];
    this.devices.forEach(function (o) { if (o.type === 'pc' && o.id !== id && o.cfg.ip) others.push(o.cfg.ip); });
    var err = root.Netsim.validateConfig(cfg, others);
    if (err) return err;
    d.cfg = root.Netsim.normalize(cfg);
    d.arp = {};
    return null;
  };

  Network.prototype.usedPorts = function (devId) {
    var used = [];
    this.linksOf(devId).forEach(function (l) {
      if (l.a.dev === devId) used.push(l.a.port);
      if (l.b.dev === devId) used.push(l.b.port);
    });
    return used;
  };

  Network.prototype.freePort = function (dev) {
    var used = this.usedPorts(dev.id), ports = portsOf(dev.type);
    for (var i = 0; i < ports.length; i++) if (used.indexOf(ports[i]) === -1) return ports[i];
    return null;
  };

  // Cable two devices using the first free port on each. Returns { link } or { error }.
  Network.prototype.connect = function (aId, bId) {
    var a = this.get(aId), b = this.get(bId);
    if (!a || !b) return { error: 'Device not found.' };
    if (a === b) return { error: 'Pick two different devices.' };
    var pa = this.freePort(a);
    if (!pa) return { error: 'No free ports on ' + a.name + '.' };
    var pb = this.freePort(b);
    if (!pb) return { error: 'No free ports on ' + b.name + '.' };
    var link = { id: 'l' + (this.nextId++), a: { dev: a.id, port: pa }, b: { dev: b.id, port: pb } };
    this.links.push(link);
    return { link: link };
  };

  Network.prototype.removeLink = function (id) {
    this.links = this.links.filter(function (l) { return l.id !== id; });
    this.purgeTables();
  };

  Network.prototype.removeDevice = function (id) {
    this.devices = this.devices.filter(function (d) { return d.id !== id; });
    this.links = this.links.filter(function (l) { return l.a.dev !== id && l.b.dev !== id; });
    this.purgeTables();
  };

  // Returns an error message, or null when the rename worked.
  Network.prototype.rename = function (id, name) {
    var d = this.get(id);
    if (!d) return 'Device not found.';
    var n = String(name).trim();
    if (!n) return 'Name cannot be empty.';
    if (n.length > 14) return 'Use 14 characters or fewer.';
    var clash = this.devices.some(function (o) { return o.id !== id && o.name.toLowerCase() === n.toLowerCase(); });
    if (clash) return 'That name is already used.';
    d.name = n;
    return null;
  };

  Network.prototype.clear = function () {
    this.devices = [];
    this.links = [];
  };

  Network.prototype.toJSON = function () {
    return {
      nextId: this.nextId,
      devices: this.devices.map(function (d) {
        var o = { id: d.id, type: d.type, name: d.name, x: d.x, y: d.y };
        if (d.sw) o.sw = d.sw.toJSON();
        if (d.rt) o.rt = d.rt.toJSON();
        if (d.type === 'pc') o.cfg = { ip: d.cfg.ip, mask: d.cfg.mask, gateway: d.cfg.gateway };
        return o;
      }),
      links: this.links.map(function (l) {
        return { id: l.id, a: { dev: l.a.dev, port: l.a.port }, b: { dev: l.b.dev, port: l.b.port } };
      })
    };
  };

  // Rebuild from saved data, skipping anything that does not make sense.
  Network.prototype.load = function (data) {
    var self = this, maxId = 0, seen = {};
    this.devices = [];
    this.links = [];

    function bump(id) { var m = /^[dl](\d+)$/.exec(id); if (m) maxId = Math.max(maxId, Number(m[1])); }

    (data.devices || []).forEach(function (o) {
      if (!o || !TYPES[o.type] || typeof o.id !== 'string' || seen[o.id]) return;
      seen[o.id] = true;
      var d = {
        id: o.id, type: o.type,
        name: String(o.name || o.id).slice(0, 14),
        x: isFinite(o.x) ? Number(o.x) : 0,
        y: isFinite(o.y) ? Number(o.y) : 0
      };
      self._equip(d, o);
      if (d.type === 'pc' && o.cfg) {
        var others = self.devices.filter(function (x) { return x.type === 'pc' && x.cfg.ip; }).map(function (x) { return x.cfg.ip; });
        if (root.Netsim.validateConfig(o.cfg, others) === null) d.cfg = root.Netsim.normalize(o.cfg);
      }
      bump(d.id);
      self.devices.push(d);
    });

    (data.links || []).forEach(function (l) {
      if (!l || !l.a || !l.b || typeof l.id !== 'string') return;
      var a = self.get(l.a.dev), b = self.get(l.b.dev);
      if (!a || !b || a === b) return;
      if (portsOf(a.type).indexOf(l.a.port) === -1 || portsOf(b.type).indexOf(l.b.port) === -1) return;
      if (self.usedPorts(a.id).indexOf(l.a.port) !== -1 || self.usedPorts(b.id).indexOf(l.b.port) !== -1) return;
      bump(l.id);
      self.links.push({ id: l.id, a: { dev: a.id, port: l.a.port }, b: { dev: b.id, port: l.b.port } });
    });

    this.nextId = Math.max(Number(data.nextId) || 1, maxId + 1);
  };

  root.Network = Network;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Network: Network };
})(typeof window !== 'undefined' ? window : globalThis);
