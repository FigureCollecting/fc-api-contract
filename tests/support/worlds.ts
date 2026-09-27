// The judge's exhaustive worlds (reset/judge/fuzz_a.py 1 and 2, fuzz2_a.py) on the server model: each case runs the
// path where the phone pushed first (REF) and the offline paths, and compares live copies per (figure, kind) and the
// pending figure items.
import { Device } from './replica-client.js';
import { Server, type Kind, type Row, type Switches } from './server-model.js';

const T = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
type Op = ['sell' | 'cancel' | 'repoint' | 'arrive', string] | ['add', Kind];
type Start = { n: number; k0: Kind; other: boolean; app: boolean };
type Path = 'REF' | 'OFF' | 'PULL1' | 'BETWEEN';

const row = (id: string, head: string, kind: Kind, count: number): Row => ({ id, head, kind, count, fields: {} });

function apply(d: Device, op: Op, t: number): void {
  if (op[0] === 'sell') d.edit(`occ/${op[1]}/status`, 'former', t);
  else if (op[0] === 'cancel') d.edit(`occ/${op[1]}/status`, null, t);
  else if (op[0] === 'repoint') d.edit(`occ/${op[1]}/head`, 'H1b', t);
  else if (op[0] === 'arrive') d.edit(`occ/${op[1]}/status`, 'owned', t);
  else {
    d.edit('occ/a1/head', 'H1', t);
    d.edit('occ/a1/status', op[1], t);
  }
}

/** Live copies per (head, kind) and the pending figure items: what the property compares. */
function outcome(s: Server): string {
  const counts: Record<string, number> = {};
  const occs = new Set([...s.emitted.keys()].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!));
  for (const x of occs) {
    const st = s.emitted.get(`occ/${x}/status`)?.[0];
    const h = s.emitted.get(`occ/${x}/head`)?.[0];
    if ((st === 'owned' || st === 'ordered' || st === 'wished') && typeof h === 'string' && h !== '') counts[`${h} ${st}`] = (counts[`${h} ${st}`] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify([sorted, s.figureItems()]);
}
const pendingOf = (o: string) => Object.keys((JSON.parse(o) as [unknown, Record<string, string>])[1]).length > 0;
const countsOf = (o: string) => JSON.stringify((JSON.parse(o) as unknown[])[0]);

function combinations<X>(xs: readonly X[], r: number): X[][] {
  if (r === 0) return [[]];
  const out: X[][] = [];
  xs.forEach((x, i) => {
    for (const rest of combinations(xs.slice(i + 1), r - 1)) out.push([x, ...rest]);
  });
  return out;
}

// ------------------------------------------------------------------ worlds 1 and 2 (fuzz_a.py)
const namer1 = (r: string, k: number) => (r === '1144' && k <= 8 ? `o${k}` : r === '900' && k === 1 ? 'p1' : `n${r}:${k}`);
const exportOf = (st: Start, d: number, kind: Kind, d900: number): Row[] => [
  row('1144', 'H1', kind, Math.max(0, st.n + d)),
  ...(st.other ? [row('900', 'H1', st.k0, Math.max(0, 1 + d900))] : []),
];

function run1(start: Start, ops: readonly Op[], exps: readonly Row[][], path: Path, sw: Switches, staging: boolean): string {
  const s = new Server({ namer: namer1, switches: sw });
  s.runImport(exportOf(start, 0, start.k0, 0), T('09:00'));
  const p = new Device(s, 'P', { staging });
  p.pull();
  if (start.app) {
    p.edit('occ/a0/head', 'H1', T('09:10'));
    p.edit('occ/a0/status', start.k0, T('09:10'));
    p.push(T('09:11'));
    p.pull();
  }
  ops.forEach((op, j) => apply(p, op, T('10:00') + j));
  const times = ['11:00', '13:00'];
  if (path === 'REF') {
    p.push(T('10:30'));
    exps.forEach((e, i) => s.runImport(e, T(times[i]!)));
  } else if (path === 'OFF') {
    exps.forEach((e, i) => s.runImport(e, T(times[i]!)));
    p.push(T('14:00'));
  } else if (path === 'PULL1') {
    s.runImport(exps[0]!, T('11:00'));
    p.pull();
    p.push(T('11:30'));
    for (const e of exps.slice(1)) s.runImport(e, T('13:00'));
  } else {
    s.runImport(exps[0]!, T('11:00'));
    p.pull();
    for (const e of exps.slice(1)) {
      s.runImport(e, T('13:00'));
      p.pull();
    }
    p.push(T('14:00'));
  }
  p.pull();
  return outcome(s);
}

export interface Tally {
  runs: number;
  same: number;
  sameWithItem: number;
  silentCounts: number;
  silentItem: number;
  differsShown: number;
  first: string[];
}

export function world(imports: 1 | 2, opts: { sw?: Switches; staging?: boolean; every?: number; limit?: number } = {}): Tally {
  const sw = opts.sw ?? {};
  const staging = opts.staging ?? true;
  const every = opts.every ?? 1;
  const t: Tally = { runs: 0, same: 0, sameWithItem: 0, silentCounts: 0, silentItem: 0, differsShown: 0, first: [] };
  const paths: Path[] = imports === 2 ? ['OFF', 'PULL1', 'BETWEEN'] : ['OFF', 'PULL1'];
  let k = 0;
  for (const n of [1, 2, 3])
    for (const k0 of ['owned', 'ordered'] as Kind[])
      for (const other of [false, true])
        for (const app of [false, true]) {
          const start: Start = { n, k0, other, app };
          const copies = [...Array.from({ length: n }, (_, i) => `o${i + 1}`), ...(other ? ['p1'] : []), ...(app ? ['a0'] : [])];
          const edits: Op[] = [];
          for (const x of copies) edits.push(['sell', x], ['cancel', x], ['repoint', x], ...(k0 === 'ordered' ? [['arrive', x] as Op] : []));
          edits.push(['add', k0]);
          const chs: [string, Row[]][] = [];
          for (const d of [-2, -1, 0, 1]) {
            if (n + d < 0) continue;
            for (const kind of [k0, ...(k0 === 'ordered' ? ['owned' as Kind] : [])])
              for (const d9 of other ? [-1, 0] : [0]) chs.push([`${d},${kind},${d9}`, exportOf(start, d, kind, d9)]);
          }
          for (const r of [0, 1, 2]) {
            for (const ops of combinations(edits, r)) {
              const onCopies = ops.filter((o) => o[0] !== 'add');
              if (new Set(onCopies.map((o) => o[1])).size < onCopies.length) continue;
              const seqs: [string, Row[]][][] = imports === 1 ? chs.map((c) => [c]) : chs.flatMap((a) => chs.map((b) => [a, b]));
              for (const seq of seqs) {
                if (seq[0]![0] === `0,${k0},0`) continue;
                if (k++ % every !== 0) continue;
                if (opts.limit !== undefined && t.runs >= opts.limit) return t;
                const exps = seq.map((c) => c[1]);
                const ref = run1(start, ops, exps, 'REF', sw, staging);
                for (const path of paths) {
                  t.runs++;
                  const got = run1(start, ops, exps, path, sw, staging);
                  if (got === ref) {
                    if (pendingOf(ref)) t.sameWithItem++;
                    else t.same++;
                    continue;
                  }
                  const what = `${path} ${JSON.stringify(start)} ${JSON.stringify(ops)} ${seq.map((c) => c[0]).join(' | ')} got ${got} ref ${ref}`;
                  if (countsOf(got) !== countsOf(ref) && !pendingOf(got)) t.silentCounts++;
                  else if (!pendingOf(got) && pendingOf(ref)) t.silentItem++;
                  else {
                    t.differsShown++;
                  }
                  if (t.first.length < 5) t.first.push(what);
                }
              }
            }
          }
        }
  return t;
}

// ------------------------------------------------------------------ world 3: two devices (fuzz2_a.py)
const namer2 = (r: string, k: number) => (r === '1144' ? `o${k}` : `n${r}:${k}`);
export function twoDevices(opts: { sw?: Switches; staging?: boolean } = {}): Tally {
  const t: Tally = { runs: 0, same: 0, sameWithItem: 0, silentCounts: 0, silentItem: 0, differsShown: 0, first: [] };
  for (const n of [2, 3])
    for (const k0 of ['owned', 'ordered'] as Kind[]) {
      const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`);
      const ops: Op[] = [];
      const kinds: ('sell' | 'cancel' | 'repoint' | 'arrive')[] = ['sell', 'cancel', 'repoint', ...(k0 === 'ordered' ? (['arrive'] as const) : [])];
      for (const x of copies) for (const kind of kinds) ops.push([kind, x]);
      for (const opa of ops)
        for (const opb of ops) {
          if (opa[1] === opb[1]) continue;
          for (const d of [-2, -1, 1]) {
            if (n + d < 0) continue;
            for (const kind of [k0, ...(k0 === 'ordered' ? ['owned' as Kind] : [])]) {
              const res: Record<string, string> = {};
              for (const path of ['REF', 'OFF'] as const) {
                const s = new Server({ namer: namer2, switches: opts.sw ?? {} });
                s.runImport([row('1144', 'H1', k0, n)], T('09:00'));
                const P = new Device(s, 'P', { staging: opts.staging ?? true });
                const Tb = new Device(s, 'T', { staging: opts.staging ?? true });
                P.pull();
                Tb.pull();
                apply(P, opa, T('10:00'));
                apply(Tb, opb, T('10:05'));
                if (path === 'REF') {
                  P.push(T('10:30'));
                  Tb.push(T('10:31'));
                }
                s.runImport([row('1144', 'H1', kind, n + d)], T('11:00'));
                if (path === 'OFF') {
                  P.pull();
                  Tb.pull();
                  P.push(T('12:00'));
                  Tb.push(T('12:10'));
                }
                for (let i = 0; i < 2; i++) {
                  P.pull();
                  Tb.pull();
                }
                res[path] = outcome(s);
              }
              t.runs++;
              if (res.OFF === res.REF) {
                if (pendingOf(res.REF!)) t.sameWithItem++;
                else t.same++;
              } else if (!pendingOf(res.OFF!)) {
                t.silentCounts++;
                if (t.first.length < 5) t.first.push(`${n} ${k0} ${JSON.stringify([opa, opb])} ${d} ${kind} ${JSON.stringify(res)}`);
              } else t.differsShown++;
            }
          }
        }
    }
  return t;
}

