// Run with: node tests/network.test.js
const assert = require('assert');
require('../app/src/main/assets/engine.js');
require('../app/src/main/assets/netsim.js');
require('../app/src/main/assets/pcshell.js');
require('../app/src/main/assets/router.js');
const { Network } = require('../app/src/main/assets/network.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

test('adding devices gives unique, tidy names and switches get a console', () => {
  const n = new Network();
  const s1 = n.add('switch', 0, 0), s2 = n.add('switch', 100, 0), p1 = n.add('pc', 0, 80);
  assert.deepStrictEqual([s1.name, s2.name, p1.name], ['SW1', 'SW2', 'PC1']);
  assert.ok(s1.sw && s1.term && s1.term.sw === s1.sw);
  assert.ok(!p1.sw);
  assert.notStrictEqual(s1.sw, s2.sw, 'each switch has its own state');
  n.removeDevice(s1.id);
  assert.strictEqual(n.add('switch', 0, 0).name, 'SW1', 'smallest free number is reused');
});

test('connect picks the first free port on each side', () => {
  const n = new Network();
  const sw = n.add('switch', 0, 0), pc1 = n.add('pc', 0, 80), pc2 = n.add('pc', 80, 80);
  const r1 = n.connect(sw.id, pc1.id), r2 = n.connect(sw.id, pc2.id);
  assert.strictEqual(r1.link.a.port, 'FastEthernet0/1');
  assert.strictEqual(r1.link.b.port, 'FastEthernet0');
  assert.strictEqual(r2.link.a.port, 'FastEthernet0/2');
  assert.strictEqual(Network.shortPort(r2.link.a.port), 'Fa0/2');
  assert.strictEqual(n.linksOf(sw.id).length, 2);
});

test('connect rejects bad requests', () => {
  const n = new Network();
  const sw = n.add('switch', 0, 0), pc = n.add('pc', 0, 80), pc2 = n.add('pc', 80, 80);
  assert.ok(n.connect(sw.id, sw.id).error);
  assert.ok(n.connect(sw.id, 'nope').error);
  assert.ok(n.connect(sw.id, pc.id).link);
  assert.strictEqual(n.connect(pc.id, pc2.id).error, 'No free ports on PC1.');
  assert.strictEqual(n.links.length, 1);
});

test('switch runs out of ports after 26 cables', () => {
  const n = new Network();
  const sw = n.add('switch', 0, 0);
  for (let i = 0; i < 26; i++) assert.ok(n.connect(sw.id, n.add('pc', i, 100).id).link, 'cable ' + (i + 1));
  assert.strictEqual(n.connect(sw.id, n.add('pc', 0, 200).id).error, 'No free ports on SW1.');
  assert.ok(n.links.some(l => l.a.port === 'GigabitEthernet0/2'));
});

test('freed ports are reused after a cable is removed', () => {
  const n = new Network();
  const sw = n.add('switch', 0, 0), a = n.add('pc', 0, 0), b = n.add('pc', 0, 0);
  const l1 = n.connect(sw.id, a.id).link;
  n.connect(sw.id, b.id);
  n.removeLink(l1.id);
  const l3 = n.connect(sw.id, n.add('pc', 0, 0).id).link;
  assert.strictEqual(l3.a.port, 'FastEthernet0/1');
});

test('removing a device removes its cables', () => {
  const n = new Network();
  const sw = n.add('switch', 0, 0), pc = n.add('pc', 0, 0), pc2 = n.add('pc', 0, 0);
  n.connect(sw.id, pc.id); n.connect(sw.id, pc2.id);
  n.removeDevice(pc.id);
  assert.strictEqual(n.links.length, 1);
  assert.ok(n.links.every(l => l.a.dev !== pc.id && l.b.dev !== pc.id));
});

test('rename validates', () => {
  const n = new Network();
  const a = n.add('switch', 0, 0), b = n.add('pc', 0, 0);
  assert.strictEqual(n.rename(a.id, '  Core  '), null);
  assert.strictEqual(a.name, 'Core');
  assert.strictEqual(n.rename(b.id, 'core'), 'That name is already used.');
  assert.strictEqual(n.rename(b.id, '   '), 'Name cannot be empty.');
  assert.strictEqual(n.rename(b.id, 'x'.repeat(15)), 'Use 14 characters or fewer.');
  assert.strictEqual(b.name, 'PC1');
});

test('save and load keeps layout, cables and switch config', () => {
  const n = new Network();
  const sw = n.add('switch', 10, 20), pc = n.add('pc', 30, 40);
  n.connect(sw.id, pc.id);
  ['enable', 'conf t', 'hostname CORE', 'end', 'wr'].forEach(c => sw.sw.exec(c));
  const copy = new Network(JSON.parse(JSON.stringify(n.toJSON())));
  assert.strictEqual(copy.devices.length, 2);
  assert.strictEqual(copy.links.length, 1);
  const sw2 = copy.get(sw.id);
  assert.deepStrictEqual([sw2.x, sw2.y], [10, 20]);
  assert.strictEqual(sw2.sw.running.hostname, 'CORE');
  assert.strictEqual(sw2.sw.startup.hostname, 'CORE');
  assert.strictEqual(sw2.sw.mode, 'user');
  const fresh = copy.add('switch', 0, 0);
  assert.ok(![sw.id, pc.id].includes(fresh.id), 'new ids never collide');
});

test('load drops broken data instead of crashing', () => {
  const n = new Network({
    nextId: 1,
    devices: [
      { id: 'd1', type: 'switch', name: 'A', x: 0, y: 0 },
      { id: 'd1', type: 'switch', name: 'dup', x: 0, y: 0 },
      { id: 'd2', type: 'toaster', name: 'bad type', x: 0, y: 0 },
      { id: 'd3', type: 'pc', name: 'B', x: 'nope', y: 5 },
      null
    ],
    links: [
      { id: 'l1', a: { dev: 'd1', port: 'FastEthernet0/1' }, b: { dev: 'd3', port: 'FastEthernet0' } },
      { id: 'l2', a: { dev: 'd1', port: 'FastEthernet0/1' }, b: { dev: 'd3', port: 'FastEthernet0' } },
      { id: 'l3', a: { dev: 'd1', port: 'FastEthernet9/9' }, b: { dev: 'd3', port: 'FastEthernet0' } },
      { id: 'l4', a: { dev: 'd1', port: 'FastEthernet0/2' }, b: { dev: 'zzz', port: 'FastEthernet0' } }
    ]
  });
  assert.deepStrictEqual(n.devices.map(d => d.id), ['d1', 'd3']);
  assert.strictEqual(n.get('d3').x, 0);
  assert.deepStrictEqual(n.links.map(l => l.id), ['l1']);
  assert.ok(n.nextId > 3);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
