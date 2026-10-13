(function () {
  'use strict';

  var LESSON = window.LESSON;
  var KEY = 'switchsim.v2';
  var OLD_KEY = 'switchsim.lesson1.v1';   // single-switch version: lesson progress is migrated
  var $ = function (id) { return document.getElementById(id); };

  var lesson = { sw: null, term: null, done: [] };
  var lessonView, devView, topo;
  var consoleDev = null;       // device whose console is open, if any
  var hintOpen = false;
  var lastCur;                 // previous current lesson step, to detect completion
  var resetTimer = 0;
  var quizChecked = false;

  /* ---------- saving (never fatal) ---------- */

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  function loadState() {
    var s = read(KEY);
    if (s) return s;
    var old = read(OLD_KEY);
    return old ? { lesson: old, net: null } : null;
  }

  function saveAll() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        lesson: { sw: lesson.sw.toJSON(), done: lesson.done },
        net: topo.toJSON()
      }));
    } catch (e) { /* storage unavailable: keep going */ }
  }

  /* ---------- tabs and screens ---------- */

  function showTab(name) {
    var net = name === 'net';
    $('view-net').hidden = !(net && !consoleDev);
    $('view-console').hidden = !(net && consoleDev);
    $('view-lab').hidden = name !== 'lab';
    $('view-quiz').hidden = name !== 'quiz';
    ['net', 'lab', 'quiz'].forEach(function (n) {
      $('tab-' + n).setAttribute('aria-selected', String(n === name));
    });
    if (net && !consoleDev) { topo.ensureView(); topo.render(); }
  }

  function currentTab() {
    return $('tab-lab').getAttribute('aria-selected') === 'true' ? 'lab'
      : $('tab-quiz').getAttribute('aria-selected') === 'true' ? 'quiz' : 'net';
  }

  /* ---------- device consoles ---------- */

  function openConsole(dev) {
    consoleDev = dev;
    $('console-title').textContent = dev.name + ' console';
    devView.attach(dev.term);
    showTab('net');
    location.hash = 'console';      // gives the Android back button something to pop
    devView.focus();
  }

  function closeConsole() {
    consoleDev = null;
    showTab('net');
  }

  window.addEventListener('hashchange', function () {
    if (location.hash !== '#console' && consoleDev) closeConsole();
  });

  $('console-back').addEventListener('click', function () {
    if (location.hash === '#console') history.back(); else closeConsole();
  });

  /* ---------- lesson ---------- */

  function evaluate() {
    LESSON.steps.forEach(function (s, i) {
      if (!lesson.done[i] && s.done(lesson.sw)) lesson.done[i] = true;
    });
  }

  function currentStep() {
    for (var i = 0; i < lesson.done.length; i++) if (!lesson.done[i]) return i;
    return -1;
  }

  function renderSteps() {
    var cur = currentStep(), total = LESSON.steps.length;
    if (cur !== lastCur) hintOpen = false;

    var leds = $('leds');
    leds.textContent = '';
    LESSON.steps.forEach(function (s, i) {
      var d = document.createElement('span');
      d.className = 'led' + (lesson.done[i] ? ' on' : i === cur ? ' now' : '');
      leds.appendChild(d);
    });

    $('count').textContent = cur === -1 ? 'Lab complete' : 'Step ' + (cur + 1) + ' of ' + total;
    $('task').textContent = cur === -1 ? 'All steps done' : LESSON.steps[cur].task;
    $('mission').textContent = LESSON.mission;

    var ol = $('steplist');
    ol.textContent = '';
    LESSON.steps.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = lesson.done[i] ? 'done' : i === cur ? 'cur' : '';
      var sr = document.createElement('span');
      sr.className = 'sr';
      sr.textContent = lesson.done[i] ? 'Done: ' : i === cur ? 'Next: ' : 'To do: ';
      li.appendChild(sr);
      li.appendChild(document.createTextNode(s.task));
      ol.appendChild(li);
    });

    var showHint = hintOpen && cur !== -1;
    $('hintbtn').hidden = cur === -1;
    $('hintbtn').textContent = showHint ? 'Hide hint' : 'Show hint';
    $('hint').hidden = !showHint;
    $('hint').textContent = showHint ? LESSON.steps[cur].hint : '';

    if (lastCur !== undefined && lastCur !== -1 && cur === -1) {
      lessonView.note('Lab complete. Open the Quiz tab to check what you learned.', 'ok');
    }
    lastCur = cur;
  }

  function lessonAfter() {
    evaluate();
    renderSteps();
    saveAll();
  }

  function startLesson(saved) {
    lesson.sw = new window.SwitchSim(saved && saved.sw);
    lesson.term = window.Network.target(lesson.sw);
    lesson.done = LESSON.steps.map(function (s, i) { return !!(saved && saved.done && saved.done[i]); });
    lastCur = undefined;
    lessonView.attach(lesson.term);
    if (saved && (lesson.done.some(Boolean) || lesson.sw.startup || lesson.sw.dirty)) {
      lessonView.note('Previous session restored. Reset lab starts a fresh switch.');
    }
    evaluate();
    renderSteps();
  }

  function onLabReset() {
    var b = $('lab-reset');
    if (b.getAttribute('data-armed') === '1') {
      clearTimeout(resetTimer);
      b.setAttribute('data-armed', '0');
      b.textContent = 'Reset lab';
      startLesson(null);
      saveAll();
      return;
    }
    b.setAttribute('data-armed', '1');
    b.textContent = 'Tap to confirm';
    resetTimer = setTimeout(function () {
      b.setAttribute('data-armed', '0');
      b.textContent = 'Reset lab';
    }, 3000);
  }

  /* ---------- quiz ---------- */

  function renderQuiz() {
    $('quiz-title').textContent = LESSON.title;
    var list = $('quiz-list');
    list.textContent = '';
    LESSON.quiz.forEach(function (q, qi) {
      var group = document.createElement('div');
      group.className = 'q';
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', 'qt' + qi);

      var qt = document.createElement('p');
      qt.className = 'qtext';
      qt.id = 'qt' + qi;
      qt.textContent = q.q;
      group.appendChild(qt);

      q.options.forEach(function (opt, oi) {
        var lab = document.createElement('label');
        lab.className = 'opt' + (q.mono ? ' mono' : '');
        var r = document.createElement('input');
        r.type = 'radio';
        r.name = 'q' + qi;
        r.value = String(oi);
        var s = document.createElement('span');
        s.textContent = opt;
        lab.appendChild(r);
        lab.appendChild(s);
        group.appendChild(lab);
      });

      var res = document.createElement('p');
      res.className = 'result';
      res.id = 'res' + qi;
      res.hidden = true;
      group.appendChild(res);
      list.appendChild(group);
    });
    $('score').textContent = '';
    $('check').textContent = 'Check answers';
    quizChecked = false;
  }

  function checkQuiz() {
    if (quizChecked) { renderQuiz(); return; }
    var right = 0;
    LESSON.quiz.forEach(function (q, qi) {
      var sel = document.querySelector('input[name="q' + qi + '"]:checked');
      var res = $('res' + qi);
      res.hidden = false;
      if (!sel) {
        res.className = 'result warn';
        res.textContent = 'No answer selected.';
        return;
      }
      var ok = Number(sel.value) === q.answer;
      if (ok) right++;
      res.className = 'result ' + (ok ? 'ok' : 'bad');
      res.textContent = (ok ? 'Correct. ' : 'Not quite. The answer is "' + q.options[q.answer] + '". ') + q.explain;
    });
    $('score').textContent = right + ' of ' + LESSON.quiz.length + ' correct';
    $('check').textContent = 'Try again';
    quizChecked = true;
  }

  /* ---------- boot ---------- */

  function boot() {
    var saved = loadState();

    devView = new window.TerminalView($('console-host'), { onCommand: saveAll });
    lessonView = new window.TerminalView($('lab-host'), { onCommand: lessonAfter });

    topo = new window.Topology({
      svg: $('net'), world: $('world'), links: $('layer-links'), devs: $('layer-devs'),
      bar: $('netbar'), toolbar: $('toolbar'),
      cable: $('tool-cable'), addSwitch: $('add-switch'), addPc: $('add-pc'),
      clear: $('net-clear'), fit: $('net-fit')
    }, { onChange: saveAll, openConsole: openConsole });
    if (saved && saved.net) topo.load(saved.net);

    startLesson(saved && saved.lesson);
    renderQuiz();

    $('tab-net').addEventListener('click', function () { showTab('net'); });
    $('tab-lab').addEventListener('click', function () { showTab('lab'); });
    $('tab-quiz').addEventListener('click', function () { showTab('quiz'); });
    $('taskbar').addEventListener('click', function () {
      var open = $('taskbar').getAttribute('aria-expanded') !== 'true';
      $('taskbar').setAttribute('aria-expanded', String(open));
      $('steps').hidden = !open;
    });
    $('hintbtn').addEventListener('click', function () { hintOpen = !hintOpen; renderSteps(); });
    $('lab-reset').addEventListener('click', onLabReset);
    $('check').addEventListener('click', checkQuiz);

    window.addEventListener('resize', function () { if (currentTab() === 'net' && !consoleDev) topo.ensureView(); });

    showTab('net');
  }

  boot();
})();
