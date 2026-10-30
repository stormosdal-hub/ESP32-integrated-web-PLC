#!/usr/bin/env python3
"""Robustness fuzz for the C engine: randomly mutate the parity projects
(drop keys, swap value types, truncate text, garbage SCL) and make sure the
engine never crashes — it must either load and scan, or reject cleanly.

    python test/parity/fuzz.py [iterations]      # FUZZ_SEED=<n> for another sequence
"""
import copy
import json
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CLI = os.environ.get('PLC_CLI') or os.path.join(ROOT, 'build_host', 'plc_cli.exe' if os.name == 'nt' else 'plc_cli')

JUNK = [None, True, False, 0, -1, 1e308, -1e308, 3.5, '', '???', 'T#', '%', '%M', 'M99999.9', 'MW8191',
        'MD8190', 'I0.8', 'Q1023.7', 'x' * 300, [], {}, [1, 2], {'a': 1}, 'IF', 'øæå', '\\"']
# data types: valid, huge, inverted, self-referencing, unknown, system FBs
TYPES = ['Int', 'Bool', 'Real', 'LReal', 'String', 'String[0]', 'String[300]', 'Array[0..9] of Int', 'Array[5..1] of Int',
         'Array[0..65535] of Int', 'Array[0..2, 0..3] of Bool', 'Array[0..3] of Array[0..3] of Byte', 'Struct',
         'Array[0..1] of Struct', 'DTL', 'TCON_IP_v4', 'TON_TIME', 'TCON', 'TSEND', 'TRCV', 'R_TRIG', 'CTU_DINT', 'Variant',
         '"Point"', '"Missing"', '"Worker"', '"Peer"', '"TcpLinkRx"', 'Array[0..300] of String[254]', 'Array[', 'of Int',
         'Array[-5..-1] of DInt', 'Word', 'CONN_OUC', 'IEC_TIMER', 'Array[0..7] of TON']
# SCL fragments spliced into code
SCL = ['', '(', ')', ':=', 'END_IF', '(*', '#', '..', '1..', '#x', '"Data"', '%X99', '.%B9', '[', ']', '#arr[#i, ', '16#',
       'T#', "'", '$', 'FOR #i := 0 TO 99999999 DO END_FOR;', 'WHILE TRUE DO END_WHILE;', 'REPEAT UNTIL FALSE END_REPEAT;',
       '#p(', '"Sum"(arr := ', 'RD_SYS_T(OUT => ', 'CountOfElements(', ' => ', 'REGION x', 'END_REGION', 'CASE', 'ELSE',
       '#con(REQ := TRUE, ID := 1, CONNECT := #con);', '#snd(REQ := TRUE, ID := 1, LEN := 70000, DATA := #p);',
       '#rcv(EN_R := TRUE, ID := 1, LEN := 0, DATA := #con);', 'INT#', 'WORD#16#', 'D#2024-13-40', 'TOD#25:99',
       'NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT NOT x', '((((((((((((((((((((',
       'SHL(IN := 1, N := 99)', 'ROL(IN := DWORD#1, N := -5)', '#w.%X31 := TRUE;', 'MAX_LEN(#x)',
       '#x := 1' + ' + #x' * 400 + ';', 'IF TRUE' + ' AND #b' * 300 + ' THEN #x := 1; END_IF;']


def junk(rnd):
    # a fresh copy: a shared [] / {} could otherwise be mutated into itself (a cycle)
    return copy.deepcopy(rnd.choice(JUNK))


def mutate(node, rnd, depth=0):
    if isinstance(node, dict):
        for k in list(node.keys()):
            r = rnd.random()
            if r < 0.04:
                del node[k]
            elif r < 0.10:
                node[k] = junk(rnd)
            else:
                mutate(node[k], rnd, depth + 1)
    elif isinstance(node, list):
        for i in range(len(node)):
            r = rnd.random()
            if r < 0.04:
                node[i] = junk(rnd)
            else:
                mutate(node[i], rnd, depth + 1)
        if node and rnd.random() < 0.05:
            node.append(rnd.choice(node))           # duplicate ids etc.


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    cases = [json.load(open(os.path.join(HERE, 'cases', f), encoding='utf-8'))
             for f in sorted(os.listdir(os.path.join(HERE, 'cases')))]
    rnd = random.Random(int(os.environ.get("FUZZ_SEED", "1234")))
    steps = {'steps': [{'t': 0, 'scans': 2}, {'set': {'A': True, 'X': 5, 'Go': True, 'ClientOn': True, 'Send': True}, 'dt': 50, 'scans': 3},
                       {'set': {'Drop': True, 'Send': False, '"Data".p.x': 7, 'Worker_DB.seq': 1}, 'dt': 20, 'scans': 3}]}
    crashes = 0
    with tempfile.TemporaryDirectory() as td:
        sp = os.path.join(td, 's.json')
        json.dump(steps, open(sp, 'w'))
        for it in range(iters):
            proj = json.loads(json.dumps(rnd.choice(cases)['project']))
            mutate(proj, rnd)
            blocks = proj.get('blocks') if isinstance(proj, dict) else None
            for b in blocks if isinstance(blocks, list) else []:
                if isinstance(b, dict) and isinstance(b.get('code'), str) and rnd.random() < 0.5:
                    c = b['code']
                    for _ in range(rnd.randrange(1, 4)):
                        cut = rnd.randrange(len(c) + 1)
                        r = rnd.random()
                        if r < 0.3 and c:
                            c = c[:cut] + c[cut + rnd.randrange(1, 40):]            # drop a piece
                        elif r < 0.5 and c:
                            other = rnd.randrange(len(c))
                            c = c[:cut] + c[other:other + rnd.randrange(1, 60)] + c[cut:]   # duplicate a piece
                        else:
                            c = c[:cut] + rnd.choice(SCL) + c[cut:]
                    b['code'] = c
                # interface / DB member types
                if isinstance(b, dict) and rnd.random() < 0.15:
                    secs = b.get('iface') if isinstance(b.get('iface'), dict) else {}
                    lists = [v for v in secs.values() if isinstance(v, list)]
                    if isinstance(b.get('members'), list):
                        lists.append(b['members'])
                    for lst in lists:
                        for m in lst:
                            if isinstance(m, dict) and rnd.random() < 0.3:
                                m['dataType'] = rnd.choice(TYPES)
                                if rnd.random() < 0.3:
                                    m['default'] = rnd.choice(JUNK + ['[1, 2, 3]', '16(0)', "'abc'", 'T#5s', '16#FFFF'])
                if isinstance(b, dict) and isinstance(b.get('startValues'), dict) and rnd.random() < 0.3:
                    b['startValues'][rnd.choice(['x', 'list[99].x', 'p.tag', 'a[', '"q".y', 'flags[-1]'])] = rnd.choice(JUNK + ["'zz'", '1e400'])
            types = proj.get('types') if isinstance(proj, dict) else None
            for u in types if isinstance(types, list) else []:
                if isinstance(u, dict) and isinstance(u.get('members'), list) and rnd.random() < 0.2:
                    for m in u['members']:
                        if isinstance(m, dict) and rnd.random() < 0.3:
                            m['dataType'] = rnd.choice(TYPES)
            text = json.dumps(proj)
            if rnd.random() < 0.1:
                text = text[:rnd.randrange(len(text))]   # truncated JSON
            pp = os.path.join(td, 'p.json')
            open(pp, 'w', encoding='utf-8').write(text)
            r = subprocess.run([CLI, pp, sp], capture_output=True, timeout=30)
            if r.returncode not in (0, 1):
                crashes += 1
                keep = os.path.join(HERE, 'fuzz_crash_%d.json' % it)
                open(keep, 'w', encoding='utf-8').write(text)
                print('CRASH (exit %d) iteration %d -> %s' % (r.returncode, it, keep))
    print('%d iterations, %d crash(es)' % (iters, crashes))
    return 1 if crashes else 0


if __name__ == '__main__':
    sys.exit(main())
