# VS Git Style

A VS Code extension that reproduces the look and feel of the Visual Studio 2026
**Git Changes** panel. MVP scope: the sidebar panel is functional; the full
Git Repository window (commit graph) is stubbed for a later pass.

## Running it

```
npm install
npm run compile
```

Then press <kbd>F5</kbd> ("Run Extension"). In the Extension Development Host,
click the branch icon in the activity bar to open **Git Changes**.

To iterate on the visual design without launching the extension host, open
[dev/preview.html](dev/preview.html) in a browser. It loads the real
`media/main.css` and `media/main.js` against a fake repository model
(`dev/preview-model.js`) with a stubbed webview API.

## What is implemented

The panel is a `WebviewView` in its own activity-bar container, styled entirely
with VS Code theme tokens so it follows the active colour theme.

| Visual Studio element | Status |
| --- | --- |
| Branch dropdown (checkout on change) | done |
| Fetch / Pull / Push / Sync buttons | done, delegated to the built-in git commands |
| `⇅ n / n` outgoing / incoming counts | done, from `rev-list --left-right --count` |
| "View all commits" link | wired to the phase-2 command |
| Commit message box, `Enter a message <Required>` | done, draft persisted across reloads |
| AI message generation (sparkle button) | done, via the VS Code Language Model API when a provider exists |
| `Commit All` split button (+ and Push / and Sync / Commit Staged) | done |
| `Amend` checkbox | done |
| `Changes (n)` tree: repo root, folders, files | done, single-child folder chains collapsed like VS |
| Per-file stage / unstage / discard / open changes | done, on hover and in the context menu |
| Change-type colouring per file | done, using the theme's `gitDecoration` colours |
| `Stashes (n)` list with `{ n } On <branch>: <message>` | done |
| Stash apply / pop / drop, `Drop All` | done |
| Multiple repositories in one workspace | first repository is shown; switching is not surfaced in the UI yet |

Reads are done by shelling out to git with machine-readable porcelain formats
(`status --porcelain=v2 -z`, `for-each-ref`, `stash list --format`). Network
operations go through the built-in `git.fetch` / `git.pull` / `git.push` /
`git.sync` commands so VS Code's credential plumbing stays in play.

## Deliberately deferred (placeholders in place)

- **Git Repository window / commit graph** — [src/repositoryWindow.ts](src/repositoryWindow.ts)
  holds the command and a description of the intended implementation. The
  "View all commits" link already calls it.
- **Keyboard navigation and screen-reader support** — `installKeyboardNavigation()`
  in [media/main.js](media/main.js) is an empty hook. Every row already carries
  `role="treeitem"`, `aria-level` and `aria-expanded`, so a future pass only
  needs a roving tabindex plus arrow/Home/End handling.
- **Pull Requests node** — needs GitHub / Azure DevOps authentication.
- **Row virtualization** — fine for the low thousands of rows; a graph over a
  large history will need it.

## Settings

- `vsGitStyle.confirmDiscard` (default `true`) — confirm before discarding a file.
- `vsGitStyle.showIgnoredFiles` (default `false`) — include ignored files in the tree.
