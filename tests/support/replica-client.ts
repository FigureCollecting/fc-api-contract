// A plain client for the server model (sync.proto rule 6, THE IMPORT, ON A CLIENT): a replica kept by LWW
// that applies a server transaction only once it has all of it (rule 7, F2), an outbox whose every entry
// carries the basis it was minted on, a display that lays the outbox over the replica, and a push that adopts
// `current`. It decides nothing about imports.
import { CARD, cmpVersion, type Choice, type FeedEvent, type Field, type ItemKind, type Json, type Pushable, type PushResult, type Server, type Version } from './server-model.js';

export class Device {
  replica = new Map<string, [Json, Version]>();
  cursor = 0;
  outbox: Pushable[] = [];
  private ctr = 0;

  constructor(
    readonly s: Server,
    readonly dev: string,
    readonly opts: { staging?: boolean } = {},
  ) {}

  private localVer(key: string): Version | undefined {
    const vs: Version[] = [];
    const r = this.replica.get(key);
    if (r !== undefined) vs.push(r[1]);
    for (const e of this.outbox) if (e.type === 'edit' && e.key === key) vs.push(e.version);
    return vs.sort(cmpVersion).at(-1);
  }

  private mint(key: string, t: number): Version {
    this.ctr++;
    let v: Version = [t, this.ctr, this.dev, 0];
    const lv = this.localVer(key);
    if (lv !== undefined && cmpVersion(v, lv) <= 0) v = [lv[0], lv[1] + 1, this.dev, 0];
    return v;
  }

  edit(key: string, value: Json, t: number): void {
    this.outbox.push({ type: 'edit', dev: this.dev, key, value, version: this.mint(key, t), basis: this.cursor, arr: -1, held: false });
  }

  answer(
    fig: string,
    choice: Choice,
    t: number,
    copies: Record<string, string> = {},
    fields: Partial<Record<Field, 'app' | 'mfc'>> = {},
    item: ItemKind = 'figure',
  ): void {
    const card = this.replica.get(`imp/mfc/${item}/${fig}`)?.[0];
    const rev = card !== null && card !== undefined && typeof card === 'object' && !Array.isArray(card) ? (card.rev as string) : null;
    const key = `res/mfc/${fig}`;
    this.outbox.push({
      type: 'answer',
      dev: this.dev,
      fig,
      key,
      rev,
      choice,
      item,
      copies,
      fields,
      version: this.mint(key, t),
      basis: this.cursor,
      arr: -1,
      lastSeq: new Map(),
      accepted: false,
    });
  }

  /** Fetched from the feed so far; `cursor` is the last event applied, always at a transaction boundary (F2). */
  private fetched = 0;
  private staged: FeedEvent[] = [];

  /** One Delta page of `n` events (all when undefined). A transaction is applied only once all of it is here. */
  pull(n?: number): void {
    const page = this.s.feed.slice(this.fetched, n === undefined ? undefined : this.fetched + n);
    this.fetched += page.length;
    this.staged.push(...page);
    const upto = this.opts.staging === false ? this.staged.length - 1 : this.staged.findLastIndex((e) => e.last);
    for (const e of this.staged.slice(0, upto + 1)) {
      const r = this.replica.get(e.key);
      if (r === undefined || cmpVersion(e.version, r[1]) > 0) this.replica.set(e.key, [e.value, e.version]);
      this.cursor = e.seq;
    }
    this.staged = this.staged.slice(upto + 1);
  }

  replayFromEmpty(): void {
    this.replica = new Map();
    this.cursor = 0;
    this.fetched = 0;
    this.staged = [];
    this.pull();
  }

  push(t: number): PushResult[] {
    if (this.outbox.length === 0) return [];
    const res = this.s.push(this.outbox, t);
    res.forEach((r, i) => {
      const it = this.outbox[i]!;
      const key = it.type === 'edit' ? it.key : CARD + it.fig;
      const local = this.replica.get(key);
      if (r.current !== undefined && (local === undefined || cmpVersion(r.current[1], local[1]) > 0)) this.replica.set(key, r.current);
    });
    this.outbox = [];
    return res;
  }

  show(key: string): Json {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const e = this.outbox[i]!;
      if (e.type === 'edit' && e.key === key) return e.value;
    }
    return this.replica.get(key)?.[0] ?? null;
  }

  cards(): string[] {
    return [...this.replica]
      .filter(([k, v]) => k.startsWith(CARD) && v[0] !== null && (v[0] as { kind?: string }).kind === 'conflict')
      .map(([k]) => k.slice(CARD.length))
      .sort();
  }
}
