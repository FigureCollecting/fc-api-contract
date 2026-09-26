import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const sync = read('proto/coordinator/v1/sync.proto');
const catalog = read('proto/coordinator/v1/catalog.proto');
const importProto = read('proto/coordinator/v1/import.proto');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  files: string[];
  exports: Record<string, unknown>;
  description: string;
};

// Collapse comment markers and whitespace so a rule reflowed across lines still matches.
const prose = (proto: string) => proto.replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ');

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

  it('keeps the deferred Resync and Ack out of the wire and says so', () => {
    expect(prose(sync)).toMatch(/Resync|prune/);
    expect(sync).not.toMatch(/rpc (Resync|Ack)\(/);
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
});

describe('package', () => {
  it('is 0.2.0', () => {
    expect(pkg.version).toBe('0.2.0');
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
