# VS Git Style

A VS Code extension that reproduces the look and feel of Visual Studio 2026's
Git tooling: the **Git Changes** sidebar and the full **Git Repository** window
with its commit graph.

## Running it

```
npm install
npm run compile
npm test
```

Then press <kbd>F5</kbd> ("Run Extension"). In the Extension Development Host,
click the branch icon in the activity bar to open **Git Changes**; the
"View all commits" link (or the *VS Git Style: Open Git Repository Window*
command) opens the graph window.

To iterate on the visual design without launching the extension host, open
[dev/preview.html](dev/preview.html) or [dev/preview-repo.html](dev/preview-repo.html)
in a browser. They load the real CSS and JS against captured models with a
stubbed webview API. `preview-repo.html?rows=2000` repeats the captured history
until it is that long, so the row windowing can be exercised without capturing a
huge repository.

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
| `Changes (n)` tree: repo root, folders, files | done, single-child folder chains collapsed like VS; folders start expanded |
| `Staged Changes (n)` as its own section | done; appears only when something is staged, with its own tree and expansion state |
| `Merge Conflicts (n)` section | done; shown above the others while a merge, rebase, cherry-pick or revert is unresolved |
| Resolve a conflict | done: open in VS Code's merge editor, take current, take incoming, or mark resolved |
| In-progress operation banner | done, naming what is being merged, with an Abort link |
| Per-file stage / unstage / discard / open changes | done, on hover and in the context menu |
| Per-file context menu | done, matching Visual Studio's: Open, Stage/Unstage, Undo Changes, View History, Compare with Unmodified, Blame (Annotate), Ignore and Untrack item. "Review changes with Copilot" is deliberately left out |
| Change-type colouring per file | done, using the theme's `gitDecoration` colours |
| `Stashes (n)` list with `{ n } On <branch>: <message>` | done |
| Stash apply / pop / drop, `Drop All` | done |
| Multiple repositories in one workspace | first repository is shown; switching is not surfaced in the UI yet |

### Conflicts and interrupted operations

An unmerged path is neither staged nor unstaged - git will not commit it at all
until it is resolved - so conflicts get their own list rather than being folded
into Changes. While any remain, the commit button is disabled with a tooltip
saying why.

The operation the working tree is sitting in is detected by verifying the
pseudo-refs git writes for it: `MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`
and `REVERT_HEAD`. Each survives until the operation is completed or aborted,
so no `.git` internals are read. `name-rev` turns the ref into the branch name
shown in the banner and in the Take Current / Take Incoming labels.

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
| History of one file | done, from the sidebar's "View History"; `git log --follow` so the history survives a rename, with the file named in the breadcrumb and a "Show all commits" link back. Incoming/Outgoing is not split in this mode, because those counts are about the branch, not the file |
| Branches / Tags pane, nested on `/` | done, with a pane filter and a draggable splitter |
| `remotes/<remote>` and `tags` nodes | done |
| `Pull Requests` node | placeholder; labelled `Merge Requests` for GitLab, see `vsGitStyle.reviewProvider` |
| `Incoming (n)` group with Fetch / Pull links | done |
| `Local History (n Outgoing)` group with Push / Sync links | done |
| Commit graph with coloured lanes and merge curves | done, SVG, lanes computed in [src/graph.ts](src/graph.ts) |
| Branch / Tag chips per commit | done, ranked so the current branch and tags survive the cap |
| Message / Author / Date / ID columns | done |
| Click to select | done, fills the commit details pane |
| Commit details pane | done: docked across the bottom, with a side-by-side diff of the selected file, change navigation, and a metadata rail holding the message, author/committer, clickable parents, refs and a folder tree of the changed files |
| Side-by-side diff inside the pane | done: whole file on both sides, synced vertical scroll, word-level highlight inside an edited line, `↑` `↓` between changes, `-n` `+n` tallies ([src/diff.ts](src/diff.ts), [media/diffview.js](media/diffview.js)) |
| Syntax colouring in the diff | done, [media/syntax.js](media/syntax.js): a lexer for comments, strings, numbers and keywords across the C family, Python, Ruby, shell, SQL, CSS/SCSS, JSON, YAML and XML/HTML; block comments and docstrings carry across lines, and a file with no lexer is left plain rather than guessed at |
| Click a file in the pane | done, shows its diff in the pane; double-click opens a real editor diff at that commit via the `vsgitstyle-blob:` scheme |
| Double-click a commit | done, opens the whole commit as a read-only patch |
| Context menu: details, copy ID, new branch here | done |
| Paging | `Load more commits`, page size from `vsGitStyle.graphPageSize` (default 200); incoming commits get their own budget so a large fetch does not truncate Local History |
| Row virtualization | done; only the rows on screen are in the DOM, so an 8,000-commit history costs what 200 does |
| Stays current | reloads when the repository changes anywhere - the sidebar, a terminal, another editor - not only on its own actions |
| Resizable columns | not done; the grid template is fixed except for the graph column |
| Resizable details pane, hideable | done: draggable dividers for the pane's height and the rail's width, a maximize toggle, a toolbar toggle and the context menu's `View Commit Details` to bring it back; all of it persists |

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

### Row virtualization

Only the commit rows on screen exist in the DOM. Each group - Incoming and Local
History - is one region whose rows are windowed: the rows scrolled out of sight
are replaced by padding of exactly their height, so the scrollbar, and every
offset below the region, sit where the whole list would have put them. Eight rows
of overscan are kept beyond each edge, and the window is recomputed once per
frame on scroll rather than once per scroll event.

The arithmetic is [media/virtual.js](media/virtual.js), kept free of the DOM so
it can be fed directly from tests. The rest is measurement: a region's offset is
read from the live layout rather than computed, because group headers, their
borders and the empty-state placeholders all sit between the regions. A region's
own height never changes, which is what makes that measurement stable as the
windows fill in.

A `ResizeObserver` on the scroller drives a resync. The height of the viewport
decides how many rows are needed, and it changes for more reasons than the
window being resized: the icon font arriving retags the toolbar's height, the
splitters move the panes, and a webview that was hidden when it first rendered
measures nothing at all until it is shown.

Measured in Edge at 1400x900 against the same page, before and after, with real
commit rows multiplied synthetically (`npm run preview-check -- --rows=8000`):

| rows | render before | render after | DOM nodes before | after |
| --- | --- | --- | --- | --- |
| 202 | 54 ms | 7 ms | 3.3k | 738 |
| 1002 | 248 ms | 14 ms | 16k | 738 |
| 2002 | 729 ms | 13 ms | 32k | 738 |
| 8002 | 2,245 ms | 17 ms | 128k | 738 |

The cost no longer follows the length of the history: what is in the DOM is a
screenful either way. `vsGitStyle.graphPageSize` (default 200) now limits how
much git is asked for, not how much the window can survive drawing.

Reads shell out to git with machine-readable formats (`status --porcelain=v2 -z`,
`for-each-ref`, `stash list --format`, `log --format`). Network operations go
through the built-in `git.fetch` / `git.pull` / `git.push` / `git.sync` commands
so VS Code's credential plumbing stays in play.

## Deliberately deferred (placeholders in place)

- **Keyboard navigation and screen-reader support** — `installKeyboardNavigation()`
  in both [media/main.js](media/main.js) and [media/repo.js](media/repo.js) is an
  empty hook. Every row already carries `role`, `aria-level` and `aria-expanded`,
  so a future pass needs a roving tabindex plus arrow/Home/End handling — and, in
  the graph window, must drive the scroll position and let the windowing rebuild
  the row, because a focused row can now be scrolled out of the DOM entirely.
- **Pull / merge requests** — the node is a label only; populating it needs the
  provider's API and a token (GitHub, GitLab, Azure DevOps).

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

## Tests

`npm test` compiles and runs the suite with node's built-in runner - no test
framework, no dependencies. 75 tests in [tests/](tests/):

- **[tests/parse.test.js](tests/parse.test.js)** - the porcelain v2 parser, the
  log and name-status parsers, and remote URL handling. Table-driven, no git
  needed: `parseStatus` was extracted as a pure function so the format's awkward
  corners can be fed in directly.
- **[tests/layout.test.js](tests/layout.test.js)** - the graph lane engine over
  synthetic topologies: linear history, a merge and its rejoin, repeated merges,
  an octopus merge, independent tips, lane reuse, missing parents, empty input.
  Every case is also walked edge by edge to confirm each line is drawn on every
  row it crosses and lands on its parent's dot.
- **[tests/tree.test.js](tests/tree.test.js)** - folder-chain compression,
  ordering, counts, and paths containing spaces.
- **[tests/virtual.test.js](tests/virtual.test.js)** - the row windowing range:
  partly visible rows at both edges, overscan and its clamps, regions above and
  below the viewport, an empty list, a viewport not yet measured. Two of them are
  invariants rather than cases - that the hidden rows above, the rendered ones
  and the hidden rows below always add up to the whole list, and that walking the
  viewport down the list a row at a time never skips one.
- **[tests/menu.test.js](tests/menu.test.js)** - the file context menu's two
  git-facing actions, against real repositories: ignore-and-untrack (including a
  file that was never tracked, where `git rm --cached` fails outright, a
  .gitignore with no trailing newline, and a repeated ignore) and file-scoped
  history (only the commits that touched the file, followed through a rename).
- **[tests/repo.test.js](tests/repo.test.js)** - real repositories built in the
  temp directory and thrown away: every change type at once, ahead/behind
  against an upstream, stashes, a conflicted merge and its resolution, abort,
  amend, discard, commit details for a merge and a root commit, and provider
  detection.

### Are the tests worth having?

`npm run mutation-check` answers that. It reintroduces seven bugs and reports
whether the suite noticed. Five were actually hit while building this - the graph
lane drift, collapsing a staged-then-edited file into one entry, dropping
`--first-parent` from a merge's file list, reading a rename's original path
without consuming it, and amending with an empty message box. The other two are
the slips windowing code classically grows: rounding the bottom edge down, which
leaves a sliver of empty scroller under the last row, and not clamping the range
to the end of the list. All seven are caught; each mutation is reverted and the
sources recompiled afterwards.

The fourth of those was originally missed, which is the point of running it: the
test written for that bug could not fail, because for ordinary paths not
advancing the index is genuinely equivalent. It only matters when the original
path itself looks like a status record, so that is what the test now feeds it.

### Checking the webview itself

`npm run preview-check` drives [dev/preview-repo.html](dev/preview-repo.html) in
headless Edge or Chrome over the DevTools protocol - node's built-in WebSocket,
so no dependency - and checks what node cannot: that the scroll height is what
the whole history would have been and never moves, that the rows on screen are
the right commits with no gaps at any scroll position, that the DOM stays
bounded, and that selecting a commit, collapsing a group and filtering all
survive the windowing. It also reports the render cost.

```
npm run preview-check -- --rows=8000 --shot=out.png
```

`--rows` sets how long the synthetic history is, `--shot` writes a screenshot,
`--keep` leaves the browser profile behind. Set `VSG_BROWSER` if neither Edge nor
Chrome is where it is looked for. It is not part of `npm test`, which stays
dependency-free and headless.

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
