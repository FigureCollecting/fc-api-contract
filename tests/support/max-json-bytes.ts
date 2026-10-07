// Upper bound on JSON.stringify output for the JSON Schema subset the payload schemas use.

export interface Schema {
  description?: string;
  type?: string;
  enum?: unknown[];
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  additionalProperties?: unknown;
  items?: Schema;
  maxItems?: number;
}
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

// What one pattern atom can match: at most `chars` characters, and whether every one of them is
// JSON-safe ASCII (0x20-0x7E but '"' and '\'), which JSON.stringify writes as one byte.
export interface Span {
  chars: number;
  ascii: boolean;
}
const SAFE = (c: number) => c >= 0x20 && c <= 0x7e && c !== 0x22 && c !== 0x5c;

// Longest string an anchored JSON Schema pattern admits, for the regex subset the schemas use.
// Anything outside the subset throws, so a new construct fails this test instead of passing it.
export function patternSpan(pattern: string): Span {
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$')) return { chars: Infinity, ascii: false };
  const src = pattern.slice(1, -1);
  let i = 0;
  const escape = (): Span & { code?: number } => {
    const e = src[i++]!;
    if (e === 'd' || e === 'w') return { chars: 1, ascii: true };
    if (/[A-Za-z0-9]/.test(e)) throw new SyntaxError(`unsupported escape \\${e} in ${pattern}`);
    return { chars: 1, ascii: SAFE(e.charCodeAt(0)), code: e.charCodeAt(0) };
  };
  const charClass = (): Span => {
    let ascii = src[i] !== '^';
    if (!ascii) i++;
    for (let first = true; src[i] !== ']' || first; first = false) {
      if (i >= src.length) throw new SyntaxError(`unclosed class in ${pattern}`);
      const lo = src[i] === '\\' ? (i++, escape()) : { chars: 1, ascii: SAFE(src.charCodeAt(i)), code: src.charCodeAt(i++) };
      if (src[i] === '-' && src[i + 1] !== ']' && lo.code !== undefined) {
        i++;
        const hi = src[i] === '\\' ? (i++, escape()) : { code: src.charCodeAt(i++) };
        if (hi.code === undefined) throw new SyntaxError(`class range to a class in ${pattern}`);
        for (let c = lo.code; c <= hi.code; c++) ascii &&= SAFE(c);
      } else ascii &&= lo.ascii;
    }
    i++;
    return { chars: 1, ascii };
  };
  const quantified = (atom: Span): Span => {
    const q = src[i];
    let times = 1;
    if (q === '?') (times = 1), i++;
    else if (q === '*' || q === '+') (times = Infinity), i++;
    else if (q === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m === null) throw new SyntaxError(`bad quantifier in ${pattern}`);
      times = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]);
      i += m[0].length;
    }
    return { chars: atom.chars === 0 ? 0 : atom.chars * times, ascii: atom.ascii };
  };
  let topLevelAlternation = false;
  const alternation = (depth: number): Span => {
    const branches: Span[] = [];
    for (;;) {
      const seq: Span = { chars: 0, ascii: true };
      while (i < src.length && src[i] !== '|' && src[i] !== ')') {
        const c = src[i++]!;
        let atom: Span;
        if (c === '\\') atom = escape();
        else if (c === '[') atom = charClass();
        else if (c === '(') {
          if (src.startsWith('?:', i)) i += 2;
          atom = alternation(depth + 1);
          if (src[i++] !== ')') throw new SyntaxError(`unclosed group in ${pattern}`);
        } else if (c === '.') atom = { chars: 1, ascii: false };
        else if ('^$)|*+?{'.includes(c)) throw new SyntaxError(`unsupported '${c}' in ${pattern}`);
        else atom = { chars: 1, ascii: SAFE(c.charCodeAt(0)) };
        const q = quantified(atom);
        seq.chars += q.chars;
        seq.ascii &&= q.ascii;
      }
      branches.push(seq);
      if (src[i] !== '|') break;
      if (depth === 0) topLevelAlternation = true;
      i++;
    }
    return { chars: Math.max(...branches.map((b) => b.chars)), ascii: branches.every((b) => b.ascii) };
  };
  const top = alternation(0);
  if (i !== src.length) throw new SyntaxError(`unbalanced ')' in ${pattern}`);
  // '^a|b$' anchors each branch at one end only, so a top-level alternation bounds nothing.
  return topLevelAlternation ? { chars: Infinity, ascii: false } : top;
}

// The most bytes JSON.stringify can write for any value the schema admits; Infinity when nothing
// bounds it. Every property counts, optional or not, and six bytes is the most one code point costs.
export function maxJsonBytes(s: Schema): number {
  if (s.enum !== undefined) return Math.max(...s.enum.map((v) => utf8(JSON.stringify(v))));
  if (s.type === 'object') {
    if (s.additionalProperties !== false) return Infinity;
    const props = Object.entries(s.properties ?? {});
    const members = props.reduce((n, [k, v]) => n + utf8(JSON.stringify(k)) + 1 + maxJsonBytes(v), 0);
    return 2 + Math.max(0, props.length - 1) + members;
  }
  if (s.type === 'string') {
    const span = s.pattern === undefined ? { chars: Infinity, ascii: false } : patternSpan(s.pattern);
    const chars = Math.min(s.maxLength ?? Infinity, span.chars);
    return 2 + chars * (span.ascii ? 1 : 6);
  }
  if (s.type === 'integer' && s.minimum !== undefined && s.maximum !== undefined)
    return Math.max(String(s.minimum).length, String(s.maximum).length);
  if (s.type === 'boolean') return 5;
  if (s.type === 'array') {
    if (s.maxItems === undefined || s.items === undefined) return Infinity;
    return 2 + s.maxItems * maxJsonBytes(s.items) + Math.max(0, s.maxItems - 1);
  }
  return Infinity;
}
