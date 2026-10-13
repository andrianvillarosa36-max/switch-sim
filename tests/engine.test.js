// Run with: node tests/engine.test.js
const assert = require('assert');
const { SwitchSim } = require('../app/src/main/assets/engine.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

test('Lesson 1 walkthrough', () => {
  const sw = new SwitchSim();
  assert.strictEqual(sw.prompt, 'Switch>');
  sw.exec('enable');
  assert.strictEqual(sw.prompt, 'Switch#');
  sw.exec('configure terminal');
  assert.strictEqual(sw.prompt, 'Switch(config)#');
  sw.exec('hostname S1');
  assert.strictEqual(sw.prompt, 'S1(config)#');
  sw.exec('enable secret class123');
  assert.strictEqual(sw.running.secret, 'class123');
  sw.exec('end');
  assert.strictEqual(sw.prompt, 'S1#');
  assert.ok(sw.dirty, 'unsaved changes should be flagged');
  assert.deepStrictEqual(sw.exec('copy running-config startup-config'), []);
  assert.strictEqual(sw.prompt, 'Destination filename [startup-config]? ');
  const out = sw.exec('');
  assert.ok(out.includes('[OK]'));
  assert.strictEqual(sw.prompt, 'S1#');
  assert.strictEqual(sw.startup.hostname, 'S1');
  assert.strictEqual(sw.startup.secret, 'class123');
  assert.ok(!sw.dirty);
  assert.ok(sw.flags.priv && sw.flags.config && sw.flags.end);
});

test('abbreviations work like IOS', () => {
  const sw = new SwitchSim();
  sw.exec('en');
  assert.strictEqual(sw.mode, 'priv');
  sw.exec('conf t');
  assert.strictEqual(sw.mode, 'config');
  sw.exec('host S2');
  assert.strictEqual(sw.running.hostname, 'S2');
  sw.exec('ena sec abc');
  assert.strictEqual(sw.running.secret, 'abc');
  sw.exec('exit');
  assert.strictEqual(sw.mode, 'priv');
  sw.exec('copy run start');
  sw.exec('');
  assert.strictEqual(sw.startup.hostname, 'S2');
  sw.exec('wr');
  assert.strictEqual(sw.startup.secret, 'abc');
});

test('ambiguous, invalid and incomplete input', () => {
  const sw = new SwitchSim();
  assert.deepStrictEqual(sw.exec('e'), ['% Ambiguous command:  "e"']);
  const bad = sw.exec('foo');
  assert.strictEqual(bad[0], '       ^'); // "Switch>" is 7 chars, token at index 0
  assert.ok(bad[1].startsWith('% Invalid input'));
  sw.exec('enable');
  assert.deepStrictEqual(sw.exec('show'), ['% Incomplete command.']);
  sw.exec('configure terminal');
  assert.deepStrictEqual(sw.exec('hostname'), ['% Incomplete command.']);
  const caret = sw.exec('hostname S1 extra');
  assert.ok(caret[1].startsWith('% Invalid input'));
  assert.deepStrictEqual(sw.exec('hostname bad_name!'), ['% Hostname contains one or more illegal characters.']);
});

test('enable asks for the secret, 3 wrong tries are rejected', () => {
  const sw = new SwitchSim();
  sw.exec('enable'); sw.exec('configure terminal');
  sw.exec('enable secret class123'); sw.exec('end'); sw.exec('disable');
  assert.strictEqual(sw.mode, 'user');

  sw.exec('enable');
  assert.strictEqual(sw.prompt, 'Password: ');
  assert.ok(sw.secretInput);
  sw.exec('wrong1'); sw.exec('wrong2');
  assert.strictEqual(sw.prompt, 'Password: ');
  assert.deepStrictEqual(sw.exec('wrong3'), ['% Bad secrets', '']);
  assert.strictEqual(sw.mode, 'user');
  assert.ok(!sw.secretInput);

  sw.exec('enable');
  sw.exec('class123');
  assert.strictEqual(sw.mode, 'priv');
});

test('secret is hashed in running-config, password is not', () => {
  const sw = new SwitchSim();
  sw.exec('enable'); sw.exec('configure terminal');
  sw.exec('enable secret class123');
  sw.exec('enable password plain1');
  sw.exec('end');
  const run = sw.exec('show running-config').join('\n');
  assert.ok(!run.includes('class123'));
  assert.ok(/enable secret 5 \$1\$mERr\$/.test(run));
  assert.ok(run.includes('enable password plain1'));
  assert.ok(run.includes('hostname Switch'));
});

test('startup-config and reload', () => {
  const sw = new SwitchSim();
  sw.exec('enable');
  assert.deepStrictEqual(sw.exec('show startup-config'), ['startup-config is not present']);
  sw.exec('conf t'); sw.exec('hostname S1'); sw.exec('end');
  // reload without saving: asks to save, answer no, confirm
  sw.exec('reload');
  assert.ok(sw.prompt.startsWith('System configuration has been modified'));
  sw.exec('maybe');
  assert.ok(sw.prompt.startsWith('System configuration has been modified'));
  sw.exec('no');
  assert.strictEqual(sw.prompt, 'Proceed with reload? [confirm]');
  sw.exec('');
  assert.strictEqual(sw.running.hostname, 'Switch', 'unsaved hostname is lost');
  assert.strictEqual(sw.mode, 'user');

  // save, then reload keeps it
  sw.exec('enable'); sw.exec('conf t'); sw.exec('hostname S1'); sw.exec('end');
  sw.exec('write memory');
  sw.exec('reload'); // not dirty: straight to confirm
  assert.strictEqual(sw.prompt, 'Proceed with reload? [confirm]');
  sw.exec('y');
  assert.strictEqual(sw.running.hostname, 'S1');

  // erase
  sw.exec('enable');
  sw.exec('erase startup-config');
  sw.exec('');
  assert.strictEqual(sw.startup, null);
});

test('? help and tab completion', () => {
  const sw = new SwitchSim();
  const top = sw.exec('?');
  assert.ok(top.some(l => l.includes('enable')));
  sw.exec('enable');
  assert.deepStrictEqual(sw.exec('co?'), ['configure  copy']);
  const next = sw.exec('copy ?');
  assert.ok(next.some(l => l.includes('running-config')));
  assert.strictEqual(sw.complete('conf'), 'configure ');
  assert.strictEqual(sw.complete('co'), 'co'); // ambiguous: unchanged
  assert.strictEqual(sw.complete('show run'), 'show running-config ');
});

test('state survives save/load, mode resets', () => {
  const a = new SwitchSim();
  a.exec('enable'); a.exec('conf t'); a.exec('hostname S1'); a.exec('end'); a.exec('wr');
  const b = new SwitchSim(JSON.parse(JSON.stringify(a.toJSON())));
  assert.strictEqual(b.running.hostname, 'S1');
  assert.strictEqual(b.startup.hostname, 'S1');
  assert.strictEqual(b.mode, 'user');
  assert.ok(b.flags.end);
});

test('show mac address-table, clear it, and reload empties it', () => {
  const sw = new SwitchSim();
  sw.exec('enable');
  const empty = sw.exec('show mac address-table');
  assert.ok(empty.includes('Total Mac Addresses for this criterion: 0'));
  sw.macTable.push({ vlan: 1, mac: '0001.0a0b.0001', port: 'FastEthernet0/1' });
  const one = sw.exec('sh mac address-table');
  assert.ok(one.some(l => /^\s+1\s+0001\.0a0b\.0001\s+DYNAMIC\s+Fa0\/1$/.test(l)), one.join('\n'));
  assert.ok(one.includes('Total Mac Addresses for this criterion: 1'));
  assert.ok(sw.exec('show mac-address-table').length === one.length, 'older spelling works');
  sw.exec('clear mac address-table dynamic');
  assert.strictEqual(sw.macTable.length, 0);
  sw.macTable.push({ vlan: 1, mac: '0001.0a0b.0001', port: 'FastEthernet0/1' });
  sw.exec('reload'); sw.exec('');
  assert.strictEqual(sw.macTable.length, 0, 'volatile');
});

test('show interfaces status uses the cables the network reports', () => {
  const sw = new SwitchSim();
  sw.portInfo = () => [
    { name: 'FastEthernet0/1', connected: true },
    { name: 'FastEthernet0/2', connected: false },
    { name: 'GigabitEthernet0/1', connected: false }
  ];
  sw.exec('enable');
  const out = sw.exec('show int status');
  assert.ok(out[0].startsWith('Port'));
  assert.ok(/^Fa0\/1\s+connected\s+1\s+a-full\s+a-100$/.test(out[1]), out[1]);
  assert.ok(/^Fa0\/2\s+notconnect/.test(out[2]), out[2]);
  assert.ok(/^Gi0\/1\s+notconnect\s+1\s+auto\s+auto$/.test(out[3]), out[3]);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
