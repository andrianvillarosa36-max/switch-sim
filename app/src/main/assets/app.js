(function () {
  'use strict';

  var LESSON = window.LESSON;
  var STORE = 'switchsim.lesson1.v1';
  var $ = function (id) { return document.getElementById(id); };

  var term = $('terminal');
  var cmd = $('cmd');
  var promptEl = $('prompt');

  var sw;                 // the simulated switch
  var done = [];          // sticky per-step completion
  var hist = [];          // command history
  var hi = 0;             // history cursor
  var hintOpen = false;
  var lastCur;            // previous current step (to detect lab completion)
  var resetTimer = null;
  var quizChecked = false;

  /* ---------- storage (never fatal) ---------- */

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; }
  }
  function persist() {
    try { localStorage.setItem(STORE, JSON.stringify({ sw: sw.toJSON(), done: done })); } catch (e) { /* ignore */ }
  }
  function forget() {
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
  }

  /* ---------- terminal output ---------- */

  function classify(t) {
    if (t.charAt(0) === '%' || /^\s*\^$/.test(t)) return 'err';
    return '';
  }

  function line(text, cls) {
    var d = document.createElement('div');
    d.className = 'line ' + (cls || '');
    d.textContent = text === '' ? ' ' : text;
    term.appendChild(d);
  }

  function echo(prompt, text) {
    var d = document.createElement('div');
    d.className = 'line echo';
    var p = document.createElement('span');
    p.className = 'p';
    p.textContent = prompt;
    var c = document.createElement('span');
    c.className = 'c';
    c.textContent = text;
    d.appendChild(p);
    d.appendChild(c);
    term.appendChild(d);
  }

  function printAll(lines) {
    lines.forEach(function (t) { line(t, classify(t)); });
  }

  function scrollDown() {
    while (term.childNodes.length > 600) term.removeChild(term.firstChild);
    term.scrollTop = term.scrollHeight;
  }

  /* ---------- lab progress ---------- */

  function currentStep() {
    for (var i = 0; i < done.length; i++) if (!done[i]) return i;
    return -1;
  }

  function evaluate() {
    LESSON.steps.forEach(function (s, i) { if (!done[i] && s.done(sw)) done[i] = true; });
  }

  function renderSteps() {
    var cur = currentStep();
    var total = LESSON.steps.length;
    if (cur !== lastCur) hintOpen = false;

    var leds = $('leds');
    leds.textContent = '';
    LESSON.steps.forEach(function (s, i) {
      var d = document.createElement('span');
      d.className = 'led' + (done[i] ? ' on' : i === cur ? ' now' : '');
      leds.appendChild(d);
    });

    $('count').textContent = cur === -1 ? 'Lab complete' : 'Step ' + (cur + 1) + ' of ' + total;
    $('task').textContent = cur === -1 ? 'All steps done. Try the quiz.' : LESSON.steps[cur].task;
    $('mission').textContent = LESSON.mission;

    var ol = $('steplist');
    ol.textContent = '';
    LESSON.steps.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = done[i] ? 'done' : i === cur ? 'cur' : '';
      var sr = document.createElement('span');
      sr.className = 'sr';
      sr.textContent = done[i] ? 'Done: ' : i === cur ? 'Next: ' : 'To do: ';
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
      line('Lab complete. Open the Quiz tab to check what you learned.', 'ok');
    }
    lastCur = cur;
  }

  function renderSyst() {
    var el = $('syst');
    if (sw.dirty) { el.textContent = 'Unsaved config'; el.className = 'syst warn'; }
    else if (sw.startup) { el.textContent = 'Config saved'; el.className = 'syst ok'; }
    else { el.textContent = 'Nothing configured'; el.className = 'syst'; }
  }

  function refresh() {
    var p = sw.prompt;
    promptEl.textContent = p;
    promptEl.classList.toggle('long', p.length > 18);
    var secret = sw.secretInput;
    var wantType = secret ? 'password' : 'text';
    if (cmd.type !== wantType) cmd.type = wantType;
    cmd.setAttribute('autocomplete', secret ? 'new-password' : 'off');
    evaluate();
    renderSteps();
    renderSyst();
    persist();
  }

  /* ---------- input handling ---------- */

  function onSubmit(e) {
    e.preventDefault();
    var text = cmd.value;
    var secret = sw.secretInput;
    var wasPending = !!sw.pending;
    echo(sw.prompt, secret ? '' : text);
    if (!wasPending && text.trim()) hist.push(text);
    hi = hist.length;
    printAll(sw.exec(text));
    cmd.value = '';
    refresh();
    scrollDown();
    cmd.focus();
  }

  function histMove(d) {
    if (sw.secretInput || !hist.length) return;
    hi = Math.min(Math.max(hi + d, 0), hist.length);
    cmd.value = hi === hist.length ? '' : hist[hi];
    var n = cmd.value.length;
    cmd.setSelectionRange(n, n);
  }

  function onTab() {
    cmd.value = sw.complete(cmd.value);
    var n = cmd.value.length;
    cmd.setSelectionRange(n, n);
    cmd.focus();
  }

  function onHelp() {
    if (sw.pending) return;
    echo(sw.prompt, cmd.value + '?');
    printAll(sw.help(cmd.value));
    scrollDown();
    cmd.focus();
  }

  /* ---------- tabs, drawer, reset ---------- */

  function showTab(name) {
    var lab = name === 'lab';
    $('view-lab').hidden = !lab;
    $('view-quiz').hidden = lab;
    $('tab-lab').setAttribute('aria-selected', String(lab));
    $('tab-quiz').setAttribute('aria-selected', String(!lab));
  }

  function toggleDrawer() {
    var open = $('taskbar').getAttribute('aria-expanded') !== 'true';
    $('taskbar').setAttribute('aria-expanded', String(open));
    $('steps').hidden = !open;
  }

  function onReset() {
    var b = $('reset');
    if (b.getAttribute('data-armed') === '1') {
      clearTimeout(resetTimer);
      b.setAttribute('data-armed', '0');
      b.textContent = 'Reset';
      forget();
      hist = [];
      hi = 0;
      lastCur = undefined;
      renderQuiz();
      start(null);
      return;
    }
    b.setAttribute('data-armed', '1');
    b.textContent = 'Tap to confirm';
    resetTimer = setTimeout(function () {
      b.setAttribute('data-armed', '0');
      b.textContent = 'Reset';
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

  function start(saved) {
    sw = new window.SwitchSim(saved && saved.sw);
    done = LESSON.steps.map(function (s, i) { return !!(saved && saved.done && saved.done[i]); });
    term.textContent = '';
    line('Simulated switch console. Type ? for help.', 'dim');
    if (saved && (done.some(Boolean) || sw.startup || sw.dirty)) {
      line('Previous session restored. Reset starts a fresh switch.', 'dim');
    }
    refresh();
    scrollDown();
  }

  // Keep the keyboard open when tapping the helper keys.
  Array.prototype.forEach.call(document.querySelectorAll('.keys button'), function (b) {
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
  });

  $('line').addEventListener('submit', onSubmit);
  $('key-tab').addEventListener('click', onTab);
  $('key-help').addEventListener('click', onHelp);
  $('key-up').addEventListener('click', function () { histMove(-1); cmd.focus(); });
  $('key-down').addEventListener('click', function () { histMove(1); cmd.focus(); });
  $('taskbar').addEventListener('click', toggleDrawer);
  $('hintbtn').addEventListener('click', function () { hintOpen = !hintOpen; renderSteps(); });
  $('tab-lab').addEventListener('click', function () { showTab('lab'); });
  $('tab-quiz').addEventListener('click', function () { showTab('quiz'); });
  $('reset').addEventListener('click', onReset);
  $('check').addEventListener('click', checkQuiz);
  term.addEventListener('click', function () {
    var sel = window.getSelection && window.getSelection().toString();
    if (!sel) cmd.focus();
  });

  renderQuiz();
  start(loadSaved());
})();
