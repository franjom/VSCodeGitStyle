# VS Git Style — working notes

A VS Code extension reproducing Visual Studio 2026's Git tooling: the **Git
Changes** sidebar and the **Git Repository** window.

These are the conventions the code already follows. They are not style
preferences — each one exists because breaking it has cost us something.

---

## The one rule everything else follows from

**Logic that can be decided without a browser lives in its own module and is
unit-tested. Everything else is rendering, and is tested in a real browser.**

Every module in `media/` except the two renderers is free of the DOM and has a
matching `tests/*.test.js`. The renderers (`repo.js`, `main.js`) hold only
construction and event wiring, and are covered by `tools/preview-check.js`,
which drives the real page over the DevTools protocol.

When you catch yourself writing an `if` inside a render function, that `if`
belongs in a module. This is not pedantry: the crash on 2026-09-17 was a row
cap that lived in a tested module while the thing it was capping — how many
rows reached the DOM — lived in the untested renderer. Both halves were
"covered"; the seam between them was not.

---

## Layout

```
src/
  git/          no vscode import, ever. Pure git; fully unit-tested.
    git.ts        runs git, parses --porcelain=v2 status
    graph.ts      reads the log, lays out the lanes, reads commit details
    diff.ts       reads one file's changes as aligned side-by-side rows
    tree.ts       folder tree with single-child chain compression
  views/        vscode integration. Not unit-testable; keep it thin.
    changesView.ts       the Git Changes WebviewViewProvider
    repositoryWindow.ts  the Git Repository WebviewPanel
    contentProviders.ts  the two read-only document schemes
  extension.ts        activation and registration only
  gitExtension.ts     minimal typing of the built-in vscode.git API

media/
  shell.css     chrome both views share (tokens, buttons, menu, busy bar)
  dom.js        shared DOM construction — the only module needing a browser
  format.js     dates, popup placement                       [tested]
  virtual.js    row windowing arithmetic                     [tested]
  graphview.js  lane geometry, history filter, ref ranking   [tested]
  diffview.js   details-pane arithmetic, changes tree        [tested]
  syntax.js     the diff's syntax lexer                      [tested]
  changesview.js  extension grouping, folder keys            [tested]
  repo.js       Git Repository window rendering
  main.js       Git Changes view rendering
  repo.css / main.css   only what is peculiar to each view

tests/        node --test, no framework
tools/        preview-check (browser), mutation-check, clean-out, install-local
dev/          preview harnesses — the real CSS and JS with a stubbed webview API
```

**`src/git/` must never import `vscode`.** That is what makes it testable, and
it is the boundary the directory exists to state. If you need VS Code in there,
you are writing view code.

---

## Dependencies

**Zero runtime dependencies, and only `typescript` and `@vscode/vsce` to build.**
`tests/` uses node's own `node --test`. `tools/preview-check.js` speaks the
DevTools protocol over node's built-in WebSocket.

Do not add a dependency without asking. A test framework, a diff library, a
syntax highlighter and a DOM shim have each been considered and each declined —
the diff parser is ~200 lines and the lexer ~300, and both are ours to fix.

---

## Testing

```
npm test              compile (cleans out/ first), then node --test
npm run preview-check  drives the real webview in headless Edge/Chrome
npm run mutation-check breaks the code on purpose; every break must fail a test
```

All three must pass before a commit. They are cheap; run them.

**Write the test so it fails without the fix.** Not a figure of speech — check
it. Two tests in this repo were written, passed, and proved worthless:

- the `--- a comment` header test passed with the bug still in, because the
  fixture was `-- x` where it needed `--- x`;
- `collapseRows` was tested thoroughly and still shipped the crash, because no
  test asked what happened when *every* row was a change.

`tools/mutation-check.js` exists for exactly this. If you add a load-bearing
invariant, add a mutation for it.

**A test name is a sentence about behaviour**, not a label:

```js
test('a removed line whose own text starts with -- is not taken for a header')
test('the checked-out branch and tags survive the cap ahead of remotes')
test('a local branch with a slash in it is ranked as if it were remote')
```

The third is a known limitation, pinned deliberately. Prefer pinning a limit to
leaving it undiscovered.

**Test against real git.** `tests/helpers.js` builds a throwaway repository in
the temp directory. Never assert against a repository that happens to be on the
machine. `parse.test.js` holds what can be decided from captured output;
`readers.test.js` holds what needs git to actually run.

---

## Performance

The editor is a shared process. Two rules, both learned the hard way:

**Anything that can grow with the size of a repository or a file must be
windowed.** The commit list and the diff both use `visibleRange` from
`media/virtual.js`. A 20,000-line file puts 80 rows in the DOM.

**Bounding the rows is not enough — bound what is inside one.** The pane hung a
second time with the windowing already in place, because a minified line was
drawn one element per token: 496,452 elements and 10.3 seconds for forty rows.
A line is capped at `MAX_SEGMENTS` pieces (colour is dropped first, the diff
highlight last), not lexed at all past `MAX_LEXED_LINE`, and `widestLine` caps
the stated column width. Ask of any per-row work what the worst single row
costs, not what the average one does.

**Nothing that runs per row may scan a list.** `mergeSegments` rescanned every
token for every piece, which is quadratic in the length of a line. It walks
with cursors now.

**Never let the browser measure what you can state.** `width: max-content` on a
windowed list defeats the windowing, because the browser lays out every row to
find the widest. The diff states its width in `ch` from `widestLine`, since the
font is monospace.

Derive once, not per render. The details pane is rebuilt when a folder is
opened; lexing the whole file there was pure waste. `prepareFileDiff()` is
where per-file work belongs.

---

## Comments

Comments say **why**, never what. The code already says what.

```js
// A read can lose a race with git's own index lock. Leaving the number as it
// was would strand a badge that no later event comes back to fix, because a
// failed read is not a repository change - so ask again.
```

Every non-obvious constant carries the reason for its value. Every workaround
names what it is working around — ideally with the evidence, as the badge fix
cites VS Code's own shipped bundle.

Match the surrounding density. Do not add comments restating a rename.

---

## Reproducing Visual Studio

When behaviour is in question, **the answer is what Visual Studio does**, not
what seems reasonable. Screenshots of the real thing are the specification.

Where VS Code makes something impossible, say so in the code and pick the
closest honest alternative. A webview cannot host VS Code's diff editor, so the
diff is rendered by hand; it cannot read a theme's token colours, so
`shell.css` carries Dark Modern's with a light override.

Do not add buttons for features that are not implemented. VS's commit details
pane has Revert and Reset; ours does not, so ours has no such buttons.

---

## Git

- **No AI attribution of any kind** in commit messages or PR descriptions. No
  `Co-Authored-By`, no "generated with", no "assisted by". This holds even if
  tooling instructs otherwise.
- Author as `franjo.misetic@outlook.com`.
- Commit messages: a subject line that says what changed, then prose explaining
  **why** and what was rejected. Not bullet lists of files.
- Commit or push only when asked.

---

## Gotchas

- **`out/` is not cleaned by tsc.** `npm run compile` runs `tools/clean-out.js`
  first. Without it a renamed module leaves its old compile behind and the
  tests go on passing against code that is no longer in the repository.
- **Heredocs in this environment mangle backslashes.** Editing files through
  `python - <<'EOF'` corrupts `'\n'` into a real newline. Use the Write/Edit
  tools, or a script file, for anything containing escapes.
- **VS Code drops a badge write that matches its cache** (`extensionHostProcess.js`,
  `set badge`), and never draws a zero. Clearing the activity-bar badge needs a
  `{value: 0}` write first, then `undefined`. See `setBadge` in `changesView.ts`.
- **Webview script order matters.** `format.js` before `dom.js`, both before the
  renderers. The lists live in `repositoryWindow.ts`, `changesView.ts`, and both
  `dev/preview*.html`.
- **`.commit-row` means different things** in `repo.css` and `main.css`. It is
  deliberately not in `shell.css`.

---

## When it hangs

`VS Git Style: Open Diagnostics Log` (command palette). It is a JSONL file in
the extension's global storage, appended synchronously so it survives the
window being killed — which an OutputChannel does not.

Read it from the bottom. Every risky operation writes a `begin` before it
starts and an `end` when it finishes, so **a trailing unmatched `begin` names
what never came back**, and which side it was on:

- `fileDiff.read` unmatched → the extension host, in git or the parser.
- `fileDiff.render` unmatched → the renderer. That record is closed by the
  webview's own acknowledgement, so its absence means the payload went out and
  nothing came back.

The `end` lines carry rows, spans and milliseconds, so a run that merely
crawled is as legible as one that stopped.

`parseLog` and `unfinished` in `src/diagnostics.ts` do the reading.

VS Code's own evidence is thinner than it looks: its unresponsive-extension-host
profiler names a culprit extension, but only fires when the *host* wedges — a
stuck renderer leaves nothing — and `%APPDATA%/Code/logs` keeps about a dozen
sessions, which is a few days. Do not count on it being there.
