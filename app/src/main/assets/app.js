(function () {
  'use strict';

  var KEY = 'switchsim.v2';
  var $ = function (id) { return document.getElementById(id); };

  var devView, topo;
  var consoleDev = null;       // device whose screen is open, if any

  /* ---------- saving (never fatal) ---------- */

  function loadState() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  function saveAll() {
    try { localStorage.setItem(KEY, JSON.stringify({ net: topo.toJSON() })); } catch (e) { /* storage unavailable */ }
  }

  /* ---------- screens ---------- */

  function showScreen() {
    $('view-net').hidden = !!consoleDev;
    $('view-console').hidden = !consoleDev;
    if (!consoleDev) { topo.ensureView(); topo.render(); }
  }

  function selectPcTab(name) {
    var settings = name === 'settings';
    $('pc-settings').hidden = !settings;
    $('console-host').hidden = settings;
    $('pc-tab-settings').setAttribute('aria-selected', String(settings));
    $('pc-tab-cmd').setAttribute('aria-selected', String(!settings));
    if (settings) {
      var c = consoleDev.cfg;
      $('pc-ip').value = c.ip;
      $('pc-mask').value = c.mask;
      $('pc-gw').value = c.gateway;
      setMsg('', '');
    } else {
      devView.update();
      devView.scrollToEnd();
      devView.focus();
    }
  }

  function setMsg(text, cls) {
    $('pc-msg').textContent = text;
    $('pc-msg').className = 'pcmsg' + (cls ? ' ' + cls : '');
  }

  function openDevice(dev) {
    var isPc = dev.type === 'pc';
    consoleDev = dev;
    $('console-title').textContent = isPc ? dev.name : dev.name + ' console';
    $('pc-tabs').hidden = !isPc;
    devView.attach(dev.term);
    $('pc-settings').hidden = true;
    $('console-host').hidden = false;
    showScreen();
    if (isPc) selectPcTab(dev.cfg.ip ? 'cmd' : 'settings'); else devView.focus();
    location.hash = 'console';      // gives the Android back button something to pop
  }

  function closeDevice() {
    consoleDev = null;
    showScreen();
  }

  window.addEventListener('hashchange', function () {
    if (location.hash !== '#console' && consoleDev) closeDevice();
  });

  $('console-back').addEventListener('click', function () {
    if (location.hash === '#console') history.back(); else closeDevice();
  });

  /* ---------- PC settings form ---------- */

  function clean(v) { return v.replace(/,/g, '.').trim(); }

  $('pc-settings').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!consoleDev || consoleDev.type !== 'pc') return;
    var ip = clean($('pc-ip').value), mask = clean($('pc-mask').value);
    if (!mask) mask = window.Netsim.classfulMask(ip);     // left empty: use the default mask for that address
    var err = topo.net.setPcConfig(consoleDev.id, { ip: ip, mask: mask, gateway: clean($('pc-gw').value) });
    if (err) { setMsg(err, 'bad'); return; }
    var c = consoleDev.cfg;
    $('pc-ip').value = c.ip;
    $('pc-mask').value = c.mask;
    $('pc-gw').value = c.gateway;
    setMsg(c.ip ? 'Saved. This PC is ' + c.ip + '.' : 'Saved. The IP settings are cleared.', 'ok');
    topo.render();
    saveAll();
    devView.update();
  });

  $('pc-go').addEventListener('click', function () { selectPcTab('cmd'); });
  $('pc-tab-settings').addEventListener('click', function () { selectPcTab('settings'); });
  $('pc-tab-cmd').addEventListener('click', function () { selectPcTab('cmd'); });

  /* ---------- boot ---------- */

  function boot() {
    var saved = loadState();

    devView = new window.TerminalView($('console-host'), { onCommand: saveAll });

    topo = new window.Topology({
      svg: $('net'), world: $('world'), links: $('layer-links'), devs: $('layer-devs'),
      bar: $('netbar'), toolbar: $('toolbar'),
      cable: $('tool-cable'), addSwitch: $('add-switch'), addPc: $('add-pc'), addRouter: $('add-router'),
      clear: $('net-clear'), fit: $('net-fit')
    }, { onChange: saveAll, openConsole: openDevice });
    if (saved && saved.net) topo.load(saved.net);

    window.addEventListener('resize', function () { if (!consoleDev) topo.ensureView(); });
    showScreen();
  }

  boot();
})();
