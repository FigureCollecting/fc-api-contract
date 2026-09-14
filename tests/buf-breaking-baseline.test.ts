import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/buf-breaking.sh', import.meta.url));

let repo: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });

const commit = (msg: string) => {
  writeFileSync(join(repo, 'f.txt'), msg);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', msg);
};

/** Run the script in --print-baseline mode: it selects a tag and exits before buf. */
const baseline = (cwd = repo) => {
  try {
    return {
      out: execFileSync('bash', [SCRIPT, '--print-baseline'], { cwd, encoding: 'utf8' }).trim(),
      code: 0,
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), code: err.status ?? -1 };
  }
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'fc-breaking-'));
  git(repo, 'init', '-q', '-b', 'develop');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('breaking-check baseline selection', () => {
  it('reports no baseline in a repo with no tags', () => {
    commit('one');
    const { out, code } = baseline();

    expect(code).toBe(0);
    expect(out).toMatch(/no v\* tag/i);
  });

  it('never compares a release against itself (finding C)', () => {
    // This is the defect: at tag-push time the HIGHEST tag IS the release
    // being cut, so a naive `git tag --sort=-version:refname | head -1`
    // compares v0.2.0 with v0.2.0 and waves a contract break through.
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');
    git(repo, 'tag', 'v0.2.0');

    const { out, code } = baseline();

    expect(code).toBe(0);
    expect(out).toContain('v0.1.0');
    expect(out).not.toContain('v0.2.0');
  });

  it('reports no baseline when the only tag is the release being cut', () => {
    commit('one');
    git(repo, 'tag', 'v0.1.0');

    const { out, code } = baseline();

    expect(code).toBe(0);
    expect(out).toMatch(/no v\* tag/i);
  });

  it('picks the highest previous tag, not the most recently created one', () => {
    commit('one');
    git(repo, 'tag', 'v0.9.0');
    commit('two');
    git(repo, 'tag', 'v0.10.0'); // created later, and higher by version sort
    commit('three');
    git(repo, 'tag', 'v0.11.0'); // HEAD — excluded

    const { out } = baseline();

    expect(out).toContain('v0.10.0');
    expect(out).not.toContain('v0.9.0');
  });

  it('fails loudly in a shallow clone instead of skipping for the wrong reason', () => {
    // A shallow checkout sees no tags, so the skip path would report "first
    // release" while a real breaking change sits in the tree.
    commit('one');
    git(repo, 'tag', 'v0.1.0');
    commit('two');

    const shallow = mkdtempSync(join(tmpdir(), 'fc-breaking-shallow-'));
    rmSync(shallow, { recursive: true, force: true });
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${repo}`, shallow);

    const { out, code } = baseline(shallow);
    rmSync(shallow, { recursive: true, force: true });

    expect(code).not.toBe(0);
    expect(out).toMatch(/shallow/i);
  });
});
