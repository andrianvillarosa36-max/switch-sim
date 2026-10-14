/*
 * A console: scrollback, helper keys (Tab, ?, history) and the input line.
 * One TerminalView can be pointed at any console state with attach(target),
 * where target = { sw: shell, log: [], hist: [], hi: 0 } (see Network.target).
 * The shell is a SwitchSim or a PcShell. Optional shell features:
 *   status()  -> { text, cls } for the light next to the keys
 *   takeJob() -> [{ t, delay }] lines to print one at a time (ping replies)
 */
(function (root) {
  'use strict';

  var uid = 0;
  var MAX_LINES = 400;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function classify(t) {
    if (/^%[A-Z0-9_]+-\d-[A-Z0-9_]+:/.test(t)) return 'sys';     // syslog-style status messages
    return (t.charAt(0) === '%' || /^\s*\^$/.test(t)) ? 'err' : '';
  }

  function TerminalView(host, opts) {
    var self = this;
    this.opts = opts || {};
    this.t = null;
    var id = 'cmd-' + (++uid);

    host.textContent = '';

    this.screen = el('div', 'screen');
    this.screen.setAttribute('role', 'log');
    this.screen.setAttribute('aria-label', 'Console');

    var keys = el('div', 'keys');
    function key(label, aria) {
      var b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      // Keep the soft keyboard open when tapping helper keys.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      keys.appendChild(b);
      return b;
    }
    var kTab = key('Tab', 'Complete word');
    var kHelp = key('?', 'Show help');
    var kUp = key('\u2191', 'Previous command');
    var kDown = key('\u2193', 'Next command');
    this.syst = el('span', 'syst');
    this.syst.setAttribute('aria-live', 'polite');
    keys.appendChild(this.syst);

    this.form = el('form', 'entry');
    this.form.setAttribute('autocomplete', 'off');
    this.promptEl = el('label', 'prompt');
    this.promptEl.htmlFor = id;
    this.input = el('input', 'cmd');
    this.input.id = id;
    this.input.type = 'text';
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('autocapitalize', 'none');
    this.input.setAttribute('autocorrect', 'off');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('enterkeyhint', 'send');
    this.input.setAttribute('aria-label', 'Command');
    var send = el('button', 'send', 'Enter');
    send.type = 'submit';
    this.form.appendChild(this.promptEl);
    this.form.appendChild(this.input);
    this.form.appendChild(send);

    host.appendChild(this.screen);
    host.appendChild(keys);
    host.appendChild(this.form);

    this.form.addEventListener('submit', function (e) { e.preventDefault(); self._submit(); });
    kTab.addEventListener('click', function () { self._tab(); });
    kHelp.addEventListener('click', function () { self._help(); });
    kUp.addEventListener('click', function () { self._history(-1); });
    kDown.addEventListener('click', function () { self._history(1); });
    this.screen.addEventListener('click', function () {
      var sel = window.getSelection && window.getSelection().toString();
      if (!sel) self.input.focus();
    });
  }

  // Point this terminal at a console state and redraw its scrollback.
  TerminalView.prototype.attach = function (target) {
    this.t = target;
    this.input.value = '';
    this.screen.textContent = '';
    if (!target.log.length) {
      this._push({ k: 'line', t: 'Simulated console. Type ? for help.', cls: 'dim' });
    } else {
      for (var i = 0; i < target.log.length; i++) this._draw(target.log[i]);
    }
    this.input.placeholder = target.busy ? 'Waiting for replies...' : '';
    this.update();
    this._scroll();
  };

  TerminalView.prototype.scrollToEnd = function () { this._scroll(); };

  // Print a message line that is not switch output (for example, lab progress).
  TerminalView.prototype.note = function (text, cls) {
    this._push({ k: 'line', t: text, cls: cls || 'dim' });
    this._scroll();
  };

  TerminalView.prototype.focus = function () { this.input.focus(); };

  TerminalView.prototype.update = function () {
    if (!this.t) return;
    var sw = this.t.sw;
    var p = sw.prompt;
    this.promptEl.textContent = p;
    this.promptEl.classList.toggle('long', p.length > 18);

    var secret = sw.secretInput;
    var want = secret ? 'password' : 'text';
    if (this.input.type !== want) this.input.type = want;
    this.input.setAttribute('autocomplete', secret ? 'new-password' : 'off');

    if (sw.status) {
      var st = sw.status();
      this.syst.textContent = st.text;
      this.syst.className = 'syst ' + st.cls;
    }
    else if (sw.dirty) { this.syst.textContent = 'Unsaved config'; this.syst.className = 'syst warn'; }
    else if (sw.startup) { this.syst.textContent = 'Config saved'; this.syst.className = 'syst ok'; }
    else { this.syst.textContent = 'Nothing configured'; this.syst.className = 'syst'; }
  };

  TerminalView.prototype._push = function (entry) {
    this.t.log.push(entry);
    if (this.t.log.length > MAX_LINES) this.t.log.shift();
    this._draw(entry);
    while (this.screen.childNodes.length > MAX_LINES) this.screen.removeChild(this.screen.firstChild);
  };

  TerminalView.prototype._draw = function (entry) {
    var d;
    if (entry.k === 'echo') {
      d = el('div', 'line echo');
      d.appendChild(el('span', 'p', entry.p));
      d.appendChild(el('span', 'c', entry.c));
    } else {
      d = el('div', 'line ' + (entry.cls || '') + (entry.tab ? ' tab' : ''), entry.t === '' ? ' ' : entry.t);
    }
    this.screen.appendChild(d);
  };

  // tabular: rows of columns (show / arp output) keep their spacing and scroll sideways instead of wrapping.
  TerminalView.prototype._printAll = function (lines, tabular) {
    for (var i = 0; i < lines.length; i++) {
      var entry = { k: 'line', t: lines[i], cls: classify(lines[i]) };
      if (tabular && /\S {3,}\S/.test(lines[i])) entry.tab = true;
      this._push(entry);
    }
  };

  function isTableCommand(text) {
    var first = text.trim().split(/\s+/)[0].toLowerCase();
    return !!first && !/\?\s*$/.test(text) && ('show'.indexOf(first) === 0 || first === 'arp');
  }

  TerminalView.prototype._scroll = function () { this.screen.scrollTop = this.screen.scrollHeight; };

  TerminalView.prototype._submit = function () {
    var t = this.t;
    if (!t || t.busy) return;
    var sw = t.sw, text = this.input.value, secret = sw.secretInput, wasPending = !!sw.pending;
    this._push({ k: 'echo', p: sw.prompt, c: secret ? '' : text });
    if (!wasPending && text.trim()) t.hist.push(text);
    t.hi = t.hist.length;
    this._printAll(sw.exec(text), !wasPending && isTableCommand(text));
    var job = sw.takeJob ? sw.takeJob() : null;
    if (job && job.length) this._play(t, job);
    this.input.value = '';
    this.update();
    if (this.opts.onCommand) this.opts.onCommand(t);
    this._scroll();
    this.input.focus();
  };

  // Print job lines one at a time. Keeps going if the user leaves the console.
  TerminalView.prototype._play = function (target, job) {
    var self = this, i = 0;
    target.busy = true;
    this.input.placeholder = 'Waiting for replies...';
    function next() {
      if (i >= job.length) {
        target.busy = false;
        if (self.t === target) { self.input.placeholder = ''; self.update(); }
        return;
      }
      var item = job[i++];
      setTimeout(function () {
        var entry = { k: 'line', t: item.t, cls: classify(item.t) };
        if (self.t === target) { self._push(entry); self._scroll(); }
        else { target.log.push(entry); if (target.log.length > MAX_LINES) target.log.shift(); }
        next();
      }, item.delay);
    }
    next();
  };

  TerminalView.prototype._tab = function () {
    if (!this.t) return;
    this.input.value = this.t.sw.complete(this.input.value);
    var n = this.input.value.length;
    this.input.setSelectionRange(n, n);
    this.input.focus();
  };

  TerminalView.prototype._help = function () {
    var t = this.t;
    if (!t || t.sw.pending) return;
    this._push({ k: 'echo', p: t.sw.prompt, c: this.input.value + '?' });
    this._printAll(t.sw.help(this.input.value));
    this._scroll();
    this.input.focus();
  };

  TerminalView.prototype._history = function (d) {
    var t = this.t;
    if (!t || t.sw.secretInput || !t.hist.length) return;
    t.hi = Math.min(Math.max(t.hi + d, 0), t.hist.length);
    this.input.value = t.hi === t.hist.length ? '' : t.hist[t.hi];
    var n = this.input.value.length;
    this.input.setSelectionRange(n, n);
    this.input.focus();
  };

  root.TerminalView = TerminalView;
})(window);
