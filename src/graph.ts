/**
 * Commit log reading plus the graph lane layout used by the Git Repository
 * window. Kept free of any vscode imports so it can be exercised directly from
 * node against a real repository.
 */

import { Git } from './git';

export interface RawCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  /** ISO-8601, formatted for display in the webview using the user's locale. */
  date: string;
  subject: string;
  /** Decorations: "HEAD -> main", "origin/main", "tag: v1.2". */
  refs: string[];
}

/** A line that crosses the whole row, from lane `from` on top to `to` below. */
export interface ThroughLine {
  from: number;
  to: number;
  color: number;
}

/** A line between the row's commit dot and the row's top or bottom edge. */
export interface DotLine {
  lane: number;
  color: number;
}

export interface GraphRow {
  commit: RawCommit;
  /** Lane the commit dot sits in. */
  lane: number;
  color: number;
  /** Lines entering from the row above and ending at the dot. */
  above: DotLine[];
  /** Lines leaving the dot towards the row below (one per parent). */
  below: DotLine[];
  /** Lines belonging to other branches that merely pass this row. */
  through: ThroughLine[];
  /** Lanes occupied at this row, used for the SVG width. */
  laneCount: number;
  group: 'incoming' | 'local';
  outgoing: boolean;
  isHead: boolean;
}

export interface GraphModel {
  rows: GraphRow[];
  maxLanes: number;
  incoming: number;
  outgoing: number;
  /** True when more commits exist beyond the requested page. */
  hasMore: boolean;
  scope: string;
  upstream?: string;
}

export interface RefEntry {
  /** Full ref name, e.g. refs/heads/feature/x. */
  name: string;
  /** Display name, e.g. feature/x. */
  short: string;
  kind: 'head' | 'remote' | 'tag';
  hash: string;
  upstream?: string;
  current: boolean;
}

const UNIT = '\x1f';
const RECORD = '\x1e';

const LOG_FORMAT = [
  '%H',
  '%P',
  '%an',
  '%aI',
  '%D',
  '%s',
].join(UNIT) + RECORD;

export async function readRefs(git: Git, root: string): Promise<RefEntry[]> {
  const out = await git.exec(root, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=%(refname)${UNIT}%(refname:short)${UNIT}%(objectname)${UNIT}%(upstream:short)${UNIT}%(HEAD)`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);

  const refs: RefEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [name, short, hash, upstream, head] = line.split(UNIT);
    if (!name) {
      continue;
    }
    const kind: RefEntry['kind'] = name.startsWith('refs/heads/')
      ? 'head'
      : name.startsWith('refs/tags/')
        ? 'tag'
        : 'remote';
    // refs/remotes/origin/HEAD is a symbolic alias, not a branch worth listing.
    if (kind === 'remote' && short?.endsWith('/HEAD')) {
      continue;
    }
    refs.push({
      name,
      short: short ?? name,
      kind,
      hash: hash ?? '',
      upstream: upstream || undefined,
      current: head?.trim() === '*',
    });
  }
  return refs;
}

export async function readGraph(
  git: Git,
  root: string,
  scope: string,
  limit: number
): Promise<GraphModel> {
  const upstream = await upstreamOf(git, root, scope);

  // Ask for one extra commit so we can tell whether a "Load more" row is needed.
  const revs = upstream ? [scope, upstream] : [scope];
  const out = await git.exec(root, [
    'log',
    '--date-order',
    `--max-count=${limit + 1}`,
    `--format=${LOG_FORMAT}`,
    ...revs,
    '--',
  ]);

  const commits = parseLog(out);
  const hasMore = commits.length > limit;
  if (hasMore) {
    commits.length = limit;
  }

  const [incomingSet, outgoingSet] = upstream
    ? await Promise.all([
        revList(git, root, [upstream, `^${scope}`]),
        revList(git, root, [scope, `^${upstream}`]),
      ])
    : [new Set<string>(), new Set<string>()];

  const headHash = (await git.exec(root, ['rev-parse', 'HEAD'])).trim();

  return {
    ...layout(commits, incomingSet, outgoingSet, headHash),
    incoming: incomingSet.size,
    outgoing: outgoingSet.size,
    hasMore,
    scope,
    upstream,
  };
}

async function upstreamOf(git: Git, root: string, scope: string): Promise<string | undefined> {
  try {
    const out = await git.exec(root, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${scope}@{u}`,
    ]);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function revList(git: Git, root: string, args: string[]): Promise<Set<string>> {
  try {
    const out = await git.exec(root, ['rev-list', ...args]);
    return new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

export function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const record of out.split(RECORD)) {
    const line = record.replace(/^\n/, '');
    if (!line.trim()) {
      continue;
    }
    const [hash, parents, author, date, refs, subject] = line.split(UNIT);
    if (!hash) {
      continue;
    }
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents: (parents ?? '').split(' ').filter(Boolean),
      author: author ?? '',
      date: date ?? '',
      subject: subject ?? '',
      refs: (refs ?? '')
        .split(', ')
        .map((r) => r.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

/**
 * Assigns each commit a lane and works out the lines that must be drawn in its
 * row.
 *
 * `lanes[i]` holds the hash the i-th lane is currently waiting for; a lane is
 * created when a commit has no lane reserved for it (a branch tip) or when a
 * merge introduces an extra parent, and freed once the commit it was waiting
 * for is emitted. Lane indices are never compacted, so a line that merely
 * passes a row keeps the same x on both edges and stays visually straight.
 */
export function layout(
  commits: RawCommit[],
  incoming: Set<string>,
  outgoing: Set<string>,
  headHash: string
): { rows: GraphRow[]; maxLanes: number } {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  const rows: GraphRow[] = [];
  let nextColor = 0;
  let maxLanes = 0;

  for (const commit of commits) {
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        waiting.push(i);
      }
    }

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0];
    } else {
      lane = firstFree(lanes);
      lanes[lane] = commit.hash;
      colors[lane] = nextColor++;
    }

    const before = lanes.slice();
    const beforeColors = colors.slice();
    const dotColor = beforeColors[lane] ?? nextColor++;

    const above: DotLine[] = waiting.map((i) => ({
      lane: i,
      color: beforeColors[i] ?? dotColor,
    }));

    // Free every lane that was waiting for this commit, including the lane just
    // created for a branch tip - otherwise the first parent cannot continue
    // straight down and the whole graph drifts one lane to the right.
    for (const i of waiting) {
      lanes[i] = null;
    }
    lanes[lane] = null;

    const below: DotLine[] = [];
    commit.parents.forEach((parent, index) => {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        if (index === 0 && lanes[lane] === null) {
          // The first parent continues straight down in the commit's own lane.
          target = lane;
          colors[target] = dotColor;
        } else {
          target = firstFree(lanes);
          colors[target] = nextColor++;
        }
        lanes[target] = parent;
      }
      below.push({ lane: target, color: colors[target] ?? dotColor });
    });

    const through: ThroughLine[] = [];
    before.forEach((hash, from) => {
      if (!hash || hash === commit.hash) {
        return;
      }
      const to = lanes.indexOf(hash);
      if (to !== -1) {
        through.push({ from, to, color: beforeColors[from] ?? 0 });
      }
    });

    trimTrailingNulls(lanes);
    const laneCount = Math.max(before.length, lanes.length);
    maxLanes = Math.max(maxLanes, laneCount);

    rows.push({
      commit,
      lane,
      color: dotColor,
      above,
      below,
      through,
      laneCount,
      group: incoming.has(commit.hash) ? 'incoming' : 'local',
      outgoing: outgoing.has(commit.hash),
      isHead: commit.hash === headHash,
    });
  }

  return { rows, maxLanes: Math.max(1, maxLanes) };
}

function firstFree(lanes: (string | null)[]): number {
  const index = lanes.indexOf(null);
  if (index !== -1) {
    return index;
  }
  lanes.push(null);
  return lanes.length - 1;
}

function trimTrailingNulls(lanes: (string | null)[]): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
    lanes.pop();
  }
}
