# VS Git Style

A VS Code extension that reproduces the look and feel of Visual Studio 2026's
Git tooling: the **Git Changes** sidebar and the full **Git Repository** window
with its commit graph, commit details pane and side-by-side diff.

When behaviour is in question the answer is what Visual Studio does, not what
seems reasonable. Where VS Code makes something impossible the code says so and
takes the closest honest alternative: a webview cannot host VS Code's diff
editor, so the diff is drawn by hand; it cannot read a theme's token colours, so
the diff carries Dark Modern's with a light override. Buttons for things that
are not implemented are left out rather than shown.

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

`npm run install-local` packages the extension with `vsce` and installs the
`.vsix` into the local VS Code, for running it against real repositories
without the development host.

To iterate on the visual design without launching the extension host, open
[dev/preview.html](dev/preview.html) or [dev/preview-repo.html](dev/preview-repo.html)
in a browser. They load the real CSS and JS against captured models with a
stubbed webview API. `preview-repo.html?rows=2000` repeats the captured history
until it is that long, so the row windowing can be exercised without capturing a
huge repository. The same page is what `npm run preview-check` drives headlessly.

There are no runtime dependencies. The dev dependencies are TypeScript, `vsce`
and the codicon font package; tests use node's own `node --test`.

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
| `Changes (n)` tree: repo root, folders, files | done, single-child folder chains collapsed like VS; folders start expanded; files carry a codicon chosen by extension |
| `Staged Changes (n)` as its own section | done; appears only when something is staged, with its own tree and expansion state |
| Section header actions | done: Stage All / Unstage All on hover, and a `…` menu with Stash All Changes and Refresh |
| `Merge Conflicts (n)` section | done; shown above the others while a merge, rebase, cherry-pick or revert is unresolved |
| Resolve a conflict | done: open in VS Code's merge editor, take current, take incoming, or mark resolved |
| In-progress operation banner | done, naming what is being merged, with an Abort link |
| Per-file stage / unstage / discard / open changes | done, on hover and in the context menu |
| Per-file context menu | done, matching Visual Studio's: Open, Stage/Unstage, Undo Changes, View History, Compare with Unmodified, Blame (Annotate), Reveal in File Explorer, Ignore and Untrack item. "Review changes with Copilot" is deliberately left out |
| Per-folder context menu | done: the file menu applied to everything beneath the folder, as one git command with the directory as pathspec. Open, Compare and Blame are shown disabled with the reason rather than dropped, which is what VS does. Conflict folders get no menu, because a conflict is resolved a file at a time |
| Change-type colouring per file | done, using the theme's `gitDecoration` colours |
| `Stashes (n)` list with `{ n } On <branch>: <message>` | done |
| Stash apply / pop / drop, `Drop All` | done |
| Activity-bar badge with the change count | done; see `setBadge` for why clearing it takes two writes |
| Multiple repositories in one workspace | the extension side tracks an active repository, but the first one is shown and switching is not surfaced in the UI yet |

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

### Reveal in File Explorer

Hands off to VS Code's own `revealFileInOS`, which knows what the file manager
is called on each platform. A deleted file is still listed in Changes and has
nothing left to select, so the folder that held it is revealed instead - walking
up, because a deletion that emptied a folder takes the folder with it.

## Git Repository window (commit graph)

A `WebviewPanel` in the editor area.

| Visual Studio element | Status |
| --- | --- |
| Toolbar: Refresh / Fetch / Pull / Push / Sync | done |
| `Filter History` box | done, filters on subject, author and hash |
| `Branch / Tag: <name>` breadcrumb | done |
| History of one file or folder | done, from the sidebar's "View History"; `git log --follow` so a file's history survives a rename, with the path named in the breadcrumb and a "Show all commits" link back. Incoming/Outgoing is not split in this mode, because those counts are about the branch, not the file |
| Branches / Tags pane, nested on `/` | done, with a pane filter and a draggable splitter |
| Refs pane folds away | done; folding takes the divider with it and hands the room to the history |
| `remotes/<remote>` and `tags` nodes | done |
| `Pull Requests` node | placeholder; labelled `Merge Requests` for GitLab, see `vsGitStyle.reviewProvider` |
| `Incoming (n)` group with Fetch / Pull links | done |
| `Local History (n Outgoing)` group with Push / Sync links | done |
| Commit graph with coloured lanes and merge curves | done, SVG, lanes computed in [src/git/graph.ts](src/git/graph.ts) |
| Branch / Tag chips per commit | done, ranked so the current branch and tags survive the cap |
| Message / Author / Date / ID columns | done |
| Click to select | done, fills the commit details pane |
| Card on hover | done: resting the pointer on a commit names the commit, author and committer with both addresses and both dates, the repository path and the message. It waits before appearing so running down the list does not flash one per row, cannot take the hover from the row underneath, and is placed by the arithmetic that keeps the context menu on screen |
| Commit details pane | done: docked across the bottom, with a side-by-side diff of the selected file, change navigation, and a metadata rail holding the message, author/committer, clickable parents, refs and a folder tree of the changed files |
| Side-by-side diff inside the pane | done: whole file on both sides, synced vertical scroll, word-level highlight inside an edited line, `↑` `↓` between changes, `-n` `+n` tallies ([src/git/diff.ts](src/git/diff.ts), [media/diffview.js](media/diffview.js)). The rows are windowed like the commit list, so a 20,000-line file puts a screenful in the DOM |
| Syntax colouring in the diff | done, [media/syntax.js](media/syntax.js): a lexer for comments, strings, numbers and keywords. One C-like grammar covers TypeScript/JavaScript, C#, Java, C/C++, Go, Rust, Swift, Kotlin, Scala, PHP and Dart; there are also Python, Ruby, shell and PowerShell, SQL, CSS/SCSS/Sass/Less, JSON, YAML and XML/HTML/XAML, including MSBuild project files. Block comments and docstrings carry across lines. A file with no lexer is left plain rather than guessed at |
| Click a file in the pane | done, shows its diff in the pane; double-click opens a real editor diff at that commit via the `vsgitstyle-blob:` scheme |
| Double-click a commit | done, opens the whole commit as a read-only patch |
| Commit context menu | done ([src/git/commitOps.ts](src/git/commitOps.ts)): View Commit Details, Checkout (--detach), Compare Commits, New Branch, New Tag, Revert, the three resets, Cherry-pick, Go to Parent / Go to Child, Show Outgoing / Incoming Only, New Worktree From, Copy Commit ID, View Full Patch, Refresh. The menu is asked for on right-click rather than shipped with every row, because what applies depends on the commit. "Add to Chat", "Review Commit" and "Squash Commits" are left out: each would be a button for something this extension does not do |
| Eye toggle on a branch row | done: puts that branch into the history beside the scope, several at once, the way Visual Studio draws them; the scope's own eye is on and locked |
| Branch context menu | done ([src/git/branchOps.ts](src/git/branchOps.ts)): checkout, detached checkout, new branch from, merge, rebase, the three resets, cherry-pick, rename, delete, view history, compare, toggle in history, fetch/pull/push/sync and new worktree. Entries that cannot apply are shown disabled with the reason; anything that can cost work confirms first, and what git cannot undo says so |
| Paging | `Load more commits`, page size from `vsGitStyle.graphPageSize` (default 200); incoming commits get their own budget so a large fetch does not truncate Local History |
| Row virtualization | done; only the rows on screen are in the DOM, so an 8,000-commit history costs what 200 does |
| Stays current | reloads when the repository changes anywhere - the sidebar, a terminal, another editor - not only on its own actions |
| Resizable columns | not done; the grid template is fixed except for the graph column |
| Resizable details pane, hideable | done: draggable dividers for the pane's height and the rail's width, a maximize toggle, a toolbar toggle and the context menu's `View Commit Details` to bring it back; all of it persists |

### How the graph is computed

`git log --date-order` supplies each commit's hash, parents, author, committer,
date, refs and subject. [src/git/graph.ts](src/git/graph.ts) then assigns lanes: `lanes[i]` holds
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

### Bounding a row, not just the rows

The diff uses the same windowing, and still hung once with it in place: a
minified line was drawn one element per token - 496,452 elements for forty
rows. So what is inside a row is bounded too. A line is cut to at most 120
pieces (colour is dropped first, the diff highlight last), a line over 10,000
characters is not lexed at all, and the column's width is stated in `ch` from
the widest line rather than measured, because `width: max-content` on a
windowed list makes the browser lay out every row to find the widest.

Reads shell out to git with machine-readable formats (`status --porcelain=v2 -z`,
`for-each-ref`, `stash list --format`, `log --format`). Network operations go
through the built-in `git.fetch` / `git.pull` / `git.push` / `git.sync` commands
so VS Code's credential plumbing stays in play.

## When it hangs

*VS Git Style: Open Diagnostics Log* (command palette) opens an append-only
JSONL file in the extension's global storage. Every risky operation writes a
`begin` line before it starts and an `end` line when it finishes, synchronously,
so the log survives the window being killed - which an OutputChannel does not.

Read it from the bottom. A trailing unmatched `begin` names what never came
back, and which side it was on: `fileDiff.read` is the extension host, in git or
the parser; `fileDiff.render` is the webview, since that record is closed by the
webview's own acknowledgement. The `end` lines carry rows, spans and
milliseconds, so a run that merely crawled is as legible as one that stopped.
The log is trimmed to 256 KB when a session opens it.

The mechanism is in [src/diagnostics.ts](src/diagnostics.ts), free of `vscode`
so it is unit-tested; the file and the command are in
[src/diagnosticsFile.ts](src/diagnosticsFile.ts). Its first real use found a
lexer that spun on a Java annotation: the read ended in 89 ms and the render
never did.

## Deliberately deferred (placeholders in place)

- **Keyboard navigation and screen-reader support** — `installKeyboardNavigation()`
  in both [media/main.js](media/main.js) and [media/repo.js](media/repo.js) is an
  empty hook. Every row already carries `role`, `aria-level` and `aria-expanded`,
  so a future pass needs a roving tabindex plus arrow/Home/End handling — and, in
  the graph window, must drive the scroll position and let the windowing rebuild
  the row, because a focused row can now be scrolled out of the DOM entirely.
- **Pull / merge requests** — the node is a label only; populating it needs the
  provider's API and a token (GitHub, GitLab, Azure DevOps).
- **Switching repositories** in the sidebar — the extension side already keeps
  an active root and accepts a change; the control that would pick one is not
  drawn yet.

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

The rule the code follows: anything that can be decided without a browser lives
in its own module and is unit-tested; everything else is rendering, and is
tested in a real browser. `src/git/` never imports `vscode`, and every module in
`media/` except the two renderers is free of the DOM, so each has a matching
test file.

`npm test` compiles and runs the suite with node's built-in runner - no test
framework. 274 tests in [tests/](tests/):

Against git itself, in throwaway repositories built in the temp directory:

- **[tests/readers.test.js](tests/readers.test.js)** - the status snapshot,
  `readGraph`, `readRefs`, commit details and provider detection: every change
  type at once, ahead/behind against an upstream, stashes, a conflicted merge
  and its resolution, abort, amend, discard, details for a merge and a root
  commit, and the history of a folder - `--follow` is passed either way, and
  git's behaviour when given a directory is relied on, so it is pinned.
- **[tests/fileActions.test.js](tests/fileActions.test.js)** - the file menu's
  git-facing actions: ignore-and-untrack (including a file that was never
  tracked, where `git rm --cached` fails outright, a .gitignore with no
  trailing newline, and a repeated ignore) and file-scoped history (only the
  commits that touched the file, followed through a rename).
- **[tests/branchOps.test.js](tests/branchOps.test.js)** and
  **[tests/commitOps.test.js](tests/commitOps.test.js)** - which menu entries
  apply to a given branch or commit, what each is called, which are disabled
  and why, what has to be confirmed, and the exact git arguments behind each.
- **[tests/diff.test.js](tests/diff.test.js)** - one file's changes as
  aligned side-by-side rows: additions, deletions, edits with their
  intra-line spans, a file too large for whole-file context falling back to
  hunks with gap rows, and a removed line whose own text starts with `--`.

From captured output or synthetic input, no git needed:

- **[tests/parse.test.js](tests/parse.test.js)** - the porcelain v2 parser, the
  log and name-status parsers, and remote URL handling. `parseStatus` was
  extracted as a pure function so the format's awkward corners can be fed in
  directly.
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
- **[tests/graphview.test.js](tests/graphview.test.js)** - lane geometry and
  the graph column's width, the history filter, and ref ranking: the
  checked-out branch and tags survive the chip cap ahead of remotes, and a
  local branch with a slash in it is ranked as if it were remote - a known
  limitation, pinned deliberately.
- **[tests/diffview.test.js](tests/diffview.test.js)** - the details pane's
  arithmetic: the widest line with tabs expanded, change anchors and which one
  is current, the changed-files tree and which of its rows are visible.
- **[tests/syntax.test.js](tests/syntax.test.js)** - the lexer, per language:
  comments, strings, numbers and keywords, block comments carrying across
  lines, the segment cap, and - with a timeout so a regression fails instead of
  wedging the run - every character that opens a word without being one.
- **[tests/format.test.js](tests/format.test.js)** - dates in whatever locale
  the machine has, and popup placement that keeps a menu or card on screen.
- **[tests/changesview.test.js](tests/changesview.test.js)** - the extension a
  file is grouped under (a dotfile is its own group) and the folder keys an
  expand-all touches.
- **[tests/diagnostics.test.js](tests/diagnostics.test.js)** - record
  formatting, trimming the log to its limit on a line boundary, parsing it back,
  and finding the `begin` that never got its `end`.

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
so no dependency - and checks what node cannot. 59 checks, covering:

- the windowing: the scroll height is what the whole history would have been
  and never moves, the rows on screen are the right commits with no gaps at any
  scroll position, the DOM stays bounded, and selecting, collapsing a group and
  filtering all survive it;
- the details pane: both sides of the diff hold the same rows so a deletion
  sits opposite its replacement, the sides scroll together, every row kind is
  drawn, the diff is coloured and a changed word keeps its colour under the
  highlight, clicking a file leaves the changes tree where it was;
- the worst rows: a 20,000-line whole-file diff and a minified line both open
  promptly, stay bounded, and do not state the column millions of pixels wide;
- the popups: the context menu closes on Escape, a click or right-click
  elsewhere, the wheel and losing focus - but not on the re-render that opening
  it causes; the branch and commit menus carry what the host described, with
  icons, ticks, shortcuts and disabled entries that do nothing when clicked;
  the hover card is delayed, stays on screen, never steals the pointer and is
  gone while a menu is up;
- the refs pane: every branch row carries an eye, another eye brings that
  branch into the history, and the pane folds away and back.

It also reports the render cost.

```
npm run preview-check -- --rows=8000 --shot=out.png
```

`--rows` sets how long the synthetic history is, `--width` and `--height` the
viewport, `--shot` writes a screenshot, `--keep` leaves the browser profile
behind and `--debug` shows the browser. Set `VSG_BROWSER` if neither Edge nor
Chrome is where it is looked for. It is not part of `npm test`, which stays
dependency-free and headless.

The Git Changes view has no browser harness of its own, so its menus and hover
buttons are checked by eye; only the git behind them is tested.

## Measured against

Lane layout is checked two ways: the computed rows are rendered as ASCII and
compared against `git log --graph` for the same revisions, and every parent edge
is then walked down the graph row by row to confirm the line is drawn on each
intervening row and lands on the parent's dot. Across the four repositories
below that is **1,215 parent edges with no gaps, no wrong endings and no lane
collisions**.

| repository | commits | lanes | refs | notes |
| --- | --- | --- | --- | --- |
| a client application | 459 | 4 | 33 | 45 merges, 23 tags, 7 remote branches, self-hosted GitLab |
| a game project | 432 | 3 | 3 | no remote |
| a worktree of the game project | 410 | 3 | 3 | |
| scratch repo | 10 | 3 | 11 | see below |

Read timings on the client application: `readRefs` 46 ms, `readGraph` over all 459
commits 143 ms, `git status` snapshot 148 ms, tree build 0.2 ms.

The scratch repository was built to cover what the real ones do not: every
change type (modify, add, delete, rename with a space in the path, untracked,
staged), three stashes, a tag, and an `origin` remote with 7 outgoing and 2
incoming commits.

Not yet exercised: a history needing more than 4 concurrent lanes, multiple
repositories in one workspace, and any remote operation that prompts for
credentials — fetch/pull/push have only been run against a local bare remote.
