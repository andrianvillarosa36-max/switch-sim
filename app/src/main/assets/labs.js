/*
 * Saved labs: named snapshots of a network, plus share codes.
 *
 * A lab stores the network JSON (Network.toJSON(): devices, cables, switch and
 * router configs, PC settings). It does not store the zoom/pan, ARP caches,
 * MAC tables or packet traces, which are rebuilt when a lab is opened.
 *
 * Share code: "SwitchSimLab1|<name>|<base64 of the network JSON>". Plain text,
 * so it can be pasted into any chat app.
 */
(function (root) {
  'use strict';

  var KEY = 'switchsim.labs.v1';
  var PREFIX = 'SwitchSimLab1';
  var MAX_LABS = 50;
  var MAX_BYTES = 400000;
  var MAX_DEVICES = 60;

  /* ---------- helpers ---------- */

  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }

  // The part of a network that counts as "changed": console mode flags do not.
  function comparable(net) {
    var c = JSON.parse(JSON.stringify(net || {}));
    (c.devices || []).forEach(function (d) { if (d.sw) delete d.sw.flags; });
    delete c.nextId;
    return stable(c);
  }

  function b64encode(text) {
    var bin = unescape(encodeURIComponent(text));
    return (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64'));
  }
  function b64decode(b64) {
    var bin = (typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'));
    return decodeURIComponent(escape(bin));
  }

  function cleanName(name) {
    return String(name || '').replace(/[|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function validNet(net) {
    return !!net && typeof net === 'object' && Array.isArray(net.devices) && net.devices.length <= MAX_DEVICES &&
      (net.links === undefined || Array.isArray(net.links));
  }

  function newId() { return 'l' + Date.now().toString(36) + Math.floor(Math.random() * 1679616).toString(36); }

  /* ---------- the store ---------- */

  // storage: anything with getItem(key) and setItem(key, value), such as localStorage.
  function Labs(storage) {
    this.s = storage;
    this.db = this._read();
  }

  Labs.prototype._read = function () {
    try {
      var d = JSON.parse(this.s.getItem(KEY));
      if (d && Array.isArray(d.labs)) {
        return { labs: d.labs.filter(function (l) { return l && typeof l.id === 'string' && typeof l.name === 'string' && validNet(l.net); }) };
      }
    } catch (e) { /* start empty */ }
    return { labs: [] };
  };

  Labs.prototype._write = function () {
    try { this.s.setItem(KEY, JSON.stringify(this.db)); return true; } catch (e) { return false; }
  };

  // Newest first (labs saved in the same millisecond keep their save order).
  Labs.prototype.list = function () {
    var order = this.db.labs;
    return order.slice().sort(function (a, b) { return (b.saved - a.saved) || (order.indexOf(b) - order.indexOf(a)); });
  };

  Labs.prototype.get = function (id) {
    for (var i = 0; i < this.db.labs.length; i++) if (this.db.labs[i].id === id) return this.db.labs[i];
    return null;
  };

  Labs.prototype.uniqueName = function (name) {
    var base = cleanName(name) || 'Untitled lab', taken = {}, n = 2, out = base;
    this.db.labs.forEach(function (l) { taken[l.name.toLowerCase()] = true; });
    while (taken[out.toLowerCase()]) out = base.slice(0, 36) + ' ' + (n++);
    return out;
  };

  // Returns { id, name } or { error }.
  Labs.prototype.save = function (name, net) {
    if (!validNet(net)) return { error: 'There is nothing to save.' };
    if (this.db.labs.length >= MAX_LABS) return { error: 'You can keep up to ' + MAX_LABS + ' labs. Delete one first.' };
    var copy = JSON.parse(JSON.stringify(net));
    if (JSON.stringify(copy).length > MAX_BYTES) return { error: 'This lab is too large to save.' };
    var lab = { id: newId(), name: this.uniqueName(name), saved: Date.now(), net: copy };
    this.db.labs.push(lab);
    if (!this._write()) { this.db.labs.pop(); return { error: 'Could not save: the phone storage is full or blocked.' }; }
    return { id: lab.id, name: lab.name };
  };

  Labs.prototype.update = function (id, net) {
    var lab = this.get(id);
    if (!lab) return { error: 'That lab no longer exists.' };
    if (!validNet(net)) return { error: 'There is nothing to save.' };
    var before = { net: lab.net, saved: lab.saved };
    lab.net = JSON.parse(JSON.stringify(net));
    lab.saved = Date.now();
    if (!this._write()) { lab.net = before.net; lab.saved = before.saved; return { error: 'Could not save: the phone storage is full or blocked.' }; }
    return { id: id, name: lab.name };
  };

  Labs.prototype.remove = function (id) {
    this.db.labs = this.db.labs.filter(function (l) { return l.id !== id; });
    this._write();
  };

  Labs.prototype.isModified = function (id, net) {
    var lab = this.get(id);
    return !lab || comparable(lab.net) !== comparable(net);
  };

  Labs.prototype.summary = function (lab) {
    return { devices: lab.net.devices.length, cables: (lab.net.links || []).length };
  };

  /* ---------- share codes ---------- */

  Labs.encode = function (name, net) {
    return PREFIX + '|' + cleanName(name) + '|' + b64encode(JSON.stringify(net));
  };

  // Returns { name, net } or { error }.
  Labs.decode = function (text) {
    var t = String(text || '').trim();
    if (!t) return { error: 'Paste a lab code first.' };
    var m = /^SwitchSimLab1\|([^|]*)\|([A-Za-z0-9+\/=\s]+)$/.exec(t);
    if (!m) return { error: 'That is not a Switch Sim lab code.' };
    if (m[2].length > MAX_BYTES * 1.4) return { error: 'That lab is too large.' };
    var net;
    try { net = JSON.parse(b64decode(m[2].replace(/\s+/g, ''))); } catch (e) { return { error: 'The code is damaged. Copy the whole text again.' }; }
    if (!validNet(net)) return { error: 'The code does not contain a valid lab.' };
    return { name: cleanName(m[1]) || 'Imported lab', net: net };
  };

  Labs.comparable = comparable;
  Labs.cleanName = cleanName;

  root.Labs = Labs;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Labs: Labs };
})(typeof window !== 'undefined' ? window : globalThis);
