// A published payload schema never gains a property (sync.proto rule 6). For every schema the previous
// v* tag published, the recursive properties and required sets must be unchanged and a closed object must
// stay closed; an enum may only grow. buf breaking guards the protos; this guards schemas/ the same way,
// against the same baseline (scripts/buf-breaking.sh --print-baseline). Run: node scripts/schema-growth.ts
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

// Every subschema, keyed by its path: properties and the other name maps, the single-schema keywords
// and the schema lists.
function walk(schema: unknown, path: string, out: Map<string, Json>): Map<string, Json> {
  if (!isObject(schema)) return out;
  out.set(path, schema);
  const at = (step: string) => `${path === '/' ? '' : path}/${step}`;
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    for (const name of names(schema[key])) walk((schema[key] as Json)[name], at(`${key}/${name}`), out);
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) walk(schema[key], at(key), out);
  for (const key of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) items(schema[key]).forEach((sub, i) => walk(sub, at(`${key}/${i}`), out));
  return out;
}

/** What `after` changed about `before` that a published schema may not change, one line each. */
export function schemaGrowthViolations(file: string, before: unknown, after: unknown): string[] {
  const old = walk(before, '/', new Map());
  const now = walk(after, '/', new Map());
  const out: string[] = [];
  const reported: string[] = [];
  for (const path of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    if (reported.some((p) => path.startsWith(`${p}/`))) continue; // said once, at the top of the subtree
    const say = (what: string) => out.push(`${file}: ${path} ${what}`);
    const a = old.get(path);
    const b = now.get(path);
    if (a === undefined || b === undefined) {
      if (b === undefined) say('is gone');
      else if (b.properties !== undefined || b.required !== undefined) say('is new and declares properties or required');
      reported.push(path);
      continue;
    }
    const gained = missing(names(b.properties), names(a.properties));
    const lost = missing(names(a.properties), names(b.properties));
    if (gained.length > 0) say(`gained properties ${gained.join(', ')}`);
    if (lost.length > 0) say(`lost properties ${lost.join(', ')}`);
    const required = missing(items(b.required), items(a.required));
    const unrequired = missing(items(a.required), items(b.required));
    if (required.length > 0) say(`required gained ${required.join(', ')}`);
    if (unrequired.length > 0) say(`required lost ${unrequired.join(', ')}`);
    const enumLost = missing(items(a.enum), items(b.enum));
    if (enumLost.length > 0) say(`enum lost ${enumLost.map((x) => JSON.stringify(x)).join(', ')}`);
    if (a.additionalProperties === false && b.additionalProperties !== false) say('is no longer closed (additionalProperties false)');
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

/** The CLI: 0 when every published schema kept its properties (or there is no baseline), 1 otherwise. */
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
    log(`Schema growth against ${result.baseline}: every published schema kept its properties (${result.checked.length} checked).`);
    return 0;
  }
  for (const line of result.violations) log(line);
  log(`A published payload schema never gains a property; a new attribute is a new facet key (sync.proto rule 6). Baseline: ${result.baseline}.`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
