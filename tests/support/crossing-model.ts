// sync.proto rule 6, IMPORT CROSSINGS, on one client over its facets, written the simplest way so
// golden/import-vectors.json `crossings` (one facet K) and `keyedCrossings` (a row's copies, conflicts) are
// executed here, not only stated. Values are a facet's own fields in the abstract (null = a tombstone or no
// value; an origin's value stands for its MFC id); versions are real rule-5 tokens.
import { SERVER_DEVICE_ID, compareVersion, parseVersion } from '../../src/index.js';

export type Value = number | string | null;
export interface Facet {
  value: Value;
  version: string;
}
export interface Event extends Facet {
  key: string;
}
interface Edit extends Event {
  /** The facet the client held for the key before minting it: what dropping the edit restores. */
  prior: Facet | undefined;
  /** What the client had taken from the server, key by key, when it minted it. */
  takenBefore: ReadonlyMap<string, string>;
  phase: 'unpushed' | 'pushed' | 'answered';
  /** OPEN until the client's Delta delivers its key at or above its version. */
  open: boolean;
}
export interface Crossing {
  /** MFC's side: the import write, or for a conflict the base's value at the conflict's version. */
  mfc: Facet;
  /** K and the key of every edit it crossed: no edit to these is pushed while it is pending. */
  holds: Set<string>;
}

const above = (a: string, b: string | undefined) => b === undefined || compareVersion(a, b) > 0;
const deviceOf = (version: string) => parseVersion(version)?.deviceId;
const CONFLICT = 'imp/mfc/conflict/';
const BASE = 'imp/mfc/base/';
const STATUS = /^occ\/([^/]+)\/status$/;

export class KeyedCrossingClient {
  constructor(readonly deviceId: string) {}
  private readonly local = new Map<string, Facet>();
  private readonly taken = new Map<string, string>();
  private edits: Edit[] = [];
  /** Pending import conflicts, by the key they are on. */
  readonly crossings = new Map<string, Crossing>();

  facet(key: string): Facet | undefined {
    return this.local.get(key);
  }

  shows(key: string): Value {
    return this.local.get(key)?.value ?? null;
  }

  get outbox(): Event[] {
    return this.edits.filter((e) => e.phase === 'unpushed').map(({ key, value, version }) => ({ key, value, version }));
  }

  /** The user edits `key`. Minted with Hlc.tick(base) on the local version, so it lands above it. */
  edit(key: string, value: Value, version: string): void {
    const prior = this.local.get(key);
    if (prior !== undefined && !above(version, prior.version)) throw new Error(`edit ${version} not above local`);
    if (!above(version, this.taken.get(key))) throw new Error(`edit ${version} not above what the client took`);
    this.edits.push({ key, value, version, prior, takenBefore: new Map(this.taken), phase: 'unpushed', open: true });
    this.local.set(key, { value, version });
  }

  /** Push every unpushed edit no pending conflict holds, and return them. */
  push(): Event[] {
    const held = new Set([...this.crossings.values()].flatMap((c) => [...c.holds]));
    const pushed = this.edits.filter((e) => e.phase === 'unpushed' && !held.has(e.key));
    for (const e of pushed) e.phase = 'pushed';
    return pushed.map(({ key, value, version }) => ({ key, value, version }));
  }

  /** A Delta event. */
  take(ev: Event): void {
    this.receive(ev, undefined);
  }

  /** The PushResult for the oldest pushed, unanswered edit. */
  answer(outcome: 'APPLIED' | 'STALE', current: Event): void {
    const e = this.edits.find((x) => x.phase === 'pushed');
    if (e === undefined) throw new Error('no pushed edit to answer');
    e.phase = 'answered';
    if (outcome === 'APPLIED') {
      if (this.local.get(e.key)?.version === e.version) this.local.set(e.key, current);
      return;
    }
    this.receive(current, e);
  }

  /** The user resolves the conflict on `key` with an ordinary write that replaces its unpushed edits. */
  resolve(key: string, choice: 'keep' | 'take', version: string): void {
    const pending = this.crossings.get(key);
    if (pending === undefined) throw new Error('nothing to resolve');
    if (!above(version, pending.mfc.version)) throw new Error("a resolution must be minted above MFC's side");
    const value = choice === 'keep' ? this.shows(key) : pending.mfc.value;
    this.edits = this.edits.filter((e) => !(e.key === key && e.phase === 'unpushed'));
    this.crossings.delete(key);
    this.edit(key, value, version);
  }

  private receive(ev: Event, stale: Edit | undefined): void {
    const target = ev.key.startsWith(CONFLICT) ? ev.key.slice(CONFLICT.length) : undefined;
    const key = target ?? ev.key;
    const fromImport = target !== undefined || deviceOf(ev.version) === SERVER_DEVICE_ID;
    const side: Facet = target === undefined ? ev : { value: this.shows(BASE + target), version: ev.version };
    const pending = this.crossings.get(key);
    if (fromImport && pending !== undefined) {
      // A later import write to K, or conflict on K, only replaces MFC's side.
      if (above(side.version, pending.mfc.version)) pending.mfc = side;
      if (target !== undefined) this.apply(ev, stale);
    } else if (fromImport && this.crosses(ev, key, side)) {
      if (target !== undefined) this.apply(ev, stale);
    } else {
      // A write to K by any other device ends a pending conflict; every write follows the ordinary rules.
      if (pending !== undefined && deviceOf(ev.version) !== this.deviceId) this.crossings.delete(key);
      this.apply(ev, stale);
    }
    if (above(ev.version, this.taken.get(ev.key))) this.taken.set(ev.key, ev.version);
    if (stale === undefined) for (const e of this.edits) if (e.key === ev.key && compareVersion(ev.version, e.version) >= 0) e.open = false;
  }

  /** The ordinary rules: adopt `current` whole for the edit it answers, else apply only a newer version. */
  private apply(ev: Event, stale: Edit | undefined): void {
    const local = this.local.get(ev.key);
    if ((stale !== undefined && local?.version === stale.version) || local === undefined || above(ev.version, local.version)) {
      this.local.set(ev.key, { value: ev.value, version: ev.version });
    }
  }

  /** Whether an import write to `key`, or a conflict raised on it, crosses open edits; records the crossing. */
  private crosses(ev: Event, key: string, side: Facet): boolean {
    // The open edits to a key, when `ev` is NEW to them: the client had not taken its version, or a higher
    // one, before the oldest was minted.
    const openTo = (k: string) => {
      const open = this.edits.filter((e) => e.open && e.key === k);
      return open.length > 0 && above(ev.version, open[0]!.takenBefore.get(ev.key)) ? open : [];
    };
    const changes = (open: Edit[]) => open.length > 0 && open.at(-1)!.value !== (open[0]!.prior?.value ?? null);
    let own = openTo(key);
    if (own.length > 0 && !changes(own) && own.every((e) => e.phase === 'unpushed')) {
      this.edits = this.edits.filter((e) => !own.includes(e));
      if (own[0]!.prior === undefined) this.local.delete(key);
      else this.local.set(key, own[0]!.prior);
      own = [];
    }
    if (side.value === this.shows(key)) return false;
    const crossed = [...own];
    const x = STATUS.exec(ev.key)?.[1];
    if (x !== undefined && (this.shows(key) === null) !== (ev.value === null)) {
      // ROW GRAIN: a removal or an addition also crosses changed statuses of the row's other copies and, for an
      // addition, app copies (no origin) of its figure set to the kind it adds.
      const row = this.shows(`occ/${x}/origin`);
      const figure = this.shows(`occ/${x}/head`);
      for (const k of new Set(this.edits.map((e) => e.key))) {
        const y = STATUS.exec(k)?.[1];
        const open = openTo(k);
        if (y === undefined || y === x || !changes(open)) continue;
        const origin = this.shows(`occ/${y}/origin`);
        const sameRow = row !== null && origin === row;
        const appCopy = ev.value !== null && origin === null && this.shows(`occ/${y}/head`) === figure && open.at(-1)!.value === ev.value;
        if (sameRow || appCopy) crossed.push(...open);
      }
    }
    if (crossed.length === 0) return false;
    this.crossings.set(key, { mfc: side, holds: new Set([key, ...crossed.map((e) => e.key)]) });
    return true;
  }
}

const K = 'K';

/** One facet K: the `crossings` cases' view of the keyed client. */
export class CrossingClient {
  private readonly client: KeyedCrossingClient;

  constructor(deviceId: string) {
    this.client = new KeyedCrossingClient(deviceId);
  }

  get local(): Facet | undefined {
    return this.client.facet(K);
  }

  /** MFC's side of a pending import conflict on K, or null when none is pending. */
  get crossing(): { mfc: Facet } | null {
    const pending = this.client.crossings.get(K);
    return pending === undefined ? null : { mfc: pending.mfc };
  }

  get outbox(): Value[] {
    return this.client.outbox.map((e) => e.value);
  }

  edit(value: Value, version: string): void {
    this.client.edit(K, value, version);
  }

  push(): void {
    this.client.push();
  }

  take(ev: Facet): void {
    this.client.take({ key: K, ...ev });
  }

  answer(outcome: 'APPLIED' | 'STALE', current: Facet): void {
    this.client.answer(outcome, { key: K, ...current });
  }

  resolve(choice: 'keep' | 'take', version: string): void {
    this.client.resolve(K, choice, version);
  }
}
