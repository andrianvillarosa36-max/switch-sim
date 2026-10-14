// Run with: node tests/router.test.js
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
const pc = (net, name, ip, gw = '') => {
  const d = named(net, 'pc', name);
  assert.strictEqual(net.setPcConfig(d.id, { ip, mask: '255.255.255.0', gateway: gw }), null);
  return d;
};
const cable = (net, a, b) => { const r = net.connect(a.id, b.id); assert.ok(r.link, r.error); return r.link; };
const rcli = (d, ...lines) => {
  if (d.rt.mode === 'user') d.rt.exec('enable');
  if (d.rt.mode === 'priv') d.rt.exec('configure terminal');
  return lines.flatMap(l => d.rt.exec(l));
};
const rshow = (d, line) => { d.rt.mode = 'priv'; return d.rt.exec(line); };
const scli = (d, ...lines) => {
  if (d.sw.mode === 'user') d.sw.exec('enable');
  if (d.sw.mode === 'priv') d.sw.exec('configure terminal');
  return lines.flatMap(l => d.sw.exec(l));
};
const ping = (net, from, ip) => N.pingOnce(net, from, ip);
const short = (p) => p.replace('FastEthernet', 'fa');

// PC1 - R1 - PC2 on two subnets
function oneRouter() {
  const net = new Network();
  const r1 = named(net, 'router', 'R1');
  const a = pc(net, 'PC1', '192.168.1.10', '192.168.1.1'), b = pc(net, 'PC2', '192.168.2.10', '192.168.2.1');
  cable(net, r1, a); cable(net, r1, b);
  rcli(r1, 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown',
    'interface g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'end');
  return { net, r1, a, b };
}

// PC1 - R1 - R2 - PC2 with a /30 between the routers
function twoRouters() {
  const net = new Network();
  const r1 = named(net, 'router', 'R1'), r2 = named(net, 'router', 'R2');
  const a = pc(net, 'PC1', '192.168.1.10', '192.168.1.1'), b = pc(net, 'PC2', '192.168.2.10', '192.168.2.1');
  cable(net, a, r1); cable(net, r1, r2); cable(net, r2, b);
  rcli(r1, 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown',
    'interface g0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'end');
  rcli(r2, 'interface g0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown',
    'interface g0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'end');
  return { net, r1, r2, a, b };
}

test('router CLI: modes, prompts, interfaces start shut down', () => {
  const net = new Network(), r = named(net, 'router', 'R1');
  assert.strictEqual(r.rt.prompt, 'Router>');
  r.rt.exec('en'); assert.strictEqual(r.rt.prompt, 'Router#');
  r.rt.exec('conf t'); assert.strictEqual(r.rt.prompt, 'Router(config)#');
  r.rt.exec('hostname R1'); assert.strictEqual(r.rt.prompt, 'R1(config)#');
  r.rt.exec('interface g0/0'); assert.strictEqual(r.rt.prompt, 'R1(config-if)#');
  r.rt.exec('interface gigabitethernet0/1.10'); assert.strictEqual(r.rt.prompt, 'R1(config-subif)#');
  r.rt.exec('hostname EDGE'); assert.strictEqual(r.rt.prompt, 'EDGE(config-subif)#', 'global command from a sub-mode');
  r.rt.exec('exit'); assert.strictEqual(r.rt.mode, 'config');
  const bad = r.rt.exec('interface g0/5');
  assert.ok(bad[1].startsWith('% Invalid input'));
  assert.ok(r.rt.exec('interface f0/0')[1].startsWith('% Invalid input'), 'routers here have Gigabit ports only');
  r.rt.exec('end');
  const brief = r.rt.exec('show ip interface brief').join('\n');
  assert.match(brief, /^Gi0\/0\s+unassigned\s+adm down\s+down$/m);
  assert.match(brief, /^Gi0\/1\.10\s+unassigned/m);
});

test('ip address validation and overlap', () => {
  const { r1 } = oneRouter();
  rcli(r1, 'interface g0/2');
  assert.deepStrictEqual(r1.rt.exec('ip address 192.168.1.5 255.255.255.0'), ['% 192.168.1.0 overlaps with GigabitEthernet0/0']);
  assert.deepStrictEqual(r1.rt.exec('ip address 192.168.9.0 255.255.255.0'), ['Bad mask /24 for address 192.168.9.0']);
  assert.deepStrictEqual(r1.rt.exec('ip address 192.168.9.255 255.255.255.0'), ['Bad mask /24 for address 192.168.9.255']);
  assert.ok(r1.rt.exec('ip address 192.168.9.1 255.0.255.0')[1].startsWith('% Invalid'));
  assert.ok(r1.rt.exec('ip address 300.1.1.1 255.255.255.0')[1].startsWith('% Invalid'));
  assert.deepStrictEqual(r1.rt.exec('ip address 192.168.9.1 255.255.255.0'), []);
  assert.strictEqual(r1.rt.portCfg('GigabitEthernet0/2').ip, '192.168.9.1');
  r1.rt.exec('no ip address');
  assert.strictEqual(r1.rt.portCfg('GigabitEthernet0/2').ip, '');
});

test('no shutdown reports link up only when a cable is plugged in and the far end is up', () => {
  const net = new Network(), r = named(net, 'router', 'R1'), p = pc(net, 'PC1', '10.0.0.5');
  assert.deepStrictEqual(rcli(r, 'interface g0/0', 'no shutdown'), [], 'no cable: nothing to report');
  rcli(r, 'shutdown');
  cable(net, r, p);
  assert.deepStrictEqual(rcli(r, 'no shutdown'), [
    '%LINK-3-UPDOWN: Interface GigabitEthernet0/0, changed state to up',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to up'
  ]);
  assert.deepStrictEqual(rcli(r, 'shutdown'), [
    '%LINK-5-CHANGED: Interface GigabitEthernet0/0, changed state to administratively down',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/0, changed state to down'
  ]);
});

test('routing between two subnets through one router', () => {
  const { net, r1, a, b } = oneRouter();
  const first = ping(net, a, '192.168.2.10');
  assert.ok(first.ok, 'PC1 to PC2');
  assert.strictEqual(first.ttl, 127, 'one router decrements TTL once');
  assert.ok(first.ms >= 10, 'first packet pays for ARP at PC and router');
  const second = ping(net, a, '192.168.2.10');
  assert.ok(second.ok && second.ms < 2);
  assert.ok(ping(net, b, '192.168.1.10').ok, 'and back');
  assert.ok(ping(net, a, '192.168.1.1').ok, 'the router answers on its own address');
  assert.strictEqual(ping(net, a, '192.168.2.1').ttl, 255 - 0, 'router replies keep TTL 255 (no hop back)');
  assert.strictEqual(a.arp['192.168.1.1'], N.routerIfaces(net, r1)[0].mac, 'PC ARPs for its gateway, not the far PC');
  assert.strictEqual(a.arp['192.168.2.10'], undefined);
});

test('PC mistakes: no gateway, wrong gateway, shut interface', () => {
  const { net, r1, a, b } = oneRouter();
  net.setPcConfig(a.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '' });
  assert.strictEqual(ping(net, a, '192.168.2.10').text, 'Reply from 192.168.1.10: Destination host unreachable.');
  net.setPcConfig(a.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.99' });
  assert.strictEqual(ping(net, a, '192.168.2.10').text, 'Request timed out.', 'nobody has that gateway address');
  net.setPcConfig(a.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  assert.ok(ping(net, a, '192.168.2.10').ok);
  rcli(r1, 'interface g0/1', 'shutdown');
  assert.strictEqual(ping(net, a, '192.168.2.10').text, 'Reply from 192.168.1.1: Destination host unreachable.', 'router has no route once its connected network is gone');
  rcli(r1, 'no shutdown');
  assert.ok(ping(net, a, '192.168.2.10').ok);
  net.setPcConfig(b.id, { ip: '192.168.2.10', mask: '255.255.255.0', gateway: '' });
  assert.strictEqual(ping(net, a, '192.168.2.10').text, 'Request timed out.', 'the reply has no way back');
});

test('router-on-a-stick: inter-VLAN routing over a trunk with subinterfaces', () => {
  const net = new Network();
  const s1 = named(net, 'switch', 'S1'), r1 = named(net, 'router', 'R1');
  const a = pc(net, 'PC1', '192.168.10.10', '192.168.10.1'), b = pc(net, 'PC2', '192.168.20.10', '192.168.20.1');
  cable(net, s1, a); cable(net, s1, b);
  const trunk = cable(net, s1, r1);
  scli(s1, 'vlan 10', 'exit', 'vlan 20', 'exit',
    'interface fa0/1', 'switchport mode access', 'switchport access vlan 10',
    'interface fa0/2', 'switchport mode access', 'switchport access vlan 20',
    'interface ' + short(trunk.a.port), 'switchport mode trunk', 'end');
  const out = rcli(r1, 'interface g0/0.10', 'ip address 192.168.10.1 255.255.255.0');
  assert.strictEqual(out.length, 3, 'IOS refuses an address before the encapsulation');
  assert.ok(out[0].startsWith('% Configuring IP routing on a LAN subinterface'));
  rcli(r1, 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0',
    'interface g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0');
  assert.strictEqual(ping(net, a, '192.168.20.10').ok, false, 'parent interface still shut down');
  rcli(r1, 'interface g0/0', 'no shutdown', 'end');
  const r = ping(net, a, '192.168.20.10');
  assert.ok(r.ok, 'PC1 (VLAN 10) reaches PC2 (VLAN 20) through the router');
  assert.strictEqual(r.ttl, 127);
  const mac = N.routerIfaces(net, r1)[0].mac;
  assert.ok(s1.sw.macTable.some(e => e.vlan === 10 && e.mac === mac && e.port === trunk.a.port), 'router MAC seen in VLAN 10');
  assert.ok(s1.sw.macTable.some(e => e.vlan === 20 && e.mac === mac), 'and in VLAN 20: same MAC on every subinterface');
  // breaking the trunk breaks routing
  scli(s1, 'interface ' + short(trunk.a.port), 'switchport trunk allowed vlan 10');
  b.arp = {}; a.arp = {};
  assert.strictEqual(ping(net, a, '192.168.20.10').ok, false, 'VLAN 20 pruned from the trunk');
  scli(s1, 'switchport trunk allowed vlan all');
  assert.ok(ping(net, a, '192.168.20.10').ok);
  scli(s1, 'switchport mode access');
  assert.strictEqual(ping(net, a, '192.168.20.10').ok, false, 'an access port cannot carry tagged subinterface traffic');
  scli(s1, 'switchport mode trunk');
  rcli(r1, 'interface g0/0.20', 'encapsulation dot1Q 30');
  assert.strictEqual(ping(net, a, '192.168.20.10').ok, false, 'wrong VLAN on the subinterface');
  assert.match(rshow(r1, 'show ip interface brief').join('\n'), /^Gi0\/0\.20\s+192\.168\.20\.1\s+up\s+up$/m);
});

test('static routes: missing return route, longest prefix, default route', () => {
  const { net, r1, r2, a } = twoRouters();
  assert.strictEqual(ping(net, a, '192.168.2.10').text, 'Reply from 192.168.1.1: Destination host unreachable.', 'R1 has no route');
  assert.deepStrictEqual(rcli(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2'), []);
  assert.strictEqual(ping(net, a, '192.168.2.10').text, 'Request timed out.', 'request arrives but R2 has no way back');
  rcli(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  const ok = ping(net, a, '192.168.2.10');
  assert.ok(ok.ok); assert.strictEqual(ok.ttl, 126, 'two routers decrement TTL twice');

  // a /32 beats the /24: send it to a next hop that does not answer
  rcli(r1, 'ip route 192.168.2.10 255.255.255.255 10.0.0.1');
  assert.strictEqual(ping(net, a, '192.168.2.10').ok, false, 'longest prefix wins');
  rcli(r1, 'no ip route 192.168.2.10 255.255.255.255 10.0.0.1');
  assert.ok(ping(net, a, '192.168.2.10').ok);

  // replace the specific route with a default route
  rcli(r1, 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'ip route 0.0.0.0 0.0.0.0 10.0.0.2');
  assert.ok(ping(net, a, '192.168.2.10').ok, 'default route');
  const route = rshow(r1, 'show ip route').join('\n');
  assert.ok(route.includes('Gateway of last resort is 10.0.0.2 to network 0.0.0.0'));
  assert.ok(route.includes('S* 0.0.0.0/0 [1/0] via 10.0.0.2'));
  assert.ok(route.includes('C  192.168.1.0/24 is directly connected, Gi0/0'));
  assert.ok(route.includes('L  10.0.0.1/32 is directly connected, Gi0/1'));
});

test('static route rules: reachable next hop, aligned mask, validation', () => {
  const { net, r1 } = twoRouters();
  assert.deepStrictEqual(rcli(r1, 'ip route 172.16.0.0 255.255.0.0 10.0.0.2'), []);
  assert.ok(rshow(r1, 'show ip route').join('\n').includes('S  172.16.0.0/16 [1/0] via 10.0.0.2'));
  rcli(r1, 'ip route 172.17.0.0 255.255.0.0 10.9.9.9');
  assert.ok(!rshow(r1, 'show ip route').join('\n').includes('172.17.0.0'), 'next hop is not on a connected network: not installed');
  assert.ok(rshow(r1, 'show running-config').join('\n').includes('ip route 172.17.0.0 255.255.0.0 10.9.9.9'), 'but it stays in the config');
  assert.deepStrictEqual(rcli(r1, 'ip route 172.18.0.1 255.255.0.0 10.0.0.2'), ['%Inconsistent address and mask']);
  assert.ok(rcli(r1, 'ip route 172.18.0.0 255.255.0.0')[0] === '% Incomplete command.');
  assert.ok(rcli(r1, 'ip route 172.18.0.0 255.0.255.0 10.0.0.2')[1].startsWith('% Invalid'));
  const dup = r1.rt.running.routes.length;
  rcli(r1, 'ip route 172.16.0.0 255.255.0.0 10.0.0.2');
  assert.strictEqual(r1.rt.running.routes.length, dup, 'duplicates are ignored');
});

test('router ping: first echo is lost to ARP, then success', () => {
  const { net, r1, r2 } = twoRouters();
  rcli(r1, 'ip route 192.168.2.0 255.255.255.0 10.0.0.2');
  rcli(r2, 'ip route 192.168.1.0 255.255.255.0 10.0.0.1');
  const head = rshow(r1, 'ping 192.168.2.10');
  assert.deepStrictEqual(head, ['Type escape sequence to abort.', 'Sending 5, 100-byte ICMP Echos to 192.168.2.10, timeout is 2 seconds:']);
  const job = r1.rt.takeJob();
  assert.strictEqual(job[0].t, '.!!!!');
  assert.ok(job[1].t.startsWith('Success rate is 80 percent (4/5), round-trip min/avg/max = '));
  rshow(r1, 'ping 192.168.2.10');
  const again = r1.rt.takeJob();
  assert.strictEqual(again[0].t, '!!!!!');
  assert.strictEqual(again[1].t.slice(0, 40), 'Success rate is 100 percent (5/5), round');
  rshow(r1, 'ping 172.31.0.1');
  const none = r1.rt.takeJob();
  assert.strictEqual(none[0].t, 'UUUUU');
  assert.strictEqual(none[1].t, 'Success rate is 0 percent (0/5)');
  assert.ok(rshow(r1, 'ping nonsense')[0].startsWith('% Unrecognized host'));
  assert.strictEqual(r1.rt.takeJob(), null);
});

test('show ip arp / clear arp-cache', () => {
  const { net, r1, a } = oneRouter();
  assert.deepStrictEqual(rshow(r1, 'show ip arp'), []);
  ping(net, a, '192.168.2.10');
  const arp = rshow(r1, 'show arp').join('\n');
  assert.match(arp, /^Address\s+Hardware Addr\s+Interface$/m);
  assert.match(arp, /^192\.168\.1\.10\s+0001\.[0-9a-f]{4}\.[0-9a-f]{4}\s+Gi0\/0$/m);
  assert.match(arp, /^192\.168\.2\.10\s+\S+\s+Gi0\/1$/m);
  rshow(r1, 'clear arp-cache');
  assert.deepStrictEqual(rshow(r1, 'show ip arp'), []);
});

test('running-config, save, reload, persistence', () => {
  const { net, r1 } = twoRouters();
  rcli(r1, 'interface g0/0', 'description lan side', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2', 'end');
  const run = rshow(r1, 'show running-config').join('\n');
  assert.ok(run.includes('interface GigabitEthernet0/0\n description lan side\n ip address 192.168.1.1 255.255.255.0\n!'));
  assert.ok(run.includes('interface GigabitEthernet0/2\n no ip address\n shutdown\n!'));
  assert.ok(run.includes('ip route 192.168.2.0 255.255.255.0 10.0.0.2'));
  assert.ok(r1.rt.dirty);
  rshow(r1, 'write memory');
  assert.ok(!r1.rt.dirty);
  // subinterface in the config text
  rcli(r1, 'interface g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'end');
  assert.ok(rshow(r1, 'show running-config').join('\n').includes('interface GigabitEthernet0/0.10\n encapsulation dot1Q 10\n ip address 192.168.10.1 255.255.255.0\n!'));
  // save and load the whole network
  const copy = new Network(JSON.parse(JSON.stringify(net.toJSON())));
  const c1 = copy.get(r1.id);
  assert.deepStrictEqual(c1.rt.running, r1.rt.running);
  assert.deepStrictEqual(c1.rt.startup, r1.rt.startup);
  // junk is dropped
  const junk = JSON.parse(JSON.stringify(net.toJSON()));
  junk.devices.find(d => d.id === r1.id).rt.running = { ports: { 'GigabitEthernet9/9': {}, 'GigabitEthernet0/0': { ip: 'x', mask: 'y', shutdown: 'no' } }, subifs: { bogus: {} }, routes: [{ net: '1.1.1.1' }] };
  const safe = new Network(junk).get(r1.id);
  assert.deepStrictEqual([safe.rt.running.ports, safe.rt.running.subifs, safe.rt.running.routes], [{}, {}, []]);
  // reload drops unsaved changes; interfaces come back as saved
  rcli(r1, 'interface g0/0', 'shutdown', 'end');
  r1.rt.exec('reload'); r1.rt.exec('no'); r1.rt.exec('');
  assert.strictEqual(r1.rt.portCfg('GigabitEthernet0/0').shutdown, false, 'saved config (no shutdown) is back');
  assert.strictEqual(r1.rt.running.subifs['GigabitEthernet0/0.10'], undefined, 'unsaved subinterface lost');
});

test('subinterface deletion and enable secret', () => {
  const net = new Network(), r = named(net, 'router', 'R1');
  rcli(r, 'interface g0/1.5', 'encapsulation dot1Q 5', 'exit', 'no interface g0/1.5');
  assert.deepStrictEqual(r.rt.running.subifs, {});
  rcli(r, 'enable secret cisco', 'end', 'disable');
  r.rt.exec('enable'); assert.strictEqual(r.rt.prompt, 'Password: ');
  r.rt.exec('cisco'); assert.strictEqual(r.rt.prompt, 'Router#');
  assert.ok(r.rt.exec('?').some(l => /show/.test(l)));
  assert.strictEqual(r.rt.complete('sh'), 'show ');
});

test('a routing loop does not hang the simulator', () => {
  const { net, r1, r2, a } = twoRouters();
  rcli(r1, 'ip route 0.0.0.0 0.0.0.0 10.0.0.2');
  rcli(r2, 'ip route 0.0.0.0 0.0.0.0 10.0.0.1');
  const r = ping(net, a, '8.8.8.8');
  assert.strictEqual(r.ok, false);
});

test('network model knows routers', () => {
  const net = new Network();
  const r = net.add('router', 5, 6);
  assert.strictEqual(r.name, 'R1');
  assert.deepStrictEqual(Network.portsOf('router'), ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'GigabitEthernet0/2']);
  const p = net.add('pc', 0, 0);
  assert.strictEqual(net.connect(r.id, p.id).link.a.port, 'GigabitEthernet0/0');
  const macs = new Set(N.routerIfaces(net, r).map(i => i.mac));
  assert.strictEqual(macs.size, 3, 'each physical port has its own MAC');
  assert.notStrictEqual(r.mac, p.mac);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
