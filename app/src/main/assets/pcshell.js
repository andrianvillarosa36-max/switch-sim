/*
 * A PC's command prompt. Implements the same small interface the console
 * (TerminalView) uses for a switch: prompt, secretInput, pending, exec(),
 * help(), complete(), plus status() and takeJob() for the status light and
 * for output that is paced over time (ping replies).
 */
(function (root) {
  'use strict';

  var COMMANDS = ['arp', 'help', 'ipconfig', 'ping'];
  var REPLY_DELAY = 450;
  var TIMEOUT_DELAY = 1100;

  function pad(s, n) { while (s.length < n) s += ' '; return s; }

  function PcShell(net, dev) {
    this.net = net;
    this.dev = dev;
    this.pending = null;
    this.secretInput = false;
    this._job = null;
  }

  Object.defineProperty(PcShell.prototype, 'prompt', { get: function () { return 'C:\\>'; } });

  PcShell.prototype.status = function () {
    var ip = this.dev.cfg.ip;
    return ip ? { text: ip, cls: 'ok' } : { text: 'No IP address', cls: 'warn' };
  };

  // Output that should appear one line at a time: [{ t, delay }]. Read once.
  PcShell.prototype.takeJob = function () {
    var j = this._job;
    this._job = null;
    return j;
  };

  PcShell.prototype.help = function () {
    return [
      '  arp -a     Show the ARP cache',
      '  arp -d     Clear the ARP cache',
      '  ipconfig   Show IP settings',
      '             (add /all for the MAC)',
      '  ping       e.g. ping 192.168.1.20'
    ];
  };

  PcShell.prototype.complete = function (line) {
    if (/\s/.test(line) || !line) return line;
    var low = line.toLowerCase();
    var hits = COMMANDS.filter(function (c) { return c.indexOf(low) === 0; });
    return hits.length === 1 ? hits[0] + ' ' : line;
  };

  PcShell.prototype.exec = function (line) {
    var text = line.trim();
    if (!text) return [];
    if (/\?\s*$/.test(text)) return this.help();
    var tok = text.split(/\s+/), cmd = tok[0].toLowerCase();
    if (cmd === 'help') return this.help();
    if (cmd === 'ipconfig') return this._ipconfig(tok);
    if (cmd === 'arp') return this._arp(tok);
    if (cmd === 'ping') return this._ping(tok);
    return ['Invalid Command.'];
  };

  PcShell.prototype._ipconfig = function (tok) {
    var opt = (tok[1] || '').toLowerCase();
    if (tok.length > 2 || (opt && opt !== '/all')) return ['Invalid Command.'];
    var c = this.dev.cfg;
    var lines = [
      '',
      'FastEthernet0 Connection:(default port)',
      ''
    ];
    if (opt === '/all') lines.push('  Physical Address : ' + this.dev.mac.toUpperCase());
    lines.push(
      '  IPv4 Address . . : ' + (c.ip || '0.0.0.0'),
      '  Subnet Mask. . . : ' + (c.mask || '0.0.0.0'),
      '  Default Gateway. : ' + (c.gateway || '0.0.0.0')
    );
    return lines;
  };

  PcShell.prototype._arp = function (tok) {
    var opt = (tok[1] || '').toLowerCase();
    var cache = this.dev.arp;
    if (opt === '-d') { this.dev.arp = {}; return []; }
    if (opt !== '-a' || tok.length > 2) return ['Usage: arp -a  or  arp -d'];
    var ips = Object.keys(cache);
    if (!ips.length) return ['No ARP Entries Found'];
    var lines = ['  Internet Address  Physical Address'];
    ips.forEach(function (ip) { lines.push('  ' + pad(ip, 18) + cache[ip]); });
    return lines;
  };

  PcShell.prototype._ping = function (tok) {
    var count = 4, args = tok.slice(1);
    if (args[0] === '-n' && args.length >= 2) {
      count = Math.floor(Number(args[1]));
      if (!(count >= 1 && count <= 20)) return ['Bad value for option -n, valid range is from 1 to 20.'];
      args = args.slice(2);
    }
    if (args.length !== 1) return ['Usage: ping [-n count] <destination IP address>'];
    var N = root.Netsim, dest = N.parseIp(args[0]);
    if (dest === null) return ['Ping request could not find host ' + args[0] + '. Please check the name and try again.'];

    var target = N.ipStr(dest), job = [], got = [], i;
    N.beginTrace(this.net);
    for (i = 0; i < count; i++) {
      var r = N.pingOnce(this.net, this.dev, target);
      if (r.ok) {
        got.push(r.ms);
        job.push({
          t: 'Reply from ' + r.from + ': bytes=32 time' + (r.ms < 1 ? '<1ms' : '=' + r.ms + 'ms') + ' TTL=' + r.ttl,
          delay: REPLY_DELAY
        });
      } else {
        job.push({ t: r.text, delay: TIMEOUT_DELAY });
      }
    }

    var lost = count - got.length;
    job.push({ t: '', delay: 250 });
    job.push({ t: 'Ping statistics for ' + target + ':', delay: 0 });
    job.push({
      t: '    Packets: Sent = ' + count + ', Received = ' + got.length + ', Lost = ' + lost +
        ' (' + Math.round(lost * 100 / count) + '% loss),',
      delay: 0
    });
    if (got.length) {
      var min = Math.min.apply(null, got), max = Math.max.apply(null, got);
      var avg = Math.round(got.reduce(function (a, b) { return a + b; }, 0) / got.length);
      job.push({ t: 'Approximate round trip times in milli-seconds:', delay: 0 });
      job.push({ t: '    Minimum = ' + min + 'ms, Maximum = ' + max + 'ms, Average = ' + avg + 'ms', delay: 0 });
    }
    this._job = job;
    return ['', 'Pinging ' + target + ' with 32 bytes of data:', ''];
  };

  root.PcShell = PcShell;
  if (typeof module !== 'undefined' && module.exports) module.exports = { PcShell: PcShell };
})(typeof window !== 'undefined' ? window : globalThis);
