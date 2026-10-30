#!/usr/bin/env python3
"""TcpLink client: talk to a PLC running the TcpLink block (examples/tcplink).

The PLC is the passive side: it listens (port 2000 in TcpLinkDemo.db), this
client connects, gets the names once (kind 1), then a data message (kind 0)
whenever something changes and at least every heartbeat. With --set it also
sends command frames (format 3) - every 0.5 s, because TcpLink marks the
link stale and clears what it received after rxTimeout (2 s) of silence.

    python tools/tcplink_client.py 192.168.1.50
    python tools/tcplink_client.py 127.0.0.1 --set StartCmd=1 --set Setpoint=42
    python tools/tcplink_client.py esp32-plc.local --seconds 10 --quiet

Values for --set are matched by name (from the names message) or given as
section[index], e.g. ints[0]=42, bits[3]=1, reals[1]=2.5.

Everything is big-endian, laid out like the UDTs in S7 "standard" memory:
Bool arrays packed 8 per byte, Word/Int 2 bytes, DInt/Real 4 bytes, the tx
times are DTL (12 bytes: year, month, day, weekday, hour, min, sec, ns).
"""
import argparse
import socket
import struct
import sys
import time

SECTIONS = ['bits', 'words', 'times', 'ints', 'dints', 'reals']
SIZE = {'words': 2, 'times': 12, 'ints': 2, 'dints': 4, 'reals': 4}
FMT = {'words': '>H', 'ints': '>h', 'dints': '>i', 'reals': '>f'}


def recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('the PLC closed the connection')
        buf += chunk
    return buf


def read_message(sock):
    """one PLC -> PC message: (kind, seq, layout, body bytes after the 32-byte header)"""
    # resynchronise on the magic byte, like the TcpLink description asks clients to
    while True:
        b = recv_exact(sock, 1)
        if b[0] == 0xA5:
            break
    head = b + recv_exact(sock, 7)
    ver, length, seq, flags, kind = head[1], *struct.unpack('>HH', head[2:6]), head[6], head[7]
    if ver != 7 or length < 32:
        raise ValueError('unexpected header: ver %d, len %d' % (ver, length))
    rest = recv_exact(sock, length - 8)
    return kind, seq, flags, list(rest[0:12]), rest[24:], rest[12:24]


def s7_strings(data, count):
    """count S7 strings [max][cur][max chars] from data -> (names, bytes used)"""
    out, pos = [], 0
    for _ in range(count):
        mx, cur = data[pos], data[pos + 1]
        out.append(data[pos + 2:pos + 2 + min(cur, mx)].decode('latin-1'))
        pos += 2 + mx
    return out, pos


def decode_names(layout, body):
    names, pos = {}, 0
    for d, direction in enumerate(('tx', 'rx')):
        for i, sec in enumerate(SECTIONS):
            n = layout[d * 6 + i]
            lst, used = s7_strings(body[pos:], n)
            names[(direction, sec)] = lst
            pos += used
    return names


def decode_data(layout, body):
    vals, pos = {}, 0
    nbytes = layout[0]
    vals['bits'] = [bool(body[pos + i // 8] >> (i % 8) & 1) for i in range(nbytes * 8)]
    pos += nbytes
    for i, sec in enumerate(SECTIONS[1:], start=1):
        n, sz = layout[i], SIZE[sec]
        items = [body[pos + k * sz:pos + (k + 1) * sz] for k in range(n)]
        vals[sec] = [decode_dtl(b) if sec == 'times' else struct.unpack(FMT[sec], b)[0] for b in items]
        pos += n * sz
    return vals


def decode_dtl(b):
    y, mo, d, _wd, h, mi, s = struct.unpack('>HBBBBBB', b[0:8])
    ns = struct.unpack('>I', b[8:12])[0]
    return '%04d-%02d-%02d %02d:%02d:%02d.%03d' % (y, mo, d, h, mi, s, ns // 1000000)


def command_frame(rx_layout, values, seq):
    """format 3: magic 5A, ver 3, len, seq, flags, spare, layout[6], then
    bits, words, ints, dints, reals (rx times are not on the line)"""
    nbits = rx_layout[0] * 8
    bits = bytearray(rx_layout[0])
    for i in range(nbits):
        if values.get(('bits', i)):
            bits[i // 8] |= 1 << (i % 8)
    body = bytes(bits)
    for i, sec in ((1, 'words'), (3, 'ints'), (4, 'dints'), (5, 'reals')):
        body += b''.join(struct.pack(FMT[sec], values.get((sec, k), 0)) for k in range(rx_layout[i]))
    length = 14 + len(body)
    return struct.pack('>BBHHBB', 0x5A, 3, length, seq & 0xFFFF, 0, 0) + bytes(rx_layout) + body


def parse_sets(sets, names):
    out = {}
    for s in sets:
        if '=' not in s:
            raise SystemExit('--set needs name=value: %r' % s)
        key, val = s.split('=', 1)
        key = key.strip()
        target = None
        if '[' in key and key.endswith(']'):
            sec, idx = key[:-1].split('[', 1)
            if sec in SECTIONS:
                target = (sec, int(idx))
        if target is None:
            for sec in SECTIONS:
                lst = names.get(('rx', sec), [])
                if key in lst:
                    target = (sec, lst.index(key))
                    break
        if target is None:
            raise SystemExit('unknown receive slot %r (names: %s)' % (key, ', '.join(
                n for sec in SECTIONS for n in names.get(('rx', sec), []) if n)))
        sec = target[0]
        if sec == 'times':
            raise SystemExit('TcpLink does not receive times')
        v = float(val) if sec == 'reals' else int(val, 0) if not val.lower() in ('true', 'false') else int(val.lower() == 'true')
        out[target] = v
    return out


def label(names, sec, i):
    lst = names.get(('tx', sec), [])
    return lst[i] if i < len(lst) and lst[i] else '%s[%d]' % (sec, i)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('host')
    ap.add_argument('--port', type=int, default=2000)
    ap.add_argument('--set', action='append', default=[], metavar='NAME=VALUE')
    ap.add_argument('--seconds', type=float, default=0, help='stop after this long (0: run until Ctrl+C)')
    ap.add_argument('--quiet', action='store_true', help='only a summary line per message')
    args = ap.parse_args()

    sock = socket.create_connection((args.host, args.port), timeout=10)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    print('connected to %s:%d' % (args.host, args.port))
    names, last, rx_layout, sets, seq = {}, {}, None, None, 0
    t_end = time.monotonic() + args.seconds if args.seconds else None
    t_send = 0.0
    counts = {0: 0, 1: 0, 2: 0}
    try:
        while t_end is None or time.monotonic() < t_end:
            sock.settimeout(0.25)
            try:
                kind, mseq, flags, layout, body, ts = read_message(sock)
            except socket.timeout:
                kind = None
            if kind == 1:
                names = decode_names(layout, body)
                counts[1] += 1
                print('names (seq %d):' % mseq)
                for (d, sec), lst in names.items():
                    if any(lst):
                        print('  %s %-5s %s' % (d, sec, ', '.join('%d=%s' % (i, n) for i, n in enumerate(lst) if n)))
            elif kind == 0:
                counts[0] += 1
                rx_layout = layout[6:12]
                vals = decode_data(layout, body)
                stamp = decode_dtl(ts) + (' local' if flags & 1 else ' UTC')
                changed = []
                for sec in SECTIONS:
                    for i, v in enumerate(vals[sec]):
                        if last.get((sec, i)) != v:
                            changed.append('%s=%s' % (label(names, sec, i), ('%.3f' % v) if sec == 'reals' else v))
                        last[(sec, i)] = v
                if args.quiet:
                    print('data seq %d at %s: %d changed' % (mseq, stamp, len(changed)))
                else:
                    print('data seq %d at %s: %s' % (mseq, stamp, ', '.join(changed) if changed else '(heartbeat)'))
            elif kind is not None:
                counts[2] = counts.get(2, 0) + 1
                print('message kind %d (seq %d) ignored' % (kind, mseq))
            if args.set and rx_layout is not None:
                if sets is None:
                    sets = parse_sets(args.set, names)
                if time.monotonic() - t_send >= 0.5:
                    seq += 1
                    sock.sendall(command_frame(rx_layout, sets, seq))
                    t_send = time.monotonic()
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
    print('%d data and %d names messages received, %d command frames sent' % (counts[0], counts[1], seq))
    return 0


if __name__ == '__main__':
    sys.exit(main())
