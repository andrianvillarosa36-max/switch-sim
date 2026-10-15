// Run with: node tests/trace.test.js
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
const pc = (net, name, ip, gw = '') => { const d = named(net, 'pc', name); assert.strictEqual(net.setPcConfig(d.id, { ip, mask: '255.255.255.0', gateway: gw }), null); return d; };
const cable = (net, a, b) => { const r = net.connect(a.id, b.id); assert.ok(r.link, r.error); return r.link; };
const cli = (d, ...lines) => { const sh = d.sw || d.rt; if (sh.mode === 'user') sh.exec('enable'); if (sh.mode === 'priv') sh.exec('configure terminal'); return lines.flatMap(l => sh.exec(l)); };
const moves = (net) => net.trace.filter(e => e.kind === 'move');
const texts = (net) => net.trace.map(e => e.text);

function lan() {
  const net = new Network();
  const s1 = named(net, 'switch', 'SW1'), a = pc(net, 'PC1', '192.168.1.10'), b = pc(net, 'PC2', '192.168.1.20');
  cable(net, s1, a); cable(net, s1, b);
  return { net, s1, a, b };
}

test('a first ping is recorded hop by hop: ARP, then the echo', () => {
  const { net, a } = lan();
  N.beginTrace(net);
  assert.ok(N.pingOnce(net, a, '192.168.1.20').ok);
  const m = moves(net);
  assert.deepStrictEqual(m.map(e => e.t), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(m.map(e => e.type), ['arp-req', 'arp-req', 'arp-rep', 'arp-rep', 'icmp-req', 'icmp-req', 'icmp-rep', 'icmp-rep']);
  assert.strictEqual(m[0].text, 'PC1 to SW1: ARP request: who has 192.168.1.20? Tell 192.168.1.10');
  assert.strictEqual(m[1].text, 'SW1 to PC2: ARP request: who has 192.168.1.20? Tell 192.168.1.10');
  assert.ok(m[4].text.startsWith('PC1 to SW1: Ping request 192.168.1.10 to 192.168.1.20 (TTL 128)'));
  assert.ok(m[7].text.startsWith('SW1 to PC1: Ping reply 192.168.1.20 to 192.168.1.10 (TTL 128)'));
  m.forEach(e => assert.ok(e.link && e.from.dev && e.to.dev && e.from.port && e.to.port));
  assert.strictEqual(m[0].from.dev, a.id);
});

test('the switch announces what it learns, once', () => {
  const { net, s1, a } = lan();
  N.beginTrace(net);
  N.pingOnce(net, a, '192.168.1.20');
  const learned = net.trace.filter(e => e.kind === 'learn').map(e => e.text);
  assert.deepStrictEqual(learned, [
    'SW1 learned ' + a.mac + ' on Fa0/1 (VLAN 1)',
    'SW1 learned ' + net.devices.find(d => d.name === 'PC2').mac + ' on Fa0/2 (VLAN 1)'
  ]);
  const before = net.trace.length;
  N.pingOnce(net, a, '192.168.1.20');
  assert.ok(net.trace.slice(before).every(e => e.kind === 'move'), 'nothing new to learn the second time');
});

test('the next ping continues the timeline and has no ARP', () => {
  const { net, a } = lan();
  N.beginTrace(net);
  N.pingOnce(net, a, '192.168.1.20');
  const firstEnd = Math.max.apply(null, net.trace.map(e => e.t));
  const n1 = net.trace.length;
  N.pingOnce(net, a, '192.168.1.20');
  const second = net.trace.slice(n1).filter(e => e.kind === 'move');
  assert.deepStrictEqual(second.map(e => e.type), ['icmp-req', 'icmp-req', 'icmp-rep', 'icmp-rep']);
  assert.ok(second[0].t > firstEnd, 'second ping starts after the first one ends');
  N.beginTrace(net);
  assert.deepStrictEqual(net.trace, []);
});

test('flooding shows branches at the same step', () => {
  const net = new Network();
  const s1 = named(net, 'switch', 'SW1'), a = pc(net, 'PC1', '192.168.1.10'), b = pc(net, 'PC2', '192.168.1.20'), c = pc(net, 'PC3', '192.168.1.30');
  cable(net, s1, a); cable(net, s1, b); cable(net, s1, c);
  N.beginTrace(net);
  N.pingOnce(net, a, '192.168.1.20');
  const flood = moves(net).filter(e => e.type === 'arp-req' && e.t === 1);
  assert.strictEqual(flood.length, 2, 'the ARP request goes to PC2 and PC3 at once');
  assert.deepStrictEqual(flood.map(e => net.get(e.to.dev).name).sort(), ['PC2', 'PC3']);
});

test('trunks show the VLAN tag; drops say why', () => {
  const net = new Network();
  const s1 = named(net, 'switch', 'SW1'), s2 = named(net, 'switch', 'SW2'), a = pc(net, 'PC1', '192.168.1.10'), b = pc(net, 'PC2', '192.168.1.20');
  cable(net, s1, a); cable(net, s2, b); const l = cable(net, s1, s2);
  const fa = (p) => p.replace('FastEthernet', 'fa');
  cli(s1, 'vlan 10', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'interface ' + fa(l.a.port), 'switchport mode trunk', 'switchport trunk allowed vlan 20');
  cli(s2, 'vlan 10', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'interface ' + fa(l.b.port), 'switchport mode trunk');
  N.beginTrace(net);
  assert.strictEqual(N.pingOnce(net, a, '192.168.1.20').text, 'Request timed out.');
  const drops = net.trace.filter(e => e.kind === 'drop').map(e => e.text);
  assert.ok(drops.includes('SW1 dropped it: ARP got no answer'.replace('ARP got no answer', 'VLAN 10 is not allowed on this trunk')) === false, 'S1 does not even forward onto the pruned trunk');
  assert.ok(drops.includes('PC1 dropped it: no ARP reply from 192.168.1.20'), drops.join(' | '));
  // allow the VLAN again: tags are visible on the trunk hop
  cli(s1, 'switchport trunk allowed vlan all');
  N.beginTrace(net);
  assert.ok(N.pingOnce(net, a, '192.168.1.20').ok);
  const tagged = moves(net).filter(e => e.tagged);
  assert.ok(tagged.length >= 4 && tagged.every(e => e.vid === 10));
  assert.ok(tagged[0].text.endsWith('[VLAN 10 tag]'));
  // the far switch does not have the VLAN: it says so
  cli(s2, 'no vlan 10');
  a.arp = {}; N.beginTrace(net);
  N.pingOnce(net, a, '192.168.1.20');
  assert.ok(net.trace.some(e => e.kind === 'drop' && e.text === 'SW2 dropped it: VLAN 10 does not exist on this switch'));
  // a tagged frame on an access port
  cli(s2, 'vlan 10', 'exit', 'interface ' + fa(l.b.port), 'switchport mode access');
  a.arp = {}; N.beginTrace(net);
  N.pingOnce(net, a, '192.168.1.20');
  assert.ok(net.trace.some(e => e.kind === 'drop' && /tagged frame on an access port/.test(e.text)));
});

test('routers: hops, TTL and "no route" are visible', () => {
  const net = new Network();
  const r1 = named(net, 'router', 'R1'), a = pc(net, 'PC1', '192.168.1.10', '192.168.1.1'), b = pc(net, 'PC2', '192.168.2.10', '192.168.2.1');
  cable(net, r1, a); cable(net, r1, b);
  cli(r1, 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'interface g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown');
  N.beginTrace(net);
  assert.ok(N.pingOnce(net, a, '192.168.2.10').ok);
  const t = texts(net);
  assert.ok(t.includes('PC1 to R1: ARP request: who has 192.168.1.1? Tell 192.168.1.10'));
  assert.ok(t.includes('R1 to PC2: ARP request: who has 192.168.2.10? Tell 192.168.2.1'));
  assert.ok(t.includes('PC1 to R1: Ping request 192.168.1.10 to 192.168.2.10 (TTL 128)'));
  assert.ok(t.includes('R1 to PC2: Ping request 192.168.1.10 to 192.168.2.10 (TTL 127)'), 'TTL drops at the router');
  assert.ok(t.includes('PC2 to R1: Ping reply 192.168.2.10 to 192.168.1.10 (TTL 128)'));
  assert.ok(t.includes('R1 to PC1: Ping reply 192.168.2.10 to 192.168.1.10 (TTL 127)'));
  const ts = moves(net).map(e => e.t);
  assert.deepStrictEqual(ts, ts.slice().sort((x, y) => x - y), 'moves are in time order');
  // no route
  cli(r1, 'interface g0/1', 'shutdown');
  N.beginTrace(net);
  N.pingOnce(net, a, '192.168.2.10');
  assert.ok(texts(net).includes('R1 dropped it: no route to 192.168.2.10'));
  assert.ok(texts(net).some(x => /R1 to PC1: Destination unreachable, sent by 192\.168\.1\.1/.test(x)), 'and tells the sender');
});

test('the trace is bounded', () => {
  const { net, a } = lan();
  N.beginTrace(net);
  for (let i = 0; i < 200; i++) N.pingOnce(net, a, '192.168.1.20');
  assert.ok(net.trace.length <= 600);
});

test('console commands start a new trace (PC and router)', () => {
  const { net, a } = lan();
  a.shell.exec('ping 192.168.1.20');
  const n1 = net.trace.length;
  assert.ok(n1 > 8, 'four pings recorded');
  a.shell.takeJob();
  a.shell.exec('ping -n 1 192.168.1.20');
  assert.ok(net.trace.length < n1, 'a new command replaces the old trace');
  assert.ok(net.trace.every(e => e.t >= 0));
  const r = named(net, 'router', 'R1');
  cli(r, 'interface g0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'end');
  r.rt.exec('ping 10.0.0.9');
  assert.ok(net.trace.length === 0 || net.trace.every(e => e.t >= 0));
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
