import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.js';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const publishYml = read('.github/workflows/publish.yml');
const buildYml = read('.github/workflows/build.yml');

// Index of a step's `- name:` line, or -1. Steps run in file order and a failed
// step fails the job, so ordering in the file IS the gate ordering.
const stepIndex = (yaml: string, name: string) => yaml.indexOf(`- name: ${name}`);

describe('publish workflow — provenance (finding A)', () => {
  it('never runs the attestation unconditionally on this private repo', () => {
    const attestAt = publishYml.indexOf('attest-build-provenance');
    if (attestAt === -1) return; // dropped entirely is also a valid fix

    // GitHub artifact attestations require Enterprise Cloud for private or
    // internal repositories. FigureCollecting is on the free plan and this repo
    // is private, so an ungated step fails the release before `npm publish`.
    const block = publishYml.slice(Math.max(0, attestAt - 600), attestAt);
    expect(block).toMatch(/if:\s*github\.event\.repository\.visibility == 'public'/);
  });
});

describe('publish workflow — the gate must exist (finding B)', () => {
  const publishAt = () => stepIndex(publishYml, 'Publish to GitHub Packages');

  it('has a publish step to gate', () => {
    expect(publishAt()).toBeGreaterThan(-1);
  });

  it.each([
    ['buf lint', 'buf lint'],
    ['Typecheck', 'typecheck'],
    ['Build', 'build'],
    ['Test with coverage', 'test:ci'],
    ['buf breaking (against the previous release tag)', 'breaking'],
  ])('runs %s before publishing', (stepName) => {
    const at = stepIndex(publishYml, stepName);
    expect(at, `step "${stepName}" is missing from publish.yml`).toBeGreaterThan(-1);
    expect(at).toBeLessThan(publishAt());
  });

  it('makes no claim that prepublishOnly runs during pack or tarball publish', () => {
    // It does not: prepublishOnly fires on `npm publish` from a DIRECTORY, not
    // on `npm pack` and not on `npm publish <tarball>`. A documented gate that
    // does not exist is worse than no gate.
    expect(publishYml).not.toMatch(/prepublishOnly[^\n]*(also runs|runs during|npm pack)/i);
    expect(publishYml).not.toMatch(/prepublishOnly runs `npm run breaking`/);
  });
});

describe('build workflow', () => {
  it('fetches full history so the breaking baseline can be found', () => {
    // With the default shallow fetch `git tag` is empty and the breaking check
    // skips on a repo that does have releases — passing for the wrong reason.
    expect(buildYml).toMatch(/fetch-depth: 0/);
  });

  it('names the breaking baseline as the previous tag, not the latest', () => {
    // The latest tag IS the release at tag-push time; the script excludes tags
    // on HEAD, and the step name has to say what it actually does.
    expect(buildYml).toContain('buf breaking (against the previous release tag)');
    expect(buildYml).not.toContain('against the last release tag');
  });

  it('gates both entry jobs with the fork shift-left expression', () => {
    const gates = buildYml.match(/github\.event_name != 'push'/g) ?? [];
    expect(gates.length).toBe(2);
  });
});

describe('coverage gate (finding G)', () => {
  const thresholds = vitestConfig.test?.coverage?.thresholds as
    | Record<string, number | boolean>
    | undefined;

  it('declares thresholds in the runner config, not only on the command line', () => {
    expect(thresholds).toBeDefined();
  });

  it.each(['lines', 'branches', 'functions', 'statements'])(
    'enforces at least 85%% on %s',
    (metric) => {
      expect(typeof thresholds?.[metric]).toBe('number');
      expect(thresholds?.[metric] as number).toBeGreaterThanOrEqual(85);
    },
  );

  it('applies the thresholds per file, so one untested new file cannot hide in the pool', () => {
    // Global-only thresholds dilute: as the generated pool grows, a small
    // untested hand-written file stops moving the aggregate. Per-file is what
    // keeps the gate able to fail.
    expect(thresholds?.perFile).toBe(true);
  });

  it('measures the code the package actually ships', () => {
    expect(vitestConfig.test?.coverage?.provider).toBe('v8');
    expect(vitestConfig.test?.coverage?.include).toContain('src/**/*.ts');
  });
});
