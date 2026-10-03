import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANNOTATIONS, RETIRED_SCHEMAS, checkSchemaGrowth, main, schemaGrowthViolations } from '../scripts/schema-growth.js';

// A closed object schema, the shape every payload schema here has.
const closed = <P extends Record<string, object>>(properties: P, required: string[] = Object.keys(properties)) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});
const DISPOSAL = closed(
  {
    reason: { enum: ['sold', 'traded'] },
    price: {
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'currency'],
      properties: { amount: { type: 'string' }, currency: { type: 'string' } },
    },
    edited_at: { type: 'string' },
  },
  ['reason', 'edited_at'],
);
const edit = (f: (s: typeof DISPOSAL) => void) => {
  const s = structuredClone(DISPOSAL);
  f(s);
  return s;
};

describe('schemaGrowthViolations: a published payload schema never gains a property', () => {
  it('passes the same schema, and changed annotations, which no validator reads', () => {
    expect(ANNOTATIONS).toEqual(['title', 'description', '$comment', 'examples']);
    expect(schemaGrowthViolations('d.json', DISPOSAL, structuredClone(DISPOSAL))).toEqual([]);
    const reworded = edit((s) => {
      Object.assign(s.properties.edited_at, { description: 'when', title: 'Edited at', $comment: 'display only', examples: ['2026-10-01T09:00:00Z'] });
      Object.assign(s, { description: 'a disposal' });
    });
    expect(schemaGrowthViolations('d.json', DISPOSAL, reworded)).toEqual([]);
  });

  it('flags a changed type, bound, pattern, format or const, added or removed', () => {
    const SCORE = closed({ score: { type: 'integer', minimum: 1, maximum: 10 }, at: { type: 'string', pattern: '^\\d{4}$', format: 'date', maxLength: 64 }, v: { const: 1 } });
    const change = (f: (s: typeof SCORE) => void) => {
      const s = structuredClone(SCORE);
      f(s);
      return schemaGrowthViolations('s.json', SCORE, s);
    };
    expect(change((s) => Object.assign(s.properties.score, { type: 'number', maximum: 100 }))).toEqual([
      's.json: /properties/score changed maximum from 10 to 100',
      's.json: /properties/score changed type from "integer" to "number"',
    ]);
    expect(change((s) => Object.assign(s.properties.at, { pattern: '^.*$', format: 'date-time', maxLength: 65, minLength: 1 }))).toEqual([
      's.json: /properties/at changed format from "date" to "date-time"',
      's.json: /properties/at changed maxLength from 64 to 65',
      's.json: /properties/at changed minLength from absent to 1',
      's.json: /properties/at changed pattern from "^\\\\d{4}$" to "^.*$"',
    ]);
    expect(change((s) => {
      delete (s.properties.score as { minimum?: number }).minimum;
      Object.assign(s.properties.v, { const: 2 });
    })).toEqual(['s.json: /properties/score changed minimum from 1 to absent', 's.json: /properties/v changed const from 1 to 2']);
  });

  it('flags a pattern property added or removed, whatever its body', () => {
    const typed = edit((s) => Object.assign(s, { patternProperties: { '^fx$': { type: 'string' } } }));
    const anyXKey = edit((s) => Object.assign(s, { patternProperties: { '^x-': {} } }));
    expect(schemaGrowthViolations('d.json', DISPOSAL, typed)).toEqual(['d.json: / gained patternProperties ^fx$']);
    expect(schemaGrowthViolations('d.json', DISPOSAL, anyXKey)).toEqual(['d.json: / gained patternProperties ^x-']);
    expect(schemaGrowthViolations('d.json', typed, DISPOSAL)).toEqual(['d.json: / lost patternProperties ^fx$', 'd.json: /patternProperties/^fx$ is gone']);
  });

  it('flags any new subschema, not only one that declares properties', () => {
    const negated = edit((s) => Object.assign(s.properties.edited_at, { not: { const: '' } }));
    const either = edit((s) => Object.assign(s, { anyOf: [{}, true] }));
    expect(schemaGrowthViolations('d.json', DISPOSAL, negated)).toEqual(['d.json: /properties/edited_at/not is new']);
    expect(schemaGrowthViolations('d.json', DISPOSAL, either)).toEqual(['d.json: /anyOf/0 is new', 'd.json: /anyOf/1 is new']);
  });

  it('flags a boolean subschema that changed, and passes one that did not', () => {
    const before = { type: 'array', items: false };
    expect(schemaGrowthViolations('a.json', before, { type: 'array', items: true })).toEqual(['a.json: /items changed from false to true']);
    expect(schemaGrowthViolations('a.json', before, structuredClone(before))).toEqual([]);
  });

  it('compares an additionalProperties schema at its own path', () => {
    const before = { type: 'object', additionalProperties: { type: 'string' } };
    expect(schemaGrowthViolations('m.json', before, structuredClone(before))).toEqual([]);
    expect(schemaGrowthViolations('m.json', before, { type: 'object', additionalProperties: { type: 'integer' } })).toEqual([
      'm.json: /additionalProperties changed type from "string" to "integer"',
    ]);
    expect(schemaGrowthViolations('m.json', before, { type: 'object', additionalProperties: true })).toEqual([
      'm.json: / changed additionalProperties from {"type":"string"} to true',
      'm.json: /additionalProperties is gone',
    ]);
  });

  it('flags a property added at the top level', () => {
    const grown = edit((s) => Object.assign(s.properties, { fx: { type: 'string' } }));
    expect(schemaGrowthViolations('d.json', DISPOSAL, grown)).toEqual(['d.json: / gained properties fx']);
  });

  it('flags a property added inside a nested object', () => {
    const grown = edit((s) => Object.assign(s.properties.price.properties, { fx: { type: 'string' } }));
    expect(schemaGrowthViolations('d.json', DISPOSAL, grown)).toEqual(['d.json: /properties/price gained properties fx']);
  });

  it('flags a property removed, and the path under it', () => {
    const shrunk = edit((s) => {
      delete (s.properties as Record<string, unknown>).price;
    });
    expect(schemaGrowthViolations('d.json', DISPOSAL, shrunk)).toEqual([
      'd.json: / lost properties price',
      'd.json: /properties/price is gone',
    ]);
  });

  it('flags a changed required set, in either direction', () => {
    const more = edit((s) => s.required.push('price'));
    const fewer = edit((s) => s.required.splice(0, 1));
    expect(schemaGrowthViolations('d.json', DISPOSAL, more)).toEqual(['d.json: / required gained price']);
    expect(schemaGrowthViolations('d.json', DISPOSAL, fewer)).toEqual(['d.json: / required lost reason']);
  });

  it('lets an enum grow and flags one that shrinks', () => {
    const grown = edit((s) => s.properties.reason.enum.push('gifted'));
    const shrunk = edit((s) => s.properties.reason.enum.pop());
    expect(schemaGrowthViolations('d.json', DISPOSAL, grown)).toEqual([]);
    expect(schemaGrowthViolations('d.json', DISPOSAL, shrunk)).toEqual(['d.json: /properties/reason enum lost "traded"']);
  });

  it('flags an enum gained where there was none: an absent enum accepts every value, so a new one narrows', () => {
    const SCORE = closed({ score: { type: 'integer', minimum: 1, maximum: 10 } });
    const narrowed = structuredClone(SCORE);
    Object.assign(narrowed.properties.score, { enum: [5, 6, 7] });
    expect(schemaGrowthViolations('s.json', SCORE, narrowed)).toEqual(['s.json: /properties/score gained enum 5, 6, 7']);
    const atTop = edit((s) => Object.assign(s, { enum: [{ reason: 'sold', edited_at: 'x' }] }));
    expect(schemaGrowthViolations('d.json', DISPOSAL, atTop)).toEqual(['d.json: / gained enum {"reason":"sold","edited_at":"x"}']);
  });

  it('flags a schema that is no longer closed', () => {
    const opened = edit((s) => Object.assign(s, { additionalProperties: true }));
    const unset = edit((s) => {
      delete (s as Record<string, unknown>).additionalProperties;
    });
    expect(schemaGrowthViolations('d.json', DISPOSAL, opened)).toEqual(['d.json: / is no longer closed (additionalProperties false)']);
    expect(schemaGrowthViolations('d.json', DISPOSAL, unset)).toEqual(['d.json: / is no longer closed (additionalProperties false)']);
  });

  it('flags properties smuggled in through a new subschema', () => {
    const smuggled = edit((s) => Object.assign(s, { anyOf: [{ properties: { fx: { type: 'string' } } }] }));
    expect(schemaGrowthViolations('d.json', DISPOSAL, smuggled)).toEqual(['d.json: /anyOf/0 is new and declares properties or required']);
  });

  it('walks items, $defs and every combinator', () => {
    const before = { $defs: { a: closed({ x: {} }) }, items: closed({ y: {} }), oneOf: [closed({ z: {} })], not: closed({ w: {} }) };
    const after = structuredClone(before);
    Object.assign(after.$defs.a.properties, { x2: {} });
    Object.assign(after.items.properties, { y2: {} });
    Object.assign(after.oneOf[0]!.properties, { z2: {} });
    Object.assign(after.not.properties, { w2: {} });
    expect(schemaGrowthViolations('t.json', before, after)).toEqual([
      't.json: /$defs/a gained properties x2',
      't.json: /items gained properties y2',
      't.json: /not gained properties w2',
      't.json: /oneOf/0 gained properties z2',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The whole check against a real git history: the baseline is the previous v* tag, chosen by
// scripts/buf-breaking.sh --print-baseline, so both guards compare against the same release.
// ---------------------------------------------------------------------------
let repo: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
const writeSchema = (name: string, schema: object) => {
  mkdirSync(join(repo, 'schemas'), { recursive: true });
  writeFileSync(join(repo, 'schemas', name), `${JSON.stringify(schema, null, 2)}\n`);
};
const commit = (msg: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', msg);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'fc-schema-growth-'));
  git(repo, 'init', '-q', '-b', 'develop');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('checkSchemaGrowth', () => {
  it('skips cleanly when no earlier v* tag exists', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    expect(checkSchemaGrowth(repo)).toEqual({ baseline: undefined, checked: [], violations: [] });
  });

  it('passes when every published schema kept its properties, and ignores one no tag has published', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    writeSchema('occ-disposal.schema.json', edit((s) => s.properties.reason.enum.push('gifted')));
    writeSchema('tag-name.schema.json', closed({ name: {}, color: {} }));
    commit('two');
    expect(checkSchemaGrowth(repo)).toEqual({ baseline: 'v0.1.0', checked: ['occ-disposal.schema.json'], violations: [] });
  });

  it('fails when a published schema gained a property, naming the file and the path', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');
    writeSchema('occ-disposal.schema.json', edit((s) => Object.assign(s.properties.price.properties, { fx: {} })));
    expect(checkSchemaGrowth(repo).violations).toEqual(['occ-disposal.schema.json: /properties/price gained properties fx']);
  });

  it('compares against the previous tag, never the release being cut', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    writeSchema('occ-disposal.schema.json', edit((s) => Object.assign(s.properties, { fx: {} })));
    commit('two');
    git(repo, 'tag', 'v0.2.0'); // HEAD: the tag being released is excluded from the baseline
    expect(checkSchemaGrowth(repo)).toMatchObject({ baseline: 'v0.1.0', violations: ['occ-disposal.schema.json: / gained properties fx'] });
  });

  it('fails when a published schema was removed, unless it is listed as retired', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    writeSchema('holding-status.schema.json', closed({ status: {} }));
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    rmSync(join(repo, 'schemas', 'occ-disposal.schema.json'));
    rmSync(join(repo, 'schemas', 'holding-status.schema.json'));
    commit('two');
    expect(checkSchemaGrowth(repo).violations).toEqual(['occ-disposal.schema.json: removed; a published schema is only ever retired, by name, in RETIRED_SCHEMAS']);
  });

  it('fails loudly in a shallow clone instead of skipping for the wrong reason', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');
    const shallow = mkdtempSync(join(tmpdir(), 'fc-schema-growth-shallow-'));
    rmSync(shallow, { recursive: true, force: true });
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${repo}`, shallow);
    try {
      expect(() => checkSchemaGrowth(shallow)).toThrow(/shallow/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe('main', () => {
  const run = (cwd: string) => {
    const out: string[] = [];
    const code = main(cwd, (line) => out.push(line));
    return { code, out: out.join('\n') };
  };

  it('exits 0 and says what it checked when clean', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');
    expect(run(repo)).toEqual({ code: 0, out: 'Schema growth against v0.1.0: every published schema is unchanged but for annotations and enum growth (1 checked).' });
  });

  it('exits 0 with a skip note when there is no earlier tag', () => {
    commit('one');
    expect(run(repo)).toEqual({ code: 0, out: 'No v* tag to compare against: first release. Skipping the schema growth check.' });
  });

  it('exits 1 and prints every violation', () => {
    writeSchema('occ-disposal.schema.json', DISPOSAL);
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');
    writeSchema('occ-disposal.schema.json', edit((s) => Object.assign(s.properties, { fx: {} })));
    const { code, out } = run(repo);
    expect(code).toBe(1);
    expect(out).toContain('occ-disposal.schema.json: / gained properties fx');
    expect(out).toMatch(/A published payload schema never gains a property or changes what it accepts; a new attribute is a new facet key/);
  });

  it('exits 1 with the reason when the baseline cannot be found', () => {
    const shallow = mkdtempSync(join(tmpdir(), 'fc-schema-growth-shallow-'));
    rmSync(shallow, { recursive: true, force: true });
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${repo}`, shallow);
    try {
      const { code, out } = run(shallow);
      expect(code).toBe(1);
      expect(out).toMatch(/shallow/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe('this repository', () => {
  it('says in the script header what is allowed: annotations and enum growth, never a narrowing', () => {
    const header = readFileSync(new URL('../scripts/schema-growth.ts', import.meta.url), 'utf8').split('\nimport ')[0]!.replace(/\/\/ /g, '').replace(/\s+/g, ' ');
    expect(header).not.toMatch(/never changes what it accepts/);
    expect(header).toMatch(/never narrows what it accepts/);
    expect(header).toMatch(/an enum may only grow, and none may be added where there was none/);
  });

  it('retires only the 0.2.x holding schemas, each with its reason', () => {
    expect(Object.keys(RETIRED_SCHEMAS).sort()).toEqual(['holding-count.schema.json', 'holding-status.schema.json']);
    for (const why of Object.values(RETIRED_SCHEMAS)) expect(why).toMatch(/0\.3\.0/);
  });
});
