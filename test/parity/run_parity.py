#!/usr/bin/env python3
"""Parity test: the C PLC engine (components/plc_core) against the IDE's own
JavaScript simulator (web/js/sim.js) on the same programs and inputs.

    python test/parity/run_parity.py            # build, regenerate cases, compare
    python test/parity/run_parity.py -k timers  # only cases whose name contains "timers"

Needs gcc and node on PATH. For every step of every case it compares each
tag value and every element/network/pin monitor flag; any difference fails.
Afterwards each case is loaded and freed 50 times under a counting allocator
(test/host/test_leak.c): any leaked byte fails too.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CORE = os.path.join(ROOT, 'components', 'plc_core')
OUT = os.path.join(ROOT, 'build_host')
CLI = os.path.join(OUT, 'plc_cli.exe' if os.name == 'nt' else 'plc_cli')


def build():
    os.makedirs(OUT, exist_ok=True)
    srcs = [os.path.join(CORE, f) for f in ('jdom.c', 'jw.c', 'plc_engine.c', 'plc_scl.c')]
    srcs.append(os.path.join(ROOT, 'test', 'host', 'plc_cli.c'))
    cmd = ['gcc', '-std=c11', '-O2', '-g', '-Wall', '-Wextra', '-Wno-unused-parameter',
           '-I' + os.path.join(CORE, 'include'), '-I' + CORE] + srcs + ['-lm', '-o', CLI]
    subprocess.run(cmd, check=True)
    # JSON parser unit tests first: everything else stands on it
    exe = os.path.join(OUT, 'test_jdom.exe' if os.name == 'nt' else 'test_jdom')
    subprocess.run(['gcc', '-std=c11', '-Wall', '-Wextra', '-I' + os.path.join(CORE, 'include'),
                    os.path.join(CORE, 'jdom.c'), os.path.join(ROOT, 'test', 'host', 'test_jdom.c'), '-o', exe], check=True)
    subprocess.run([exe], check=True)
    # shift-register chains (main/shiftreg.c) against simulated 74HC595 / 74HC165 chips
    exe = os.path.join(OUT, 'test_shiftreg.exe' if os.name == 'nt' else 'test_shiftreg')
    subprocess.run(['gcc', '-std=c11', '-Wall', '-Wextra', '-I' + os.path.join(ROOT, 'main'),
                    os.path.join(ROOT, 'main', 'shiftreg.c'), os.path.join(ROOT, 'test', 'host', 'test_shiftreg.c'),
                    '-o', exe], check=True)
    subprocess.run([exe], check=True)
    # I2C module protocols (main/i2c_dev.c) against simulated PCF8574 / MCP23017 / ADS1115
    exe = os.path.join(OUT, 'test_i2c_dev.exe' if os.name == 'nt' else 'test_i2c_dev')
    subprocess.run(['gcc', '-std=c11', '-Wall', '-Wextra', '-I' + os.path.join(ROOT, 'main'),
                    os.path.join(ROOT, 'main', 'i2c_dev.c'), os.path.join(ROOT, 'test', 'host', 'test_i2c_dev.c'),
                    '-lm', '-o', exe], check=True)
    subprocess.run([exe], check=True)


def same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if a is None or b is None:
        return a is b
    a, b = float(a), float(b)
    return abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


def describe(project):
    """element/box/pin/network id -> human-readable location"""
    names = {}
    for b in project.get('blocks', []):
        for ni, n in enumerate(b.get('networks') or []):
            if not n:
                continue
            where = '%s/net%d' % (b.get('name'), ni + 1)
            names[n.get('id')] = where
            for s in n.get('stages') or []:
                for br in s.get('branches') or []:
                    for e in br.get('elements') or []:
                        names[e['id']] = '%s %s(%s)' % (where, e['kind'], e.get('operand', ''))
            for e in n.get('outputs') or []:
                names[e['id']] = '%s %s(%s)' % (where, e['kind'], e.get('operand', ''))
            for bx in n.get('boxes') or []:
                names[bx['id']] = '%s box %s' % (where, bx['kind'])
                for pin in (bx.get('inputs') or []) + (bx.get('outputs') or []):
                    names[pin['id']] = '%s box %s pin %s' % (where, bx['kind'], pin['name'])
    return names


def compare(kase, js, c):
    errs = []
    names = describe(kase['project'])
    if len(js['steps']) != len(c['steps']):
        errs.append('step count differs: js=%d c=%d' % (len(js['steps']), len(c['steps'])))
    for i, (sj, sc) in enumerate(zip(js['steps'], c['steps'])):
        for k, v in sj['mem'].items():
            cv = sc['mem'].get(k, '<missing>')
            if cv == '<missing>' or not same(v, cv):
                errs.append('step %d: tag %s  js=%r  c=%r' % (i, k, v, cv))
        for grp in ('live', 'power', 'pins'):
            for k in sorted(set(sj[grp]) | set(sc[grp])):
                a, b = sj[grp].get(k, False), sc[grp].get(k, False)
                if a != b:
                    errs.append('step %d: %s %s  js=%s c=%s' % (i, grp, names.get(k, k), a, b))
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-k', default='', help='only run cases whose name contains this')
    ap.add_argument('--no-build', action='store_true')
    args = ap.parse_args()
    if not args.no_build:
        build()
    subprocess.run(['node', os.path.join(HERE, 'make_cases.js')], check=True, stdout=subprocess.DEVNULL)
    failed = 0
    cases = sorted(glob.glob(os.path.join(HERE, 'cases', '*.json')))
    for path in cases:
        name = os.path.splitext(os.path.basename(path))[0]
        if args.k not in name:
            continue
        with open(path, encoding='utf-8') as f:
            kase = json.load(f)
        js = json.loads(subprocess.run(['node', os.path.join(HERE, 'js_ref.js'), path],
                                       check=True, capture_output=True, text=True, encoding='utf-8').stdout)
        with tempfile.TemporaryDirectory() as td:
            pj, sj = os.path.join(td, 'project.json'), os.path.join(td, 'steps.json')
            with open(pj, 'w', encoding='utf-8') as f:
                json.dump(kase['project'], f)
            with open(sj, 'w', encoding='utf-8') as f:
                json.dump({'steps': kase['steps']}, f)
            res = subprocess.run([CLI, pj, sj], capture_output=True, text=True, encoding='utf-8')
            if res.returncode != 0:
                print('FAIL %-10s C engine exited %d: %s %s' % (name, res.returncode, res.stdout, res.stderr))
                failed += 1
                continue
            c = json.loads(res.stdout)
        errs = compare(kase, js, c)
        nchk = sum(len(s['mem']) + len(s['live']) + len(s['power']) + len(s['pins']) for s in js['steps'])
        if errs:
            failed += 1
            print('FAIL %-10s %d difference(s)' % (name, len(errs)))
            for e in errs[:40]:
                print('     ' + e)
        else:
            print('ok   %-10s %3d steps, %5d values compared%s' % (
                name, len(js['steps']), nchk,
                ('   warnings: ' + ' | '.join(c['warnings'])) if c.get('warnings') else ''))
    print('\n%s' % ('ALL PARITY CASES PASS' if not failed else '%d case(s) FAILED' % failed))

    # a PLC is re-programmed many times without a reboot: nothing may leak
    if not args.no_build:
        leak = os.path.join(OUT, 'test_leak.exe' if os.name == 'nt' else 'test_leak')
        srcs = [os.path.join(CORE, f) for f in ('jdom.c', 'jw.c', 'plc_engine.c', 'plc_scl.c')]
        subprocess.run(['gcc', '-std=c11', '-O1', '-I' + os.path.join(CORE, 'include'), '-I' + CORE] + srcs +
                       [os.path.join(ROOT, 'test', 'host', 'test_leak.c'), '-lm', '-o', leak], check=True)
        with tempfile.TemporaryDirectory() as td:
            for path in cases:
                name = os.path.splitext(os.path.basename(path))[0]
                if args.k not in name:
                    continue
                pj = os.path.join(td, name + '.json')
                with open(path, encoding='utf-8') as f, open(pj, 'w', encoding='utf-8') as g:
                    json.dump(json.load(f)['project'], g, separators=(',', ':'))
                r = subprocess.run([leak, pj, '50'], capture_output=True, text=True)
                print('leak %-10s %s' % (name, r.stdout.strip()))
                if r.returncode != 0:
                    failed += 1
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
