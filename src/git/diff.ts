/**
 * One commit's changes to one file, as rows a side-by-side view can draw.
 * Kept free of any vscode imports so the parser can be exercised directly from
 * node, the same way graph.ts is.
 *
 * Visual Studio's commit details pane shows the whole file on both sides with
 * the changed lines picked out, not just the hunks, so the diff is read with a
 * context wide enough to swallow most files whole. A file too big for that
 * falls back to real hunks separated by gap rows.
 */

import { Git } from '../git/git';

/** A half-open `[start, end)` range of characters within a line. */
export type Span = [number, number];

export type DiffRowKind = 'same' | 'change' | 'add' | 'del' | 'gap';

/**
 * One row of the side-by-side view. A row carries a cell for each side, and
 * either may be absent: a pure addition has no left cell, a deletion no right.
 * `change` is the interesting one - both sides present and differing - and it
 * is the only kind that carries spans.
 */
export interface DiffRow {
  kind: DiffRowKind;
  oldNo: number | null;
  newNo: number | null;
  oldText: string | null;
  newText: string | null;
  /** Character ranges that differ, for the intra-line highlight. */
  oldSpans?: Span[];
  newSpans?: Span[];
  /** On a `gap` row, how many unchanged lines it stands in for. */
  skipped?: number;
}

export interface FileDiff {
  path: string;
  origPath?: string;
  /** Git refused to diff it; `rows` is empty. */
  binary: boolean;
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Runs of changed rows, which is what "N changes" counts and ↑ ↓ step through. */
  changes: number;
  /** The file was too large to show whole, so `gap` rows stand in for the rest. */
  truncated: boolean;
}

/**
 * Wide enough that an ordinary source file arrives as one hunk covering every
 * line, which is what makes the two sides scroll as complete documents.
 */
const WHOLE_FILE_CONTEXT = 100000;

/** Context used on the retry, once a file has proved too big to show whole. */
const FALLBACK_CONTEXT = 6;

/**
 * Past this the whole-file read is abandoned. A diff is held in memory three
 * times over - raw, parsed, and posted to the webview - so the cap is well
 * below what a webview will happily render.
 */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

/**
 * How many differing tokens are worth a table. Applied to what is left after
 * the shared head and tail are trimmed, so eighty is generous: an edit leaving
 * more than eighty tokens differing in the middle of one line has no word-level
 * story left to tell.
 */
const MAX_SPAN_TOKENS = 80;

/**
 * The preamble git prints for a file before its first hunk. Matched only there,
 * because every one of these can equally be the text of a changed line.
 */
const HEADER =
  /^(index |--- |\+\+\+ |old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|new file mode|deleted file mode)/;

export async function readFileDiff(
  git: Git,
  root: string,
  hash: string,
  filePath: string,
  origPath?: string
): Promise<FileDiff> {
  // A rename is only detected when both names are in the pathspec; asking for
  // the new name alone hides the old side and the file reads as freshly added.
  const paths = origPath && origPath !== filePath ? [origPath, filePath] : [filePath];

  const read = async (context: number): Promise<string> =>
    git.exec(root, [
      'show',
      '--format=',
      `-U${context}`,
      '-M',
      // Matches readCommitDetails, so the diff agrees with the file list: a
      // merge is shown against its first parent, and the root commit against
      // the empty tree rather than failing for want of a parent.
      '--first-parent',
      '--root',
      hash,
      '--',
      ...paths,
    ]);

  let truncated = false;
  let out = await read(WHOLE_FILE_CONTEXT);
  if (out.length > MAX_DIFF_BYTES) {
    truncated = true;
    out = await read(FALLBACK_CONTEXT);
  }

  const diff = parseUnifiedDiff(out);
  diff.path = filePath;
  if (origPath && origPath !== filePath) {
    diff.origPath = origPath;
  }
  diff.truncated = truncated;
  return diff;
}

/**
 * Parses `git diff -U<n>` output for a single file into aligned rows.
 *
 * Within a hunk a run of removed lines followed by a run of added lines is the
 * shape of an edit rather than a delete next to an insert, so the runs are
 * paired off row by row and the leftovers fall through as one-sided rows. That
 * pairing is what lets the two sides line up and what gives the intra-line
 * highlight something to compare against.
 */
export function parseUnifiedDiff(out: string): FileDiff {
  const diff: FileDiff = {
    path: '',
    binary: false,
    rows: [],
    added: 0,
    removed: 0,
    changes: 0,
    truncated: false,
  };

  const lines = out.split('\n');
  let oldNo = 0;
  let newNo = 0;
  // Headers only appear before a file's first hunk. Inside one, a line such as
  // "--- foo" is a removed line whose own text begins with "--", and taking it
  // for a header would silently drop it.
  let inHunk = false;
  // Removed lines wait here until the following added lines are known, because
  // only then can an edit be told from a plain deletion.
  let pendingDel: { no: number; text: string }[] = [];
  let pendingAdd: { no: number; text: string }[] = [];

  const flush = (): void => {
    const paired = Math.min(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < paired; i++) {
      const left = pendingDel[i]!;
      const right = pendingAdd[i]!;
      const spans = intraLineSpans(left.text, right.text);
      diff.rows.push({
        kind: 'change',
        oldNo: left.no,
        newNo: right.no,
        oldText: left.text,
        newText: right.text,
        oldSpans: spans.old,
        newSpans: spans.new,
      });
    }
    for (let i = paired; i < pendingDel.length; i++) {
      const left = pendingDel[i]!;
      diff.rows.push({
        kind: 'del',
        oldNo: left.no,
        newNo: null,
        oldText: left.text,
        newText: null,
      });
    }
    for (let i = paired; i < pendingAdd.length; i++) {
      const right = pendingAdd[i]!;
      diff.rows.push({
        kind: 'add',
        oldNo: null,
        newNo: right.no,
        oldText: null,
        newText: right.text,
      });
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      inHunk = false;
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      diff.binary = true;
      continue;
    }
    if (!inHunk && HEADER.test(line)) {
      continue;
    }
    // Git's marker for a file whose last line has no terminator. It describes
    // the line before it rather than being one, so it is simply dropped.
    if (line.startsWith('\\ ')) {
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      inHunk = true;
      const nextOld = Number(hunk[1]);
      const nextNew = Number(hunk[3]);
      // Anything between the last hunk and this one was never sent, so the row
      // that stands in its place says how much is missing.
      const skipped = newNo > 0 ? nextNew - newNo - 1 : 0;
      if (skipped > 0) {
        diff.rows.push({
          kind: 'gap',
          oldNo: null,
          newNo: null,
          oldText: null,
          newText: null,
          skipped,
        });
      }
      oldNo = nextOld - 1;
      newNo = nextNew - 1;
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      newNo++;
      diff.added++;
      pendingAdd.push({ no: newNo, text });
    } else if (marker === '-') {
      oldNo++;
      diff.removed++;
      pendingDel.push({ no: oldNo, text });
    } else if (marker === ' ') {
      flush();
      oldNo++;
      newNo++;
      diff.rows.push({
        kind: 'same',
        oldNo,
        newNo,
        oldText: text,
        newText: text,
      });
    }
    // Anything else is a trailing blank from the split, or output this parser
    // has no business with; dropping it keeps a stray line out of the view.
  }
  flush();

  diff.changes = countChangeRuns(diff.rows);
  return diff;
}

/** Maximal runs of changed rows - what the ↑ ↓ buttons step between. */
function countChangeRuns(rows: DiffRow[]): number {
  let runs = 0;
  let inRun = false;
  for (const row of rows) {
    const changed = row.kind === 'add' || row.kind === 'del' || row.kind === 'change';
    if (changed && !inRun) {
      runs++;
    }
    inRun = changed;
  }
  return runs;
}

/**
 * Splits a line into words, runs of whitespace, and single other characters,
 * so that a highlight lands on the identifier that actually changed rather
 * than on every character from the first difference onwards.
 */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_$]+|\s+|[^\s]/gu) ?? [];
}

/**
 * The parts of two versions of a line that differ, as character ranges.
 *
 * The common subsequence is found over tokens rather than characters, which is
 * both far cheaper and what makes a renamed identifier highlight as one word.
 */
export function intraLineSpans(
  oldText: string,
  newText: string
): { old: Span[]; new: Span[] } {
  const all = tokenize(oldText);
  const bll = tokenize(newText);

  // What the two lines share at each end is trimmed before the table below is
  // built, because the table is quadratic in what is left and an edit almost
  // always leaves the indentation and the tail of the line alone. Without this
  // a reformatted file pays for the whole of every line: 1.08 ms each at two
  // hundred tokens, which is twenty seconds of extension host for twenty
  // thousand lines, and a wedged window while it runs.
  let head = 0;
  while (head < all.length && head < bll.length && all[head] === bll[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < all.length - head &&
    tail < bll.length - head &&
    all[all.length - 1 - tail] === bll[bll.length - 1 - tail]
  ) {
    tail++;
  }

  const a = all.slice(head, all.length - tail);
  const b = bll.slice(head, bll.length - tail);
  const oldFrom = width(all, 0, head);
  const newFrom = width(bll, 0, head);

  if (a.length === 0 && b.length === 0) {
    return { old: [], new: [] };
  }

  // Still too much differing between the shared ends to be worth picking apart
  // word by word - a rewritten line, or a data line with no structure in
  // common. Marking the middle whole says the same thing for less.
  if (a.length > MAX_SPAN_TOKENS || b.length > MAX_SPAN_TOKENS) {
    return {
      old: a.length ? [[oldFrom, oldFrom + width(a, 0, a.length)]] : [],
      new: b.length ? [[newFrom, newFrom + width(b, 0, b.length)]] : [],
    };
  }

  // lcs[i][j] is the length of the longest common subsequence of a[i..] and
  // b[j..], filled from the end so the walk below can take the greedy step.
  const lcs: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    lcs.push(new Array<number>(b.length + 1).fill(0));
  }
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  // Offsets are into the whole line, not the trimmed middle the table covers.
  let oldAt = oldFrom;
  let newAt = newFrom;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      oldAt += a[i]!.length;
      newAt += b[j]!.length;
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      pushSpan(oldSpans, oldAt, oldAt + a[i]!.length);
      oldAt += a[i]!.length;
      i++;
    } else {
      pushSpan(newSpans, newAt, newAt + b[j]!.length);
      newAt += b[j]!.length;
      j++;
    }
  }
  for (; i < a.length; i++) {
    pushSpan(oldSpans, oldAt, oldAt + a[i]!.length);
    oldAt += a[i]!.length;
  }
  for (; j < b.length; j++) {
    pushSpan(newSpans, newAt, newAt + b[j]!.length);
    newAt += b[j]!.length;
  }

  return { old: oldSpans, new: newSpans };
}

/** Characters spanned by tokens [from, to). */
function width(tokens: string[], from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) {
    total += tokens[i]!.length;
  }
  return total;
}

/** Appends a range, merging it into the previous one when they touch. */
function pushSpan(spans: Span[], start: number, end: number): void {
  if (start === end) {
    return;
  }
  const last = spans[spans.length - 1];
  if (last && last[1] === start) {
    last[1] = end;
    return;
  }
  spans.push([start, end]);
}
