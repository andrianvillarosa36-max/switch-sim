// Run with: node tests/labs.test.js
const assert = require('assert');
require('../app/src/main/assets/engine.js');
require('../app/src/main/assets/netsim.js');
require('../app/src/main/assets/pcshell.js');
require('../app/src/main/assets/router.js');
const { Network } = require('../app/src/main/assets/network.js');
const { Labs } = require('../app/src/main/assets/labs.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 5).join('\n     ')); process.exitCode = 1; }
}
const memory = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, raw: m }; };
function sampleNet() {
  const net = new Network();
  const s = net.add('switch', 10, 20), p = net.add('pc', 30, 40), r = net.add('router', 50, 60);
  net.connect(s.id, p.id); net.connect(s.id, r.id);
  net.setPcConfig(p.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  ['enable', 'conf t', 'vlan 10', 'name Sales', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'end', 'write memory'].forEach(c => s.sw.exec(c));
  ['enable', 'conf t', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'end'].forEach(c => r.rt.exec(c));
  return net;
}

test('save, list, open, update, remove', () => {
  const store = memory(), labs = new Labs(store), net = sampleNet();
  assert.deepStrictEqual(labs.list(), []);
  const a = labs.save('VLAN practice', net.toJSON());
  assert.ok(a.id && a.name === 'VLAN practice');
  const b = labs.save('Routing', new Network().toJSON());
  assert.deepStrictEqual(labs.summary(labs.get(a.id)), { devices: 3, cables: 2 });
  assert.deepStrictEqual(labs.summary(labs.get(b.id)), { devices: 0, cables: 0 });
  // reopening restores everything
  const reopened = new Network(new Labs(store).get(a.id).net);
  assert.strictEqual(reopened.devices.length, 3);
  const sw = reopened.devices.find(d => d.type === 'switch');
  assert.strictEqual(sw.sw.vlans[10], 'Sales');
  assert.strictEqual(sw.sw.portCfg('FastEthernet0/1').accessVlan, 10);
  assert.strictEqual(reopened.devices.find(d => d.type === 'pc').cfg.ip, '192.168.1.10');
  assert.strictEqual(reopened.devices.find(d => d.type === 'router').rt.portCfg('GigabitEthernet0/0').ip, '192.168.1.1');
  // newest first, update bumps the time
  assert.strictEqual(labs.list()[0].id, b.id);
  const before = labs.get(a.id).saved;
  const later = sampleNet(); later.add('pc', 0, 0);
  const upd = labs.update(a.id, later.toJSON());
  assert.strictEqual(upd.id, a.id);
  assert.strictEqual(labs.summary(labs.get(a.id)).devices, 4);
  assert.ok(labs.get(a.id).saved >= before);
  labs.remove(b.id);
  assert.strictEqual(labs.list().length, 1);
  assert.strictEqual(new Labs(store).list().length, 1, 'persisted');
  assert.ok(labs.update('nope', net.toJSON()).error);
});

test('names are cleaned and made unique', () => {
  const labs = new Labs(memory()), net = new Network().toJSON();
  assert.strictEqual(labs.save('  Lab   one |  ', net).name, 'Lab one');
  assert.strictEqual(labs.save('lab one', net).name, 'lab one 2');
  assert.strictEqual(labs.save('LAB ONE', net).name, 'LAB ONE 3');
  assert.strictEqual(labs.save('', net).name, 'Untitled lab');
  assert.strictEqual(labs.save('x'.repeat(60), net).name.length, 40);
});

test('modified detection ignores layout noise that is not a change', () => {
  const labs = new Labs(memory()), net = sampleNet(), lab = labs.save('L', net.toJSON());
  assert.strictEqual(labs.isModified(lab.id, net.toJSON()), false);
  // console modes and the id counter are not changes
  const sw = net.devices.find(d => d.type === 'switch');
  sw.sw.exec('enable'); sw.sw.exec('configure terminal'); sw.sw.exec('end');
  net.nextId += 5;
  assert.strictEqual(labs.isModified(lab.id, net.toJSON()), false);
  // a real change is
  sw.sw.exec('configure terminal'); sw.sw.exec('hostname Core');
  assert.strictEqual(labs.isModified(lab.id, net.toJSON()), true);
  assert.strictEqual(labs.isModified('missing', net.toJSON()), true);
  const moved = sampleNet(); moved.devices[0].x += 1;
  assert.strictEqual(labs.isModified(lab.id, moved.toJSON()), true, 'moving a device counts');
});

test('share code round trip, including unicode names and configs', () => {
  const net = sampleNet();
  const code = Labs.encode('Café lab ✓', net.toJSON());
  assert.ok(code.startsWith('SwitchSimLab1|Café lab ✓|'));
  assert.ok(!/\n/.test(code));
  const back = Labs.decode(code);
  assert.strictEqual(back.name, 'Café lab ✓');
  assert.strictEqual(Labs.comparable(back.net), Labs.comparable(net.toJSON()));
  // survives being wrapped by a chat app
  const wrapped = '  ' + code.replace(/(.{60})/g, '$1\n') + '\n';
  assert.strictEqual(Labs.decode(wrapped.replace(/\n/g, '')).name, 'Café lab ✓');
  const pieces = code.split('|');
  assert.strictEqual(Labs.decode(pieces[0] + '|' + pieces[1] + '|' + pieces[2].replace(/(.{40})/g, '$1\n')).name, 'Café lab ✓', 'line breaks inside the data are fine');
});

test('bad share codes give clear errors', () => {
  assert.strictEqual(Labs.decode('').error, 'Paste a lab code first.');
  assert.strictEqual(Labs.decode('hello world').error, 'That is not a Switch Sim lab code.');
  assert.strictEqual(Labs.decode('SwitchSimLab1|x|@@@').error, 'That is not a Switch Sim lab code.');
  assert.strictEqual(Labs.decode('SwitchSimLab1|x|QUJD').error, 'The code is damaged. Copy the whole text again.');
  const notLab = 'SwitchSimLab1|x|' + Buffer.from(JSON.stringify({ hello: 1 })).toString('base64');
  assert.strictEqual(Labs.decode(notLab).error, 'The code does not contain a valid lab.');
  const huge = { devices: Array.from({ length: 61 }, (_, i) => ({ id: 'd' + i, type: 'pc' })), links: [] };
  assert.strictEqual(Labs.decode('SwitchSimLab1|x|' + Buffer.from(JSON.stringify(huge)).toString('base64')).error, 'The code does not contain a valid lab.');
  assert.strictEqual(Labs.decode('SwitchSimLab1||' + Buffer.from(JSON.stringify({ devices: [] })).toString('base64')).name, 'Imported lab');
});

test('an imported lab with junk is sanitised when loaded', () => {
  const net = sampleNet().toJSON();
  net.devices.push({ id: 'dX', type: 'toaster', name: 'bad', x: 0, y: 0 });
  net.devices.find(d => d.type === 'switch').sw.running.ports = { 'FastEthernet9/9': { mode: 'trunk' } };
  net.links.push({ id: 'lX', a: { dev: 'dX', port: 'x' }, b: { dev: 'dY', port: 'y' } });
  const out = Labs.decode(Labs.encode('junk', net));
  const loaded = new Network(out.net);
  assert.strictEqual(loaded.devices.length, 3);
  assert.strictEqual(loaded.links.length, 2);
  assert.deepStrictEqual(loaded.devices.find(d => d.type === 'switch').sw.running.ports, {});
});

test('limits and storage failures are reported, not thrown', () => {
  const store = memory(), labs = new Labs(store), net = new Network().toJSON();
  for (let i = 0; i < 50; i++) assert.ok(labs.save('lab ' + i, net).id);
  assert.match(labs.save('one too many', net).error, /up to 50 labs/);
  const broken = new Labs({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  assert.match(broken.save('x', net).error, /storage is full/);
  assert.strictEqual(broken.list().length, 0, 'a failed save is rolled back');
  const lab = labs.list()[0];
  const failing = new Labs({ getItem: () => JSON.stringify({ labs: [lab] }), setItem: () => { throw new Error('quota'); } });
  assert.match(failing.update(lab.id, net).error, /storage is full/);
  assert.deepStrictEqual(failing.get(lab.id).net, lab.net, 'and the old lab is kept');
  assert.ok(new Labs({ getItem: () => 'not json', setItem() {} }).list().length === 0, 'corrupt storage starts empty');
  assert.match(new Labs(memory()).save('x', null).error, /nothing to save/);
  const bigNet = { devices: [{ id: 'd1', type: 'pc', name: 'x'.repeat(450000) }], links: [] };
  assert.match(new Labs(memory()).save('big', bigNet).error, /too large/);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
