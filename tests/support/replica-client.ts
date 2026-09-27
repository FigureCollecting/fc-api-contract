// A plain client for the server model (import.proto THE SERVER DECIDES, client rules): a replica kept by
// LWW, an outbox whose every entry carries the basis it was minted on, a display that lays the outbox
// over the replica, and a push that adopts `current`. It decides nothing about imports.
import { CARD, cmpVersion, type Choice, type Field, type ItemKind, type Json, type Pushable, type PushResult, type Server, type Version } from './server-model.js';

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

  pull(n?: number): void {
    const evs = this.s.feed.slice(this.cursor, n === undefined ? undefined : this.cursor + n);
    for (const e of evs) {
      const r = this.replica.get(e.key);
      if (r === undefined || cmpVersion(e.version, r[1]) > 0) this.replica.set(e.key, [e.value, e.version]);
      this.cursor = e.seq;
    }
  }

  replayFromEmpty(): void {
    this.replica = new Map();
    this.cursor = 0;
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
