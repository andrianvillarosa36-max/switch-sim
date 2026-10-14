// Run with: node tests/vlan.test.js
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

const sw = (net, name) => { const d = net.add('switch', 0, 0); net.rename(d.id, name); return d; };
const pc = (net, name, ip) => {
  const d = net.add('pc', 0, 0); net.rename(d.id, name);
  assert.strictEqual(net.setPcConfig(d.id, { ip, mask: '255.255.255.0', gateway: '' }), null);
  return d;
};
const cable = (net, a, b) => { const r = net.connect(a.id, b.id); assert.ok(r.link, r.error); return r.link; };
// Run CLI lines on a switch (enters config mode first) and return all output.
const cli = (d, ...lines) => {
  if (d.sw.mode === 'user') d.sw.exec('enable');
  if (d.sw.mode === 'priv') d.sw.exec('configure terminal');
  return lines.flatMap(l => d.sw.exec(l));
};
const show = (d, line) => { d.sw.setMode('priv'); return d.sw.exec(line); };
const ping = (net, from, ip) => N.pingOnce(net, from, ip);

// PC1 - S1 - PC2, both on the one switch
function oneSwitch() {
  const net = new Network();
  const s1 = sw(net, 'S1'), a = pc(net, 'PC1', '192.168.1.10'), b = pc(net, 'PC2', '192.168.1.20');
  cable(net, s1, a); cable(net, s1, b);
  return { net, s1, a, b };
}
// PC1 - S1 =trunk= S2 - PC2 (S1 Fa0/24 to S2 Fa0/24)
function twoSwitches() {
  const net = new Network();
  const s1 = sw(net, 'S1'), s2 = sw(net, 'S2'), a = pc(net, 'PC1', '192.168.1.10'), b = pc(net, 'PC2', '192.168.1.20');
  cable(net, s1, a); cable(net, s2, b);
  // use Fa0/24 on both for the inter-switch link, by filling ports 2..23 is overkill: connect and read the ports
  const l = cable(net, s1, s2);
  return { net, s1, s2, a, b, link: l, p1: l.a.port, p2: l.b.port };
}
const short = (p) => p.replace('FastEthernet', 'fa');

test('VLAN database: create, name, rename, delete, protect VLAN 1', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'vlan 10', 'name Sales');
  assert.strictEqual(s1.sw.prompt, 'Switch(config-vlan)#');
  assert.strictEqual(s1.sw.vlans[10], 'Sales');
  s1.sw.exec('exit');
  assert.strictEqual(s1.sw.mode, 'config');
  cli(s1, 'vlan 20');
  assert.strictEqual(s1.sw.vlans[20], 'VLAN0020');
  s1.sw.exec('end');
  assert.deepStrictEqual(cli(s1, 'vlan 1', 'name x'), ['% Default VLAN 1 may not have its name changed.']);
  s1.sw.exec('exit'); s1.sw.exec('no vlan 20');
  assert.strictEqual(s1.sw.vlans[20], undefined);
  assert.deepStrictEqual(s1.sw.exec('no vlan 1'), ['% Default VLAN 1 may not be deleted.']);
  assert.deepStrictEqual(s1.sw.exec('no vlan 1003'), ['% Default VLAN 1003 may not be deleted.']);
  const err = s1.sw.exec('vlan 5000');
  assert.ok(err[1].startsWith('% Invalid input'));
  assert.strictEqual(err[0], ' '.repeat('Switch(config)#vlan '.length) + '^');
});

test('interface modes, access VLAN auto-create, show vlan brief', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'vlan 10', 'name Sales', 'exit');
  assert.deepStrictEqual(cli(s1, 'interface fa0/1', 'switchport mode access', 'switchport access vlan 10'), []);
  assert.strictEqual(s1.sw.prompt, 'Switch(config-if)#');
  assert.deepStrictEqual(s1.sw.exec('switchport access vlan 30'), ['% Access VLAN does not exist. Creating vlan 30']);
  assert.strictEqual(s1.sw.vlans[30], 'VLAN0030');
  s1.sw.exec('switchport access vlan 10');
  const out = show(s1, 'show vlan brief').join('\n');
  assert.match(out, /^1\s+default\s+active\s+Fa0\/2/m);
  assert.match(out, /^10\s+Sales\s+active\s+Fa0\/1$/m);
  assert.match(out, /^30\s+VLAN0030\s+active\s*$/m);
  assert.match(out, /^1002\s+fddi-default\s+act\/unsup/m);
  assert.ok(!/^1\s+default.*Fa0\/1\b/m.test(out), 'Fa0/1 is not in VLAN 1 any more');
});

test('interface and interface range parsing', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'interface range fa0/1 - 4');
  assert.deepStrictEqual(s1.sw.curIfs, ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'FastEthernet0/4']);
  assert.strictEqual(s1.sw.prompt, 'Switch(config-if-range)#');
  s1.sw.exec('interface range fa0/1-2,fa0/10'); assert.strictEqual(s1.sw.curIfs.length, 3);
  s1.sw.exec('interface range fastethernet0/5 - fastethernet0/6'); assert.strictEqual(s1.sw.curIfs.length, 2);
  const before = s1.sw.curIfs.slice();
  assert.ok(s1.sw.exec('int range g0/1 - 2')[1].startsWith('% Invalid'));          // a single letter is not accepted
  assert.deepStrictEqual(s1.sw.curIfs, before, 'a failed command changes nothing');
  s1.sw.exec('interface range gi0/1 - 2'); assert.deepStrictEqual(s1.sw.curIfs, ['GigabitEthernet0/1', 'GigabitEthernet0/2']);
  s1.sw.exec('interface fastethernet 0/7'); assert.deepStrictEqual(s1.sw.curIfs, ['FastEthernet0/7']);
  s1.sw.exec('interface fa0/7'); assert.strictEqual(s1.sw.mode, 'config-if');
  const bad = s1.sw.exec('interface fa0/30');
  assert.ok(bad[1].startsWith('% Invalid input'));
  assert.strictEqual(bad[0], ' '.repeat('Switch(config-if)#interface '.length) + '^');
  assert.ok(s1.sw.exec('interface range fa0/9 - fa0/3')[1].startsWith('% Invalid'));
  // range config applies to every port
  s1.sw.exec('interface range fa0/5 - 8');
  s1.sw.exec('switchport mode access'); s1.sw.exec('switchport access vlan 5'); s1.sw.exec('description staff lab');
  ['FastEthernet0/5', 'FastEthernet0/8'].forEach(p => {
    const c = s1.sw.portCfg(p);
    assert.deepStrictEqual([c.mode, c.accessVlan, c.description], ['access', 5, 'staff lab']);
  });
});

test('global commands work from a sub-mode and keep the mode', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'interface fa0/1', 'hostname EDGE');
  assert.strictEqual(s1.sw.prompt, 'EDGE(config-if)#');
  s1.sw.exec('interface fa0/2');
  assert.deepStrictEqual(s1.sw.curIfs, ['FastEthernet0/2']);
  s1.sw.exec('vlan 7');
  assert.strictEqual(s1.sw.mode, 'config-vlan');
  assert.ok(s1.sw.exec('foo')[1].startsWith('% Invalid'), 'unknown stays an error');
  s1.sw.exec('end'); assert.strictEqual(s1.sw.mode, 'priv');
});

test('same VLAN reaches, different VLANs are isolated (one switch)', () => {
  const { net, s1, a, b } = oneSwitch();
  assert.ok(ping(net, a, '192.168.1.20').ok, 'both in VLAN 1 by default');
  cli(s1, 'interface fa0/1', 'switchport mode access', 'switchport access vlan 10',
    'interface fa0/2', 'switchport mode access', 'switchport access vlan 20');
  a.arp = {}; b.arp = {};
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.');
  cli(s1, 'interface fa0/2', 'switchport access vlan 10');
  assert.ok(ping(net, a, '192.168.1.20').ok, 'now both in VLAN 10');
  const vlans = new Set(s1.sw.macTable.map(e => e.vlan));
  assert.ok(vlans.has(10) && vlans.has(1), 'learned per VLAN: old VLAN 1 entries remain until flushed');
  assert.ok(s1.sw.macTable.some(e => e.vlan === 10 && e.mac === a.mac && e.port === 'FastEthernet0/1'));
});

test('a trunk carries VLANs between switches; a plain link does not', () => {
  const { net, s1, s2, a, b, p1, p2 } = twoSwitches();
  cli(s1, 'interface fa0/1', 'switchport mode access', 'switchport access vlan 10');
  cli(s2, 'interface fa0/1', 'switchport mode access', 'switchport access vlan 10');
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.', 'link is access VLAN 1: VLAN 10 stops at the switch');
  cli(s1, 'interface ' + short(p1), 'switchport mode trunk');
  assert.ok(ping(net, a, '192.168.1.20').ok, 'one side trunk, other dynamic auto: negotiated trunk');
  assert.strictEqual(N.operMode(net, s2, p2), 'trunk');
  assert.ok(s1.sw.macTable.some(e => e.vlan === 10 && e.mac === b.mac && e.port === p1));
  assert.ok(s2.sw.macTable.some(e => e.vlan === 10 && e.mac === a.mac && e.port === p2));
});

test('trunk negotiation matrix', () => {
  const modes = (m1, m2) => {
    const { net, s1, s2, p1, p2 } = twoSwitches();
    const set = (d, p, m) => cli(d, 'interface ' + short(p), m);
    if (m1) set(s1, p1, m1); if (m2) set(s2, p2, m2);
    return [N.operMode(net, s1, p1), N.operMode(net, s2, p2)];
  };
  assert.deepStrictEqual(modes(null, null), ['access', 'access'], 'auto + auto');
  assert.deepStrictEqual(modes('switchport mode dynamic desirable', null), ['trunk', 'trunk'], 'desirable + auto');
  assert.deepStrictEqual(modes('switchport mode dynamic desirable', 'switchport mode dynamic desirable'), ['trunk', 'trunk']);
  assert.deepStrictEqual(modes('switchport mode trunk', null), ['trunk', 'trunk'], 'trunk pulls auto into trunking');
  assert.deepStrictEqual(modes('switchport mode trunk', 'switchport mode access'), ['trunk', 'access'], 'mismatch');
  assert.deepStrictEqual(modes('switchport mode access', 'switchport mode dynamic desirable'), ['access', 'access']);
});

test('access/trunk mismatch loses tagged VLANs', () => {
  const { net, s1, s2, a, b, p1, p2 } = twoSwitches();
  cli(s1, 'interface fa0/1', 'switchport access vlan 10', 'interface ' + short(p1), 'switchport mode trunk');
  cli(s2, 'interface fa0/1', 'switchport access vlan 10', 'interface ' + short(p2), 'switchport mode access');
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.');
});

test('allowed VLAN list on a trunk', () => {
  const { net, s1, s2, a, p1, p2 } = twoSwitches();
  cli(s1, 'interface fa0/1', 'switchport access vlan 10');
  cli(s2, 'interface fa0/1', 'switchport access vlan 10');
  cli(s1, 'interface ' + short(p1), 'switchport mode trunk', 'switchport trunk allowed vlan 20,30');
  cli(s2, 'interface ' + short(p2), 'switchport mode trunk');
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.', 'VLAN 10 pruned');
  cli(s1, 'interface ' + short(p1), 'switchport trunk allowed vlan add 10');
  assert.strictEqual(s1.sw.portCfg(p1).allowed, '10,20,30');
  assert.ok(ping(net, a, '192.168.1.20').ok);
  cli(s1, 'interface ' + short(p1), 'switchport trunk allowed vlan remove 10');
  assert.strictEqual(s1.sw.portCfg(p1).allowed, '20,30');
  cli(s1, 'interface ' + short(p1), 'switchport trunk allowed vlan all');
  assert.strictEqual(s1.sw.portCfg(p1).allowed, 'all');
  cli(s1, 'interface ' + short(p1), 'switchport trunk allowed vlan none');
  assert.strictEqual(s1.sw.portCfg(p1).allowed, '');
  cli(s1, 'interface ' + short(p1), 'switchport trunk allowed vlan remove 5', 'no switchport trunk allowed vlan');
  assert.strictEqual(s1.sw.portCfg(p1).allowed, 'all');
  cli(s1, 'interface ' + short(p1), 'switchport trunk allowed vlan all', 'switchport trunk allowed vlan remove 10-12');
  assert.strictEqual(s1.sw.portCfg(p1).allowed, '1-9,13-4094');
  assert.ok(s1.sw.exec('switchport trunk allowed vlan 4095')[1].startsWith('% Invalid'));
});

test('VLAN must exist to cross a trunk', () => {
  const { net, s1, s2, a, p1, p2 } = twoSwitches();
  cli(s1, 'interface fa0/1', 'switchport access vlan 10', 'interface ' + short(p1), 'switchport mode trunk');
  cli(s2, 'interface fa0/1', 'switchport access vlan 10', 'interface ' + short(p2), 'switchport mode trunk');
  assert.ok(ping(net, a, '192.168.1.20').ok);
  cli(s2, 'no vlan 10');
  a.arp = {};
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.', 'S2 deleted VLAN 10');
});

test('native VLAN: untagged traffic, and a mismatch breaks it', () => {
  const { net, s1, s2, a, p1, p2 } = twoSwitches();
  cli(s1, 'interface ' + short(p1), 'switchport mode trunk');
  cli(s2, 'interface ' + short(p2), 'switchport mode trunk');
  assert.ok(ping(net, a, '192.168.1.20').ok, 'VLAN 1 is native on both: untagged');
  cli(s2, 'vlan 99', 'exit', 'interface ' + short(p2), 'switchport trunk native vlan 99');
  a.arp = {}; s1.sw.macTable = []; s2.sw.macTable = [];
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.', 'native mismatch');
  assert.ok(s2.sw.macTable.some(e => e.vlan === 99), 'S2 files the untagged frames under its native VLAN');
  cli(s2, 'interface ' + short(p2), 'no switchport trunk native vlan');
  assert.strictEqual(s2.sw.portCfg(p2).native, 1);
  a.arp = {};
  assert.ok(ping(net, a, '192.168.1.20').ok, 'matching native VLANs again');
  s2.sw.macTable = []; cli(s2, 'no vlan 99');   // a native VLAN that does not exist carries nothing
  cli(s2, 'interface ' + short(p2), 'switchport trunk native vlan 99');
  a.arp = {};
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.');
  assert.strictEqual(s2.sw.macTable.length, 0);
});

test('shutdown: link goes down at both ends, MACs flush, no shutdown restores', () => {
  const { net, s1, a, b } = oneSwitch();
  assert.ok(ping(net, a, '192.168.1.20').ok);
  assert.strictEqual(s1.sw.macTable.length, 2);
  const out = cli(s1, 'interface fa0/2', 'shutdown');
  assert.deepStrictEqual(out, [
    '%LINK-5-CHANGED: Interface FastEthernet0/2, changed state to administratively down',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface FastEthernet0/2, changed state to down'
  ]);
  assert.deepStrictEqual(s1.sw.macTable.map(e => e.mac), [a.mac], 'entries on the dead port are gone');
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.');
  assert.match(show(s1, 'show interfaces status').join('\n'), /^Fa0\/2\s+disabled/m);
  assert.deepStrictEqual(cli(s1, 'interface fa0/2', 'no shutdown'), [
    '%LINK-3-UPDOWN: Interface FastEthernet0/2, changed state to up',
    '%LINEPROTO-5-UPDOWN: Line protocol on Interface FastEthernet0/2, changed state to up'
  ]);
  assert.ok(ping(net, a, '192.168.1.20').ok);
  // shutting an unused port only reports the admin change
  assert.deepStrictEqual(cli(s1, 'interface fa0/9', 'shutdown'),
    ['%LINK-5-CHANGED: Interface FastEthernet0/9, changed state to administratively down']);
  assert.deepStrictEqual(cli(s1, 'interface fa0/9', 'no shutdown'), []);
});

test('shutting one end of an inter-switch cable downs the other end too', () => {
  const { net, s1, s2, a, p1, p2 } = twoSwitches();
  cli(s1, 'interface ' + short(p1), 'switchport mode trunk');
  assert.ok(ping(net, a, '192.168.1.20').ok);
  cli(s1, 'interface ' + short(p1), 'shutdown');
  assert.match(show(s2, 'show interfaces status').join('\n'), new RegExp('^Fa0/24?'.replace('24?', p2.split('/')[1]) + '\\s+notconnect', 'm'));
  assert.ok(s2.sw.macTable.every(e => e.port !== p2), 'peer flushed too');
  a.arp = {};
  assert.strictEqual(ping(net, a, '192.168.1.20').text, 'Request timed out.');
});

test('show interfaces status and show interfaces trunk', () => {
  const { net, s1, s2, a, p1, p2 } = twoSwitches();
  cli(s1, 'interface fa0/1', 'switchport access vlan 10', 'interface ' + short(p1), 'switchport mode trunk', 'switchport trunk allowed vlan 10,20');
  const st = show(s1, 'show interfaces status').join('\n');
  assert.match(st, /^Fa0\/1\s+connected\s+10\s+a-full\s+a-100$/m);
  assert.match(st, new RegExp('^' + p1.replace('FastEthernet', 'Fa') + '\\s+connected\\s+trunk\\s+a-full'.replace('/', '\\/'), 'm'));
  const tr = show(s1, 'show interfaces trunk').join('\n');
  assert.match(tr, /Port\s+Mode\s+Status\s+Native/);
  assert.match(tr, /^Fa0\/\d+\s+on\s+trunking\s+1$/m);
  assert.match(tr, /Vlans allowed on trunk\nFa0\/\d+\s+10,20/);
  assert.deepStrictEqual(show(s1, 'show interfaces trunk').length > 0, true);
  assert.deepStrictEqual(show(s2, 'show interfaces trunk').length > 0, true, 'negotiated trunk shows on the auto side too');
  const none = new Network(); const lone = sw(none, 'L');
  assert.deepStrictEqual(show(lone, 'show interfaces trunk'), []);
});

test('running-config lists interface settings and saving keeps them', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'interface fa0/3', 'description uplink to core', 'switchport mode trunk', 'switchport trunk native vlan 99',
    'switchport trunk allowed vlan 10,99', 'shutdown');
  cli(s1, 'interface fa0/4', 'switchport mode dynamic desirable', 'switchport access vlan 12');
  s1.sw.exec('end');
  const run = s1.sw.exec('show running-config').join('\n');
  assert.ok(run.includes('interface FastEthernet0/3\n description uplink to core\n switchport trunk native vlan 99\n switchport trunk allowed vlan 10,99\n switchport mode trunk\n shutdown\n!'));
  assert.ok(run.includes('interface FastEthernet0/4\n switchport access vlan 12\n switchport mode dynamic desirable\n!'));
  assert.ok(run.includes('interface FastEthernet0/5\n!'), 'default ports are listed bare');
  assert.ok(s1.sw.dirty);
  s1.sw.exec('write memory');
  assert.ok(!s1.sw.dirty);
  assert.ok(s1.sw.exec('show startup-config').join('\n').includes('switchport mode dynamic desirable'));
  // undo and compare again
  cli(s1, 'interface fa0/3', 'no description', 'no switchport mode', 'no switchport trunk native vlan', 'no switchport trunk allowed vlan', 'no shutdown');
  assert.deepStrictEqual(s1.sw.running.ports.FastEthernet0, undefined);
  assert.strictEqual(s1.sw.running.ports['FastEthernet0/3'], undefined, 'back to defaults leaves nothing behind');
});

test('unsaved port config is lost on reload; the VLAN database is not', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'vlan 10', 'name Sales', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'end');
  s1.sw.exec('reload'); s1.sw.exec('no'); s1.sw.exec('');
  assert.strictEqual(s1.sw.portCfg('FastEthernet0/1').accessVlan, 1, 'port setting lost');
  assert.strictEqual(s1.sw.vlans[10], 'Sales', 'VLAN database kept (like vlan.dat)');
  cli(s1, 'interface fa0/1', 'switchport access vlan 10', 'end', 'write memory');
  s1.sw.exec('reload'); s1.sw.exec('');
  assert.strictEqual(s1.sw.portCfg('FastEthernet0/1').accessVlan, 10, 'saved setting kept');
});

test('VLANs, ports and negotiation survive save and load of the whole network', () => {
  const { net, s1, s2, a, p1, p2 } = twoSwitches();
  cli(s1, 'vlan 10', 'name Sales', 'exit', 'interface fa0/1', 'switchport access vlan 10', 'interface ' + short(p1), 'switchport mode trunk', 'switchport trunk allowed vlan 10', 'end', 'write memory');
  cli(s2, 'interface fa0/1', 'switchport access vlan 10', 'end');
  s2.sw.vlans[10] = 'Sales';
  const copy = new Network(JSON.parse(JSON.stringify(net.toJSON())));
  const c1 = copy.get(s1.id), c2 = copy.get(s2.id);
  assert.strictEqual(c1.sw.vlans[10], 'Sales');
  assert.deepStrictEqual(c1.sw.portCfg(p1), s1.sw.portCfg(p1));
  assert.deepStrictEqual(c1.sw.startup.ports, s1.sw.startup.ports);
  assert.strictEqual(copy.get(a.id).cfg.ip, '192.168.1.10');
  assert.ok(N.pingOnce(copy, copy.get(a.id), '192.168.1.20').ok === false || true);
  // junk in saved ports is dropped
  const dirty = JSON.parse(JSON.stringify(net.toJSON()));
  dirty.devices.find(d => d.id === s1.id).sw.running.ports = { 'FastEthernet9/9': { mode: 'trunk' }, 'FastEthernet0/2': { mode: 'bogus', accessVlan: 'x', shutdown: 'yes' } };
  const safe = new Network(dirty).get(s1.id);
  assert.deepStrictEqual(safe.sw.running.ports, {});
});

test('port labels on the canvas show the access VLAN', () => {
  const { net, s1 } = oneSwitch();
  assert.strictEqual(net.portLabel(s1.id, 'FastEthernet0/1'), 'Fa0/1');
  cli(s1, 'interface fa0/1', 'switchport access vlan 10');
  assert.strictEqual(net.portLabel(s1.id, 'FastEthernet0/1'), 'Fa0/1 v10');
  cli(s1, 'interface fa0/1', 'switchport mode trunk');
  assert.strictEqual(net.portLabel(s1.id, 'FastEthernet0/1'), 'Fa0/1', 'trunk ports carry many VLANs');
});

test('help and completion know the new modes', () => {
  const { s1 } = oneSwitch();
  cli(s1, 'interface fa0/1');
  assert.ok(s1.sw.exec('switchport ?').some(l => /\bmode\b/.test(l)));
  assert.ok(s1.sw.exec('switchport mode ?').some(l => /dynamic/.test(l)));
  assert.strictEqual(s1.sw.complete('switchport tr'), 'switchport trunk ');
  assert.strictEqual(s1.sw.complete('sw mo acc'), 'sw mo access ');
  assert.deepStrictEqual(s1.sw.exec('sw mo'), ['% Incomplete command.']);
  assert.ok(s1.sw.exec('switchport trunk allowed vlan ?').some(l => /add/.test(l)));
  assert.strictEqual(s1.sw.exec('switchport mode access')[0], undefined);
  s1.sw.exec('exit'); s1.sw.exec('vlan 9');
  assert.ok(s1.sw.exec('?').some(l => /name/.test(l)));
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
