(function () {
  'use strict';

  var KEY = 'switchsim.v2';
  var $ = function (id) { return document.getElementById(id); };

  var devView, topo, labs, labsUI;
  var consoleDev = null;       // device whose screen is open, if any
  var labsOpen = false;        // the My labs screen is showing
  var currentLab = null;       // id of the saved lab the working network came from

  /* ---------- saving (never fatal) ---------- */

  function loadState() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  function saveAll() {
    var snap = topo.toJSON();
    try { localStorage.setItem(KEY, JSON.stringify({ net: snap, lab: currentLab })); } catch (e) { /* storage unavailable */ }
    updateLabName(snap.net);
  }

  // Under the title: which saved lab this is, and whether it has unsaved changes.
  function updateLabName(net) {
    var el = $('labname'), text = '', lab = currentLab && labs ? labs.get(currentLab) : null;
    if (lab) text = lab.name + (labs.isModified(currentLab, net) ? ' (changed)' : '');
    else if (net.devices.length) text = 'Unsaved lab';
    el.textContent = text;
    el.hidden = !text;
  }

  // A store that works even when localStorage is blocked (labs just will not survive a restart).
  function storage() {
    try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; } catch (e) {
      var m = {};
      return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); } };
    }
  }

  /* ---------- screens ---------- */

  function showScreen() {
    $('view-net').hidden = !!consoleDev || labsOpen;
    $('view-console').hidden = !consoleDev;
    $('view-labs').hidden = !labsOpen;
    $('open-labs').hidden = !!consoleDev || labsOpen;
    if (!consoleDev && !labsOpen) { topo.ensureView(); topo.render(); }
  }

  function openLabs() {
    if (consoleDev) closeDevice();
    topo.stopPlayback();
    labsOpen = true;
    showScreen();
    labsUI.render();
    location.hash = 'labs';          // gives the Android back button something to pop
  }

  function closeLabs() {
    if (!labsOpen) return;
    labsOpen = false;
    showScreen();
    if (location.hash === '#labs') history.back();
  }

  // Replace the working network (used when a lab is opened or a new one started).
  function loadNet(net) {
    consoleDev = null;
    topo.stopPlayback();
    topo.load({ net: net });
  }

  $('open-labs').addEventListener('click', openLabs);
  $('labs-back').addEventListener('click', closeLabs);

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

  // Show Watch whenever there is traffic to replay on the map.
  function updateWatch() { $('console-watch').hidden = !(topo && topo.net.trace.length); }

  $('console-watch').addEventListener('click', function () {
    closeDevice();
    topo.startPlayback();
  });

  function openDevice(dev) {
    var isPc = dev.type === 'pc';
    consoleDev = dev;
    $('console-title').textContent = isPc ? dev.name : dev.name + ' console';
    $('pc-tabs').hidden = !isPc;
    devView.attach(dev.term);
    updateWatch();
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
    if (location.hash !== '#labs' && labsOpen) { labsOpen = false; showScreen(); }
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

    labs = new window.Labs(storage());
    if (saved && saved.lab && labs.get(saved.lab)) currentLab = saved.lab;

    devView = new window.TerminalView($('console-host'), { onCommand: function () { saveAll(); updateWatch(); } });

    topo = new window.Topology({
      svg: $('net'), world: $('world'), links: $('layer-links'), devs: $('layer-devs'),
      bar: $('netbar'), toolbar: $('toolbar'),
      cable: $('tool-cable'), addSwitch: $('add-switch'), addPc: $('add-pc'), addRouter: $('add-router'),
      clear: $('net-clear'), fit: $('net-fit'), replay: $('net-replay'), fx: $('layer-fx'),
      playbar: $('playbar'),
      pb: { step: $('pstep'), lines: $('plines'), prev: $('p-prev'), play: $('p-play'), next: $('p-next'), speed: $('p-speed'), close: $('p-close') }
    }, { onChange: saveAll, openConsole: openDevice });
    if (saved && saved.net) topo.load(saved.net);

    labsUI = new window.LabsUI({
      labs: labs,
      getNet: function () { return topo.toJSON().net; },
      loadNet: loadNet,
      getCurrent: function () { return currentLab; },
      setCurrent: function (id) { currentLab = id; saveAll(); },
      afterLoad: function () { closeLabs(); topo.fit(); },
      changed: saveAll
    });
    updateLabName(topo.toJSON().net);

    window.addEventListener('resize', function () { if (!consoleDev) topo.ensureView(); });
    showScreen();
  }

  boot();
})();
