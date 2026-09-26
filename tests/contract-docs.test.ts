import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const sync = read('proto/coordinator/v1/sync.proto');
const catalog = read('proto/coordinator/v1/catalog.proto');
const importProto = read('proto/coordinator/v1/import.proto');
const readme = read('README.md');
const hlcSource = read('src/hlc.ts');
const genSync = read('src/gen/coordinator/v1/sync_pb.ts');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  files: string[];
  exports: Record<string, unknown>;
  description: string;
};

// Collapse comment markers and whitespace so a rule reflowed across lines still matches.
const prose = (proto: string) => proto.replace(/^\s*(\/\/|\*) ?/gm, '').replace(/\s+/g, ' ');

describe('sync.proto', () => {
  it('no longer tells a client to keep its losing payload under the server version', () => {
    expect(sync).not.toMatch(/whatever the outcome/);
    expect(prose(sync)).toMatch(/adopt `current` whole/i);
    expect(prose(sync)).toMatch(/never pair the server's version with the client's losing payload/i);
  });

  it('writes the version grammar and its ordering table into the comment', () => {
    const text = prose(sync);
    expect(text).toMatch(/<instant>#<10-digit counter>#<32-hex device id>/);
    expect(sync).toContain('2026-09-14T11:30:00.123456Z#0000000000#00000000000000000000000000000000');
    expect(text).toMatch(/lowercase, dashless uuid/i);
    expect(text).toMatch(/reserved all-zero device id/i);
    expect(text).toMatch(/COLLATE "C"/);
  });

  it('trusts the wall clock after a forward gap and recovers a jump through rebase', () => {
    const text = prose(sync);
    expect(text).toMatch(/clamped only when the offset looks suspect/i);
    expect(text).toMatch(/a sleep \(monotonic time stalls\) or a wall-clock jump/i);
    expect(text).toMatch(/calls Hlc\.rebase\(\), adopts `current` and re-mints with Hlc\.tick\(base\)/i);
    expect(text).toMatch(/never clamps a base or an observed token/i);
  });

  it('states the bound the Hlc keeps, and when only the server backs it', () => {
    const text = prose(sync);
    expect(text).toMatch(/once anchored and rebased, a tick never passes server-now plus the clamp \(assuming the client's monotonic time keeps server rate\) while the anchor is fresh and every earlier edit minted past the bound has been answered, or re-minted after a rebase if unpushed, and re-minted if REJECTED version_future or dropped, after a rebase if past the fresh Status sample, for any other code/i);
    expect(text).not.toMatch(/while the anchor is fresh \(bar a 1 us carry/i);
    const firstStatus = /the client calls Hlc\.rebase\(\) after each session's first Status \(a no-op when the clock is not ahead\)/i;
    expect(text).toMatch(firstStatus);
    expect(prose(hlcSource.slice(hlcSource.indexOf('Drop whatever the clock holds'), hlcSource.indexOf('rebase(): boolean')))).toMatch(/call it after each session's first Status \(a no-op when the clock is not ahead\)/i);
    expect(text).toMatch(/a stale anchor may tick past server-now plus the clamp, and the server's version_future check is the backstop only when the push precedes real time catching up/i);
    expect(text).not.toMatch(/version_future check catches a jump/i);
    expect(text).toMatch(/the offset restored from the last one/i);
    expect(text).toMatch(/a phone on automatic time keeps its offset near zero and is unaffected/i);
  });

  it('floors every tick at the Status sample and every edit at its facet\'s version', () => {
    const text = prose(sync);
    expect(text).toMatch(/never below that Status sample plus the monotonic time elapsed since it/i);
    expect(text).toMatch(/before minting any edit the client hands the facet's current local version to Hlc\.tick\(base\)/i);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/re-mints with Hlc\.tick\(base\)/);
    expect(rejected).toMatch(/before minting any edit, not only a re-mint, the client hands Hlc\.tick the facet's current local version/i);
  });

  it('re-mints every unpushed edit past the new present after a rebase, not only the rejected one', () => {
    const text = prose(sync);
    expect(text).toMatch(/after any rebase, re-mint every unpushed edit past the new present, on its facet's server version/i);
    expect(text).toMatch(/a later edit on that facet takes the re-minted version as its base/i);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/re-mints the same way, on its facet's server version, every other unpushed edit minted before the rebase whose version is past the new present/i);
    const rebaseDoc = prose(hlcSource.slice(hlcSource.indexOf('Drop whatever the clock holds'), hlcSource.indexOf('rebase(): boolean')));
    expect(rebaseDoc).toMatch(/after any rebase, re-mint every unpushed edit past the new present \(above snapshot\(\)\), on its facet's server version/i);
    expect(rebaseDoc).toMatch(/a later edit on that facet takes the re-minted version as its base/i);
  });

  it('says a tick past the bound carries later ticks past it, through the clock and as a base, until it is answered', () => {
    const text = prose(sync);
    expect(text).toMatch(/it holds the clock ahead, and as a base it lifts the next edit on its facet/i);
    expect(text).toMatch(/until real time overtakes it or it has been answered, or re-minted after a rebase if unpushed, and re-minted if REJECTED version_future or dropped, after a rebase if past the fresh Status sample, for any other code, later ticks may pass the bound even on a fresh anchor/i);
    expect(text).not.toMatch(/it is answered, and re-minted if REJECTED, later ticks/i);
  });

  it('states the precondition of the bound wherever the bound is stated, and leaves an unanswered push to its retry', () => {
    const precondition = /every earlier edit minted past the bound has been answered, or re-minted after a rebase if unpushed, and re-minted if REJECTED version_future or dropped, after a rebase if past the fresh Status sample, for any other code/i;
    const inFlight = /an edit pushed but not yet answered is not re-minted in place: its retry carries the same client_id/i;
    const untilAnswered = /until it is answered, later ticks on that facet, and through the clock every later tick, may pass the bound/i;
    const text = prose(sync);
    expect(text).toMatch(precondition);
    expect(text).toMatch(inFlight);
    expect(text).toMatch(untilAnswered);
    const rebaseDoc = prose(hlcSource.slice(hlcSource.indexOf('Drop whatever the clock holds'), hlcSource.indexOf('rebase(): boolean')));
    expect(rebaseDoc).toMatch(precondition);
    expect(rebaseDoc).toMatch(inFlight);
    expect(rebaseDoc).toMatch(untilAnswered);
  });

  it('answers a replayed client_id with each event\'s recorded outcome and reason, and `current` re-read at the replay', () => {
    const clientId = prose(sync.slice(sync.indexOf('message PushRequest {'), sync.indexOf('string client_id = 1;')));
    const duplicate = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_APPLIED = 1;'), sync.indexOf('PUSH_OUTCOME_DUPLICATE = 2;')));
    const result = prose(sync.slice(sync.indexOf('message PushResult {'), sync.indexOf('SyncEvent current = 4;')));
    for (const text of [clientId, duplicate, result]) {
      expect(text).toMatch(/a replay \(same client_id, same events\) returns each event's recorded outcome and reason/i);
      expect(text).toMatch(/an event first APPLIED is answered DUPLICATE, one first REJECTED is REJECTED again with the same reason, one first STALE is STALE again and one first REVIEW is REVIEW again/i);
      expect(text).toMatch(/`current` on every replayed user-owned result is the facet as the server holds it at the replay/i);
    }
    for (const text of [sync, genSync]) expect(text).not.toMatch(/byte-identical/i);
    expect(duplicate).toMatch(/DUPLICATE answers only an event that was written/i);
    expect(clientId).toMatch(/the same client_id with different events is INVALID_ARGUMENT/i);
    const errors = prose(sync.slice(sync.indexOf('ERROR CONTRACT:'), sync.indexOf('service SyncService {')));
    expect(errors).toMatch(/a client_id already recorded with different events -> INVALID_ARGUMENT/i);
  });

  it('states the client_id grammar, that anything else is INVALID_ARGUMENT, and that it is checked before the transaction', () => {
    const clientId = prose(sync.slice(sync.indexOf('message PushRequest {'), sync.indexOf('string client_id = 1;')));
    expect(clientId).toMatch(/1 to 128 characters, each printable ASCII 0x21-0x7E \(no space, control or non-ASCII character\); anything else is INVALID_ARGUMENT, checked before the transaction opens/i);
    const errors = prose(sync.slice(sync.indexOf('ERROR CONTRACT:'), sync.indexOf('service SyncService {')));
    expect(errors).toMatch(/a client_id that is not 1 to 128 characters, each printable ASCII 0x21-0x7E, -> INVALID_ARGUMENT, checked before the transaction opens/i);
  });

  it('rebases after any REJECTED edit past the fresh Status sample, not only version_future', () => {
    const any = /after any REJECTED edit, whatever the code, the client takes a fresh Status and, if the edit's version is past the fresh Status sample \(server_now_iso\), calls Hlc\.rebase\(\) before it mints again/i;
    expect(prose(sync)).toMatch(any);
    expect(sync).not.toMatch(/past the present,/);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(any);
    expect(rejected).toMatch(/a replay under the same client_id is REJECTED again with the same reason/i);
  });

  it('pins the server\'s check order: every REJECTED check before any STALE, REVIEW or APPLIED routing', () => {
    const order = /the server runs the REJECTED checks in the listed order \(version_malformed, version_future, facet_key_not_user_owned, device_mismatch, payload_invalid\), all before any STALE, REVIEW or APPLIED routing, so an event past server_now \+ 5 minutes is REJECTED version_future unless an earlier-listed check fails, whatever the field's policy and whatever the stored version/i;
    const rule5 = prose(sync.slice(sync.indexOf(' 5. THE VERSION GRAMMAR'), sync.indexOf(' 6. USER-OWNED FACET KEYS')));
    expect(rule5).toMatch(order);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(order);
  });

  it('bounds every version the server emits, since the Hlc folds tokens unclamped', () => {
    const emitted = /every version the server emits, in Delta or as `current`, is at most server_now \+ 5 minutes when emitted: a pushed one by the check order, the import by min\(export_date, server_now\), and every other server write, server-owned facets included, at most server_now\. The Hlc folds tokens unclamped, so the bound depends on this\./i;
    const rule5 = prose(sync.slice(sync.indexOf(' 5. THE VERSION GRAMMAR'), sync.indexOf(' 6. USER-OWNED FACET KEYS')));
    expect(rule5).toMatch(emitted);
    const observeDoc = prose(hlcSource.slice(hlcSource.indexOf('Fold in a token seen from elsewhere'), hlcSource.indexOf('observe(version: string)')));
    expect(observeDoc).toMatch(emitted);
    expect(sync).not.toMatch(/bounds every token on the feed/);
    expect(hlcSource).not.toMatch(/bounds every token on the feed/);
  });

  it('pins server_now to one clock that never steps back, and the bound to client monotonic time keeping server rate', () => {
    const rule5 = prose(sync.slice(sync.indexOf(' 5. THE VERSION GRAMMAR'), sync.indexOf(' 6. USER-OWNED FACET KEYS')));
    expect(rule5).toMatch(/server_now is one clock that never steps back: the one Status samples and the one version_future checks against\./i);
    expect(rule5).toMatch(/a tick never passes server-now plus the clamp \(assuming the client's monotonic time keeps server rate\)/i);
  });

  it('rests the collation rule on out-of-grammar tokens, which is where collations disagree', () => {
    const text = prose(sync);
    expect(text).not.toMatch(/ignores '#' at the first level/);
    expect(text).toMatch(/order the same under C, glibc and ICU/i);
    expect(text).toMatch(/rejects an out-of-grammar token before it is stored/i);
    expect(text).toMatch(/COLLATE "C"/);
  });

  it('states the future-skew bound as a number', () => {
    expect(prose(sync)).toMatch(/server_now \+ 5 minutes/);
  });

  it('lists every REJECTED reason code', () => {
    for (const code of ['version_malformed', 'version_future', 'facet_key_not_user_owned', 'device_mismatch', 'payload_invalid']) {
      expect(sync).toContain(code);
    }
  });

  it('documents the user-owned facet-key grammar for the per-product register', () => {
    const text = prose(sync);
    for (const key of ['holding/{head_id}/status', 'holding/{head_id}/count', 'uf/{head_id}/score', 'uf/{head_id}/note']) {
      expect(text).toContain(key);
    }
    expect(text).toMatch(/written against the head_id at write time and never re-keyed/i);
    expect(text).toMatch(/edited_at/);
  });

  it('keys every facet of a holding by its status facet\'s head_id and says which status shows after a merge', () => {
    const text = prose(sync);
    expect(text).toMatch(/keyed by the head_id its status facet was first written under, never by the ProductCard\.head_id/i);
    expect(text).toMatch(/the status with the higher version is displayed/i);
    expect(text).toMatch(/a delete on a merged card tombstones every live status among requested_as/i);
  });

  it('applies the merged-card rules to requested_as unioned across every GetProducts call', () => {
    expect(prose(sync)).toMatch(/groups cards by head_id across every call and page and unions their requested_as; the display, write-target and delete rules apply to that union/i);
  });

  it('says the payload schemas check writes only, so an additive property cannot break an installed phone', () => {
    const text = prose(sync);
    expect(text).toMatch(/The schemas check writes only/);
    expect(text).toMatch(/10,000 code points/);
  });

  it('caps a pushed payload at MAX_PAYLOAD_BYTES of UTF-8 and names the reject', () => {
    const text = prose(sync);
    expect(text).toMatch(/a pushed payload over 65,536 bytes \(MAX_PAYLOAD_BYTES, counted as UTF-8\) is REJECTED payload_invalid: payload over 65536 bytes/i);
    expect(text).toMatch(/a schema-valid payload as JSON\.stringify writes it is at most 60,133 bytes/i);
    const payloadDoc = prose(sync.slice(sync.indexOf('message SyncEvent'), sync.indexOf('string payload = 4;')));
    expect(payloadDoc).toMatch(/at most MAX_PAYLOAD_BYTES \(65,536\) UTF-8 bytes on Push/i);
    const rejected = prose(sync.slice(sync.indexOf('PUSH_OUTCOME_REVIEW = 4;'), sync.indexOf('PUSH_OUTCOME_REJECTED = 5;')));
    expect(rejected).toMatch(/payload_invalid .*is over MAX_PAYLOAD_BYTES/i);
  });

  it('answers an oversized request or a full queue RESOURCE_EXHAUSTED and a lock timeout UNAVAILABLE', () => {
    const contract = prose(sync.slice(sync.indexOf('ERROR CONTRACT:'), sync.indexOf('service SyncService')));
    expect(contract).toMatch(/a request body over 16 MiB \(16,777,216 bytes\) -> RESOURCE_EXHAUSTED/i);
    expect(contract).toMatch(/the client splits the batch/i);
    expect(contract).toMatch(/the user's push queue is full -> RESOURCE_EXHAUSTED/i);
    expect(contract).toMatch(/retries later with the same client_id and the same events/i);
    expect(contract).toMatch(/a lock timeout -> UNAVAILABLE/i);
    expect(contract).toMatch(/UNAVAILABLE\. The transaction rolled back, .*the client retries with the same client_id and the same events/i);
    expect(contract).toMatch(/nothing is written and nothing is recorded under the client_id/i);
  });

  it('keeps the deferred Resync and Ack out of the wire and says so', () => {
    expect(prose(sync)).toMatch(/Resync|prune/);
    expect(sync).not.toMatch(/rpc (Resync|Ack)\(/);
  });
});

describe('hlc.ts', () => {
  it('points its 1-3 line header at sync.proto rule 5 for the bound; the clamp doc says the clamp is the server skew', () => {
    const headerLines = hlcSource.slice(0, hlcSource.indexOf('import {')).trimEnd().split('\n');
    expect(headerLines.length).toBeLessThanOrEqual(3);
    expect(prose(headerLines.join('\n'))).toMatch(/the bound and its assumptions: sync\.proto rule 5/i);
    const clampDoc = prose(hlcSource.slice(hlcSource.indexOf('clampMs?: number;') - 400, hlcSource.indexOf('clampMs?: number;')));
    expect(clampDoc).toMatch(/must equal MAX_FUTURE_SKEW_MS/i);
    expect(clampDoc).toMatch(/a larger one lets a fresh tick be REJECTED/i);
    expect(clampDoc).not.toMatch(/may not be below/i);
  });

  it('calls the floor a lower bound on server time only assuming monotonic time keeps server rate', () => {
    const text = prose(hlcSource);
    const lowerBounds = text.match(/lower bound[^.]*\./gi) ?? [];
    expect(lowerBounds.length).toBe(2);
    for (const sentence of lowerBounds) expect(sentence).toMatch(/assuming monotonic time keeps server rate/i);
  });
});

describe('catalog.proto', () => {
  it('states that ProductCard carries no inventory_level and why', () => {
    const text = prose(catalog);
    expect(text).toMatch(/carries no inventory_level/i);
    expect(text).toMatch(/entitlement/i);
  });

  it('states how GetProducts paging works', () => {
    const text = prose(catalog);
    expect(text).toMatch(/follow next_page_token until it is empty/i);
    expect(text).toMatch(/first page only/i);
    expect(text).toMatch(/at most 200 refs/i);
  });

  it('states how ER redirects are exposed', () => {
    const text = prose(catalog);
    expect(text).toMatch(/survivor/i);
    expect(text).toMatch(/requested_as/);
    expect(text).toMatch(/never re-keyed/i);
    expect(text).toMatch(/which status is shown/i);
    expect(text).toMatch(/what a delete clears/i);
    expect(text).toMatch(/groups cards by head_id across every call and page and unions their requested_as; the display, write-target and delete rules of sync\.proto rule 6 apply to that union/i);
  });

  it('marks SearchProducts UNIMPLEMENTED until served', () => {
    expect(prose(catalog)).toMatch(/UNIMPLEMENTED/);
  });
});

describe('import.proto', () => {
  it('versions import writes under the reserved server device with a per-user counter', () => {
    const text = prose(importProto);
    expect(text).toMatch(/reserved server device/i);
    expect(text).toMatch(/per-user import counter/i);
    expect(text).toMatch(/never removes a holding a device wrote/i);
  });

  it('keys import writes the way rule 6 keys device writes', () => {
    expect(prose(importProto)).toMatch(/already holds under a merged head_id writes under that head_id/i);
  });

  it('never versions an import in the future', () => {
    const text = prose(importProto);
    expect(text).toMatch(/whichever is earlier/i);
    expect(text).toMatch(/export_date later than the server's current UTC date plus one day -> INVALID_ARGUMENT/i);
  });

  it('counts a resolved row whose write lost to a newer device edit', () => {
    expect(prose(importProto)).toMatch(/added \+ moved \+ unchanged \+ kept_newer == resolved/);
  });
});

describe('README', () => {
  it('does not rest the collation rule on # being ignored', () => {
    expect(readme).not.toMatch(/which ignores `#`/);
    expect(readme).toMatch(/out-of-grammar token/);
  });
});

describe('package', () => {
  it('is 0.2.1', () => {
    expect(pkg.version).toBe('0.2.1');
  });

  it('ships and exports the new protos, the golden vectors and the payload schemas', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['proto', 'dist', 'golden', 'schemas']));
    for (const key of [
      './proto/coordinator/v1/catalog.proto',
      './proto/coordinator/v1/import.proto',
      './golden/version-vectors.json',
      './schemas/*',
    ]) {
      expect(pkg.exports, key).toHaveProperty([key]);
    }
  });
});
