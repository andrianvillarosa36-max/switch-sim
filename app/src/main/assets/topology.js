/*
 * The network canvas. Draws a Network (see network.js) as SVG and handles
 * touch: drag a device to move it, drag the background to pan, pinch to zoom,
 * tap to select, Cable mode to connect two devices, double-tap a device to
 * open it (a switch console, or a PC's settings and command prompt).
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var GRID = 28;
  var MIN_S = 0.4;
  var MAX_S = 2.5;
  var MOVE_SLOP = 6;       // px a finger must travel before a tap becomes a drag
  var DOUBLE_TAP_MS = 350;

  /* ---------- small DOM helpers ---------- */

  function S(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function H(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  /* ---------- device icons (drawn around 0,0) ---------- */

  function icon(type) {
    var g = S('g');
    if (type === 'switch') {
      S('rect', { 'class': 'ic-body', x: -36, y: -14, width: 72, height: 28, rx: 4 }, g);
      for (var i = 0; i < 8; i++) S('rect', { 'class': 'ic-port', x: -30 + i * 8, y: 1, width: 6, height: 6, rx: 1 }, g);
      S('circle', { 'class': 'ic-led', cx: -29, cy: -8, r: 2 }, g);
      S('circle', { 'class': 'ic-led warm', cx: -22, cy: -8, r: 2 }, g);
    } else {
      S('rect', { 'class': 'ic-body', x: -18, y: -18, width: 36, height: 26, rx: 3 }, g);
      S('rect', { 'class': 'ic-screen', x: -14, y: -14, width: 28, height: 18, rx: 1 }, g);
      S('rect', { 'class': 'ic-stand', x: -4, y: 8, width: 8, height: 6 }, g);
      S('rect', { 'class': 'ic-stand', x: -12, y: 14, width: 24, height: 3, rx: 1 }, g);
    }
    return g;
  }

  function iconSvg(kind) {
    var svg = S('svg', { viewBox: '-40 -22 80 44', 'aria-hidden': 'true' });
    if (kind === 'cable') {
      S('line', { 'class': 'cable', x1: -30, y1: 8, x2: 30, y2: -8 }, svg);
      S('circle', { 'class': 'portdot', cx: -30, cy: 8, r: 6 }, svg);
      S('circle', { 'class': 'portdot', cx: 30, cy: -8, r: 6 }, svg);
    } else {
      svg.appendChild(icon(kind));
    }
    return svg;
  }

  /* ---------- the controller ---------- */

  // refs: { svg, world, links, devs, bar, toolbar, cable, addSwitch, addPc, clear, fit }
  // hooks: { onChange(), openConsole(device) }
  function Topology(refs, hooks) {
    this.r = refs;
    this.h = hooks || {};
    this.net = new root.Network();
    this.view = { x: 0, y: 0, s: 1, set: false };
    this.ui = { tool: 'move', sel: null, from: null, editing: false, draft: null, confirm: null, clearArmed: false, msg: '' };
    this.ptrs = {};
    this.g = null;
    this._raf = 0;
    this._saveTimer = 0;
    this._clearTimer = 0;
    this._lastTap = { id: null, t: 0 };

    var icons = refs.toolbar.querySelectorAll('.ico');
    for (var i = 0; i < icons.length; i++) icons[i].appendChild(iconSvg(icons[i].getAttribute('data-icon')));

    this._bind();
    this.render();
  }

  Topology.prototype.toJSON = function () {
    var v = this.view;
    return { net: this.net.toJSON(), view: { x: v.x, y: v.y, s: v.s, set: v.set } };
  };

  Topology.prototype.load = function (data) {
    if (!data) return;
    this.net = new root.Network(data.net || {});
    var v = data.view;
    if (v && isFinite(v.x) && isFinite(v.y) && isFinite(v.s) && v.s > 0) {
      this.view = { x: Number(v.x), y: Number(v.y), s: clamp(Number(v.s), MIN_S, MAX_S), set: !!v.set };
    }
    this.ui.sel = null;
    this.ui.from = null;
    this.ui.editing = false;
    this.render();
  };

  Topology.prototype._changed = function () { if (this.h.onChange) this.h.onChange(); };

  Topology.prototype._changedSoon = function () {
    var self = this;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () { self._changed(); }, 400);
  };

  /* ---------- view math ---------- */

  Topology.prototype.local = function (e) {
    var rect = this.r.svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  Topology.prototype.toWorld = function (p) {
    return { x: (p.x - this.view.x) / this.view.s, y: (p.y - this.view.y) / this.view.s };
  };

  Topology.prototype.applyView = function () {
    var v = this.view;
    this.r.world.setAttribute('transform', 'translate(' + v.x + ' ' + v.y + ') scale(' + v.s + ')');
    var st = this.r.svg.style, step = GRID * v.s;
    st.backgroundSize = step + 'px ' + step + 'px';
    st.backgroundPosition = v.x + 'px ' + v.y + 'px';
  };

  // Call when the canvas becomes visible: puts the origin in the middle the first time.
  Topology.prototype.ensureView = function () {
    if (!this.view.set) {
      var rect = this.r.svg.getBoundingClientRect();
      if (!rect.width) return;
      this.view = { x: rect.width / 2, y: rect.height / 2, s: 1, set: true };
    }
    this.applyView();
  };

  Topology.prototype.zoomAt = function (p, factor) {
    var v = this.view, w = this.toWorld(p), s = clamp(v.s * factor, MIN_S, MAX_S);
    v.x = p.x - w.x * s;
    v.y = p.y - w.y * s;
    v.s = s;
    this.applyView();
  };

  Topology.prototype.fit = function () {
    var rect = this.r.svg.getBoundingClientRect(), devs = this.net.devices, v = this.view;
    if (!rect.width) return;
    if (!devs.length) {
      this.view = { x: rect.width / 2, y: rect.height / 2, s: 1, set: true };
    } else {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      devs.forEach(function (d) {
        minX = Math.min(minX, d.x - 46); maxX = Math.max(maxX, d.x + 46);
        minY = Math.min(minY, d.y - 30); maxY = Math.max(maxY, d.y + 56);
      });
      var s = clamp(Math.min(1.2, (rect.width - 40) / (maxX - minX), (rect.height - 40) / (maxY - minY)), MIN_S, MAX_S);
      this.view = { x: rect.width / 2 - ((minX + maxX) / 2) * s, y: rect.height / 2 - ((minY + maxY) / 2) * s, s: s, set: true };
    }
    this.applyView();
    this._changed();
  };

  Topology.prototype.visibleCenter = function () {
    var rect = this.r.svg.getBoundingClientRect();
    if (!rect.width) return { x: 0, y: 0 };
    return this.toWorld({ x: rect.width / 2, y: rect.height / 2 });
  };

  // Nearest empty spot around c, spiralling outward.
  Topology.prototype.freeSpot = function (c) {
    var devs = this.net.devices;
    for (var k = 0; k <= 5; k++) {
      for (var dx = -k; dx <= k; dx++) {
        for (var dy = -k; dy <= k; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
          var x = Math.round(c.x + dx * 100), y = Math.round(c.y + dy * 84);
          var taken = devs.some(function (d) { return Math.abs(d.x - x) < 90 && Math.abs(d.y - y) < 70; });
          if (!taken) return { x: x, y: y };
        }
      }
    }
    return { x: Math.round(c.x), y: Math.round(c.y) };
  };

  /* ---------- drawing ---------- */

  Topology.prototype.render = function () {
    this.applyView();
    this.drawCanvas();
    this.renderBar();
    this.r.cable.setAttribute('aria-pressed', String(this.ui.tool === 'cable'));
    this.r.clear.textContent = this.ui.clearArmed ? 'Tap to clear' : 'Clear';
  };

  Topology.prototype.requestDraw = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.drawCanvas(); });
  };

  Topology.prototype.drawCanvas = function () {
    var net = this.net, ui = this.ui, r = this.r;
    r.links.textContent = '';
    r.devs.textContent = '';

    net.links.forEach(function (l) {
      var a = net.get(l.a.dev), b = net.get(l.b.dev);
      if (!a || !b) return;
      var selected = ui.sel && ui.sel.kind === 'link' && ui.sel.id === l.id;
      var g = S('g', { 'data-kind': 'link', 'data-id': l.id }, r.links);
      S('line', { 'class': 'hit-line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, g);
      S('line', { 'class': 'cable' + (selected ? ' sel' : ''), x1: a.x, y1: a.y, x2: b.x, y2: b.y }, g);

      var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) return;
      var ux = dx / len, uy = dy / len;
      function end(dev, sx, sy, port) {
        var dotR = Math.min(46, len * 0.28), labR = Math.min(60, len * 0.4);
        S('circle', { 'class': 'portdot', cx: dev.x + sx * dotR, cy: dev.y + sy * dotR, r: 4.5 }, g);
        var t = S('text', { 'class': 'portlabel', x: dev.x + sx * labR - sy * 10, y: dev.y + sy * labR + sx * 10 + 3, 'text-anchor': 'middle' }, g);
        t.textContent = root.Network.shortPort(port);
      }
      end(a, ux, uy, l.a.port);
      end(b, -ux, -uy, l.b.port);
    });

    net.devices.forEach(function (d) {
      var selected = ui.sel && ui.sel.kind === 'dev' && ui.sel.id === d.id;
      var from = ui.tool === 'cable' && ui.from === d.id;
      var g = S('g', { 'class': 'dev', 'data-kind': 'dev', 'data-id': d.id, transform: 'translate(' + d.x + ' ' + d.y + ')' }, r.devs);
      var hasIp = d.type === 'pc' && d.cfg && d.cfg.ip;
      S('rect', { 'class': 'hit', x: -44, y: -24, width: 88, height: 80 }, g);
      if (selected || from) {
        S('rect', { 'class': 'selring' + (from ? ' from' : ''), x: -42, y: -22, width: 84, height: hasIp ? 76 : 62, rx: 8 }, g);
      }
      g.appendChild(icon(d.type));
      S('text', { 'class': 'label', y: 34, 'text-anchor': 'middle' }, g).textContent = d.name;
      if (hasIp) S('text', { 'class': 'iplabel', y: 47, 'text-anchor': 'middle' }, g).textContent = d.cfg.ip;
    });
  };

  /* ---------- selection bar ---------- */

  Topology.prototype._btn = function (label, cls, fn) {
    var b = H('button', 'abtn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  Topology.prototype.renderBar = function () {
    var self = this, ui = this.ui, net = this.net, bar = this.r.bar;
    bar.textContent = '';
    var info = H('div', 'nbinfo'), acts = H('div', 'nbacts');
    bar.appendChild(info);
    bar.appendChild(acts);
    function title(t) { info.appendChild(H('span', 'nbtitle', t)); }
    function sub(t, cls) { info.appendChild(H('span', 'nbsub' + (cls ? ' ' + cls : ''), t)); }

    if (ui.tool === 'cable') {
      title('Cable');
      sub(ui.msg || (ui.from ? 'Now tap the second device.' : 'Tap the first device.'));
      acts.appendChild(this._btn('Done', 'primary', function () {
        ui.tool = 'move'; ui.from = null; ui.msg = '';
        self.render();
      }));
      return;
    }

    var sel = ui.sel, d = sel && sel.kind === 'dev' ? net.get(sel.id) : null;

    if (d && ui.editing) {
      var input = H('input', 'rename');
      input.type = 'text';
      input.maxLength = 14;
      input.value = ui.draft !== null ? ui.draft : d.name;
      input.setAttribute('aria-label', 'Device name');
      input.setAttribute('autocapitalize', 'none');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      info.appendChild(input);
      if (ui.msg) sub(ui.msg, 'bad');
      var save = function () {
        var err = net.rename(d.id, input.value);
        if (err) { ui.msg = err; ui.draft = input.value; self.renderBar(); return; }
        ui.editing = false; ui.draft = null; ui.msg = '';
        self.render();
        self._changed();
      };
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      acts.appendChild(this._btn('Save', 'primary', save));
      acts.appendChild(this._btn('Cancel', '', function () {
        ui.editing = false; ui.draft = null; ui.msg = '';
        self.renderBar();
      }));
      input.focus();
      input.select();
      return;
    }

    if (d) {
      var n = net.linksOf(d.id).length;
      title(d.name);
      sub((d.type === 'switch' ? 'Switch' : d.cfg.ip ? 'PC, ' + d.cfg.ip : 'PC, no IP address') +
        ', ' + n + (n === 1 ? ' cable' : ' cables'));
      acts.appendChild(this._btn(d.type === 'switch' ? 'Console' : 'Open', 'primary', function () {
        self._lastTap = { id: null, t: 0 };
        if (self.h.openConsole) self.h.openConsole(d);
      }));
      acts.appendChild(this._btn('Rename', '', function () {
        ui.editing = true; ui.draft = null; ui.msg = ''; ui.confirm = null;
        self.renderBar();
      }));
      acts.appendChild(this._btn(ui.confirm === d.id ? 'Tap to delete' : 'Delete', 'danger', function () {
        if (ui.confirm !== d.id) { ui.confirm = d.id; self.renderBar(); return; }
        net.removeDevice(d.id);
        ui.sel = null; ui.confirm = null;
        self.render();
        self._changed();
      }));
      return;
    }

    var link = sel && sel.kind === 'link' ? net.getLink(sel.id) : null;
    if (link) {
      var la = net.get(link.a.dev), lb = net.get(link.b.dev);
      title(la.name + ' ' + root.Network.shortPort(link.a.port) + ' to ' + lb.name + ' ' + root.Network.shortPort(link.b.port));
      sub('Cable');
      acts.appendChild(this._btn('Delete cable', 'danger', function () {
        net.removeLink(link.id);
        ui.sel = null;
        self.render();
        self._changed();
      }));
      return;
    }

    sub(ui.msg || (net.devices.length
      ? 'Tap a device to select it. Drag to move, pinch to zoom.'
      : 'Add a switch or PC to begin.'));
  };

  /* ---------- actions ---------- */

  Topology.prototype.addDevice = function (type) {
    this.ensureView();
    var spot = this.freeSpot(this.visibleCenter());
    var d = this.net.add(type, spot.x, spot.y);
    this.ui = { tool: 'move', sel: { kind: 'dev', id: d.id }, from: null, editing: false, draft: null, confirm: null, clearArmed: false, msg: '' };
    this.render();
    this._changed();
  };

  Topology.prototype._cableTap = function (id) {
    var ui = this.ui, net = this.net;
    if (!ui.from) { ui.from = id; ui.msg = ''; return; }
    if (ui.from === id) { ui.from = null; return; }
    var res = net.connect(ui.from, id);
    if (res.error) {
      ui.msg = res.error;
    } else {
      var a = net.get(res.link.a.dev), b = net.get(res.link.b.dev), P = root.Network.shortPort;
      ui.msg = 'Connected ' + a.name + ' ' + P(res.link.a.port) + ' to ' + b.name + ' ' + P(res.link.b.port) + '.';
      this._changed();
    }
    ui.from = null;
  };

  Topology.prototype._tap = function (hit) {
    var ui = this.ui, now = Date.now();
    ui.msg = ''; ui.confirm = null; ui.clearArmed = false; ui.editing = false; ui.draft = null;

    if (ui.tool === 'cable') {
      if (hit && hit.kind === 'dev') this._cableTap(hit.id); else ui.from = null;
      this.render();
      return;
    }

    var dbl = hit && hit.kind === 'dev' && this._lastTap.id === hit.id && now - this._lastTap.t < DOUBLE_TAP_MS;
    this._lastTap = { id: hit ? hit.id : null, t: now };
    ui.sel = hit;
    this.render();
    if (dbl) {
      this._lastTap = { id: null, t: 0 };
      var d = this.net.get(hit.id);
      if (d && this.h.openConsole) this.h.openConsole(d);
    }
  };

  /* ---------- touch handling ---------- */

  Topology.prototype._hit = function (node) {
    var n = node && node.closest ? node.closest('[data-kind]') : null;
    return n ? { kind: n.getAttribute('data-kind'), id: n.getAttribute('data-id') } : null;
  };

  Topology.prototype._startPinch = function () {
    var ids = Object.keys(this.ptrs), a = this.ptrs[ids[0]], b = this.ptrs[ids[1]];
    var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.g = {
      type: 'pinch', ids: ids,
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      s0: this.view.s,
      w0: this.toWorld(mid)
    };
  };

  Topology.prototype._bind = function () {
    var self = this, r = this.r, svg = r.svg;

    svg.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      self.ptrs[e.pointerId] = self.local(e);
      var count = Object.keys(self.ptrs).length;
      if (count === 2) { self._startPinch(); return; }
      if (count > 2) return;
      var hit = self._hit(e.target), p = self.ptrs[e.pointerId];
      if (hit && hit.kind === 'dev') {
        var d = self.net.get(hit.id), w = self.toWorld(p);
        self.g = { type: 'drag', hit: hit, dev: d, dx: d.x - w.x, dy: d.y - w.y, start: p, moved: false };
      } else {
        self.g = { type: 'pan', hit: hit, start: p, vx: self.view.x, vy: self.view.y, moved: false };
      }
    });

    svg.addEventListener('pointermove', function (e) {
      if (!self.ptrs[e.pointerId]) return;
      var p = self.local(e);
      self.ptrs[e.pointerId] = p;
      var g = self.g;
      if (!g) return;

      if (g.type === 'pinch') {
        var a = self.ptrs[g.ids[0]], b = self.ptrs[g.ids[1]];
        if (!a || !b) return;
        var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        var s = clamp(g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, MIN_S, MAX_S);
        self.view.s = s;
        self.view.x = mid.x - g.w0.x * s;
        self.view.y = mid.y - g.w0.y * s;
        self.applyView();
        return;
      }

      var dx = p.x - g.start.x, dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < MOVE_SLOP) return;
      g.moved = true;

      if (g.type === 'drag') {
        if (self.ui.tool === 'move' && !(self.ui.sel && self.ui.sel.kind === 'dev' && self.ui.sel.id === g.dev.id)) {
          self.ui.sel = g.hit; self.ui.msg = ''; self.ui.confirm = null; self.ui.editing = false;
          self.renderBar();
        }
        var w = self.toWorld(p);
        g.dev.x = Math.round(w.x + g.dx);
        g.dev.y = Math.round(w.y + g.dy);
        self.requestDraw();
      } else {
        self.view.x = g.vx + dx;
        self.view.y = g.vy + dy;
        self.applyView();
      }
    });

    function finish(e, cancelled) {
      if (!self.ptrs[e.pointerId]) return;
      delete self.ptrs[e.pointerId];
      var g = self.g;
      if (!g) return;
      if (g.type === 'pinch') {
        self.g = null;
        self._changedSoon();
        return;
      }
      self.g = null;
      if (g.moved) {
        self.drawCanvas();
        self._changedSoon();
      } else if (!cancelled) {
        self._tap(g.hit);
      }
    }
    svg.addEventListener('pointerup', function (e) { finish(e, false); });
    svg.addEventListener('pointercancel', function (e) { finish(e, true); });

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.zoomAt(self.local(e), Math.exp(-e.deltaY * 0.0015));
      self._changedSoon();
    }, { passive: false });

    r.addSwitch.addEventListener('click', function () { self.addDevice('switch'); });
    r.addPc.addEventListener('click', function () { self.addDevice('pc'); });

    r.cable.addEventListener('click', function () {
      var ui = self.ui;
      ui.tool = ui.tool === 'cable' ? 'move' : 'cable';
      ui.sel = null; ui.from = null; ui.msg = ''; ui.editing = false; ui.confirm = null;
      self.render();
    });

    r.fit.addEventListener('click', function () { self.fit(); });

    r.clear.addEventListener('click', function () {
      var ui = self.ui;
      if (ui.clearArmed) {
        clearTimeout(self._clearTimer);
        self.net.clear();
        ui.clearArmed = false; ui.sel = null; ui.from = null; ui.msg = '';
        self.render();
        self._changed();
        return;
      }
      ui.clearArmed = true;
      self.render();
      clearTimeout(self._clearTimer);
      self._clearTimer = setTimeout(function () { ui.clearArmed = false; self.render(); }, 3000);
    });
  };

  root.Topology = Topology;
})(window);
