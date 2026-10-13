// Run with: node tests/netsim.test.js
const assert = require('assert');
require('../app/src/main/assets/engine.js');
const N = require('../app/src/main/assets/netsim.js');
require('../app/src/main/assets/pcshell.js');
const { Network } = require('../app/src/main/assets/network.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 4).join('\n     ')); process.exitCode = 1; }
}

function pc(net, name, ip, mask = '255.255.255.0', gateway = '') {
  const d = net.add('pc', 0, 0);
  net.rename(d.id, name);
  const err = net.setPcConfig(d.id, { ip, mask, gateway });
  assert.strictEqual(err, null, name + ': ' + err);
  return d;
}
const sw = (net, name) => { const d = net.add('switch', 0, 0); net.rename(d.id, name); return d; };
const cable = (net, a, b) => { const r = net.connect(a.id, b.id); assert.ok(r.link, r.error); return r.link; };
const shortMac = (d) => d.mac;

// PC1 - SW1 - PC2
function lan() {
  const net = new Network();
  const s1 = sw(net, 'SW1'), p1 = pc(net, 'PC1', '192.168.1.10'), p2 = pc(net, 'PC2', '192.168.1.20');
  cable(net, s1, p1); cable(net, s1, p2);
  return { net, s1, p1, p2 };
}

test('IPv4 helpers', () => {
  assert.strictEqual(N.parseIp('192.168.1.10'), 3232235786);
  assert.strictEqual(N.ipStr(3232235786), '192.168.1.10');
  assert.strictEqual(N.parseIp('256.1.1.1'), null);
  assert.strictEqual(N.parseIp('1.2.3'), null);
  assert.strictEqual(N.parseIp('01.02.03.004'), 16909060);
  assert.strictEqual(N.maskBits(N.parseIp('255.255.255.0')), 24);
  assert.strictEqual(N.maskBits(N.parseIp('255.0.255.0')), -1);
  assert.strictEqual(N.classfulMask('10.1.1.1'), '255.0.0.0');
  assert.strictEqual(N.classfulMask('172.16.0.1'), '255.255.0.0');
  assert.strictEqual(N.classfulMask('192.168.1.1'), '255.255.255.0');
  assert.strictEqual(N.classfulMask('nope'), '');
});

test('validateConfig', () => {
  const v = (ip, mask, gateway, others) => N.validateConfig({ ip, mask, gateway }, others);
  assert.strictEqual(v('', '', ''), null);
  assert.strictEqual(v('192.168.1.10', '255.255.255.0', ''), null);
  assert.strictEqual(v('192.168.1.10', '255.255.255.0', '192.168.1.1'), null);
  assert.match(v('', '255.255.255.0', ''), /Enter an IP/);
  assert.match(v('192.168.1', '255.255.255.0', ''), /valid IP/);
  assert.match(v('192.168.1.10', '', ''), /subnet mask/);
  assert.match(v('192.168.1.10', '255.0.255.0', ''), /valid subnet mask/);
  assert.match(v('192.168.1.10', '255.255.255.255', ''), /valid subnet mask/);
  assert.match(v('192.168.1.0', '255.255.255.0', ''), /network address/);
  assert.match(v('192.168.1.255', '255.255.255.0', ''), /broadcast/);
  assert.match(v('127.0.0.1', '255.0.0.0', ''), /host address/);
  assert.match(v('224.0.0.5', '255.255.255.0', ''), /host address/);
  assert.match(v('192.168.1.10', '255.255.255.0', '192.168.2.1'), /same subnet/);
  assert.match(v('192.168.1.10', '255.255.255.0', '192.168.1.10'), /same as/);
  assert.match(v('192.168.1.10', '255.255.255.0', 'abc'), /valid gateway/);
  assert.match(v('192.168.1.10', '255.255.255.0', '', ['192.168.1.10']), /already uses/);
  assert.deepStrictEqual(N.normalize({ ip: ' 192.168.001.010 ', mask: '255.255.255.0', gateway: '' }),
    { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '' });
});

test('ping across one switch works and the switch learns both MACs', () => {
  const { net, s1, p1, p2 } = lan();
  assert.strictEqual(s1.sw.macTable.length, 0);
  const r1 = N.pingOnce(net, p1, '192.168.1.20');
  assert.ok(r1.ok, 'first ping');
  assert.ok(r1.ms >= 10, 'first packet pays for ARP, got ' + r1.ms);
  const r2 = N.pingOnce(net, p1, '192.168.1.20');
  assert.ok(r2.ok && r2.ms === 0, 'later packets are fast');
  const t = s1.sw.macTable;
  assert.deepStrictEqual(t.map(e => [e.mac, e.port]), [
    [p1.mac, 'FastEthernet0/1'],
    [p2.mac, 'FastEthernet0/2']
  ]);
  assert.strictEqual(p1.arp['192.168.1.20'], p2.mac);
  assert.strictEqual(p2.arp['192.168.1.10'], p1.mac, 'the target learns the asker from the ARP request');
});

test('ping works in both directions and across two switches', () => {
  const net = new Network();
  const s1 = sw(net, 'SW1'), s2 = sw(net, 'SW2');
  const p1 = pc(net, 'PC1', '10.0.0.1', '255.0.0.0'), p2 = pc(net, 'PC2', '10.0.0.2', '255.0.0.0');
  cable(net, s1, p1); const trunk = cable(net, s1, s2); cable(net, s2, p2);
  assert.ok(N.pingOnce(net, p1, '10.0.0.2').ok);
  assert.ok(N.pingOnce(net, p2, '10.0.0.1').ok);
  const mac = (s) => s.sw.macTable.map(e => e.mac + '@' + e.port);
  assert.deepStrictEqual(mac(s1), [p1.mac + '@FastEthernet0/1', p2.mac + '@' + trunk.a.port]);
  assert.deepStrictEqual(mac(s2), [p1.mac + '@' + trunk.b.port, p2.mac + '@FastEthernet0/2']);
});

test('unknown unicast is flooded, then the switch has learned', () => {
  const { net, s1, p1, p2 } = lan();
  assert.ok(N.pingOnce(net, p1, '192.168.1.20').ok);
  s1.sw.macTable = [];                        // ARP caches stay, MAC table is gone
  const r = N.pingOnce(net, p1, '192.168.1.20');
  assert.ok(r.ok, 'flooded request still reaches PC2');
  assert.strictEqual(s1.sw.macTable.length, 2, 'relearned from the request and the reply');
});

test('no cable, no IP, bad subnet or no gateway', () => {
  const net = new Network();
  const p1 = pc(net, 'PC1', '192.168.1.10'), p2 = pc(net, 'PC2', '192.168.1.20');
  assert.deepStrictEqual(N.pingOnce(net, p1, '192.168.1.20'), { ok: false, text: 'Request timed out.' }, 'no cables');

  const s1 = sw(net, 'SW1'); cable(net, s1, p1); cable(net, s1, p2);
  assert.ok(N.pingOnce(net, p1, '192.168.1.20').ok);

  const bare = net.add('pc', 0, 0); cable(net, s1, bare);
  assert.strictEqual(N.pingOnce(net, bare, '192.168.1.20').text, 'Request timed out.', 'no IP configured');

  const other = N.pingOnce(net, p1, '192.168.2.5');
  assert.strictEqual(other.text, 'Reply from 192.168.1.10: Destination host unreachable.', 'other subnet, no gateway');

  net.setPcConfig(p1.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  assert.strictEqual(N.pingOnce(net, p1, '192.168.2.5').text, 'Request timed out.', 'gateway that does not exist');

  net.setPcConfig(p2.id, { ip: '192.168.5.20', mask: '255.255.255.0', gateway: '' });
  assert.strictEqual(N.pingOnce(net, p1, '192.168.1.20').text, 'Request timed out.', 'target has a different address now');
});

test('pinging yourself works', () => {
  const { net, p1 } = lan();
  assert.deepStrictEqual(N.pingOnce(net, p1, '192.168.1.10'), { ok: true, ms: 0, ttl: 128, from: '192.168.1.10' });
});

test('a switch loop does not hang and traffic still gets through', () => {
  const net = new Network();
  const a = sw(net, 'A'), b = sw(net, 'B'), c = sw(net, 'C');
  const p1 = pc(net, 'PC1', '192.168.1.10'), p2 = pc(net, 'PC2', '192.168.1.20');
  cable(net, a, b); cable(net, b, c); cable(net, c, a);
  cable(net, a, p1); cable(net, c, p2);
  const r = N.pingOnce(net, p1, '192.168.1.20');
  assert.ok(r.ok);
});

test('removing a cable forgets the MACs learned on that port', () => {
  const { net, s1, p1, p2 } = lan();
  N.pingOnce(net, p1, '192.168.1.20');
  assert.strictEqual(s1.sw.macTable.length, 2);
  const l = net.links.find(x => x.b.dev === p2.id);
  net.removeLink(l.id);
  assert.deepStrictEqual(s1.sw.macTable.map(e => e.mac), [p1.mac]);
  net.removeDevice(p1.id);
  assert.strictEqual(s1.sw.macTable.length, 0);
});

test('MAC addresses are unique and stable', () => {
  const net = new Network();
  const macs = [];
  for (let i = 0; i < 40; i++) macs.push(net.add('pc', 0, 0).mac);
  assert.strictEqual(new Set(macs).size, 40);
  assert.ok(macs.every(m => /^0001\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(m)));
  const copy = new Network(JSON.parse(JSON.stringify(net.toJSON())));
  assert.deepStrictEqual(copy.devices.map(d => d.mac), macs);
});

test('setPcConfig: duplicate IPs are refused, settings survive save and load', () => {
  const net = new Network();
  const a = net.add('pc', 0, 0), b = net.add('pc', 0, 0);
  assert.strictEqual(net.setPcConfig(a.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' }), null);
  assert.match(net.setPcConfig(b.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '' }), /already uses/);
  assert.deepStrictEqual(b.cfg, { ip: '', mask: '', gateway: '' });
  assert.strictEqual(net.setPcConfig(a.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '' }), null, 'own address is fine');
  net.setPcConfig(a.id, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  const copy = new Network(JSON.parse(JSON.stringify(net.toJSON())));
  assert.deepStrictEqual(copy.get(a.id).cfg, { ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  assert.deepStrictEqual(copy.get(b.id).cfg, { ip: '', mask: '', gateway: '' });
  assert.deepStrictEqual(copy.get(a.id).arp, {});
});

test('PC command prompt: ipconfig, arp, help, unknown', () => {
  const { net, p1, p2 } = lan();
  const sh = p1.shell;
  assert.strictEqual(sh.prompt, 'C:\\>');
  const ip = sh.exec('ipconfig').join('\n');
  assert.ok(ip.includes('IPv4 Address . . : 192.168.1.10'));
  assert.ok(ip.includes('Default Gateway. : 0.0.0.0'));
  assert.ok(!ip.includes('Physical'));
  assert.ok(sh.exec('ipconfig /all').join('\n').includes(p1.mac.toUpperCase()));
  assert.deepStrictEqual(sh.exec('arp -a'), ['No ARP Entries Found']);
  assert.deepStrictEqual(sh.exec('nonsense'), ['Invalid Command.']);
  assert.ok(sh.exec('?').length >= 4 && sh.exec('help').length >= 4);
  assert.strictEqual(sh.status().text, '192.168.1.10');
  N.pingOnce(net, p1, '192.168.1.20');
  const arp = sh.exec('arp -a');
  assert.ok(arp[1].includes('192.168.1.20') && arp[1].includes(p2.mac));
  sh.exec('arp -d');
  assert.deepStrictEqual(sh.exec('arp -a'), ['No ARP Entries Found']);
  assert.strictEqual(sh.complete('ipc'), 'ipconfig ');
  assert.strictEqual(sh.complete('p'), 'ping ');
  assert.strictEqual(sh.complete('a'), 'arp ');
  assert.strictEqual(sh.complete('ping 1'), 'ping 1');
  assert.strictEqual(new Network().add('pc', 0, 0).shell.status().cls, 'warn');
});

test('PC ping command: output, statistics, errors', () => {
  const { p1 } = lan();
  const sh = p1.shell;
  const head = sh.exec('ping 192.168.1.20');
  assert.deepStrictEqual(head, ['', 'Pinging 192.168.1.20 with 32 bytes of data:', '']);
  const job = sh.takeJob();
  assert.strictEqual(sh.takeJob(), null, 'job is read once');
  const text = job.map(j => j.t);
  assert.strictEqual(text.filter(t => t.startsWith('Reply from 192.168.1.20: bytes=32')).length, 4);
  assert.ok(/time=\d+ms TTL=128/.test(text[0]), 'first reply includes the ARP delay: ' + text[0]);
  assert.ok(/time<1ms TTL=128/.test(text[1]));
  assert.ok(text.includes('    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),'));
  assert.ok(text.some(t => t.startsWith('    Minimum = 0ms, Maximum =')));

  sh.exec('ping -n 2 192.168.1.20');
  assert.strictEqual(sh.takeJob().filter(j => j.t.startsWith('Reply')).length, 2);

  sh.exec('ping 192.168.1.99');
  const lost = sh.takeJob().map(j => j.t);
  assert.strictEqual(lost.filter(t => t === 'Request timed out.').length, 4);
  assert.ok(lost.includes('    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),'));
  assert.ok(!lost.some(t => t.startsWith('Approximate')));

  assert.match(sh.exec('ping banana')[0], /could not find host banana/);
  assert.match(sh.exec('ping')[0], /Usage/);
  assert.match(sh.exec('ping -n 0 1.1.1.1')[0], /Bad value/);
  assert.strictEqual(sh.takeJob(), null, 'errors start no job');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
