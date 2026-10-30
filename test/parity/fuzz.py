#!/usr/bin/env python3
"""Robustness fuzz for the C engine: randomly mutate the parity projects
(drop keys, swap value types, truncate text, garbage SCL) and make sure the
engine never crashes — it must either load and scan, or reject cleanly.

    python test/parity/fuzz.py [iterations]      # FUZZ_SEED=<n> for another sequence
"""
import json
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CLI = os.path.join(ROOT, 'build_host', 'plc_cli.exe' if os.name == 'nt' else 'plc_cli')

JUNK = [None, True, False, 0, -1, 1e308, -1e308, 3.5, '', '???', 'T#', '%', '%M', 'M99999.9', 'MW8191',
        'MD8190', 'I0.8', 'Q1023.7', 'x' * 300, [], {}, [1, 2], {'a': 1}, 'IF', 'øæå', '\\"']


def mutate(node, rnd, depth=0):
    if isinstance(node, dict):
        for k in list(node.keys()):
            r = rnd.random()
            if r < 0.04:
                del node[k]
            elif r < 0.10:
                node[k] = rnd.choice(JUNK)
            else:
                mutate(node[k], rnd, depth + 1)
    elif isinstance(node, list):
        for i in range(len(node)):
            r = rnd.random()
            if r < 0.04:
                node[i] = rnd.choice(JUNK)
            else:
                mutate(node[i], rnd, depth + 1)
        if node and rnd.random() < 0.05:
            node.append(rnd.choice(node))           # duplicate ids etc.


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    cases = [json.load(open(os.path.join(HERE, 'cases', f), encoding='utf-8'))
             for f in sorted(os.listdir(os.path.join(HERE, 'cases')))]
    rnd = random.Random(int(os.environ.get("FUZZ_SEED", "1234")))
    steps = {'steps': [{'t': 0, 'scans': 2}, {'set': {'A': True, 'X': 5}, 'dt': 50, 'scans': 3}]}
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
                    cut = rnd.randrange(len(c) + 1)
                    b['code'] = c[:cut] + rnd.choice(['', '(', ':=', 'END_IF', '(*', '#', '..', '1..']) + c[cut:]
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
