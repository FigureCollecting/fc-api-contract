// A published payload schema never gains a property (sync.proto rule 6), and never narrows what it accepts. For
// every schema the previous v* tag published, every keyword must be unchanged at every depth except the
// ANNOTATIONS, which no validator reads, and an enum: an enum may only grow, and none may be added where there was
// none (an absent enum accepts every value). No property, pattern property or subschema is added or removed, a
// closed object stays closed, and no type, bound, pattern or format changes.
// buf breaking guards the protos; this guards schemas/ the same way, against the same baseline
// (scripts/buf-breaking.sh --print-baseline). Run: node scripts/schema-growth.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Schemas deliberately retired, by file name, with the release and the reason. Nothing else may disappear. */
export const RETIRED_SCHEMAS: Readonly<Record<string, string>> = {
  'holding-status.schema.json': '0.3.0 retired the per-figure holding grain for per-copy occurrences (sync.proto rule 6)',
  'holding-count.schema.json': '0.3.0 retired the per-figure holding grain for per-copy occurrences (sync.proto rule 6)',
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const names = (v: unknown): string[] => (isObject(v) ? Object.keys(v) : []);
const items = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const missing = <T>(from: T[], within: T[]) => from.filter((x) => !within.some((y) => JSON.stringify(y) === JSON.stringify(x)));

/** The only keywords a published schema may change: annotations, which no validator reads. An enum may also grow. */
export const ANNOTATIONS: readonly string[] = ['title', 'description', '$comment', 'examples'];
// The keywords that hold subschemas, by name, one or a list. A subschema is compared at its own path.
const NAME_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const SINGLE = ['items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties'];
const LISTS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];

// Every subschema, boolean ones included, keyed by its path. A boolean additionalProperties is compared at its
// parent, where false means closed.
function walk(schema: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
  out.set(path, schema);
  if (!isObject(schema)) return out;
  const at = (step: string) => `${path === '/' ? '' : path}/${step}`;
  for (const key of NAME_MAPS) {
    for (const name of names(schema[key])) walk((schema[key] as Json)[name], at(`${key}/${name}`), out);
  }
  if (isObject(schema.additionalProperties)) walk(schema.additionalProperties, at('additionalProperties'), out);
  for (const key of SINGLE) if (schema[key] !== undefined) walk(schema[key], at(key), out);
  for (const key of LISTS) items(schema[key]).forEach((sub, i) => walk(sub, at(`${key}/${i}`), out));
  return out;
}

const shown = (v: unknown) => (v === undefined ? 'absent' : JSON.stringify(v));

/** What `after` changed about `before` that a published schema may not change, one line each. */
export function schemaGrowthViolations(file: string, before: unknown, after: unknown): string[] {
  const old = walk(before, '/', new Map());
  const now = walk(after, '/', new Map());
  const out: string[] = [];
  const reported: string[] = [];
  for (const path of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    if (reported.some((p) => path === p || path.startsWith(`${p}/`))) continue; // said once, at the top of the subtree
    const say = (what: string) => out.push(`${file}: ${path} ${what}`);
    const a = old.get(path);
    const b = now.get(path);
    if (!old.has(path) || !now.has(path)) {
      if (!now.has(path)) say('is gone');
      else say(isObject(b) && (b.properties !== undefined || b.required !== undefined) ? 'is new and declares properties or required' : 'is new');
      reported.push(path);
      continue;
    }
    if (!isObject(a) || !isObject(b)) {
      if (shown(a) !== shown(b)) say(`changed from ${shown(a)} to ${shown(b)}`);
      continue;
    }
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (ANNOTATIONS.includes(key) || SINGLE.includes(key) || LISTS.includes(key)) continue;
      if (NAME_MAPS.includes(key)) {
        const gained = missing(names(b[key]), names(a[key]));
        const lost = missing(names(a[key]), names(b[key]));
        if (gained.length > 0) say(`gained ${key} ${gained.join(', ')}`);
        if (lost.length > 0) say(`lost ${key} ${lost.join(', ')}`);
        for (const name of gained) reported.push(`${path === '/' ? '' : path}/${key}/${name}`);
      } else if (key === 'required') {
        const required = missing(items(b.required), items(a.required));
        const unrequired = missing(items(a.required), items(b.required));
        if (required.length > 0) say(`required gained ${required.join(', ')}`);
        if (unrequired.length > 0) say(`required lost ${unrequired.join(', ')}`);
      } else if (key === 'enum' && a.enum === undefined) {
        say(`gained enum ${items(b.enum).map((x) => JSON.stringify(x)).join(', ')}`);
      } else if (key === 'enum') {
        const enumLost = missing(items(a.enum), items(b.enum));
        if (enumLost.length > 0) say(`enum lost ${enumLost.map((x) => JSON.stringify(x)).join(', ')}`);
      } else if (key === 'additionalProperties' && a[key] === false && b[key] !== false) {
        say('is no longer closed (additionalProperties false)');
      } else if (!(key === 'additionalProperties' && isObject(a[key]) && isObject(b[key])) && shown(a[key]) !== shown(b[key])) {
        say(`changed ${key} from ${shown(a[key])} to ${shown(b[key])}`);
      }
    }
  }
  return out;
}

export interface SchemaGrowth {
  /** The previous v* tag, or undefined when there is none (a first release has nothing to keep). */
  baseline: string | undefined;
  /** The published schemas compared, by file name. */
  checked: string[];
  violations: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Compare the working tree's schemas/ with those the previous v* tag published. Throws when no baseline can be found. */
export function checkSchemaGrowth(cwd: string): SchemaGrowth {
  let baseline: string;
  try {
    baseline = execFileSync('bash', [join(HERE, 'buf-breaking.sh'), '--print-baseline'], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    const failed = e as { stdout: string; stderr: string };
    throw new Error(`${failed.stderr}${failed.stdout}`.trim());
  }
  if (!/^v\S+$/.test(baseline)) return { baseline: undefined, checked: [], violations: [] };
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const published = git('ls-tree', '--name-only', baseline, '--', 'schemas/')
    .split('\n')
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice('schemas/'.length))
    .sort();
  const checked: string[] = [];
  const violations: string[] = [];
  for (const file of published) {
    const current = join(cwd, 'schemas', file);
    if (!existsSync(current)) {
      if (RETIRED_SCHEMAS[file] === undefined) violations.push(`${file}: removed; a published schema is only ever retired, by name, in RETIRED_SCHEMAS`);
      continue;
    }
    checked.push(file);
    const before: unknown = JSON.parse(git('show', `${baseline}:schemas/${file}`));
    violations.push(...schemaGrowthViolations(file, before, JSON.parse(readFileSync(current, 'utf8'))));
  }
  return { baseline, checked, violations };
}

/** The CLI: 0 when every published schema is unchanged but for annotations and enum growth (or there is no baseline), 1 otherwise. */
export function main(cwd: string = process.cwd(), log: (line: string) => void = console.log): number {
  let result: SchemaGrowth;
  try {
    result = checkSchemaGrowth(cwd);
  } catch (e) {
    log((e as Error).message);
    return 1;
  }
  if (result.baseline === undefined) {
    log('No v* tag to compare against: first release. Skipping the schema growth check.');
    return 0;
  }
  if (result.violations.length === 0) {
    log(`Schema growth against ${result.baseline}: every published schema is unchanged but for annotations and enum growth (${result.checked.length} checked).`);
    return 0;
  }
  for (const line of result.violations) log(line);
  log(`A published payload schema never gains a property or changes what it accepts; a new attribute is a new facet key (sync.proto rule 6). Baseline: ${result.baseline}.`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
