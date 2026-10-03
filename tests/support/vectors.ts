// golden/import-vectors.json, typed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Copy, ReimportCase, ReimportResult } from './reimport-model.js';
import type { ReviewEnd, ScenarioEnd, Step } from './trace-runner.js';

export interface Vectors {
  serverScenarios: { id: string; name: string; rank: Record<string, string>; steps: Step[]; expect: ScenarioEnd }[];
  reimports: (ReimportCase & {
    expect: {
      copies: Copy[];
      figures: ReimportResult['figures'];
      writes: string[];
      conflicts: string[];
      unresolved: { line: number; reason: string }[];
    };
  })[];
  review: { name: string; rule: string; steps: Step[]; expect: ReviewEnd }[];
}

export const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../golden/import-vectors.json', import.meta.url)), 'utf8')) as Vectors;
