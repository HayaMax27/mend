// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old path, new path) pairs, for the R rows (SPEC.md section 2). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** One line matches another at a tier (SPEC.md section 5). */
function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions i where O matches lines[i..] at the tier, at or after `from`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!matchLine(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    let pos = occurrences(lines, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to `target` at the first tier where one is. */
function findSingleLine(lines: string[], target: string, from: number, strict: boolean): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (matchLine(lines[i]!, target, t)) return i;
    }
  }
  return null;
}

/** One line of a hunk or chunk body: context, old, or new. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

interface OldLine {
  text: string;
  ctx: boolean;
}
interface NewLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Split body lines into the old lines O and the new lines N (SPEC.md section 5). */
function splitBody(items: BodyLine[]): { o: OldLine[]; n: NewLine[] } {
  const o: OldLine[] = [];
  const n: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'old') o.push({ text: it.text, ctx: it.kind === 'ctx' });
    if (it.kind === 'ctx' || it.kind === 'new') n.push({ text: it.text, ctx: it.kind === 'ctx', oIndex: it.kind === 'ctx' ? o.length - 1 : -1 });
  }
  return { o, n };
}

/** The lines that replace O at `pos`: context lines are the file's own, others re-indented at tier 2. */
function buildReplacement(lines: string[], o: OldLine[], pos: number, tier: number, n: NewLine[]): string[] {
  const f = leadingWs(lines[pos]!);
  const p = leadingWs(o[0]!.text);
  return n.map((it) => {
    if (it.ctx) return lines[pos + it.oIndex]!;
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return it.text;
  });
}

/** Replace O at `pos` by N in the file model. */
function applyReplace(f: FileModel, pos: number, o: OldLine[], n: NewLine[], tier: number): void {
  f.lines.splice(pos, o.length, ...buildReplacement(f.lines, o, pos, tier, n));
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** The path of a `--- ` or `+++ ` line (SPEC.md section 6). */
function unifiedPath(line: string): string {
  const p = line.slice(4).split('\t')[0]!.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

interface Hunk {
  a: number;
  items: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterLastCtxNew: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAfterLastNew: boolean;
}

/** Parse a unified hunk body starting at `start`; returns the hunk and the next line index. */
function parseHunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  type Tok = { t: 'line'; kind: 'ctx' | 'old' | 'new'; text: string } | { t: 'bs' };
  const toks: Tok[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      toks.push({ t: 'line', kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1) });
      j++;
    } else if (l.startsWith('\\')) {
      toks.push({ t: 'bs' });
      j++;
    } else if (l === '') {
      toks.push({ t: 'line', kind: 'ctx', text: '' });
      j++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (toks.length > 0) {
    const last = toks[toks.length - 1]!;
    if (last.t === 'line' && last.kind === 'ctx' && last.text === '') toks.pop();
    else break;
  }
  let lastCtxNew = -1;
  let lastNew = -1;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]!;
    if (tok.t === 'line' && (tok.kind === 'ctx' || tok.kind === 'new')) lastCtxNew = k;
    if (tok.t === 'line' && tok.kind === 'new') lastNew = k;
  }
  const items: BodyLine[] = [];
  for (const tok of toks) {
    if (tok.t === 'line') items.push({ kind: tok.kind, text: tok.text });
  }
  return {
    hunk: {
      a,
      items,
      bsAfterLastCtxNew: lastCtxNew >= 0 && toks[lastCtxNew + 1]?.t === 'bs',
      bsAfterLastNew: lastNew >= 0 && toks[lastNew + 1]?.t === 'bs',
    },
    next: j,
  };
}

/** Apply one unified hunk to the file; returns the new d (SPEC.md section 6). */
function applyUnifiedHunk(f: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n } = splitBody(hunk.items);
  if (o.length === 0) {
    const at = Math.min(hunk.a + d, f.lines.length);
    const atEnd = at === f.lines.length;
    f.lines.splice(at, 0, ...n.map((x) => x.text));
    if (atEnd) f.final = !hunk.bsAfterLastCtxNew;
    return d + n.length;
  }
  const found = findTier(f.lines, o.map((x) => x.text), strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const endsAtEnd = best + o.length === f.lines.length;
  applyReplace(f, best, o, n, found.tier);
  if (endsAtEnd) f.final = !hunk.bsAfterLastCtxNew;
  return d + (n.length - o.length);
}

interface RawSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | undefined;
  pairNew: string | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** One unified section as one edit (SPEC.md section 6). */
function unifiedSectionEdit(s: RawSection, strict: boolean): Edit {
  const pick = (pair: string | undefined, rename: string | undefined, git: string | undefined): string | null | undefined => {
    const v = pair !== undefined ? pair : rename !== undefined ? rename : git;
    return v === undefined ? undefined : v === '/dev/null' ? null : v;
  };
  const oldRaw = pick(s.pairOld, s.renameOld, s.gitOld);
  const newRaw = pick(s.pairNew, s.renameNew, s.gitNew);
  const oldPath: string | null = oldRaw === undefined ? null : oldRaw;
  const newPath: string | null = newRaw === undefined ? null : newRaw;
  if (s.isCreate || oldPath === null) {
    if (newPath === null) return () => {};
    let bsAfterLastPlus = false;
    for (let k = s.hunks.length - 1; k >= 0; k--) {
      const h = s.hunks[k]!;
      if (h.items.some((it) => it.kind === 'new')) {
        bsAfterLastPlus = h.bsAfterLastNew;
        break;
      }
    }
    const plus = s.hunks.flatMap((h) => h.items.filter((it) => it.kind === 'new').map((it) => it.text));
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (bsAfterLastPlus ? '' : '\n'));
    };
  }
  if (s.isDelete || newPath === null) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const f = splitFile(before);
      let d = 0;
      for (const hunk of s.hunks) d = applyUnifiedHunk(f, hunk, d, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(f));
      tree.moves.push([oldPath, newPath]);
    };
  }
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const f = splitFile(before);
    let d = 0;
    for (const hunk of s.hunks) d = applyUnifiedHunk(f, hunk, d, strict, oldPath);
    tree.now.set(oldPath, joinFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  const fresh = (): RawSection => ({
    gitOld: undefined,
    gitNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let cur: RawSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = fresh();
        sections.push(cur);
        inHeader = true;
      }
      cur.pairOld = unifiedPath(l);
      cur.pairNew = unifiedPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i + 1, Number(m[1]));
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.pairNew = unifiedPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const o: OldLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    applyReplace(f, found.positions[0]!, o, n, found.tier);
    tree.now.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

const isV4ASectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyLine[];
}

/** Split an Update File section's lines into chunks (SPEC.md section 8). `base` is the 0-based patch index of raw[0]. */
function parseV4AChunks(raw: string[], base: number): V4AChunk[] {
  const chunks: V4AChunk[] = [];
  const lineNo = (idx: number): number => base + idx + 1;
  let k = 0;
  while (k < raw.length) {
    const cl = raw[k]!;
    if (blank(cl) && chunks.length > 0) {
      k++;
      continue;
    }
    let anchor: string | null = null;
    if (cl.startsWith('@@')) {
      const a = cl.slice(2).trim();
      anchor = a === '' ? null : a;
      k++;
    } else if (chunks.length > 0) {
      throw new Exit2(`error: parse ${lineNo(k)}`);
    }
    const items: BodyLine[] = [];
    let eof = false;
    while (k < raw.length) {
      const bl = raw[k]!;
      if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
        items.push({ kind: bl[0] === ' ' ? 'ctx' : bl[0] === '-' ? 'old' : 'new', text: bl.slice(1) });
        k++;
      } else if (bl === '') {
        items.push({ kind: 'ctx', text: '' });
        k++;
      } else if (bl === '*** End of File') {
        eof = true;
        k++;
        break;
      } else if (bl.startsWith('@@')) {
        break;
      } else {
        throw new Exit2(`error: parse ${lineNo(k)}`);
      }
    }
    chunks.push({ anchor, eof, items });
  }
  return chunks;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(f.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitBody(chunk.items);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
      } else {
        const found = findTier(f.lines, o.map((x) => x.text), strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        applyReplace(f, pos, o, n, found.tier);
        cursor = pos + n.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const start = i;
      let j = i + 1;
      const raw: string[] = [];
      while (j < last && !isV4ASectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const sl = raw[k]!;
        if (sl.startsWith('+')) fileLines.push(sl.slice(1));
        else if (sl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${start + k + 2}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4ASectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const rawStart = j;
      const raw: string[] = [];
      while (j < last && !isV4ASectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const chunks = parseV4AChunks(raw, rawStart);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  // A move is an R row when the old path existed before and is gone after, and the new path did
  // not exist before and is there after; it replaces that pair's D and A rows and sorts by <new>.
  const renames: Array<[string, string]> = [];
  for (const [oldP, newP] of tree.moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) renames.push([oldP, newP]);
  }
  const renamedOld = new Set(renames.map(([o]) => o));
  const renamedNew = new Set(renames.map(([, n]) => n));
  const rows: Array<{ key: string; text: string }> = [];
  for (const [oldP, newP] of renames) rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  for (const p of [...tree.now.keys()].sort(byPath)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && renamedOld.has(p)) continue;
    if (was === null && renamedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byPath(a.key, b.key));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byPath)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
