# VS Git Style

A VS Code extension that reproduces the look and feel of Visual Studio 2026's
Git tooling: the **Git Changes** sidebar and the full **Git Repository** window
with its commit graph.

## Running it

```
npm install
npm run compile
```

Then press <kbd>F5</kbd> ("Run Extension"). In the Extension Development Host,
click the branch icon in the activity bar to open **Git Changes**; the
"View all commits" link (or the *VS Git Style: Open Git Repository Window*
command) opens the graph window.

To iterate on the visual design without launching the extension host, open
[dev/preview.html](dev/preview.html) or [dev/preview-repo.html](dev/preview-repo.html)
in a browser. They load the real CSS and JS against captured models with a
stubbed webview API.

## Git Changes (sidebar)

A `WebviewView` in its own activity-bar container, styled entirely with VS Code
theme tokens so it follows the active colour theme.

| Visual Studio element | Status |
| --- | --- |
| Branch dropdown (checkout on change) | done |
| Fetch / Pull / Push / Sync buttons | done, delegated to the built-in git commands |
| `⇅ n / n` outgoing / incoming counts | done, from `rev-list --left-right --count` |
| "View all commits" link | done, opens the Git Repository window |
| Commit message box, `Enter a message <Required>` | done, draft persisted across reloads |
| AI message generation (sparkle button) | done, via the VS Code Language Model API when a provider exists |
| `Commit All` / `Commit Staged` split button | done; the primary action becomes `Commit Staged` as soon as anything is staged, with and Push / and Sync variants |
| `Amend` checkbox | done |
| `Changes (n)` tree: repo root, folders, files | done, single-child folder chains collapsed like VS |
| `Staged Changes (n)` as its own section | done; appears only when something is staged, with its own tree and expansion state |
| Per-file stage / unstage / discard / open changes | done, on hover and in the context menu |
| Change-type colouring per file | done, using the theme's `gitDecoration` colours |
| `Stashes (n)` list with `{ n } On <branch>: <message>` | done |
| Stash apply / pop / drop, `Drop All` | done |
| Multiple repositories in one workspace | first repository is shown; switching is not surfaced in the UI yet |

### Why the two lists are read separately

git's porcelain status carries two independent states per file: X is the index,
Y is the worktree. A file that was edited, staged, then edited again is `MM` and
genuinely belongs in both lists, so each column is read on its own instead of
collapsing the file into a single entry with a flag. Such a file appears in both
sections, offering Stage in one and Unstage in the other.

## Git Repository window (commit graph)

A `WebviewPanel` in the editor area.

| Visual Studio element | Status |
| --- | --- |
| Toolbar: Refresh / Fetch / Pull / Push / Sync | done |
| `Filter History` box | done, filters on subject, author and hash |
| `Branch / Tag: <name>` breadcrumb | done |
| Branches / Tags pane, nested on `/` | done, with a pane filter and a draggable splitter |
| `remotes/<remote>` and `tags` nodes | done |
| `Pull Requests` node | placeholder; labelled `Merge Requests` for GitLab, see `vsGitStyle.reviewProvider` |
| `Incoming (n)` group with Fetch / Pull links | done |
| `Local History (n Outgoing)` group with Push / Sync links | done |
| Commit graph with coloured lanes and merge curves | done, SVG, lanes computed in [src/graph.ts](src/graph.ts) |
| Branch / Tag chips per commit | done, ranked so the current branch and tags survive the cap |
| Message / Author / Date / ID columns | done |
| Click to select | done, fills the commit details pane |
| Commit details pane | done: message, author/committer, full SHA, clickable parents, refs, and the changed-file list |
| Click a file in the pane | done, opens a real diff of that file at that commit via the `vsgitstyle-blob:` scheme |
| Double-click a commit | done, opens the whole commit as a read-only patch |
| Context menu: details, copy ID, new branch here | done |
| Paging | `Load more commits`, page size from `vsGitStyle.graphPageSize` (default 200); incoming commits get their own budget so a large fetch does not truncate Local History |
| Stays current | reloads when the repository changes anywhere - the sidebar, a terminal, another editor - not only on its own actions |
| Resizable columns | not done; the grid template is fixed except for the graph column |
| Resizable details pane, hideable | done, draggable splitter plus a toolbar toggle; width and visibility persist |

### How the graph is computed

`git log --date-order` supplies each commit's hash, parents, author, date, refs
and subject. [src/graph.ts](src/graph.ts) then assigns lanes: `lanes[i]` holds
the hash lane `i` is waiting for, a lane is created for a branch tip or an extra
merge parent, and freed once its commit is emitted. Lane indices are never
compacted, so a line that merely passes a row keeps the same x on both edges and
stays visually straight. Each row records the lines entering from above, the
lines leaving towards its parents, and the lines that pass it, which the webview
draws as one small SVG per row.

The layout was verified against `git log --graph` on a repository with real
merge topology, including a check that every parent edge lands in the lane where
that parent's own dot sits.

Reads shell out to git with machine-readable formats (`status --porcelain=v2 -z`,
`for-each-ref`, `stash list --format`, `log --format`). Network operations go
through the built-in `git.fetch` / `git.pull` / `git.push` / `git.sync` commands
so VS Code's credential plumbing stays in play.

## Deliberately deferred (placeholders in place)

- **Keyboard navigation and screen-reader support** — `installKeyboardNavigation()`
  in both [media/main.js](media/main.js) and [media/repo.js](media/repo.js) is an
  empty hook. Every row already carries `role`, `aria-level` and `aria-expanded`,
  so a future pass only needs a roving tabindex plus arrow/Home/End handling.
- **Pull / merge requests** — the node is a label only; populating it needs the
  provider's API and a token (GitHub, GitLab, Azure DevOps).
- **Row virtualization** — every loaded commit is a live DOM row (about 14 DOM
  nodes and 2.4 SVG paths each). Measured row-build cost, with real commit rows
  multiplied synthetically:

  | rows | build | DOM nodes |
  | --- | --- | --- |
  | 100 | 125 ms | 1.5k |
  | 432 | 212 ms | 6.3k |
  | 1000 | 440 ms | 14.5k |
  | 3000 | 920 ms | 43k |
  | 8000 | 2.7 s | 115k |

  Measured under jsdom, which does no layout, so treat these as relative rather
  than exact. The default 200-commit page is comfortable and a few `Load more`
  presses stay fine; past roughly 1500 rows the window starts to feel heavy, which
  is the point at which windowing needs doing rather than the page size lowered.

## Settings

- `vsGitStyle.confirmDiscard` (default `true`) — confirm before discarding a file.
- `vsGitStyle.showIgnoredFiles` (default `false`) — include ignored files in the tree.
- `vsGitStyle.graphPageSize` (default `200`) — commits loaded per page in the graph.
- `vsGitStyle.reviewProvider` (default `auto`) — `github`, `gitlab`, `azure` or
  `none`. Controls whether the review node reads "Pull Requests" or GitLab's
  "Merge Requests". On `auto` the `origin` URL's host is checked first, and
  because a self-hosted host gives nothing away (`git.example.com` says nothing
  about what runs on it) a committed CI definition is used as a second signal:
  `.gitlab-ci.yml` or `.gitlab/` means GitLab, `.github/` means GitHub,
  `azure-pipelines.yml` means Azure DevOps. Set the value explicitly if both
  signals miss.

## Measured against

Lane layout is checked two ways: the computed rows are rendered as ASCII and
compared against `git log --graph` for the same revisions, and every parent edge
is then walked down the graph row by row to confirm the line is drawn on each
intervening row and lands on the parent's dot. Across the four repositories
below that is **1,215 parent edges with no gaps, no wrong endings and no lane
collisions**.

| repository | commits | lanes | refs | notes |
| --- | --- | --- | --- | --- |
| `MedicusClientv2` | 459 | 4 | 33 | 45 merges, 23 tags, 7 remote branches, self-hosted GitLab |
| `DungeonKeeperRemake` | 432 | 3 | 3 | no remote |
| `DungeonKeeperRemake-Codex` | 410 | 3 | 3 | worktree of the above |
| scratch repo | 10 | 3 | 11 | see below |

Read timings on `MedicusClientv2`: `readRefs` 46 ms, `readGraph` over all 459
commits 143 ms, `git status` snapshot 148 ms, tree build 0.2 ms.

The scratch repository was built to cover what the real ones do not: every
change type (modify, add, delete, rename with a space in the path, untracked,
staged), three stashes, a tag, and an `origin` remote with 7 outgoing and 2
incoming commits.

Not yet exercised: a history needing more than 4 concurrent lanes, multiple
repositories in one workspace, and any remote operation that prompts for
credentials — fetch/pull/push have only been run against a local bare remote.
