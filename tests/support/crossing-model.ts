// sync.proto rule 6, IMPORT CROSSINGS, as one facet K on one client, written the simplest way so
// golden/import-vectors.json `crossings` are executed here, not only stated. Values are K's own
// fields in the abstract (null = a tombstone or no value); versions are real rule-5 tokens.
import { SERVER_DEVICE_ID, compareVersion, parseVersion } from '../../src/index.js';

export type Value = number | string | null;
export interface Facet {
  value: Value;
  version: string;
}
interface Edit extends Facet {
  /** The highest version the client had taken from the server for K when it minted this edit. */
  takenBefore: string | undefined;
  phase: 'unpushed' | 'pushed' | 'answered';
  /** OPEN until the client's Delta delivers K at or above this edit's version. */
  open: boolean;
}

const above = (a: string, b: string | undefined) => b === undefined || compareVersion(a, b) > 0;
const isImport = (version: string) => parseVersion(version)?.deviceId === SERVER_DEVICE_ID;

export class CrossingClient {
  constructor(readonly deviceId: string) {}
  local: Facet | undefined;
  taken: string | undefined;
  edits: Edit[] = [];
  /** MFC's side of a pending import conflict on K, or null when none is pending. */
  crossing: { mfc: Facet } | null = null;

  get outbox(): Value[] {
    return this.edits.filter((e) => e.phase === 'unpushed').map((e) => e.value);
  }

  /** The user edits K. Minted with Hlc.tick(base) on the local version, so it lands above it. */
  edit(value: Value, version: string): void {
    if (this.local !== undefined && !above(version, this.local.version)) throw new Error(`edit ${version} not above local`);
    if (!above(version, this.taken)) throw new Error(`edit ${version} not above what the client took`);
    this.edits.push({ value, version, takenBefore: this.taken, phase: 'unpushed', open: true });
    this.local = { value, version };
  }

  /** Push every unpushed edit, unless an import conflict holds them. */
  push(): void {
    if (this.crossing !== null) return;
    for (const e of this.edits) if (e.phase === 'unpushed') e.phase = 'pushed';
  }

  /** A Delta event for K. */
  take(ev: Facet): void {
    this.receive(ev, undefined);
  }

  /** The PushResult for the oldest pushed, unanswered edit. */
  answer(outcome: 'APPLIED' | 'STALE', current: Facet): void {
    const e = this.edits.find((x) => x.phase === 'pushed');
    if (e === undefined) throw new Error('no pushed edit to answer');
    e.phase = 'answered';
    if (outcome === 'APPLIED') {
      if (this.local?.version === e.version) this.local = current;
      return;
    }
    this.receive(current, e);
  }

  /** The user resolves the pending conflict with an ordinary write that replaces the unpushed edits. */
  resolve(choice: 'keep' | 'take', version: string): void {
    const pending = this.crossing;
    if (pending === null) throw new Error('nothing to resolve');
    if (!above(version, pending.mfc.version)) throw new Error('a resolution must be minted above the import write');
    const value = choice === 'keep' ? this.local!.value : pending.mfc.value;
    this.edits = this.edits.filter((e) => e.phase !== 'unpushed');
    this.crossing = null;
    this.edit(value, version);
  }

  private crosses(ev: Facet): boolean {
    const open = this.edits.filter((e) => e.open);
    if (open.length === 0 || !above(ev.version, open[0]!.takenBefore)) return false;
    return ev.value !== open.at(-1)!.value;
  }

  private receive(ev: Facet, stale: Edit | undefined): void {
    const fromImport = isImport(ev.version);
    if (this.crossing !== null && fromImport) {
      // A later import write only replaces MFC's side.
      if (above(ev.version, this.crossing.mfc.version)) this.crossing = { mfc: ev };
    } else if (fromImport && this.crosses(ev)) {
      this.crossing = { mfc: ev };
    } else {
      // A write by any other device ends a pending conflict; every write follows the ordinary rules.
      if (parseVersion(ev.version)?.deviceId !== this.deviceId) this.crossing = null;
      if (stale !== undefined && this.local?.version === stale.version) this.local = ev; // adopt `current` whole
      else if (this.local === undefined || above(ev.version, this.local.version)) this.local = ev;
    }
    if (above(ev.version, this.taken)) this.taken = ev.version;
    if (stale === undefined) for (const e of this.edits) if (compareVersion(ev.version, e.version) >= 0) e.open = false;
  }
}
