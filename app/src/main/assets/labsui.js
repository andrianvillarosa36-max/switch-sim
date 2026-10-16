/*
 * The My labs screen: save the current network under a name, reopen or update
 * a saved lab, share one as a text code, import a code.
 *
 * app = {
 *   labs,                       // a Labs store (labs.js)
 *   getNet(), loadNet(net),     // read / replace the working network
 *   getCurrent(), setCurrent(id), // which saved lab the working network came from
 *   afterLoad()                 // called after a lab was opened (the app closes this screen)
 *   changed()                   // called when the header should be refreshed
 * }
 */
(function (root) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function LabsUI(app) {
    this.app = app;
    this.armed = null;          // a two-tap action waiting for its second tap: 'open:<id>', 'delete:<id>', 'new'
    this.armTimer = 0;
    this.code = '';
    this._bind();
  }

  LabsUI.prototype._msg = function (text, cls) {
    var m = $('labs-msg');
    m.textContent = text || '';
    m.className = 'pcmsg' + (cls ? ' ' + cls : '');
  };

  LabsUI.prototype._arm = function (key) {
    var self = this;
    this.armed = key;
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(function () { self.armed = null; self.render(); }, 3500);
    this.render();
  };

  // True when opening another lab or starting a new one would throw work away.
  LabsUI.prototype._unsaved = function () {
    var app = this.app, net = app.getNet(), cur = app.getCurrent();
    if (cur && app.labs.get(cur)) return app.labs.isModified(cur, net);
    return net.devices.length > 0;
  };

  LabsUI.prototype.render = function () {
    var self = this, app = this.app, labs = app.labs, net = app.getNet(), cur = app.getCurrent();
    var curLab = cur ? labs.get(cur) : null;

    $('labs-current').textContent = curLab
      ? 'You are working on "' + curLab.name + '"' + (labs.isModified(cur, net) ? ', which has unsaved changes.' : '.')
      : (net.devices.length ? 'This network is not saved yet. Give it a name to keep it.' : 'This network is empty.');

    var list = $('labs-list');
    list.textContent = '';
    var all = labs.list();
    if (!all.length) list.appendChild(el('p', 'empty', 'No saved labs yet.'));

    all.forEach(function (lab) {
      var isCur = lab.id === cur, changed = isCur && labs.isModified(lab.id, net);
      var row = el('div', 'labrow'), info = el('div', 'labinfo');
      var title = el('span', 'nbtitle', lab.name);
      if (isCur) title.appendChild(el('span', 'badge' + (changed ? ' changed' : ''), changed ? 'changed' : 'open'));
      info.appendChild(title);
      var s = labs.summary(lab);
      info.appendChild(el('span', 'nbsub', s.devices + (s.devices === 1 ? ' device, ' : ' devices, ') + s.cables +
        (s.cables === 1 ? ' cable' : ' cables') + ', saved ' + new Date(lab.saved).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      var acts = el('div', 'labacts');

      function btn(label, cls, fn) {
        var b = el('button', 'abtn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        b.addEventListener('click', fn);
        acts.appendChild(b);
      }

      if (!isCur || changed) {
        var openKey = 'open:' + lab.id, risky = isCur ? changed : self._unsaved();
        btn(self.armed === openKey ? 'Tap to discard changes' : (isCur ? 'Revert' : 'Open'), 'primary', function () {
          if (risky && self.armed !== openKey) { self._arm(openKey); return; }
          self._open(lab);
        });
      }
      if (changed) btn('Update', '', function () { self._update(lab); });
      btn('Share', '', function () { self._share(lab); });
      var delKey = 'delete:' + lab.id;
      btn(self.armed === delKey ? 'Tap to delete' : 'Delete', 'danger', function () {
        if (self.armed !== delKey) { self._arm(delKey); return; }
        self.armed = null;
        labs.remove(lab.id);
        if (app.getCurrent() === lab.id) app.setCurrent(null);
        self._msg('Deleted "' + lab.name + '".', '');
        self.render();
        app.changed();
      });

      row.appendChild(info);
      row.appendChild(acts);
      list.appendChild(row);
    });

    $('labs-new').textContent = this.armed === 'new' ? 'Tap to discard changes' : 'New empty lab';
  };

  LabsUI.prototype._open = function (lab) {
    this.armed = null;
    this.app.loadNet(JSON.parse(JSON.stringify(lab.net)));
    this.app.setCurrent(lab.id);
    this._msg('', '');
    this.app.afterLoad();
  };

  LabsUI.prototype._update = function (lab) {
    var res = this.app.labs.update(lab.id, this.app.getNet());
    this._msg(res.error || 'Updated "' + lab.name + '".', res.error ? 'bad' : 'ok');
    this.render();
    this.app.changed();
  };

  LabsUI.prototype._share = function (lab) {
    this.code = root.Labs.encode(lab.name, lab.net);
    $('labs-code').value = this.code;
    $('labs-share').hidden = false;
    $('labs-send').hidden = !(root.AndroidBridge && root.AndroidBridge.share);
    $('labs-share').scrollIntoView({ block: 'nearest' });
  };

  LabsUI.prototype._copy = function () {
    var ok = false, ta = $('labs-code');
    try {
      if (root.AndroidBridge && root.AndroidBridge.copy) { root.AndroidBridge.copy(this.code); ok = true; }
    } catch (e) { ok = false; }
    if (!ok) {
      try { ta.removeAttribute('readonly'); ta.focus(); ta.select(); ok = document.execCommand('copy'); ta.setAttribute('readonly', ''); } catch (e) { ok = false; }
    }
    this._msg(ok ? 'Copied. Paste it into a message.' : 'Press and hold the text, then choose Copy.', ok ? 'ok' : '');
  };

  LabsUI.prototype._bind = function () {
    var self = this, app = this.app;

    $('labs-save').addEventListener('submit', function (e) {
      e.preventDefault();
      var net = app.getNet();
      if (!net.devices.length) { self._msg('Add some devices first, then save.', 'bad'); return; }
      var res = app.labs.save($('labs-name').value, net);
      if (res.error) { self._msg(res.error, 'bad'); return; }
      $('labs-name').value = '';
      app.setCurrent(res.id);
      self._msg('Saved "' + res.name + '".', 'ok');
      self.render();
      app.changed();
    });

    $('labs-new').addEventListener('click', function () {
      if (self._unsaved() && self.armed !== 'new') { self._arm('new'); return; }
      self.armed = null;
      app.loadNet({ devices: [], links: [] });
      app.setCurrent(null);
      self._msg('', '');
      app.afterLoad();
    });

    $('labs-copy').addEventListener('click', function () { self._copy(); });
    $('labs-send').addEventListener('click', function () {
      try { root.AndroidBridge.share(self.code); } catch (e) { self._msg('Sharing is not available here. Use Copy.', 'bad'); }
    });
    $('labs-share-close').addEventListener('click', function () { $('labs-share').hidden = true; });

    $('labs-import-btn').addEventListener('click', function () {
      var res = root.Labs.decode($('labs-import').value);
      if (res.error) { self._msg(res.error, 'bad'); return; }
      var saved = app.labs.save(res.name, res.net);
      if (saved.error) { self._msg(saved.error, 'bad'); return; }
      $('labs-import').value = '';
      self._msg('Imported "' + saved.name + '". Tap Open to use it.', 'ok');
      self.render();
    });
  };

  root.LabsUI = LabsUI;
})(window);
