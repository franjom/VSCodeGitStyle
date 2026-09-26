/**
 * Commit log reading plus the graph lane layout used by the Git Repository
 * window. Kept free of any vscode imports so it can be exercised directly from
 * node against a real repository.
 */

import { Git } from '../git/git';

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
  /** The branch the Incoming and Local History counts are measured against. */
  scope: string;
  /**
   * Branches shown alongside it, from the eye toggle in the tree. Visual
   * Studio's Git Repository window draws several at once and names them all in
   * the breadcrumb; only `scope` decides what counts as incoming or outgoing.
   */
  extras: string[];
  upstream?: string;
  /** Set when the history is scoped to one file, for the breadcrumb. */
  file?: string;
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

export interface CommitFile {
  /** Raw git status letter: A, M, D, T, R or C. */
  status: string;
  path: string;
  origPath?: string;
}

export interface CommitPerson {
  name: string;
  email: string;
  date: string;
}

export interface CommitDetails {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: string[];
  author: CommitPerson;
  committer: CommitPerson;
  subject: string;
  body: string;
  files: CommitFile[];
  /** True when the file list was capped. */
  truncated: boolean;
  /** A merge's file list is its diff against the first parent. */
  isMerge: boolean;
}

const MAX_DETAIL_FILES = 500;

const DETAIL_FORMAT = [
  '%H',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%D',
  '%s',
  '%b',
].join(UNIT);

export async function readCommitDetails(
  git: Git,
  root: string,
  hash: string
): Promise<CommitDetails> {
  const [headerOut, filesOut] = await Promise.all([
    git.exec(root, ['show', '-s', `--format=${DETAIL_FORMAT}`, hash]),
    // --first-parent gives a merge a meaningful file list (git would otherwise
    // print nothing), and --root lets the initial commit show its own files.
    git.exec(root, [
      'show',
      '--format=',
      '--name-status',
      '-z',
      '-M',
      '--first-parent',
      '--root',
      hash,
    ]),
  ]);

  const parts = headerOut.split(UNIT);
  const parents = (parts[1] ?? '').split(' ').filter(Boolean);
  const files = parseNameStatus(filesOut);

  return {
    hash: parts[0] ?? hash,
    shortHash: (parts[0] ?? hash).slice(0, 7),
    parents,
    refs: (parts[8] ?? '')
      .split(', ')
      .map((r) => r.trim())
      .filter(Boolean),
    author: { name: parts[2] ?? '', email: parts[3] ?? '', date: parts[4] ?? '' },
    committer: { name: parts[5] ?? '', email: parts[6] ?? '', date: parts[7] ?? '' },
    subject: parts[9] ?? '',
    body: (parts[10] ?? '').replace(/\s+$/, ''),
    files: files.slice(0, MAX_DETAIL_FILES),
    truncated: files.length > MAX_DETAIL_FILES,
    isMerge: parents.length > 1,
  };
}

/**
 * Parses `--name-status -z`: a status token followed by one path, or by an old
 * and a new path when the status is a rename or copy.
 */
export function parseNameStatus(out: string): CommitFile[] {
  const tokens = out.split('\0');
  const files: CommitFile[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]?.replace(/^\n+/, '').trim();
    if (!status) {
      continue;
    }
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const origPath = tokens[++i];
      const path = tokens[++i];
      if (path === undefined) {
        break;
      }
      files.push({ status: letter, path, origPath });
    } else {
      const path = tokens[++i];
      if (path === undefined) {
        break;
      }
      files.push({ status: letter, path });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return files;
}

export type ReviewProvider = 'github' | 'gitlab' | 'azure' | 'unknown';

export interface ReviewInfo {
  provider: ReviewProvider;
  host?: string;
  /** "Pull Requests" or, for GitLab, "Merge Requests". */
  label: string;
}

/**
 * Extracts the host from any of the URL shapes git accepts for a remote:
 * scp-like (git@host:group/repo.git), ssh:// with an optional port, and
 * http(s):// with optional credentials.
 */
export function remoteHost(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  const scp = /^[^/@]+@([^:/]+):/.exec(trimmed);
  if (scp) {
    return scp[1];
  }
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/.exec(trimmed);
  if (scheme) {
    return scheme[1];
  }
  return undefined;
}

/**
 * Guesses the review provider from the host. A self-hosted instance cannot be
 * recognised this way - git.example.com says nothing about what runs on it - so
 * the `vsGitStyle.reviewProvider` setting overrides this.
 */
export function providerFromHost(host: string | undefined): ReviewProvider {
  if (!host) {
    return 'unknown';
  }
  const lower = host.toLowerCase();
  if (lower === 'github.com' || lower.endsWith('.github.com')) {
    return 'github';
  }
  if (lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.startsWith('gitlab.')) {
    return 'gitlab';
  }
  if (lower === 'dev.azure.com' || lower.endsWith('.visualstudio.com')) {
    return 'azure';
  }
  return 'unknown';
}

export function labelForProvider(provider: ReviewProvider): string {
  return provider === 'gitlab' ? 'Merge Requests' : 'Pull Requests';
}

/**
 * Second-chance detection for self-hosted instances, whose hostname gives
 * nothing away. A committed CI definition does: only GitLab reads
 * .gitlab-ci.yml, only GitHub reads .github/workflows.
 */
async function providerFromMarkers(git: Git, root: string): Promise<ReviewProvider> {
  try {
    const out = await git.exec(root, [
      'ls-tree',
      'HEAD',
      '--name-only',
      '--',
      '.gitlab-ci.yml',
      '.gitlab',
      '.github',
      'azure-pipelines.yml',
    ]);
    const names = out.split('\n').map((l) => l.trim());
    if (names.some((n) => n === '.gitlab-ci.yml' || n === '.gitlab')) {
      return 'gitlab';
    }
    if (names.includes('.github')) {
      return 'github';
    }
    if (names.includes('azure-pipelines.yml')) {
      return 'azure';
    }
  } catch {
    /* no HEAD yet, or not a repo - fall through */
  }
  return 'unknown';
}

export async function readReviewInfo(
  git: Git,
  root: string,
  configured: ReviewProvider | 'auto'
): Promise<ReviewInfo> {
  let host: string | undefined;
  try {
    host = remoteHost(await git.exec(root, ['remote', 'get-url', 'origin']));
  } catch {
    host = undefined;
  }

  if (configured !== 'auto') {
    return { provider: configured, host, label: labelForProvider(configured) };
  }

  // The host is the stronger signal when it is recognisable - a repository
  // mirrored to GitHub may still carry a .gitlab-ci.yml.
  let provider = providerFromHost(host);
  if (provider === 'unknown') {
    provider = await providerFromMarkers(git, root);
  }
  return { provider, host, label: labelForProvider(provider) };
}

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
  limit: number,
  file?: string,
  extras: string[] = []
): Promise<GraphModel> {
  const upstream = await upstreamOf(git, root, scope);

  // One file's history is about the file, not about how the branch stands
  // against its upstream: splitting it into Incoming and Local History would
  // count commits that never touched the file. Everything is Local History.
  const [incomingSet, outgoingSet] =
    upstream && !file
      ? await Promise.all([
          revList(git, root, [upstream, `^${scope}`]),
          revList(git, root, [scope, `^${upstream}`]),
        ])
      : [new Set<string>(), new Set<string>()];

  // The log covers the scope and its upstream together, so a big fetch would
  // otherwise spend the whole page on incoming commits and leave Local History
  // looking truncated. Give the incoming commits their own budget on top, with
  // a ceiling so a wildly stale branch cannot blow the page up.
  const incomingBudget = Math.min(incomingSet.size, 2000);
  const requested = limit + incomingBudget;

  // Ask for one extra commit so we can tell whether a "Load more" row is needed.
  // Every branch the window is showing goes into the one log, so the lanes are
  // laid out across all of them together rather than stitched from separate
  // reads. The scope leads: a commit it shares with an extra still belongs to
  // the branch whose incoming and outgoing counts are on screen.
  // A branch listed twice, or the same as the scope, would put its commits in
  // the log twice over and give git a redundant revision to walk.
  const shown = [...new Set([scope, ...extras.filter(Boolean)])];
  const revs = upstream && !file ? [...shown, upstream] : shown;
  const out = await git.exec(root, [
    'log',
    '--date-order',
    `--max-count=${requested + 1}`,
    `--format=${LOG_FORMAT}`,
    // --follow carries the history through renames, which is the point of
    // asking for one file's history. It takes exactly one path, and the path
    // has to come after the --, or git reads it as a revision.
    ...(file ? ['--follow'] : []),
    ...revs,
    '--',
    ...(file ? [file] : []),
  ]);

  const commits = parseLog(out);
  const hasMore = commits.length > requested;
  if (hasMore) {
    commits.length = requested;
  }

  const headHash = (await git.exec(root, ['rev-parse', 'HEAD'])).trim();

  return {
    ...layout(commits, incomingSet, outgoingSet, headHash),
    incoming: incomingSet.size,
    outgoing: outgoingSet.size,
    hasMore,
    scope,
    extras: shown.slice(1),
    upstream,
    file,
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
      } else if (index === 0 && target > lane && lanes[lane] === null) {
        // The first parent is already awaited further right, because another
        // branch reached it first. Pull it back into this commit's own lane so
        // the main line hugs the left edge the way `git log --graph` and Visual
        // Studio both draw it; the vacated lane becomes a converging line.
        lanes[target] = null;
        target = lane;
        lanes[target] = parent;
        colors[target] = dotColor;
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
