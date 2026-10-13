/*
 * The network model: devices, their ports, and the cables between them.
 * No drawing code lives here, so it runs in Node tests too. Later stages
 * (PC addressing, ping, VLANs) extend this model.
 *
 * Device: { id, type: 'switch' | 'pc', name, x, y, sw?, term? }
 *   sw   - the simulated switch (SwitchSim) for switches
 *   term - that switch's console state { sw, log, hist, hi }
 * Link:   { id, a: { dev, port }, b: { dev, port } }
 */
(function (root) {
  'use strict';

  var SWITCH_PORTS = (function () {
    var list = [], i;
    for (i = 1; i <= 24; i++) list.push('FastEthernet0/' + i);
    list.push('GigabitEthernet0/1', 'GigabitEthernet0/2');
    return list;
  })();
  var PC_PORTS = ['FastEthernet0'];
  var TYPES = { 'switch': SWITCH_PORTS, 'pc': PC_PORTS };
  var PREFIX = { 'switch': 'SW', 'pc': 'PC' };

  function portsOf(type) { return TYPES[type] || []; }
  function shortPort(name) { return name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi'); }

  // A console's state: the switch plus its scrollback and command history.
  function target(sw) { return { sw: sw, log: [], hist: [], hi: 0 }; }

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
    if (type === 'switch') { d.sw = new root.SwitchSim(); d.term = target(d.sw); }
    this.devices.push(d);
    return d;
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
  };

  Network.prototype.removeDevice = function (id) {
    this.devices = this.devices.filter(function (d) { return d.id !== id; });
    this.links = this.links.filter(function (l) { return l.a.dev !== id && l.b.dev !== id; });
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
      if (d.type === 'switch') { d.sw = new root.SwitchSim(o.sw); d.term = target(d.sw); }
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
