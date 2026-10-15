// Run with: node tests/rip.test.js
const assert = require('assert');
require('../app/src/main/assets/engine.js');
const N = require('../app/src/main/assets/netsim.js');
require('../app/src/main/assets/pcshell.js');
require('../app/src/main/assets/router.js');
const { Network } = require('../app/src/main/assets/network.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 5).join('\n     ')); process.exitCode = 1; }
}
const named = (net, type, name) => { const d = net.add(type, 0, 0); net.rename(d.id, name); return d; };
const pc = (net, name, ip, gw) => { const d = named(net, 'pc', name); assert.strictEqual(net.setPcConfig(d.id, { ip, mask: '255.255.255.0', gateway: gw }), null); return d; };
const cable = (net, a, b) => { const r = net.connect(a.id, b.id); assert.ok(r.link, r.error); return r.link; };
const rcli = (d, ...lines) => { if (d.rt.mode === 'user') d.rt.exec('enable'); if (d.rt.mode === 'priv') d.rt.exec('configure terminal'); return lines.flatMap(l => d.rt.exec(l)); };
const scli = (d, ...lines) => { if (d.sw.mode === 'user') d.sw.exec('enable'); if (d.sw.mode === 'priv') d.sw.exec('configure terminal'); return lines.flatMap(l => d.sw.exec(l)); };
const show = (d, l) => { d.rt.mode = 'priv'; return d.rt.exec(l).join('\n'); };
const ifcfg = (r, g, ip, mask) => rcli(r, 'interface ' + g, 'ip address ' + ip + ' ' + mask, 'no shutdown');

// PC1 - R1 - R2 - R3 - PC2 (a chain)
function chain(withRip = true) {
  const net = new Network();
  const r1 = named(net, 'router', 'R1'), r2 = named(net, 'router', 'R2'), r3 = named(net, 'router', 'R3');
  const a = pc(net, 'PC1', '192.168.1.10', '192.168.1.1'), b = pc(net, 'PC2', '192.168.3.10', '192.168.3.1');
  cable(net, a, r1); cable(net, r1, r2); cable(net, r2, r3); cable(net, r3, b);
  ifcfg(r1, 'g0/0', '192.168.1.1', '255.255.255.0'); ifcfg(r1, 'g0/1', '10.0.12.1', '255.255.255.252');
  ifcfg(r2, 'g0/0', '10.0.12.2', '255.255.255.252'); ifcfg(r2, 'g0/1', '10.0.23.1', '255.255.255.252');
  ifcfg(r3, 'g0/0', '10.0.23.2', '255.255.255.252'); ifcfg(r3, 'g0/1', '192.168.3.1', '255.255.255.0');
  if (withRip) {
    rcli(r1, 'router rip', 'version 2', 'network 192.168.1.0', 'network 10.0.0.0', 'no auto-summary', 'end');
    rcli(r2, 'router rip', 'version 2', 'network 10.0.0.0', 'no auto-summary', 'end');
    rcli(r3, 'router rip', 'version 2', 'network 10.0.0.0', 'network 192.168.3.0', 'no auto-summary', 'end');
  }
  return { net, r1, r2, r3, a, b };
}

test('RIP learns networks hop by hop with the right metrics', () => {
  const { r1, r2, r3 } = chain();
  const t1 = show(r1, 'show ip route');
  assert.ok(t1.includes('Codes: C - connected, S - static, R - RIP, L - local'));
  assert.ok(t1.includes('R  10.0.23.0/30 [120/1] via 10.0.12.2, Gi0/1'), t1);
  assert.ok(t1.includes('R  192.168.3.0/24 [120/2] via 10.0.12.2, Gi0/1'));
  const t2 = show(r2, 'show ip route');
  assert.ok(t2.includes('R  192.168.1.0/24 [120/1] via 10.0.12.1, Gi0/0'));
  assert.ok(t2.includes('R  192.168.3.0/24 [120/1] via 10.0.23.2, Gi0/1'));
  const t3 = show(r3, 'show ip route');
  assert.ok(t3.includes('R  192.168.1.0/24 [120/2] via 10.0.23.1, Gi0/0'));
  assert.ok(t3.includes('R  10.0.12.0/30 [120/1] via 10.0.23.1, Gi0/0'));
  assert.ok(!t1.includes('R  10.0.12.0'), 'directly connected networks are not learned again');
});

test('hosts can ping end to end over RIP routes', () => {
  const { net, a, b } = chain();
  const r = N.pingOnce(net, a, '192.168.3.10');
  assert.ok(r.ok);
  assert.strictEqual(r.ttl, 125, 'three routers');
  assert.ok(N.pingOnce(net, b, '192.168.1.10').ok);
});

test('without RIP nothing is learned and the ping fails', () => {
  const { net, r1, a } = chain(false);
  assert.ok(!show(r1, 'show ip route').includes('R  '));
  assert.strictEqual(N.pingOnce(net, a, '192.168.3.10').text, 'Reply from 192.168.1.1: Destination host unreachable.');
});

test('a missing network statement keeps a LAN out of RIP', () => {
  const { net, r3, r1, a } = chain();
  rcli(r3, 'router rip', 'no network 192.168.3.0', 'end');
  assert.ok(!show(r1, 'show ip route').includes('192.168.3.0'));
  assert.strictEqual(N.pingOnce(net, a, '192.168.3.10').text, 'Reply from 192.168.1.1: Destination host unreachable.');
  rcli(r3, 'router rip', 'network 192.168.3.77', 'end');       // normalised to the classful network
  assert.deepStrictEqual(r3.rt.running.rip.networks, ['10.0.0.0', '192.168.3.0']);
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
});

test('passive-interface stops updates going out of that interface', () => {
  const { net, r1, r2, a } = chain();
  rcli(r1, 'router rip', 'passive-interface g0/1', 'end');
  assert.ok(!show(r2, 'show ip route').includes('192.168.1.0'), 'R2 no longer hears R1');
  assert.ok(show(r1, 'show ip route').includes('R  192.168.3.0/24'), 'R1 still listens to R2');
  assert.strictEqual(N.pingOnce(net, a, '192.168.3.10').text, 'Request timed out.', 'no way back for the reply');
  rcli(r1, 'router rip', 'no passive-interface g0/1', 'end');
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
});

test('a shut interface withdraws the routes behind it', () => {
  const { net, r1, r2, a } = chain();
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
  rcli(r2, 'interface g0/1', 'shutdown', 'end');
  assert.ok(!show(r1, 'show ip route').includes('192.168.3.0'));
  assert.strictEqual(N.pingOnce(net, a, '192.168.3.10').text, 'Reply from 192.168.1.1: Destination host unreachable.');
  rcli(r2, 'interface g0/1', 'no shutdown', 'end');
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
});

test('shortest path wins and RIP fails over when a link goes down', () => {
  const net = new Network();
  const r1 = named(net, 'router', 'R1'), r2 = named(net, 'router', 'R2'), r3 = named(net, 'router', 'R3');
  const a = pc(net, 'PC1', '192.168.1.10', '192.168.1.1'), b = pc(net, 'PC2', '192.168.3.10', '192.168.3.1');
  cable(net, a, r1);    // R1 g0/0
  cable(net, r1, r3);   // R1 g0/1 - R3 g0/0 (direct)
  cable(net, r3, b);    // R3 g0/1
  cable(net, r1, r2);   // R1 g0/2 - R2 g0/0
  cable(net, r2, r3);   // R2 g0/1 - R3 g0/2
  ifcfg(r1, 'g0/0', '192.168.1.1', '255.255.255.0'); ifcfg(r1, 'g0/1', '10.0.13.1', '255.255.255.252'); ifcfg(r1, 'g0/2', '10.0.12.1', '255.255.255.252');
  ifcfg(r2, 'g0/0', '10.0.12.2', '255.255.255.252'); ifcfg(r2, 'g0/1', '10.0.23.1', '255.255.255.252');
  ifcfg(r3, 'g0/0', '10.0.13.2', '255.255.255.252'); ifcfg(r3, 'g0/2', '10.0.23.2', '255.255.255.252'); ifcfg(r3, 'g0/1', '192.168.3.1', '255.255.255.0');
  [[r1, '192.168.1.0'], [r2], [r3, '192.168.3.0']].forEach(([r, lan]) => rcli(r, 'router rip', 'version 2', 'network 10.0.0.0', lan ? 'network ' + lan : 'exit', 'end'));
  assert.ok(show(r1, 'show ip route').includes('R  192.168.3.0/24 [120/1] via 10.0.13.2, Gi0/1'), 'direct link: one hop');
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
  assert.strictEqual(N.pingOnce(net, a, '192.168.3.10').ttl, 126);
  rcli(r1, 'interface g0/1', 'shutdown', 'end');
  assert.ok(show(r1, 'show ip route').includes('R  192.168.3.0/24 [120/2] via 10.0.12.2, Gi0/2'), 'fails over through R2');
  const r = N.pingOnce(net, a, '192.168.3.10');
  assert.ok(r.ok); assert.strictEqual(r.ttl, 125, 'one more router on the way');
});

test('static routes (distance 1) beat RIP (distance 120)', () => {
  const { net, r1, a } = chain();
  rcli(r1, 'ip route 192.168.3.0 255.255.255.0 10.0.12.2', 'end');
  const t = show(r1, 'show ip route');
  assert.ok(t.includes('S  192.168.3.0/24 [1/0] via 10.0.12.2'));
  assert.ok(!t.includes('R  192.168.3.0/24'), 'the RIP route to the same prefix is hidden');
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
  // a bad static route with the same prefix breaks things even though RIP knows better
  rcli(r1, 'no ip route 192.168.3.0 255.255.255.0 10.0.12.2', 'ip route 192.168.3.0 255.255.255.0 10.0.12.99', 'end');
  assert.ok(show(r1, 'show ip route').includes('R  192.168.3.0/24'), 'a static route whose next hop is unreachable is not installed');
  assert.ok(N.pingOnce(net, a, '192.168.3.10').ok);
  // a longer static prefix wins over RIP
  rcli(r1, 'ip route 192.168.3.0 255.255.255.128 10.0.12.1', 'end');
  assert.strictEqual(N.pingOnce(net, a, '192.168.3.10').ok, false, 'the /25 static route points at R1 itself and beats the RIP /24');
});

test('RIP adjacency needs a working Layer 2 path through switches', () => {
  const net = new Network();
  const r1 = named(net, 'router', 'R1'), r2 = named(net, 'router', 'R2'), s = named(net, 'switch', 'SW1');
  const a = pc(net, 'PC1', '192.168.1.10', '192.168.1.1'), b = pc(net, 'PC2', '192.168.2.10', '192.168.2.1');
  cable(net, a, r1); cable(net, r1, s); cable(net, r2, s);     // R1 g0/1 - SW fa0/1, R2 g0/0 - SW fa0/2
  cable(net, r2, b);                                           // R2 g0/1: its LAN needs a live link to be advertised
  ifcfg(r1, 'g0/0', '192.168.1.1', '255.255.255.0'); ifcfg(r1, 'g0/1', '10.0.0.1', '255.255.255.0');
  ifcfg(r2, 'g0/0', '10.0.0.2', '255.255.255.0');
  rcli(r2, 'interface g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown');
  rcli(r1, 'router rip', 'network 192.168.1.0', 'network 10.0.0.0', 'end');
  rcli(r2, 'router rip', 'network 192.168.2.0', 'network 10.0.0.0', 'end');
  assert.ok(show(r1, 'show ip route').includes('R  192.168.2.0/24 [120/1] via 10.0.0.2, Gi0/1'), 'neighbours across a switch');
  scli(s, 'interface fa0/2', 'switchport mode access', 'switchport access vlan 20', 'end');
  assert.ok(!show(r1, 'show ip route').includes('192.168.2.0'), 'different VLANs: no adjacency');
  assert.ok(!show(r2, 'show ip route').includes('192.168.1.0'));
});

test('show ip protocols, running-config and no router rip', () => {
  const { r1, r2 } = chain();
  rcli(r1, 'router rip', 'passive-interface g0/0', 'end');
  const p = show(r1, 'show ip protocols');
  assert.ok(p.startsWith('Routing Protocol is "rip"'));
  assert.ok(p.includes('send version 2'));
  assert.ok(/Routing for Networks:\n    10\.0\.0\.0\n    192\.168\.1\.0/.test(p));
  assert.ok(p.includes('Passive Interface(s):\n    GigabitEthernet0/0'));
  assert.ok(/Gateway {3}Distance\n    10\.0\.12\.2 {1,}120/.test(p), p);
  const run = show(r1, 'show running-config');
  assert.ok(run.includes('router rip\n version 2\n passive-interface GigabitEthernet0/0\n network 10.0.0.0\n network 192.168.1.0\n no auto-summary\n!'), run);
  assert.strictEqual(show(r1, 'show ip protocols') === '' , false);
  rcli(r2, 'no router rip', 'end');
  assert.strictEqual(show(r2, 'show ip protocols'), '');
  assert.ok(!show(r2, 'show running-config').includes('router rip'));
  assert.ok(!show(r1, 'show ip route').includes('R  192.168.3.0'), 'R2 is gone from RIP, so R1 loses what it knew through R2');
});

test('router rip mode: prompts, errors, fallback, help', () => {
  const net = new Network(), r = named(net, 'router', 'R1');
  rcli(r, 'router rip');
  assert.strictEqual(r.rt.prompt, 'Router(config-router)#');
  assert.ok(r.rt.exec('network banana')[1].startsWith('% Invalid input'));
  assert.ok(r.rt.exec('version 3')[1].startsWith('% Invalid input'));
  assert.ok(r.rt.exec('passive-interface g0/9')[1].startsWith('% Invalid input'));
  r.rt.exec('hostname EDGE'); assert.strictEqual(r.rt.prompt, 'EDGE(config-router)#', 'global command works in router mode');
  r.rt.exec('interface g0/0'); assert.strictEqual(r.rt.mode, 'config-if');
  r.rt.exec('router rip'); r.rt.exec('exit'); assert.strictEqual(r.rt.mode, 'config');
  r.rt.exec('router rip'); assert.ok(r.rt.exec('?').some(l => /network/.test(l)));
  assert.strictEqual(r.rt.complete('pass'), 'passive-interface ');
  assert.strictEqual(show(r, 'show ip route').includes('R  '), false);
});

test('RIP settings survive save and load', () => {
  const { net, r1 } = chain();
  rcli(r1, 'router rip', 'passive-interface g0/0', 'end');
  const copy = new Network(JSON.parse(JSON.stringify(net.toJSON())));
  assert.deepStrictEqual(copy.get(r1.id).rt.running.rip, r1.rt.running.rip);
  const a = copy.devices.find(d => d.name === 'PC1');
  assert.ok(N.pingOnce(copy, a, '192.168.3.10').ok, 'routes are rebuilt from the saved config');
  const junk = JSON.parse(JSON.stringify(net.toJSON()));
  junk.devices.find(d => d.id === r1.id).rt.running.rip = { enabled: true, version: 9, networks: ['10.0.0.1', 'x', '192.168.1.0'], passive: ['GigabitEthernet9/9', 'GigabitEthernet0/1'], autoSummary: 'no' };
  const safe = new Network(junk).get(r1.id).rt.running.rip;
  assert.deepStrictEqual(safe, { enabled: true, version: 1, networks: ['192.168.1.0'], passive: ['GigabitEthernet0/1'], autoSummary: true });
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
