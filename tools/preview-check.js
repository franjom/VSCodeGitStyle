'use strict';

/*
 * Drives dev/preview-repo.html in a real headless browser and checks the row
 * windowing: that the scroll height is what the full list would have been, that
 * the rows on screen are the right ones at every scroll position, and that the
 * DOM stays bounded however long the history is.
 *
 * The webview's rendering cannot be exercised from node - it needs layout,
 * scrolling and a frame loop - so this talks to Edge or Chrome over the DevTools
 * protocol with node's built-in WebSocket. No dependencies, same as the rest of
 * the project.
 *
 *   node tools/preview-check.js [--rows=2000] [--width=1400] [--height=900]
 *                              [--shot=<file.png>] [--keep] [--debug]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROW_H = 22;

// Overridable, so the layout can be checked at a width where the columns run
// out of room as well as at a comfortable one.
const VIEWPORT = {
  width: Number(arg('width', '1400')),
  height: Number(arg('height', '900')),
};

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  const fromEnv = process.env.VSG_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const found = BROWSERS.find(function (candidate) {
    return fs.existsSync(candidate);
  });
  if (!found) {
    throw new Error(
      'No Edge or Chrome found. Set VSG_BROWSER to a Chromium executable.'
    );
  }
  return found;
}

function arg(name, fallback) {
  const hit = process.argv.find(function (a) {
    return a.startsWith('--' + name + '=');
  });
  return hit ? hit.slice(name.length + 3) : fallback;
}

/**
 * The browser can still hold its profile when the run ends, so the one that
 * could not be deleted last time is cleared at the start of the next one. Left
 * to itself it would drop a directory into the temp folder on every run.
 */
function sweepOldProfiles() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith('vsg-preview-')) {
      try {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      } catch {
        // Still in use by a browser that has not finished exiting.
      }
    }
  }
}

function pause(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * The browser is asked for port 0 and writes the one it got into its profile.
 * A fixed port would be answered by a browser left over from an earlier run,
 * which then serves a stale page - and looks like a failure of the thing under
 * test rather than of the harness.
 */
async function waitForPort(profile) {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) {
        return port;
      }
    }
    await pause(100);
  }
  throw new Error('The browser never reported its debugging port.');
}

async function waitForTarget(port, url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      const targets = await response.json();
      const page = targets.find(function (t) {
        return t.type === 'page' && t.url === url;
      });
      if (page && page.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The browser has not finished opening its debugging port yet.
    }
    await pause(150);
  }
  throw new Error('The browser never reported a page target for ' + url);
}

/**
 * The process spawned here hands off to other browser processes, so killing it
 * alone leaves the page - and its hold on the profile - alive.
 */
function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

/** A minimal CDP client: enough to evaluate scripts and take a screenshot. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener('message', function (event) {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiting.reject(new Error(message.error.message));
    } else {
      waiting.resolve(message.result);
    }
  });

  const ready = new Promise(function (resolve, reject) {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', function () {
      reject(new Error('Could not open the DevTools socket.'));
    });
  });

  return {
    ready: ready,
    send: function (method, params) {
      const id = nextId++;
      socket.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
      });
    },
    close: function () { socket.close(); },
  };
}

async function evaluate(cdp, fn, argument) {
  // `settle` waits two frames: one for the queued window sync, one for its
  // paint. Every page-side helper needs it, so it is always in scope.
  const expression =
    '(function () { const settle = ' +
    settle.toString() +
    '; return (' +
    fn.toString() +
    ')(' +
    JSON.stringify(argument === undefined ? null : argument) +
    '); })()';
  const result = await cdp.send('Runtime.evaluate', {
    expression: expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      'Page threw: ' +
        (result.exceptionDetails.exception
          ? result.exceptionDetails.exception.description
          : result.exceptionDetails.text)
    );
  }
  return result.result.value;
}

// ------------------------------------------------------------- page-side code
// These run inside the browser, so they see the real repo.js state.

function readLayout() {
  const rows = document.querySelector('.rows');
  const rowsTop = rows.getBoundingClientRect().top;
  const offsetOf = function (node) {
    return Math.round(node.getBoundingClientRect().top - rowsTop + rows.scrollTop);
  };

  // Each group is its own window, with a group header between them, so the
  // regions are read apart rather than as one run of rows.
  const windows = [...rows.querySelectorAll('.row-window')].map(function (host) {
    const rendered = [...host.querySelectorAll('.commit-row')];
    return {
      top: offsetOf(host),
      height: Math.round(host.getBoundingClientRect().height),
      paddingTop: host.style.paddingTop,
      paddingBottom: host.style.paddingBottom,
      ids: rendered.map(function (row) {
        return row.querySelector('.id').textContent;
      }),
      // Where each rendered row sits inside the scrolled content, so gaps and
      // overlaps show up as arithmetic rather than as a picture.
      tops: rendered.map(offsetOf),
    };
  });

  return {
    scrollHeight: rows.scrollHeight,
    clientHeight: rows.clientHeight,
    scrollTop: rows.scrollTop,
    domNodes: rows.getElementsByTagName('*').length,
    rendered: rows.querySelectorAll('.commit-row').length,
    windows: windows,
  };
}

function scrollTo(to) {
  const rows = document.querySelector('.rows');
  rows.scrollTop = to;
  // Two frames: one for the scroll event's queued sync, one for its paint.
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { resolve(rows.scrollTop); });
    });
  });
}

function settle() {
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(resolve);
    });
  });
}

/** Clicks the row in the middle of the viewport, deep inside the history. */
function clickDeepRow(at) {
  const rows = document.querySelector('.rows');
  rows.scrollTop = at;
  return settle().then(function () {
    const before = rows.scrollTop;
    const rendered = [...rows.querySelectorAll('.commit-row')];
    const target = rendered[Math.floor(rendered.length / 2)];
    const id = target.querySelector('.id').textContent;
    target.click();
    return settle().then(function () {
      const selected = rows.querySelectorAll('.commit-row.selected');
      return {
        scrollBefore: before,
        scrollAfter: rows.scrollTop,
        clickedId: id,
        selectedCount: selected.length,
        selectedId: selected.length ? selected[0].querySelector('.id').textContent : null,
      };
    });
  });
}

function applyFilter(text) {
  const input = document.querySelector('.filter-input');
  const rows = document.querySelector('.rows');
  input.value = text;
  input.dispatchEvent(new Event('input'));
  return settle().then(function () {
    return {
      rendered: rows.querySelectorAll('.commit-row').length,
      scrollHeight: rows.scrollHeight,
      windows: rows.querySelectorAll('.row-window').length,
      subjects: [...rows.querySelectorAll('.commit-row .msg span')]
        .slice(0, 40)
        .map(function (s) { return s.textContent; }),
    };
  });
}

function collapseLocalGroup() {
  const rows = document.querySelector('.rows');
  const state = function () {
    return {
      rendered: rows.querySelectorAll('.commit-row').length,
      scrollHeight: rows.scrollHeight,
      scrollTop: rows.scrollTop,
      clientHeight: rows.clientHeight,
      windows: [...rows.querySelectorAll('.row-window')].map(function (host) {
        return {
          rows: host.querySelectorAll('.commit-row').length,
          top: Math.round(host.getBoundingClientRect().top - rows.getBoundingClientRect().top),
          paddingTop: host.style.paddingTop,
        };
      }),
    };
  };
  // Each click re-renders the rows, so the header has to be found again rather
  // than held on to across the toggle.
  const clickLast = function () {
    const headers = [...rows.querySelectorAll('.group-header')];
    headers[headers.length - 1].click();
    return settle();
  };
  return clickLast().then(function () {
    const collapsed = state();
    return clickLast().then(function () {
      return { collapsed: collapsed, expanded: state() };
    });
  });
}

/**
 * Drags the details divider, selects a commit, then drags again. Selecting
 * replaces the whole details pane, and a splitter holding the old element goes
 * on resizing a detached node - the drag looks dead until the next full render.
 *
 * The pane is docked across the bottom, so the divider moves vertically and
 * dragging it upwards is what makes the pane taller.
 */
function dragSplitterAroundSelection() {
  const rows = document.querySelector('.rows');
  const splitter = document.querySelector('.splitter.horizontal');
  const heightNow = function () {
    return Math.round(document.querySelector('.details').getBoundingClientRect().height);
  };

  const drag = function (by) {
    const box = splitter.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    splitter.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y })
    );
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y - by })
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y - by }));
    return settle();
  };

  const before = heightNow();
  return drag(60).then(function () {
    const afterFirst = heightNow();
    // Select a commit, which rebuilds the details pane.
    const row = rows.querySelector('.commit-row');
    row.click();
    return settle()
      .then(settle)
      .then(function () {
        const afterSelect = heightNow();
        return drag(60).then(function () {
          return {
            before: before,
            afterFirst: afterFirst,
            afterSelect: afterSelect,
            afterSecond: heightNow(),
          };
        });
      });
  });
}

/**
 * Selects a commit and reports on the side-by-side diff it brings up: whether
 * both sides were built, whether they line up row for row, and whether
 * scrolling one carries the other with it.
 */
function inspectDiffPane() {
  const row = document.querySelector('.rows .commit-row');
  row.click();
  return settle()
    .then(settle)
    .then(settle)
    .then(function () {
      const sides = [...document.querySelectorAll('.diff-side')];
      if (sides.length !== 2) {
        return { sides: sides.length };
      }
      const counts = sides.map(function (side) {
        return side.querySelectorAll('.diff-row').length;
      });
      const heights = sides.map(function (side) {
        return Math.round(side.querySelector('.diff-rows').getBoundingClientRect().height);
      });

      sides[0].scrollTop = 120;
      return settle()
        .then(settle)
        .then(function () {
          return {
            sides: 2,
            counts: counts,
            heights: heights,
            scrolled: sides[0].scrollTop,
            follower: sides[1].scrollTop,
            words: document.querySelectorAll('.diff-row .word').length,
            keywords: document.querySelectorAll('.diff-row .tok-keyword').length,
            comments: document.querySelectorAll('.diff-row .tok-comment').length,
            // A piece that is both changed and coloured proves the two
            // markings compose rather than one winning.
            both: document.querySelectorAll('.diff-row .word.tok-keyword, .diff-row .word.tok-type, .diff-row .word.tok-string').length,
            added: document.querySelectorAll('.diff-row.k-add').length,
            removed: document.querySelectorAll('.diff-row.k-del').length,
            gaps: document.querySelectorAll('.diff-row.k-gap').length,
            files: document.querySelectorAll('.changes .tree-row.change-file').length,
            selectedFiles: document.querySelectorAll('.changes .tree-row.change-file.selected').length,
            dirs: document.querySelectorAll('.changes .tree-row.group-node').length,
          };
        });
    });
}

/**
 * Scrolls the metadata rail down, clicks another file, and reports where the
 * rail ended up. Selecting a file rebuilds the whole pane, and a rail that
 * starts again from the top puts the file just clicked out of reach.
 */
function railScrollAcrossFileClick() {
  const scroller = document.querySelector('.meta-rail .scroll');
  scroller.scrollTop = scroller.scrollHeight;
  return settle().then(function () {
    const before = scroller.scrollTop;
    const files = [...document.querySelectorAll('.changes .tree-row.change-file')];
    const target = files[files.length - 1];
    const name = target.querySelector('.label').textContent;
    target.click();
    return settle()
      .then(settle)
      .then(function () {
        const after = document.querySelector('.meta-rail .scroll');
        return {
          scrollable: before > 0,
          before: before,
          after: after ? after.scrollTop : -1,
          clicked: name,
          selected: (document.querySelector('.changes .tree-row.change-file.selected .label') || {})
            .textContent,
        };
      });
  });
}

/**
 * Opens the generated file, whose every line changed, and reports what that
 * costs. A diff this dense used to be built in full - 20,000 rows in each
 * column - which wedged the window; the point of the check is that what
 * reaches the DOM follows the viewport, not the file.
 */
function inspectDenseDiff() {
  const files = [...document.querySelectorAll('.changes .tree-row.change-file')];
  const target = files.find(function (row) {
    return row.querySelector('.label').textContent.indexOf('designer') !== -1;
  });
  const started = performance.now();
  target.click();
  return settle()
    .then(settle)
    .then(settle)
    .then(function () {
      const elapsed = Math.round(performance.now() - started);
      const sides = [...document.querySelectorAll('.diff-side')];
      const host = sides[0].querySelector('.diff-rows');
      const rendered = sides.map(function (side) {
        return side.querySelectorAll('.diff-row').length;
      });

      // Halfway down, to prove the window moves rather than just starting small.
      sides[0].scrollTop = Math.round(sides[0].scrollHeight / 2);
      return settle()
        .then(settle)
        .then(function () {
          const firstNo = host.querySelector('.diff-row .ln');
          return {
            elapsed: elapsed,
            rendered: rendered,
            nodes: document.querySelectorAll('.diff-row').length,
            scrollHeight: sides[0].scrollHeight,
            followerTop: sides[1].scrollTop,
            leaderTop: sides[0].scrollTop,
            firstLineNo: firstNo ? Number(firstNo.textContent) : -1,
            changes: (document.querySelector('.details-toolbar .count') || {}).textContent,
          };
        });
    });
}

/**
 * Opens the minified bundle, whose lines run to tens of thousands of characters.
 * Bounding the rows is not enough on its own: a line coloured token by token
 * becomes a node per token, and a screenful of those is what hangs a renderer.
 */
function inspectWideDiff() {
  const files = [...document.querySelectorAll('.changes .tree-row.change-file')];
  const target = files.find(function (row) {
    return row.querySelector('.label').textContent.indexOf('.min.js') !== -1;
  });
  const started = performance.now();
  target.click();
  return settle()
    .then(settle)
    .then(settle)
    .then(function () {
      const elapsed = Math.round(performance.now() - started);
      const rows = [...document.querySelectorAll('.diff-row')];
      let worst = 0;
      for (const row of rows) {
        const n = row.querySelectorAll('.code *').length;
        if (n > worst) {
          worst = n;
        }
      }
      const host = document.querySelector('.diff-rows');
      return {
        elapsed: elapsed,
        rows: rows.length,
        worstRow: worst,
        total: document.querySelectorAll('.diff-row .code *').length,
        width: host ? Math.round(host.getBoundingClientRect().width) : -1,
        highlighted: document.querySelectorAll('.diff-row .word').length,
      };
    });
}

/**
 * Every way out of a context menu.
 *
 * A menu that can only be dismissed by choosing something is a trap, and this
 * regressed once without anything noticing: the dismissals lived in each
 * webview and were dropped when the two copies were merged into media/dom.js.
 */
function inspectMenuDismissal() {
  const menu = document.getElementById('menu');
  const rowOf = function () {
    return document.querySelector('.rows .commit-row');
  };
  const open = function () {
    rowOf().dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })
    );
    return settle();
  };
  const shown = function () {
    return !menu.hidden;
  };

  const result = {};
  return open()
    .then(function () {
      result.opens = shown();
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      return settle();
    })
    .then(function () {
      result.escape = !shown();
      return open();
    })
    .then(function () {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return settle();
    })
    .then(function () {
      result.clickAway = !shown();
      return open();
    })
    .then(function () {
      // A right-click on something with no menu of its own.
      document.body.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
      return settle();
    })
    .then(function () {
      result.rightClickAway = !shown();
      return open();
    })
    .then(function () {
      document.querySelector('.rows').dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      return settle();
    })
    .then(function () {
      result.scroll = !shown();
      return open();
    })
    .then(function () {
      window.dispatchEvent(new Event('blur'));
      return settle();
    })
    .then(function () {
      result.blur = !shown();
      return open();
    })
    .then(function () {
      // And the way that always worked: picking something.
      result.itemCount = menu.querySelectorAll('.item').length;
      menu.querySelector('.item').click();
      return settle();
    })
    .then(function () {
      result.choosing = !shown();
      return result;
    });
}

/**
 * The eye on a branch row, which puts that branch into the history beside the
 * scope, and the branch context menu the extension host describes.
 */
function inspectBranchRow() {
  const rows = [...document.querySelectorAll('.tree-row.branch')];
  const scopeRow = rows.find(function (row) {
    return row.classList.contains('selected');
  });
  const other = rows.find(function (row) {
    return !row.classList.contains('selected') && row.querySelector('.eye');
  });

  const result = {
    branchRows: rows.length,
    eyes: document.querySelectorAll('.tree-row .eye').length,
    scopeEyeOn: !!(scopeRow && scopeRow.querySelector('.eye.on')),
    scopeEyeLocked: !!(scopeRow && scopeRow.querySelector('.eye').disabled),
    otherEyeOn: !!other.querySelector('.eye.on'),
  };

  other.querySelector('.eye').click();
  return settle()
    .then(settle)
    .then(function () {
      // The row is rebuilt by the render, so it has to be found again.
      const label = other.querySelector('.label').textContent;
      const again = [...document.querySelectorAll('.tree-row.branch')].find(function (row) {
        return row.querySelector('.label').textContent === label;
      });
      result.toggledOn = !!again.querySelector('.eye.on');
      result.extras = (window.__VSG_REPO_MODEL.graph.extras || []).length;

      again.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })
      );
      return settle();
    })
    .then(function () {
      const menu = document.getElementById('menu');
      const items = [...menu.querySelectorAll('.item')];
      const disabled = items.filter(function (item) {
        return item.classList.contains('disabled');
      });
      result.menuItems = items.length;
      result.menuSeparators = menu.querySelectorAll('.separator').length;
      // The column is always present so labels line up; an entry without an
      // icon gets an empty one.
      result.menuIcons = menu.querySelectorAll('.menu-icon').length;
      result.menuFilledIcons = menu.querySelectorAll('.menu-icon.codicon').length;
      result.menuHasHistory = items.some(function (item) {
        return item.textContent.indexOf('View History') !== -1;
      });

      // A disabled entry must neither act nor close the menu.
      const currentRow = [...document.querySelectorAll('.tree-row.branch.current')][0];
      result.disabledOnOther = disabled.length;
      if (currentRow) {
        document.getElementById('menu').hidden = true;
        currentRow.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })
        );
      }
      return settle();
    })
    .then(function () {
      const menu = document.getElementById('menu');
      const disabled = menu.querySelector('.item.disabled');
      result.currentHasDisabled = !!disabled;
      result.disabledSaysWhy = disabled ? disabled.textContent.indexOf('Already checked out') !== -1 : false;
      if (disabled) {
        disabled.click();
      }
      return settle();
    })
    .then(function () {
      result.stillOpenAfterDisabledClick = !document.getElementById('menu').hidden;
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return settle();
    })
    .then(function () {
      return result;
    });
}

/** The hover card, the commit menu, and folding the refs pane away. */
function inspectCommitRowFeatures() {
  const row = document.querySelector('.rows .commit-row');
  const result = {};

  row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  result.cardBeforeDelay = !!document.querySelector('.hover-card');

  return new Promise(function (resolve) {
    // Longer than the card's own delay.
    setTimeout(resolve, 700);
  })
    .then(settle)
    .then(function () {
      const card = document.querySelector('.hover-card');
      result.card = !!card;
      if (card) {
        const text = card.textContent;
        result.cardFields = ['Commit:', 'Author:', 'Author Date:', 'Committer:', 'Commit Date:', 'Repository Path:']
          .filter(function (key) { return text.indexOf(key) !== -1; }).length;
        const box = card.getBoundingClientRect();
        result.cardOnScreen =
          box.left >= 0 && box.top >= 0 &&
          box.right <= window.innerWidth && box.bottom <= window.innerHeight;
        result.cardIgnoresPointer = getComputedStyle(card).pointerEvents === 'none';
      }
      row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      return settle();
    })
    .then(function () {
      result.cardGoesAway = !document.querySelector('.hover-card');

      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 250, clientY: 250 })
      );
      return settle();
    })
    .then(settle)
    .then(function () {
      const menu = document.getElementById('menu');
      const items = [...menu.querySelectorAll('.item')];
      result.menuItems = items.length;
      result.menuShortcut = !!menu.querySelector('.menu-shortcut');
      result.menuChecked = !!menu.querySelector('.menu-icon.codicon-check');
      result.menuDisabled = !!menu.querySelector('.item.disabled');
      result.noCardWithMenu = !document.querySelector('.hover-card');
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return settle();
    })
    .then(function () {
      result.leftBefore = !!document.querySelector('.left');
      const fold = document.querySelector('.toolbar .icon-btn');
      fold.click();
      return settle();
    })
    .then(settle)
    .then(function () {
      result.leftAfter = !!document.querySelector('.left');
      // Scoped to the upper band: the details pane's own rail divider is
      // also a vertical splitter and is nothing to do with this.
      result.splitterGone = !document.querySelector('.upper .splitter.vertical');
      const rows = document.querySelector('.rows');
      result.rowsWidened = rows.getBoundingClientRect().width;
      document.querySelector('.toolbar .icon-btn').click();
      return settle();
    })
    .then(settle)
    .then(function () {
      result.leftRestored = !!document.querySelector('.left');
      result.rowsNarrowed = document.querySelector('.rows').getBoundingClientRect().width;
      return result;
    });
}

/** Selects the first changed file, so the screenshot shows a representative diff. */
function selectFirstFile() {
  const first = document.querySelector('.changes .tree-row.change-file');
  if (first) {
    first.click();
  }
  return settle().then(settle);
}

function timeRender() {
  // The harness renders the whole window from a 'model' message, which is what
  // the extension does on every refresh, so this is the cost being measured.
  const started = performance.now();
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'model', model: window.__VSG_REPO_MODEL } })
  );
  return Math.round(performance.now() - started);
}

function readModel() {
  const graph = window.__VSG_REPO_MODEL.graph;
  const ids = function (group) {
    return graph.rows
      .filter(function (r) { return r.group === group; })
      .map(function (r) { return r.commit.shortHash; });
  };
  // In the order the two windows appear: incoming first, then local history.
  const groups = [ids('incoming'), ids('local')].filter(function (list) {
    return list.length > 0;
  });
  return { total: graph.rows.length, groups: groups };
}

// ------------------------------------------------------------------ the check

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures.push(name + (detail ? ' - ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' - ' + detail : ''));
  }
}

async function main() {
  const rowCount = Number(arg('rows', '2000'));
  const shot = arg('shot', null);
  const browser = findBrowser();
  sweepOldProfiles();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vsg-preview-'));
  const url =
    'file:///' +
    path.resolve(__dirname, '..', 'dev', 'preview-repo.html').replace(/\\/g, '/') +
    '?rows=' +
    rowCount +
    // Chromium caches file:// documents between runs, which otherwise serves a
    // stale harness after every edit to it.
    '&t=' +
    Date.now();

  console.log('browser: ' + browser);
  console.log('page:    ' + url);

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
      url,
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  try {
    const target = await waitForTarget(await waitForPort(profile), url);
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    // Pin the page's size. The browser's own chrome can change height while the
    // run is going - an infobar arriving, for one - and every measurement here
    // is against the viewport.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // The harness renders on the 'ready' round trip. Wait for the icon font as
    // well: until it lands the toolbar is the wrong height, which moves the
    // scroller under the measurements taken here.
    await evaluate(cdp, function () {
      return document.fonts.ready.then(settle).then(settle);
    });

    const model = await evaluate(cdp, readModel);
    console.log(
      'model:   ' +
        model.total +
        ' rows in ' +
        model.groups.length +
        ' groups (' +
        model.groups.map(function (g) { return g.length; }).join(' + ') +
        ')\n'
    );

    const first = await evaluate(cdp, readLayout);
    const fullHeight = first.scrollHeight;

    if (process.argv.includes('--debug')) {
      console.log('debug: ' + JSON.stringify(first, null, 2).slice(0, 2000) + '\n');
    }

    console.log('unscrolled:');
    check(
      'only a window of rows is in the DOM',
      first.rendered < 100,
      first.rendered + ' rows rendered of ' + model.total
    );
    check(
      'the DOM node count is bounded',
      first.domNodes < 3000,
      first.domNodes + ' nodes'
    );
    // A short history still fills the pane, so the floor is the viewport.
    const expectedHeight = Math.max(model.total * ROW_H, first.clientHeight);
    check(
      'the scroll height covers the whole history',
      Math.abs(fullHeight - expectedHeight) < 200,
      fullHeight + 'px for ' + model.total + ' rows (expected about ' + expectedHeight + 'px)'
    );
    check(
      'every group is present and sized for all of its rows',
      first.windows.length === model.groups.length &&
        first.windows.every(function (w, i) {
          return w.height === model.groups[i].length * ROW_H;
        }),
      first.windows.map(function (w) { return w.height + 'px'; }).join(', ') +
        ' for ' +
        model.groups.map(function (g) { return g.length * ROW_H + 'px'; }).join(', ')
    );
    check(
      'the first rows shown are the first rows of each group',
      first.windows.every(function (w, i) {
        return w.ids.length === 0 || w.ids[0] === model.groups[i][0];
      }),
      first.windows.map(function (w) { return w.ids[0]; }).join(', ')
    );

    const times = [];
    for (let i = 0; i < 5; i++) {
      times.push(await evaluate(cdp, timeRender));
    }
    times.sort(function (a, b) { return a - b; });
    console.log(
      '\nrender: ' + times[2] + ' ms for ' + model.total + ' rows (median of ' + times.length +
        '), ' + first.rendered + ' rows and ' + first.domNodes + ' nodes in the DOM'
    );

    // Walk the whole history in viewport-sized steps, checking every stop.
    const step = Math.floor(first.clientHeight * 0.8);
    const stops = [];
    for (let at = 0; at < fullHeight; at += step) {
      stops.push(at);
    }
    stops.push(fullHeight);

    let gapSeen = null;
    let heightDrift = null;
    let wrongRow = null;
    let maxRendered = 0;
    let maxNodes = 0;

    const started = Date.now();
    for (const at of stops) {
      await evaluate(cdp, scrollTo, at);
      const layout = await evaluate(cdp, readLayout);
      maxRendered = Math.max(maxRendered, layout.rendered);
      maxNodes = Math.max(maxNodes, layout.domNodes);

      if (layout.scrollHeight !== fullHeight && heightDrift === null) {
        heightDrift = 'at ' + at + ': ' + layout.scrollHeight + ' instead of ' + fullHeight;
      }

      const viewTop = layout.scrollTop;
      const viewBottom = viewTop + layout.clientHeight;

      layout.windows.forEach(function (window_, g) {
        const group = model.groups[g] || [];

        // Within a region the rendered rows must be one unbroken run.
        for (let i = 1; i < window_.tops.length; i++) {
          if (window_.tops[i] !== window_.tops[i - 1] + ROW_H && gapSeen === null) {
            gapSeen =
              'at ' + at + ': group ' + g + ' row ' + i + ' sits at ' + window_.tops[i] +
              ', expected ' + (window_.tops[i - 1] + ROW_H);
          }
        }

        // Wherever the region overlaps the viewport, that band has to be
        // filled: this is the check that would catch a blank stripe.
        const wantTop = Math.max(viewTop, window_.top);
        const wantBottom = Math.min(viewBottom, window_.top + window_.height);
        if (wantBottom - wantTop > 1 && gapSeen === null) {
          if (window_.tops.length === 0) {
            gapSeen = 'at ' + at + ': group ' + g + ' is on screen but has no rows';
          } else {
            const coveredTop = window_.tops[0];
            const coveredBottom = window_.tops[window_.tops.length - 1] + ROW_H;
            if (coveredTop > wantTop + 1 || coveredBottom < wantBottom - 1) {
              gapSeen =
                'at ' + at + ': group ' + g + ' covers ' + coveredTop + '-' + coveredBottom +
                ' but ' + wantTop + '-' + wantBottom + ' is on screen';
            }
          }
        }

        // The rows are not merely present, they are the right ones: the ids
        // must be the model's own, in order, starting where the padding says.
        if (wrongRow === null && window_.ids.length) {
          const startIndex = Math.round((window_.tops[0] - window_.top) / ROW_H);
          for (let i = 0; i < window_.ids.length; i++) {
            if (window_.ids[i] !== group[startIndex + i]) {
              wrongRow =
                'at ' + at + ': group ' + g + ' row ' + (startIndex + i) + ' shows ' +
                window_.ids[i] + ', expected ' + group[startIndex + i];
              break;
            }
          }
        }
      });
    }
    const elapsed = Date.now() - started;

    console.log('\nscrolled through ' + stops.length + ' viewports:');
    check('the scroll height never moves', heightDrift === null, heightDrift);
    check('the rows on screen have no gaps', gapSeen === null, gapSeen);
    check('the rows on screen are the right commits', wrongRow === null, wrongRow);
    check(
      'the window stays bounded while scrolling',
      maxRendered < 100 && maxNodes < 3000,
      maxRendered + ' rows, ' + maxNodes + ' nodes at the widest'
    );
    console.log(
      '  (' + stops.length + ' scroll stops in ' + elapsed + ' ms, ' + Math.round(elapsed / stops.length) + ' ms each)'
    );

    console.log('\ninteractions:');

    const deep = await evaluate(cdp, clickDeepRow, Math.floor(fullHeight * 0.6));
    check(
      'selecting a commit keeps the scroll position',
      deep.scrollAfter === deep.scrollBefore,
      'scrolled from ' + deep.scrollBefore + ' to ' + deep.scrollAfter
    );
    check(
      'the clicked commit, and only it, is selected',
      deep.selectedCount === 1 && deep.selectedId === deep.clickedId,
      deep.selectedCount + ' selected (' + deep.selectedId + '), clicked ' + deep.clickedId
    );

    // A history that fits the viewport cannot shrink the scroll height, so the
    // height assertions only apply when there is something to scroll.
    const scrollable = fullHeight > first.clientHeight;
    const otherGroups = model.groups.slice(0, -1).reduce(function (sum, g) {
      return sum + g.length;
    }, 0);

    const collapse = await evaluate(cdp, collapseLocalGroup);
    check(
      'collapsing the group leaves only the other groups rendered',
      collapse.collapsed.rendered === otherGroups &&
        (!scrollable || collapse.collapsed.scrollHeight < fullHeight / 2),
      collapse.collapsed.rendered + ' rows of an expected ' + otherGroups + ', ' +
        collapse.collapsed.scrollHeight + 'px'
    );
    check(
      'expanding it again restores them',
      collapse.expanded.scrollHeight === fullHeight &&
        collapse.expanded.rendered === first.rendered,
      collapse.expanded.rendered + ' rows of an expected ' + first.rendered + ', ' +
        collapse.expanded.scrollHeight + 'px, scrolled to ' + collapse.expanded.scrollTop +
        ', viewport ' + collapse.expanded.clientHeight + ' (was ' + first.clientHeight + ')' +
        ', windows ' + JSON.stringify(collapse.expanded.windows)
    );

    // The filter cuts the list down; the window has to shrink with it rather
    // than keep padding for rows that are no longer there.
    const filtered = await evaluate(cdp, applyFilter, 'Widget settings');
    check(
      'filtering cuts the list down to the matches',
      filtered.rendered > 0 &&
        filtered.rendered <= first.rendered &&
        (!scrollable || (filtered.scrollHeight < fullHeight / 4 && filtered.scrollHeight > 0)),
      filtered.rendered + ' rows, ' + filtered.scrollHeight + 'px of ' + fullHeight + 'px'
    );
    check(
      'every row left matches the filter',
      filtered.subjects.length > 0 &&
        // The filter itself is case-insensitive, so the check has to be too.
        filtered.subjects.every(function (s) {
          return s.toLowerCase().indexOf('widget settings') !== -1;
        }),
      filtered.subjects.slice(0, 3).join(' / ')
    );

    const drag = await evaluate(cdp, dragSplitterAroundSelection);
    check(
      'the details divider resizes the pane',
      drag.afterFirst > drag.before + 20,
      drag.before + 'px then ' + drag.afterFirst + 'px'
    );
    check(
      'the splitter still works after a commit is selected',
      drag.afterSecond > drag.afterSelect + 20,
      drag.afterSelect + 'px then ' + drag.afterSecond + 'px (selecting replaces the pane)'
    );

    const diff = await evaluate(cdp, inspectDiffPane);
    check(
      'selecting a commit builds both sides of the diff',
      diff.sides === 2,
      diff.sides + ' diff column(s)'
    );
    check(
      'the two sides hold the same rows, so a deletion sits opposite its replacement',
      diff.sides === 2 && diff.counts[0] === diff.counts[1] && diff.heights[0] === diff.heights[1],
      diff.sides === 2
        ? diff.counts.join(' vs ') + ' rows, ' + diff.heights.join('px vs ') + 'px'
        : 'no diff'
    );
    check(
      'scrolling one side carries the other with it',
      diff.sides === 2 && diff.scrolled > 0 && diff.follower === diff.scrolled,
      diff.sides === 2 ? diff.scrolled + 'px then ' + diff.follower + 'px' : 'no diff'
    );
    check(
      'every row kind is drawn',
      diff.sides === 2 && diff.added > 0 && diff.removed > 0 && diff.gaps > 0 && diff.words > 0,
      diff.sides === 2
        ? diff.added + ' added, ' + diff.removed + ' removed, ' + diff.gaps +
          ' gap(s), ' + diff.words + ' highlighted word(s)'
        : 'no diff'
    );
    check(
      'the changes tree nests the files and opens on the first one',
      diff.sides === 2 && diff.files > 0 && diff.dirs > 0 && diff.selectedFiles === 1,
      diff.sides === 2
        ? diff.files + ' file(s) under ' + diff.dirs + ' folder(s), ' +
          diff.selectedFiles + ' selected'
        : 'no diff'
    );

    check(
      'the diff is syntax coloured',
      diff.sides === 2 && diff.keywords > 0 && diff.comments > 0,
      diff.sides === 2
        ? diff.keywords + ' keyword(s), ' + diff.comments + ' comment(s)'
        : 'no diff'
    );
    check(
      'a changed word keeps its colour as well as its highlight',
      diff.sides === 2 && diff.both > 0,
      diff.sides === 2 ? diff.both + ' piece(s) carrying both' : 'no diff'
    );

    const rail = await evaluate(cdp, railScrollAcrossFileClick);
    check(
      'clicking a file leaves the changes tree where it was',
      rail.scrollable && rail.after === rail.before,
      rail.scrollable
        ? 'scrolled to ' + rail.before + 'px, left at ' + rail.after + 'px'
        : 'the rail did not scroll, so the check proves nothing'
    );
    check(
      'clicking a file selects that file',
      rail.selected === rail.clicked,
      'clicked ' + rail.clicked + ', selected ' + rail.selected
    );

    // 20,000 rows a side: the whole point is that the DOM does not grow with
    // the file. A generous ceiling - what matters is that it is a ceiling.
    const dense = await evaluate(cdp, inspectDenseDiff);
    check(
      'a whole-file diff of 20,000 changed lines stays bounded',
      dense.nodes > 0 && dense.nodes < 400,
      dense.nodes + ' rows in the DOM across both columns (' + dense.rendered.join(' + ') + ')'
    );
    check(
      'and it opens promptly',
      dense.elapsed < 2000,
      dense.elapsed + ' ms from click to drawn'
    );
    check(
      'the scrollbar still spans the whole file',
      dense.scrollHeight > 20000 * 18 * 0.9,
      dense.scrollHeight + 'px of an expected ' + 20000 * 18 + 'px'
    );
    check(
      'scrolling into the middle brings up the rows that belong there',
      dense.firstLineNo > 9000 && dense.firstLineNo < 11000,
      'first row on screen is line ' + dense.firstLineNo
    );
    check(
      'and the other column follows it',
      dense.followerTop === dense.leaderTop,
      dense.leaderTop + 'px then ' + dense.followerTop + 'px'
    );

    const wide = await evaluate(cdp, inspectWideDiff);
    check(
      'a minified line is not drawn one element per token',
      wide.worstRow > 0 && wide.worstRow <= 120,
      wide.worstRow + ' elements in the busiest row, ' + wide.total + ' across the diff'
    );
    check(
      'and it still opens promptly',
      wide.elapsed < 2000,
      wide.elapsed + ' ms from click to drawn'
    );
    check(
      'the column is not stated millions of pixels wide',
      wide.width > 0 && wide.width < 60000,
      wide.width + 'px'
    );
    check(
      'what changed in the line is still marked',
      wide.highlighted > 0,
      wide.highlighted + ' highlighted run(s)'
    );

    const menu = await evaluate(cdp, inspectMenuDismissal);
    check('a right-click opens the context menu', menu.opens && menu.itemCount > 0,
      menu.itemCount + ' item(s)');
    check('Escape closes it', menu.escape, String(menu.escape));
    check('a click elsewhere closes it', menu.clickAway, String(menu.clickAway));
    check('a right-click elsewhere closes it', menu.rightClickAway, String(menu.rightClickAway));
    check('turning the wheel closes it', menu.scroll, String(menu.scroll));
    check(
      'but the re-render that opening it causes does not',
      menu.opens,
      'a programmatic scroll restore must not count as scrolling'
    );
    check('losing focus closes it', menu.blur, String(menu.blur));
    check('and choosing an item still closes it', menu.choosing, String(menu.choosing));

    const branch = await evaluate(cdp, inspectBranchRow);
    check(
      'every branch row carries an eye',
      branch.eyes === branch.branchRows && branch.eyes > 0,
      branch.eyes + ' eyes on ' + branch.branchRows + ' branch rows'
    );
    check(
      "the scope's own eye is on and cannot be turned off",
      branch.scopeEyeOn && branch.scopeEyeLocked,
      'on=' + branch.scopeEyeOn + ' locked=' + branch.scopeEyeLocked
    );
    check(
      'clicking another eye brings that branch into the history',
      !branch.otherEyeOn && branch.toggledOn && branch.extras === 1,
      'was off, now on, ' + branch.extras + ' extra branch(es) shown'
    );
    check(
      'a branch right-click opens the menu the extension host described',
      branch.menuItems >= 7 && branch.menuSeparators >= 2 && branch.menuHasHistory,
      branch.menuItems + ' items, ' + branch.menuSeparators + ' separators'
    );
    check(
      'every menu entry keeps the icon column, so labels line up',
      branch.menuIcons === branch.menuItems && branch.menuFilledIcons > 0,
      branch.menuIcons + ' columns for ' + branch.menuItems + ' items, ' +
        branch.menuFilledIcons + ' with an icon'
    );
    check(
      'an entry that cannot apply is shown disabled, with the reason',
      branch.currentHasDisabled && branch.disabledSaysWhy,
      'disabled=' + branch.currentHasDisabled + ' explains=' + branch.disabledSaysWhy
    );
    check(
      'and clicking it does nothing, rather than looking like it did',
      branch.stillOpenAfterDisabledClick,
      String(branch.stillOpenAfterDisabledClick)
    );

    const rowFeatures = await evaluate(cdp, inspectCommitRowFeatures);
    check(
      'resting on a commit row raises a card, but not instantly',
      !rowFeatures.cardBeforeDelay && rowFeatures.card,
      'delayed=' + !rowFeatures.cardBeforeDelay + ' shown=' + rowFeatures.card
    );
    check(
      'the card names the commit, both people and both dates',
      rowFeatures.cardFields === 6,
      rowFeatures.cardFields + ' of 6 fields'
    );
    check(
      'it stays on screen and never steals the pointer',
      rowFeatures.cardOnScreen && rowFeatures.cardIgnoresPointer,
      'onScreen=' + rowFeatures.cardOnScreen + ' inert=' + rowFeatures.cardIgnoresPointer
    );
    check('moving off the row takes it away', rowFeatures.cardGoesAway, String(rowFeatures.cardGoesAway));
    check(
      'a commit right-click opens the menu the host answered with',
      rowFeatures.menuItems >= 10,
      rowFeatures.menuItems + ' items'
    );
    check(
      'and it carries shortcuts, ticks and disabled entries',
      rowFeatures.menuShortcut && rowFeatures.menuChecked && rowFeatures.menuDisabled,
      'shortcut=' + rowFeatures.menuShortcut + ' tick=' + rowFeatures.menuChecked +
        ' disabled=' + rowFeatures.menuDisabled
    );
    check(
      'the card is gone while the menu is up',
      rowFeatures.noCardWithMenu,
      String(rowFeatures.noCardWithMenu)
    );
    check(
      'the refs pane folds away and gives its room to the history',
      rowFeatures.leftBefore && !rowFeatures.leftAfter && rowFeatures.splitterGone &&
        rowFeatures.rowsWidened > rowFeatures.rowsNarrowed,
      'history ' + Math.round(rowFeatures.rowsNarrowed) + 'px then ' +
        Math.round(rowFeatures.rowsWidened) + 'px'
    );
    check('and unfolds again', rowFeatures.leftRestored, String(rowFeatures.leftRestored));

    const cleared = await evaluate(cdp, applyFilter, '');
    check(
      'clearing the filter restores the whole history',
      cleared.scrollHeight === fullHeight,
      cleared.scrollHeight + 'px of ' + fullHeight + 'px'
    );

    if (shot) {
      await evaluate(cdp, scrollTo, Math.floor(fullHeight / 2));
      await evaluate(cdp, selectFirstFile);
      const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shot, Buffer.from(image.data, 'base64'));
      console.log('\nscreenshot: ' + shot);
    }
  } finally {
    if (cdp) {
      // Ask the browser to exit rather than killing it: it then releases its
      // profile, which a killed one holds on to for a good while.
      try {
        await cdp.send('Browser.close');
      } catch {
        // Already gone, or refused - the kill below is the fallback.
      }
      cdp.close();
    }
    await pause(300);
    killTree(child);
    if (!process.argv.includes('--keep')) {
      // The browser goes on holding its profile open for a moment after being
      // killed, so wait it out rather than leave a directory behind on every
      // run. A profile that will not go is reported, not fatal.
      let removed = false;
      for (let attempt = 0; attempt < 6 && !removed; attempt++) {
        await pause(500);
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          removed = true;
        } catch {
          // Still locked; give it another go.
        }
      }
      if (!removed && process.argv.includes('--debug')) {
        console.log('(left ' + profile + ' behind; the next run will sweep it)');
      }
    }
  }

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' check(s) failed.');
    process.exitCode = 1;
  } else {
    console.log('All checks passed.');
  }
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
