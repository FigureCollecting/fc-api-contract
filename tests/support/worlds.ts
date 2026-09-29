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

// ------------------------------------------------------------------ world 4: late units and a knowing reaction (HELD)
type LateUnit = ['sell' | 'sell+disposal' | 'cancel' | 'tag', string] | ['add' | 'score', ''];
type Reaction = 'none' | 'readd' | 'tag-o1' | 'tag-o2' | 'sell-o2' | 'file-new' | 'score';
type RPath = 'REF' | 'OFF1' | 'OFF2';

function lateUnit(d: Device, u: LateUnit, t: number): void {
  const [op, x] = u;
  if (op === 'sell' || op === 'sell+disposal') d.edit(`occ/${x}/status`, 'former', t);
  if (op === 'sell+disposal') d.edit(`occ/${x}/disposal`, { reason: 'sold' }, t);
  if (op === 'cancel') d.edit(`occ/${x}/status`, null, t);
  if (op === 'tag') d.edit(`occ/${x}/tag/t1`, {}, t);
  if (op === 'add') {
    d.edit('occ/a1/head', 'H1', t);
    d.edit('occ/a1/status', 'owned', t);
  }
  if (op === 'score') d.edit('uf/H1/score', 9, t);
}

function react(d: Device, r: Reaction, n: number, t: number): void {
  if (r === 'readd') {
    d.edit('occ/a3/head', 'H1', t);
    d.edit('occ/a3/status', 'owned', t);
  } else if (r === 'tag-o1' || r === 'tag-o2') d.edit(`occ/${r.slice(4)}/tag/t9`, {}, t);
  else if (r === 'sell-o2') d.edit('occ/o2/status', 'former', t);
  else if (r === 'file-new') d.edit(`occ/o${n + 1}/collection`, 'owned/shelf-b', t);
  else if (r === 'score') d.edit('uf/H1/score', 7, t);
}

/** Live copies per (head, kind), the pending figure items, and the held edits. */
function reactionOutcome(s: Server): { counts: string; items: string; held: string[] } {
  const [counts, items] = JSON.parse(outcome(s)) as [unknown, unknown];
  return { counts: JSON.stringify(counts), items: JSON.stringify(items), held: Object.values(s.heldCards()).flat().sort() };
}

function runReaction(n: number, units: readonly LateUnit[], d: number, r: Reaction, path: RPath, sw: Switches) {
  const s = new Server({ namer: namer2, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  s.runImport([row('1144', 'H1', 'owned', n)], T('09:00'));
  P.pull();
  Tb.pull();
  units.forEach((u, j) => lateUnit(P, u, T('10:00') + j));
  const firstUnit = P.outbox.filter((e) => e.type === 'edit' && e.key.startsWith(units[0]![0] === 'add' ? 'occ/a1/' : units[0]![0] === 'score' ? 'uf/' : `occ/${units[0]![1]}/`)).length;
  if (path === 'REF') P.push(T('10:30'));
  s.runImport([row('1144', 'H1', 'owned', n + d)], T('11:00'));
  Tb.pull();
  react(Tb, r, n, T('11:10'));
  Tb.push(T('11:11'));
  if (path === 'OFF1') P.push(T('12:00'));
  if (path === 'OFF2') {
    // the two late units in two pushes: the second's relevance test must not undo the first's hold
    const rest = P.outbox.splice(firstUnit);
    P.push(T('12:00'));
    P.outbox.push(...rest);
    P.push(T('12:05'));
  }
  P.pull();
  Tb.pull();
  return reactionOutcome(s);
}

export interface ReactionTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  silent: number;
  /** With no reaction, anything but the pushed-first result (a hold with no reaction to justify it). */
  noReactionDiffers: number;
  first: string[];
}

/**
 * The phone makes one or two late units offline (a sale, a sale with its disposal, a cancel, a tag, an added copy, a
 * score), MFC changes the Count, the tablet pulls the import and reacts knowingly (or not), and the phone pushes its
 * units in one push or in two. REF: the phone pushed first. No path may differ from REF silently.
 */
export function reactionWorld(opts: { sw?: Switches } = {}): ReactionTally {
  const sw = opts.sw ?? {};
  const t: ReactionTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, silent: 0, noReactionDiffers: 0, first: [] };
  for (const n of [1, 2, 3]) {
    const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`);
    const ops: LateUnit[] = [...copies.flatMap((x) => (['sell', 'sell+disposal', 'cancel', 'tag'] as const).map((op): LateUnit => [op, x])), ['add', ''], ['score', '']];
    const combos: LateUnit[][] = [...ops.map((u) => [u]), ...combinations(ops, 2).filter(([a, b]) => a![1] !== b![1] || a![1] === '')];
    for (const units of combos)
      for (const d of [-2, -1, 1]) {
        if (n + d < 0) continue;
        for (const r of ['none', 'readd', 'tag-o1', 'tag-o2', 'sell-o2', 'file-new', 'score'] as Reaction[]) {
          if ((r === 'tag-o2' || r === 'sell-o2') && n < 2) continue;
          if (r === 'file-new' && d < 1) continue;
          const ref = runReaction(n, units, d, r, 'REF', sw);
          for (const path of (units.length === 2 ? ['OFF1', 'OFF2'] : ['OFF1']) as RPath[]) {
            const got = runReaction(n, units, d, r, path, sw);
            t.runs++;
            const shown = got.held.length > 0 || got.items !== '{}';
            const what = `n=${n} ${JSON.stringify(units)} d=${d} T:${r} ${path} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`;
            if (got.counts === ref.counts && got.items === ref.items && got.held.length === 0) t.same++;
            else if (got.counts === ref.counts && shown) t.sameCountsShown++;
            else if (shown) t.differsShown++;
            else {
              t.silent++;
              if (t.first.length < 5) t.first.push(what);
            }
            if (r === 'none' && (got.counts !== ref.counts || got.items !== ref.items || got.held.length > 0)) {
              t.noReactionDiffers++;
              if (t.first.length < 10) t.first.push(`no reaction: ${what}`);
            }
          }
        }
      }
  }
  return t;
}


// ------------------------------------------------------------------ world 5: reactions to an item (HELD (i) and (ii))
// The tablet reacts only when the import showed it something for the figure (a figure item or a change entry), by hand
// or by an answer, and the phone's late unit arrives after the tablet's reaction (OFF-T) or before it (OFF-P). A path
// where the tablet did not react is compared with pushed-first and no reaction; one where it reacted, with pushed-first
// and the same conditional reaction. A STALE answer is shown: the client shows the item as it now is.
type ItemUnit = ['sell' | 'sell+disposal' | 'cancel' | 'tag', string] | ['add', ''];
type ItemReaction = 'none' | 'readd' | 'tag-o1' | 'sell-o1' | 'sell-o2' | 'sell-high' | 'reown' | 'take' | 'keep' | 'undo' | 'dismiss';
type ItemPath = 'REF' | 'OFF-T' | 'OFF-P';

const liveOn = (d: Device) =>
  [...d.replica.keys()]
    .filter((k) => k.startsWith('occ/') && k.endsWith('/status'))
    .map((k) => k.split('/')[1]!)
    .filter((c) => ['owned', 'ordered', 'wished'].includes(d.show(`occ/${c}/status`) as string) && d.show(`occ/${c}/head`) === 'H1')
    .sort();
const removedOn = (d: Device) =>
  [...d.replica.keys()]
    .filter((k) => k.startsWith('occ/') && k.endsWith('/head') && d.show(k) === 'H1')
    .map((k) => k.split('/')[1]!)
    .filter((c) => d.show(`occ/${c}/status`) === null && d.show(`occ/${c}/origin`) !== null)
    .sort();

/** The tablet's reaction, if the import showed it something: whether it reacted, and the copy a by-hand sale wrote. */
function reactToItem(Tb: Device, r: ItemReaction, t: number): { reacted: boolean; sold: string | null } {
  const no = { reacted: false, sold: null };
  const fig = Tb.show('imp/mfc/figure/H1');
  const ch = Tb.show('imp/mfc/change/H1');
  if ((fig === null && ch === null) || r === 'none') return no;
  if (r === 'readd') {
    Tb.edit('occ/a3/head', 'H1', t);
    Tb.edit('occ/a3/status', 'owned', t);
  } else if (r === 'tag-o1') Tb.edit('occ/o1/tag/t9', {}, t);
  else if (r === 'sell-o1' || r === 'sell-o2' || r === 'sell-high') {
    // by name, or by PICKS: the highest-id live copy the tablet shows
    const c = r === 'sell-high' ? liveOn(Tb).at(-1) : liveOn(Tb).includes(r.slice(5)) ? r.slice(5) : undefined;
    if (c === undefined) return no;
    Tb.edit(`occ/${c}/status`, 'former', t);
    return { reacted: true, sold: c };
  } else if (r === 'reown') {
    const c = removedOn(Tb).at(-1);
    if (c === undefined) return no;
    Tb.edit(`occ/${c}/status`, 'owned', t);
  } else if (r === 'take' || r === 'keep') {
    if (fig === null) return no;
    Tb.answer('H1', r, t);
  } else {
    if (ch === null) return no;
    Tb.answer('H1', r, t, {}, {}, 'change');
  }
  return { reacted: true, sold: null };
}

function runItemReaction(policy: string, pre: string, n: number, u: ItemUnit, d: number, r: ItemReaction, path: ItemPath, sw: Switches) {
  const s = new Server({ namer: namer2, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  Tb.edit('pref/mfc/import', { import_policy: policy }, T('08:00'));
  Tb.push(T('08:01'));
  s.runImport([row('1144', 'H1', 'owned', n)], T('09:00'));
  P.pull();
  Tb.pull();
  if (pre === 'appadd') {
    Tb.edit('occ/b1/head', 'H1', T('09:30'));
    Tb.edit('occ/b1/status', 'owned', T('09:30'));
  } else if (pre === 'appsell') Tb.edit(`occ/o${n}/status`, 'former', T('09:30'));
  Tb.push(T('09:31'));
  const [op, x] = u;
  if (op === 'sell' || op === 'sell+disposal') P.edit(`occ/${x}/status`, 'former', T('10:00'));
  if (op === 'sell+disposal') P.edit(`occ/${x}/disposal`, { reason: 'sold' }, T('10:00'));
  if (op === 'cancel') P.edit(`occ/${x}/status`, null, T('10:00'));
  if (op === 'tag') P.edit(`occ/${x}/tag/t1`, {}, T('10:00'));
  if (op === 'add') {
    P.edit('occ/a1/head', 'H1', T('10:00'));
    P.edit('occ/a1/status', 'owned', T('10:00'));
  }
  if (path === 'REF') P.push(T('10:30'));
  s.runImport([row('1144', 'H1', 'owned', n + d)], T('11:00'));
  Tb.pull();
  const { reacted, sold } = reactToItem(Tb, r, T('11:10'));
  if (path === 'OFF-P') P.push(T('11:20'));
  const stale = Tb.push(T('11:30')).some((x) => x.outcome === 'STALE') && ['take', 'keep', 'undo', 'dismiss'].includes(r);
  if (path === 'OFF-T') P.push(T('12:00'));
  for (let i = 0; i < 2; i++) {
    P.pull();
    Tb.pull();
  }
  const [counts, items] = JSON.parse(outcome(s)) as [unknown, unknown];
  // both devices took the same copy out, offline: plain concurrency on one copy, which no import decided
  const collision = sold !== null && sold === x && op !== 'tag';
  return { counts: JSON.stringify(counts), items: JSON.stringify(items), held: Object.values(s.heldCards()).flat().sort(), reacted, stale, collision };
}

export interface ItemReactionTally {
  runs: number;
  same: number;
  shown: number;
  silent: number;
  /** Counts equal, pushed-first has an item and this path shows nothing. */
  silentItem: number;
  /** The tablet's by-hand sale took the very copy the phone sold offline: counted apart, never silent. */
  collisions: number;
  reacted: number;
  first: string[];
}

/**
 * One late unit on the phone (a sale, a sale with its disposal, a cancel, a tag, an added copy), MFC changes the Count,
 * and the tablet, having pulled the import, reacts to the figure item or change entry it shows (ASK, FAVOR_APP and
 * FAVOR_MFC; the app unchanged, a copy added, or a copy sold before the import). No path may differ from its
 * pushed-first reference silently.
 */
export function itemReactionWorld(opts: { sw?: Switches } = {}): ItemReactionTally {
  const sw = opts.sw ?? {};
  const t: ItemReactionTally = { runs: 0, same: 0, shown: 0, silent: 0, silentItem: 0, collisions: 0, reacted: 0, first: [] };
  for (const policy of ['ASK', 'FAVOR_APP', 'FAVOR_MFC'])
    for (const pre of ['none', 'appadd', 'appsell'])
      for (const n of [1, 2, 3]) {
        const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((c) => !(pre === 'appsell' && c === `o${n}`));
        const units: ItemUnit[] = [...copies.flatMap((x) => (['sell', 'sell+disposal', 'cancel', 'tag'] as const).map((op): ItemUnit => [op, x])), ['add', '']];
        for (const u of units)
          for (const d of [-2, -1, 1]) {
            if (n + d < 0) continue;
            for (const r of ['none', 'readd', 'tag-o1', 'sell-o1', 'sell-o2', 'sell-high', 'reown', 'take', 'keep', 'undo', 'dismiss'] as ItemReaction[]) {
              const refR = runItemReaction(policy, pre, n, u, d, r, 'REF', sw);
              const refNone = runItemReaction(policy, pre, n, u, d, 'none', 'REF', sw);
              for (const path of ['OFF-T', 'OFF-P'] as ItemPath[]) {
                const got = runItemReaction(policy, pre, n, u, d, r, path, sw);
                const ref = got.reacted ? refR : refNone;
                t.runs++;
                if (got.reacted) t.reacted++;
                const shown = got.held.length > 0 || got.items !== '{}' || got.stale;
                if (got.counts === ref.counts && got.items === ref.items && got.held.length === 0) t.same++;
                else if (shown) t.shown++;
                else if (got.counts === ref.counts) {
                  t.silentItem++;
                  if (t.first.length < 5) t.first.push(`item: ${policy} ${pre} ${path} n=${n} ${JSON.stringify(u)} d=${d} T:${r} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
                } else if (got.collision) t.collisions++;
                else {
                  t.silent++;
                  if (t.first.length < 5) t.first.push(`${policy} ${pre} ${path} n=${n} ${JSON.stringify(u)} d=${d} T:${r} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`);
                }
              }
            }
          }
      }
  return t;
}

// ------------------------------------------------------------------ world 7: compound reactions (HELD (i) and (ii))
// The tablet answers the item it was shown (undo or dismiss a change entry, keep or take a figure item, dismiss an
// align-MFC entry) AND someone acts by hand on the same showing: the tablet itself, its outbox going as one push or as
// two (the answer first) with the phone's late unit between or after, or a third device U that pulled the same showing.
// Each offline path is compared with pushed-first plus the same conditional reactions, the other devices' pushes in the
// path's own order. When pushed-first the by-hand pick (the highest or lowest live copy) is the phone's own late copy,
// which the device could not see offline, the path is compared once more with pushed-first where the device takes out
// the copy it took out offline, by name: equal there, it is counted apart as a pick, never as silent.
type CAnswer = 'undo' | 'dismiss' | 'take' | 'keep' | 'dismiss-align';
type CHand = 'sell-high' | 'sell-low' | 'reown' | 'readd' | 'tag';
export type COrder = 'T-P' | 'P-T' | 'T1-P-T2' | 'T1-T2-P' | 'P-T1-T2' | 'T-P-U' | 'T-U-P' | 'P-T-U' | 'U-T-P' | 'U-P-T' | 'P-U-T';
/** Pushed-first: the phone's unit before the import, the other devices' pushes in the path's own order. */
type CRef = 'REF T' | 'REF T1-T2' | 'REF T-U' | 'REF U-T';
export interface CCase {
  policy: string;
  pre: string;
  n: number;
  u: [string, string];
  d: number;
  a: CAnswer;
  h: CHand;
  /** T: the tablet answers and acts by hand; TU: the tablet answers and U acts by hand. */
  who: 'T' | 'TU';
}
/** What a device shows for H1 when it acts by hand (its outbox then holds its answer at most, never an edit). */
const liveAndRemoved = (d: Device) => {
  const occs = [...new Set([...d.replica.keys()].filter((k) => k.startsWith('occ/')).map((k) => k.split('/')[1]!))].sort();
  return {
    live: occs.filter((c) => d.show(`occ/${c}/status`) === 'owned' && d.show(`occ/${c}/head`) === 'H1'),
    removed: occs.filter((c) => d.show(`occ/${c}/status`) === null && d.show(`occ/${c}/head`) === 'H1'),
  };
};

export function runCompound(c: CCase, path: CRef | COrder, allow: { a: boolean; h: boolean }, sw: Switches, byName?: string) {
  const s = new Server({ namer: namer2, switches: sw });
  const P = new Device(s, 'P');
  const Tb = new Device(s, 'T');
  const U = new Device(s, 'U');
  Tb.edit('pref/mfc/import', { import_policy: c.policy }, T('07:50'));
  Tb.push(T('07:51'));
  s.runImport([row('1144', 'H1', 'owned', c.n)], T('08:00'));
  for (const d of [P, Tb, U]) d.pull();
  if (c.pre === 'appadd') {
    Tb.edit('occ/b1/head', 'H1', T('08:10'));
    Tb.edit('occ/b1/status', 'owned', T('08:10'));
  } else if (c.pre === 'appsell') Tb.edit(`occ/o${c.n}/status`, 'former', T('08:10'));
  Tb.push(T('08:11'));
  const [op, x] = c.u;
  if (op === 'sell' || op === 'sell+disposal') P.edit(`occ/${x}/status`, 'former', T('08:20'));
  if (op === 'sell+disposal') P.edit(`occ/${x}/disposal`, { reason: 'sold' }, T('08:20'));
  if (op === 'cancel') P.edit(`occ/${x}/status`, null, T('08:20'));
  if (op === 'add') {
    P.edit('occ/a1/head', 'H1', T('08:20'));
    P.edit('occ/a1/status', 'owned', T('08:20'));
  }
  if (path.startsWith('REF')) P.push(T('08:30'));
  s.runImport([row('1144', 'H1', 'owned', Math.max(0, c.n + c.d))], T('10:00'));
  Tb.pull();
  const fig = Tb.show('imp/mfc/figure/H1');
  const ch = Tb.show('imp/mfc/change/H1');
  const al = Tb.show('imp/mfc/align/H1');
  let didA = false;
  if (allow.a) {
    if ((c.a === 'undo' || c.a === 'dismiss') && ch !== null) didA = true;
    if ((c.a === 'take' || c.a === 'keep') && fig !== null) didA = true;
    if (c.a === 'dismiss-align' && al !== null) didA = true;
    if (didA) Tb.answer('H1', c.a === 'dismiss-align' ? 'dismiss' : c.a, T('10:10'), {}, {}, c.a === 'dismiss-align' ? 'align' : c.a === 'undo' || c.a === 'dismiss' ? 'change' : 'figure');
  }
  const nA = Tb.outbox.length;
  // the by-hand device: the tablet, or U, which pulled the same showing
  const H = c.who === 'T' ? Tb : U;
  if (c.who === 'TU') U.pull();
  const shown = ['figure', 'change', 'align'].some((k) => H.show(`imp/mfc/${k}/H1`) !== null);
  let didH = '';
  if (allow.h && shown) {
    const { live, removed } = liveAndRemoved(H);
    const t = T('10:11');
    if (c.h === 'sell-high' || c.h === 'sell-low') {
      const o = byName ?? (c.h === 'sell-low' ? live[0] : live.at(-1));
      if (o !== undefined) {
        H.edit(`occ/${o}/status`, 'former', t);
        didH = o;
      }
    } else if (c.h === 'reown') {
      const o = removed.at(-1);
      if (o !== undefined) {
        H.edit(`occ/${o}/status`, 'owned', t);
        didH = 'reown';
      }
    } else if (c.h === 'readd') {
      H.edit('occ/r1/head', 'H1', t);
      H.edit('occ/r1/status', 'owned', t);
      didH = 'readd';
    } else if (live[0] !== undefined) {
      H.edit(`occ/${live[0]}/tag/t9`, {}, t);
      didH = 'tag';
    }
  }
  const res: string[] = [];
  const pT = (n?: number) => res.push(...Tb.push(T('11:00') + res.length, n).map((r) => r.outcome));
  const pP = () => res.push(...P.push(T('11:00') + res.length).map((r) => r.outcome));
  const pU = () => res.push(...U.push(T('11:00') + res.length).map((r) => r.outcome));
  const split = nA > 0 && Tb.outbox.length > nA;
  const seq: Record<CRef | COrder, (() => void)[]> = {
    'REF T': [() => pT()],
    'REF T1-T2': [() => pT(nA), () => pT()],
    'REF T-U': [() => pT(), pU],
    'REF U-T': [pU, () => pT()],
    'T-P': [() => pT(), pP],
    'P-T': [pP, () => pT()],
    'T1-P-T2': [() => pT(nA), pP, () => pT()],
    'T1-T2-P': [() => pT(nA), () => pT(), pP],
    'P-T1-T2': [pP, () => pT(nA), () => pT()],
    'T-P-U': [() => pT(), pP, pU],
    'T-U-P': [() => pT(), pU, pP],
    'P-T-U': [pP, () => pT(), pU],
    'U-T-P': [pU, () => pT(), pP],
    'U-P-T': [pU, pP, () => pT()],
    'P-U-T': [pP, pU, () => pT()],
  };
  for (const f of seq[path]) f();
  for (let i = 0; i < 2; i++) for (const d of [P, Tb, U]) d.pull();
  let counts = 0;
  for (const [k, v] of s.emitted) if (k.endsWith('/status') && v[0] === 'owned' && s.emitted.get(k.replace('/status', '/head'))?.[0] === 'H1') counts++;
  const items = JSON.stringify({ f: s.figureItems(), c: Object.keys(s.changeEntries()).sort(), a: Object.keys(s.alignEntries()).sort() });
  const held = Object.values(s.heldCards()).flat().length;
  return { counts, items, held, stale: didA && res.includes('STALE'), didA, didH, split, out: res.join(',') };
}

export interface CompoundTally {
  runs: number;
  same: number;
  sameCountsShown: number;
  differsShown: number;
  /** A by-hand pick the replay made differ, equal to pushed-first with the copy taken out by name. */
  picks: number;
  pickCases: string[];
  silent: number;
  /** Counts equal, pushed-first has an item and this path shows nothing. */
  silentItem: number;
  first: string[];
}

/**
 * One late unit on the phone (a sale, a sale with its disposal, a cancel, an added copy), MFC changes the Count by -2 to
 * +2, and the tablet answers what it shows while it, or a third device, acts by hand on the same showing (ASK, FAVOR_APP
 * and FAVOR_MFC; the app unchanged, a copy added, or a copy sold before the import). No path may differ from its
 * pushed-first reference silently. `every` runs every k-th case (CI); FC_PROPERTY_FULL runs them all.
 */
export function compoundReactionWorld(opts: { sw?: Switches; every: number }): CompoundTally {
  const sw = opts.sw ?? {};
  const every = opts.every;
  const t: CompoundTally = { runs: 0, same: 0, sameCountsShown: 0, differsShown: 0, picks: 0, pickCases: [], silent: 0, silentItem: 0, first: [] };
  const EMPTY = '{"f":{},"c":[],"a":[]}';
  const sameAs = (r: { counts: number; items: string }, g: { counts: number; items: string }) => r.counts === g.counts && r.items === g.items;
  let k = 0;
  for (const policy of ['ASK', 'FAVOR_APP', 'FAVOR_MFC'])
    for (const pre of ['none', 'appadd', 'appsell'])
      for (const n of [1, 2, 3]) {
        const copies = Array.from({ length: n }, (_, i) => `o${i + 1}`).filter((x) => !(pre === 'appsell' && x === `o${n}`));
        const units: [string, string][] = [...copies.flatMap((x) => ['sell', 'sell+disposal', 'cancel'].map((op): [string, string] => [op, x])), ['add', '']];
        for (const u of units)
          for (const d of [-2, -1, 1, 2]) {
            if (n + d < 0) continue;
            for (const a of ['undo', 'dismiss', 'take', 'keep', 'dismiss-align'] as CAnswer[])
              for (const h of ['sell-high', 'sell-low', 'reown', 'readd', 'tag'] as CHand[])
                for (const who of ['T', 'TU'] as const) {
                  if (k++ % every !== 0) continue;
                  const c: CCase = { policy, pre, n, u, d, a, h, who };
                  const refs = new Map<string, ReturnType<typeof runCompound>>();
                  const orders: COrder[] = who === 'T' ? ['T-P', 'P-T', 'T1-P-T2', 'T1-T2-P', 'P-T1-T2'] : ['T-P-U', 'T-U-P', 'P-T-U', 'U-T-P', 'U-P-T', 'P-U-T'];
                  for (const path of orders) {
                    const got = runCompound(c, path, { a: true, h: true }, sw);
                    if (!got.split && path.includes('1')) continue; // one push: the same as T-P or P-T
                    const allow = { a: got.didA, h: got.didH !== '' };
                    const refPath = `REF ${path.split('-').filter((x) => x !== 'P').join('-')}` as CRef;
                    const key = `${allow.a}|${allow.h}|${refPath}`;
                    if (!refs.has(key)) refs.set(key, runCompound(c, refPath, allow, sw));
                    const ref = refs.get(key)!;
                    t.runs++;
                    if (got.counts === ref.counts && got.items === ref.items && got.held === 0) {
                      t.same++;
                      continue;
                    }
                    const shown = got.held > 0 || got.stale || (got.items !== ref.items && got.items !== EMPTY);
                    const what = `${JSON.stringify(c)} ${path} got ${JSON.stringify(got)} ref ${JSON.stringify(ref)}`;
                    if (got.counts === ref.counts) {
                      if (shown) t.sameCountsShown++;
                      else {
                        t.silentItem++;
                        if (t.first.length < 5) t.first.push(`item: ${what}`);
                      }
                    } else if (shown) t.differsShown++;
                    else if (u[0] === 'add' && ref.didH === 'a1' && got.didH !== 'a1' && sameAs(runCompound(c, refPath, allow, sw, got.didH), got)) {
                      t.picks++;
                      if (t.pickCases.length < 20) t.pickCases.push(what);
                    }
                    else {
                      t.silent++;
                      if (t.first.length < 5) t.first.push(what);
                    }
                  }
                }
          }
      }
  return t;
}
