# Handoff

Paste the block below into a fresh Claude Code session started in this folder
(`D:\VsGitStyle`). Everything it refers to is committed.

---

## Prompt

You are picking up **VS Git Style**, a VS Code extension that reproduces the
look and feel of Visual Studio 2026's Git tooling. I built it with Claude in a
previous session; the working tree is clean at commit `7da6b8a` with 14 commits
of history. Read `README.md` first — it documents what is implemented, what is
deliberately deferred, and how the graph layout works.

**The goal was and remains MVP look-and-feel parity, not functional parity with
Visual Studio.** Don't chase completeness for its own sake.

### What exists

Two views, both webviews styled entirely with VS Code theme tokens:

- **Git Changes** — a `WebviewView` in its own activity-bar container
  (`media/main.js`, `media/main.css`, `src/changesView.ts`). Branch dropdown,
  fetch/pull/push/sync, outgoing/incoming counts, commit box with AI message
  generation, `Commit All` / `Commit Staged` split button, Amend, and four
  sections in this order: Merge Conflicts, Staged Changes, Changes, Stashes.
- **Git Repository** — a `WebviewPanel` with the commit graph
  (`media/repo.js`, `media/repo.css`, `src/repositoryWindow.ts`,
  `src/graph.ts`). Branches/tags pane, Incoming and Local History groups, SVG
  lane graph, Message/Author/Date/ID columns, history filter, paging, and a
  commit details pane.

Supporting code: `src/git.ts` (shells out to git, owns `parseStatus`),
`src/tree.ts` (folder tree with single-child chain compression),
`src/gitExtension.ts` (minimal typing of the built-in `vscode.git` API).

### Commands

```
npm test               # compile + 65 tests, node's built-in runner, ~15s
npm run mutation-check # reintroduces 7 bugs, checks the tests catch them
npm run preview-check  # drives the preview in headless Edge and checks the graph window
npm run package        # builds vs-git-style-<version>.vsix (~110 KB)
```

`dev/preview.html` and `dev/preview-repo.html` open in a browser and render the
real CSS/JS against captured models, so the design can be iterated on without
launching an Extension Development Host. Press F5 for the real thing.

### Rules for changing this code

1. **Run `npm test` before and after any change**, and `npm run mutation-check`
   when you touch `src/git.ts`, `src/graph.ts` or `media/virtual.js`. The git
   handling broke twice during development without anything noticing, which is
   why the suite exists. When you touch the graph window's rendering, run
   `npm run preview-check` too — it is the only thing that exercises layout.
2. **Verify against real git, not reasoning.** Build a throwaway repo in the
   temp directory (`tests/helpers.js` has a `TestRepo` class for exactly this)
   and check the actual output. Several bugs below were only found that way.
3. **Do not edit `media/*.js` or `src/*.ts` through shell heredocs.** Backslash
   escapes get eaten in transit, which silently turned `\n` into a real newline
   inside a string literal and `\u0000` into a raw NUL byte. Use the Write and
   Edit tools.
4. Match the surrounding style: no semicolon-free lines, comments that explain
   *why* rather than *what*, and no new runtime dependencies (the extension
   currently ships none).

### Non-obvious things that will bite you

These each cost a real bug. They are commented in the code, but know them:

- **`git status --porcelain=v2` carries two independent states per file**: `X`
  is the index, `Y` is the worktree. A file edited, staged, then edited again is
  `MM` and belongs in *both* lists. A single entry with a boolean flag cannot
  represent it.
- **A rename record's original path is a separate NUL-terminated token that must
  be consumed, not just read** (`tokens[++i]`). It only misbehaves when the old
  path itself looks like a status record, which is why the test feeds it
  `? old.cs`.
- **The graph must pull the main line back to the leftmost lane after a merge.**
  Without it the layout is still topologically correct but drifts right and
  spends lanes it doesn't need, unlike `git log --graph` and Visual Studio.
  Lane indices are otherwise never compacted, so a line that merely passes a row
  keeps the same x on both edges.
- **`git show` prints no file list for a merge commit** — use `--first-parent`.
  And the initial commit needs `--root` or it shows nothing either.
- **`git checkout -- <folder>` fails** with "pathspec did not match any file(s)
  known to git" when the folder holds nothing tracked, so `discardFolder`
  guards it.
- **`git commit --amend -m ''` silently blanks the message.** Amending with an
  empty box passes `--no-edit`.
- **Network operations go through the built-in `git.fetch` / `git.pull` /
  `git.push` / `git.sync` commands**, not raw git, so VS Code's credential
  plumbing is used. This is verified working against a private GitLab over
  HTTPS. Everything else shells out directly.
- **VS Code gives webviews no access to the active file icon theme.** The
  language badges in `media/main.js` are mapped from the extension by hand.
- **The tree tracks which nodes are *closed*, not open** (`collapsedNodes`), so
  folders default to expanded.
- **A self-hosted host cannot be identified by name.** `git.example.com` says
  nothing, so provider detection falls back to a committed CI file
  (`.gitlab-ci.yml` → GitLab). `vsGitStyle.reviewProvider` overrides it.
- **Only the commit rows on screen are in the DOM.** Each group in the graph
  window is a windowed region, and the padding standing in for the hidden rows
  is what holds the scrollbar still. Two consequences: a row you are holding a
  reference to can vanish on the next scroll, and anything that rebuilds the
  rows must put the scroll position back — emptying the container collapses its
  height and drags the scroll to the top with it.
- **A region's offset is measured, never computed.** Group headers, their
  borders and the empty-state placeholders sit between the regions, and adding
  up their heights by hand is how that goes wrong the first time something
  between them changes.
- **The viewport height changes without a window resize** — the icon font
  arriving retags the toolbar, the splitters move the panes, and a hidden
  webview measures nothing until it is shown. That is why a `ResizeObserver`
  watches the scroller rather than a `resize` listener watching the window.
- **The preview harnesses are not the extension.** `dev/preview.html` once
  uppercased every section header because `#frame .title` is a descendant
  selector. If something looks wrong only in the browser preview, suspect the
  harness first.

### Verified against

Real repositories, not just synthetic data: a 459-commit GitLab repo with 45
merges and 23 tags, and two ~430-commit repos. The lane layout was compared row
for row against `git log --graph`, and 1,215 parent edges were walked for
continuity with no gaps. Read timings: refs 46 ms, a 459-commit graph 143 ms,
`git status` 148 ms.

### Backlog, in the order I'd rank it

Nothing here is urgent; the extension is usable as it stands.

1. **Resizable columns** in the graph window. The grid template is fixed except
   for the graph column, which is sized from the lane count.
2. **Multi-repo switcher.** Only the first repository in a workspace is shown;
   `ChangesViewProvider` already tracks all of them and the model carries a
   `repos` array, so this is mostly UI.
3. **Real Seti file icons**, by vendoring `seti.woff` (MIT) and its class map,
   replacing the hand-mapped language badges.
4. **Keyboard navigation and screen-reader support.** Deliberately deferred by
   the user. `installKeyboardNavigation()` in both `media/main.js` and
   `media/repo.js` is an empty hook, and rows already carry `role`,
   `aria-level` and `aria-expanded`, so a pass needs a roving tabindex plus
   arrow/Home/End handling. In the graph window it also has to drive the scroll
   position rather than move focus between live rows, since a focused row can
   be scrolled out of the DOM.
5. **Pull/merge requests.** The node is a label only; populating it needs the
   provider's API and a token.
6. **Windowing the Git Changes tree**, if a repository ever turns up with enough
   changed files to matter. The graph window was the one that needed it; the
   sidebar's tree is still built whole.

The row windowing was checked in headless Edge over the DevTools protocol
(`npm run preview-check`) at 10, 200, 2,000 and 8,000 commits: the scroll height
holds, the rows on screen are the right commits with no gaps at every scroll
position, and the DOM stays at ~44 rows and ~740 nodes whatever the length.
Render cost went from 2,245 ms to 17 ms at 8,000 rows.

Untested paths: push, pull and sync against a remote that prompts for
credentials (fetch is proven); more than 4 concurrent graph lanes; multiple
repositories in one workspace. The windowing has not been watched by a human in
the real Extension Development Host — only in the browser harness, which uses
the same CSS and JS.

### How to work with me

Ask before installing anything into my real VS Code or touching repositories
outside this folder. Don't run push, pull or any mutating git command against my
work repositories — build throwaway repos instead. Tell me plainly when
something doesn't work rather than reporting success.

---

## Where things stand

- 15 commits at `295b5f8`, plus the row virtualization work on top of it.
- `vs-git-style-<version>.vsix` is built and gitignored. Install the newest build
  with `npm run install-local`.
- Toolchain used: Node 22.14, git 2.39.1, VS Code 1.137.
