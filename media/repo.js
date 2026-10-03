/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const menuEl = document.getElementById('menu');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ROW_H = 22;
  const LANE_W = 14;
  const LANE_COLORS = 8;

  // Rows kept in the DOM beyond each edge of the viewport, so a small scroll is
  // already covered by the time the next frame runs.
  const OVERSCAN = 8;

  const visibleRange = self.VsgVirtual.visibleRange;
  const diffView = self.VsgDiffView;
  const graphView = self.VsgGraphView;
  const dom = self.VsgDom;
  const format = self.VsgFormat;

  const persisted = vscode.getState() || {};

  const state = {
    model: null,
    busy: false,
    filter: '',
    refFilter: '',
    collapsed: Object.assign({ incoming: false, local: false }, persisted.collapsed),
    treeClosed: new Set(persisted.treeClosed || ['tags', 'pullRequests']),
    selected: null,
    leftWidth: persisted.leftWidth || 260,
    detailsVisible: persisted.detailsVisible !== false,
    // The details are a column beside the history, now that the diff they used
    // to sit over opens in VS Code's own editor beneath the window.
    detailsWidth: persisted.detailsWidth || 320,
    details: null,
    detailsError: null,
    detailsLoading: false,
    /** Path of the file last opened from the changes tree, marked selected. */
    detailsFile: null,
    changesClosed: new Set(persisted.changesClosed || []),
    /** The refs pane folded to a strip, for a narrow window. */
    leftCollapsed: persisted.leftCollapsed || false,
  };

  // The row regions currently on screen, rebuilt with the rows themselves.
  let windows = [];

  function save() {
    vscode.setState({
      collapsed: state.collapsed,
      treeClosed: [...state.treeClosed],
      leftWidth: state.leftWidth,
      detailsVisible: state.detailsVisible,
      detailsWidth: state.detailsWidth,
      changesClosed: [...state.changesClosed],
      leftCollapsed: state.leftCollapsed,
    });
  }

  function post(message) {
    vscode.postMessage(message);
  }

  // ------------------------------------------------------------- dom helpers
  //
  // The construction itself lives in media/dom.js, shared with the Git Changes
  // view. These are the local names the rendering below reads with, plus the
  // one binding dom.js cannot make for us: which element is this view's menu.

  const laneX = function (lane) {
    return graphView.laneX(lane, LANE_W);
  };
  const color = function (index) {
    return graphView.laneColor(index, LANE_COLORS);
  };
  const graphWidth = function (maxLanes) {
    return graphView.graphWidth(maxLanes, LANE_W);
  };
  const matches = function (row) {
    return graphView.matchesFilter(row.commit, state.filter);
  };

  const el = dom.el;
  const icon = dom.icon;
  const iconButton = dom.iconButton;
  const link = dom.link;
  const formatDate = format.formatDate;

  function showMenu(event, items) {
    dom.showMenu(menuEl, event, items);
  }

  function hideMenu() {
    dom.hideMenu(menuEl);
  }

  // ------------------------------------------------------------ graph drawing

  function path(d, stroke) {
    const node = document.createElementNS(SVG_NS, 'path');
    node.setAttribute('d', d);
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', '1.6');
    node.setAttribute('fill', 'none');
    return node;
  }

  /**
   * One SVG per commit row. Lines are drawn between the row's own edges only,
   * so rows stay independent and the graph stitches together vertically.
   */
  function graphCell(row, maxLanes) {
    const width = graphWidth(maxLanes);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(ROW_H));
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + ROW_H);
    svg.style.flex = '0 0 auto';

    const cx = laneX(row.lane);
    const cy = ROW_H / 2;

    for (const line of row.through) {
      const x1 = laneX(line.from);
      const x2 = laneX(line.to);
      if (x1 === x2) {
        svg.appendChild(path('M' + x1 + ' 0 L' + x1 + ' ' + ROW_H, color(line.color)));
      } else {
        svg.appendChild(
          path(
            'M' + x1 + ' 0 C' + x1 + ' ' + cy + ' ' + x2 + ' ' + cy + ' ' + x2 + ' ' + ROW_H,
            color(line.color)
          )
        );
      }
    }

    for (const line of row.above) {
      const x1 = laneX(line.lane);
      if (x1 === cx) {
        svg.appendChild(path('M' + cx + ' 0 L' + cx + ' ' + cy, color(line.color)));
      } else {
        svg.appendChild(
          path(
            'M' + x1 + ' 0 C' + x1 + ' ' + cy + ' ' + cx + ' 0 ' + cx + ' ' + cy,
            color(line.color)
          )
        );
      }
    }

    for (const line of row.below) {
      const x2 = laneX(line.lane);
      if (x2 === cx) {
        svg.appendChild(path('M' + cx + ' ' + cy + ' L' + cx + ' ' + ROW_H, color(line.color)));
      } else {
        svg.appendChild(
          path(
            'M' + cx + ' ' + cy + ' C' + cx + ' ' + ROW_H + ' ' + x2 + ' ' + cy + ' ' + x2 + ' ' + ROW_H,
            color(line.color)
          )
        );
      }
    }

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', row.isHead ? '4.5' : '3.5');
    dot.setAttribute('fill', color(row.color));
    if (row.isHead) {
      dot.setAttribute('stroke', 'var(--vscode-editor-background, #1f1f1f)');
      dot.setAttribute('stroke-width', '1.6');
    }
    svg.appendChild(dot);

    const cell = el('div', 'cell graph-cell');
    cell.appendChild(svg);
    return cell;
  }

  // ------------------------------------------------------------------ render

  function render() {
    const rowsScroller = root.querySelector('.rows');
    const scrollTop = rowsScroller ? rowsScroller.scrollTop : 0;
    const railTop = railScrollTop();

    root.textContent = '';
    root.appendChild(renderToolbar());
    root.appendChild(el('div', 'progress' + (state.busy ? ' busy' : '')));

    if (!state.model) {
      root.appendChild(el('div', 'empty', 'Loading…'));
      return;
    }

    root.appendChild(renderBreadcrumb());

    // The graph column has to be as wide as the widest row's lanes, otherwise
    // a busy history is clipped by the grid template.
    root.style.setProperty('--vsg-col-graph', graphWidth(state.model.graph.maxLanes) + 'px');

    // Refs, history and commit details side by side. Visual Studio docks the
    // details across the bottom, over the diff; here the diff is VS Code's own
    // editor, opened in a group beneath this whole window, so the details take
    // a column instead and leave the history its full height.
    const body = el('div', 'body');
    // Folded away the pane costs nothing but its divider, which goes with it:
    // there is no width left to drag.
    if (!state.leftCollapsed) {
      const left = renderLeft();
      left.style.flexBasis = state.leftWidth + 'px';
      body.appendChild(left);
      body.appendChild(
        renderSplitter({
          className: 'left-divider',
          selector: '.left',
          axis: 'x',
          min: 140,
          max: 720,
          apply: function (size) {
            state.leftWidth = size;
          },
        })
      );
    }
    body.appendChild(renderRight());

    if (state.detailsVisible) {
      body.appendChild(
        renderSplitter({
          className: 'details-divider',
          selector: '.details',
          axis: 'x',
          // The column sits at the right edge, so dragging left has to widen it.
          invert: true,
          min: 220,
          max: 720,
          apply: function (size) {
            state.detailsWidth = size;
          },
        })
      );
      const details = renderDetails();
      details.style.flexBasis = state.detailsWidth + 'px';
      body.appendChild(details);
    }
    root.appendChild(body);

    const newScroller = root.querySelector('.rows');
    if (newScroller) {
      newScroller.scrollTop = scrollTop;
    }
    restoreRailScroll(railTop);
    // Only now is the pane laid out, which is what the row windows measure
    // themselves against.
    syncWindows();

    installKeyboardNavigation(root);
  }

  function renderToolbar() {
    const bar = el('div', 'toolbar');
    bar.appendChild(
      iconButton(
        state.leftCollapsed ? 'chevron-right' : 'chevron-left',
        state.leftCollapsed ? 'Show the branches pane' : 'Hide the branches pane',
        function () {
          state.leftCollapsed = !state.leftCollapsed;
          save();
          render();
        }
      )
    );
    bar.appendChild(el('div', 'sep'));
    bar.appendChild(iconButton('refresh', 'Refresh', function () { post({ type: 'refresh' }); }));
    bar.appendChild(el('div', 'sep'));
    bar.appendChild(iconButton('cloud-download', 'Fetch', function () { post({ type: 'remote', op: 'fetch' }); }));
    bar.appendChild(iconButton('arrow-down', 'Pull', function () { post({ type: 'remote', op: 'pull' }); }));
    bar.appendChild(iconButton('arrow-up', 'Push', function () { post({ type: 'remote', op: 'push' }); }));
    bar.appendChild(iconButton('sync', 'Sync', function () { post({ type: 'remote', op: 'sync' }); }));
    bar.appendChild(el('div', 'spacer'));

    bar.appendChild(
      iconButton(
        'layout-sidebar-right',
        state.detailsVisible ? 'Hide commit details' : 'Show commit details',
        function () {
          state.detailsVisible = !state.detailsVisible;
          save();
          render();
        }
      )
    );
    bar.appendChild(el('div', 'sep'));

    const filter = el('input', 'filter-input');
    filter.type = 'text';
    filter.placeholder = 'Filter History';
    filter.value = state.filter;
    filter.addEventListener('input', function () {
      state.filter = filter.value;
      renderRowsOnly();
    });
    bar.appendChild(filter);
    return bar;
  }

  function renderBreadcrumb() {
    const model = state.model;
    const bar = el('div', 'breadcrumb');
    bar.appendChild(el('span', null, 'Branch / Tag:'));
    bar.appendChild(el('strong', null, model.graph.scope));
    if (model.graph.upstream) {
      bar.appendChild(el('span', null, '→ ' + model.graph.upstream));
    }
    // One file's history: say which file, and give a way back to the branch.
    if (model.graph.file) {
      const chip = el('span', 'file-scope');
      chip.appendChild(icon('history'));
      chip.appendChild(el('span', null, 'History of ' + model.graph.file));
      chip.title = model.graph.file;
      bar.appendChild(chip);
      bar.appendChild(link('Show all commits', function () { post({ type: 'clearFile' }); }));
    }
    return bar;
  }

  /**
   * `selector` rather than the element itself: selecting a commit replaces the
   * whole details pane, and a splitter holding a reference to the old one would
   * go on resizing a node that is no longer in the document - the drag simply
   * stopped working until the next full render.
   */
  /**
   * A draggable divider. `axis` picks the dimension it moves in, `invert` is
   * for a pane that grows as the pointer travels toward its own edge - as the
   * details column at the right does - and `apply` records the new size.
   */
  function renderSplitter(options) {
    const horizontal = options.axis !== 'y';
    const splitter = el(
      'div',
      'splitter ' + (horizontal ? 'vertical' : 'horizontal') +
        (options.className ? ' ' + options.className : '')
    );
    splitter.addEventListener('mousedown', function (event) {
      event.preventDefault();
      splitter.classList.add('dragging');
      const pane = root.querySelector(options.selector);
      if (!pane) {
        return;
      }
      const start = horizontal ? event.clientX : event.clientY;
      const rect = pane.getBoundingClientRect();
      const startSize = horizontal ? rect.width : rect.height;

      function move(e) {
        const at = horizontal ? e.clientX : e.clientY;
        const delta = options.invert ? start - at : at - start;
        const next = Math.max(options.min, Math.min(options.max, startSize + delta));
        options.apply(next);
        // Resolved on every move, so a pane replaced mid-drag is still sized.
        const current = root.querySelector(options.selector);
        if (current) {
          current.style.flexBasis = next + 'px';
        }
      }
      function up() {
        splitter.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        save();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return splitter;
  }

  // -------------------------------------------------------------- left pane

  function treeRow(options) {
    const node = el('div', 'tree-row ' + (options.kind || ''));
    node.setAttribute('role', 'treeitem');
    node.setAttribute('aria-level', String((options.depth || 0) + 1));
    node.style.paddingLeft = 2 + (options.depth || 0) * 14 + 'px';

    if (options.open === undefined) {
      node.appendChild(el('span', 'chev'));
    } else {
      node.appendChild(icon(options.open ? 'chevron-down' : 'chevron-right', 'chev'));
      node.setAttribute('aria-expanded', String(options.open));
    }

    const iconWrap = el('span', 'icon');
    iconWrap.appendChild(icon(options.codicon));
    node.appendChild(iconWrap);
    node.appendChild(el('span', 'label', options.label));
    if (options.suffix) {
      node.appendChild(el('span', 'suffix', options.suffix));
    }
    if (options.current) {
      node.classList.add('current');
    }
    if (options.selected) {
      node.classList.add('selected');
    }
    return node;
  }

  /**
   * The eye that puts a branch into the history beside the scope, and takes it
   * out again. Visual Studio shows it on the row itself, so a branch can be
   * brought into view without opening a menu.
   *
   * The scope is always drawn, so its eye is on and cannot be turned off - the
   * way out of that is to make another branch the scope.
   */
  function eyeToggle(ref) {
    const graph = state.model.graph;
    const isScope = graph.scope === ref.short;
    const shown = isScope || (graph.extras || []).indexOf(ref.short) !== -1;

    const button = iconButton(
      shown ? 'eye' : 'eye-closed',
      isScope
        ? 'Shown as the current history'
        : shown
          ? 'Hide ' + ref.short + ' from the history'
          : 'Show ' + ref.short + ' in the history',
      function () {
        post({ type: 'branchOp', op: 'toggleInHistory', ref: ref.short });
      },
      isScope
    );
    button.classList.add('eye');
    if (shown) {
      button.classList.add('on');
    }
    return button;
  }

  /**
   * The branch context menu, as the extension host described it. Nothing about
   * which entries apply is decided here - see src/git/branchOps.ts.
   */
  function branchMenuItems(ref) {
    const entries = (state.model.menus && state.model.menus[ref.short]) || [];
    const items = [];
    for (const entry of entries) {
      items.push({
        label: entry.disabled ? entry.label + '  —  ' + entry.why : entry.label,
        icon: entry.icon,
        run: entry.disabled
          ? function () {}
          : function () {
              post({ type: 'branchOp', op: entry.op, ref: ref.short });
            },
        disabled: entry.disabled,
      });
      if (entry.breakAfter) {
        items.push('-');
      }
    }
    return items;
  }

  function toggleTree(key) {
    if (state.treeClosed.has(key)) {
      state.treeClosed.delete(key);
    } else {
      state.treeClosed.add(key);
    }
    save();
    render();
  }

  function isOpen(key) {
    return !state.treeClosed.has(key);
  }

  function renderNested(container, node, depth, keyPrefix) {
    const dirs = [...node.dirs.entries()].sort(function (a, b) {
      return a[0].localeCompare(b[0]);
    });
    for (const [name, child] of dirs) {
      const key = keyPrefix + '/' + name;
      const open = isOpen(key);
      const row = treeRow({
        kind: 'group-node',
        depth: depth,
        open: open,
        codicon: open ? 'folder-opened' : 'folder',
        label: name,
      });
      row.addEventListener('click', function () {
        toggleTree(key);
      });
      container.appendChild(row);
      if (open) {
        renderNested(container, child, depth + 1, key);
      }
    }

    const leaves = node.leaves.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    for (const leaf of leaves) {
      const ref = leaf.ref;
      const row = treeRow({
        kind: ref.kind === 'tag' ? 'tag' : 'branch',
        depth: depth,
        codicon: ref.kind === 'tag' ? 'tag' : 'git-branch',
        label: leaf.name,
        current: ref.current,
        selected: state.model.graph.scope === ref.short,
        suffix: ref.current ? '(current)' : undefined,
      });
      row.addEventListener('click', function () {
        post({ type: 'setScope', scope: ref.short });
      });
      row.addEventListener('contextmenu', function (event) {
        showMenu(event, branchMenuItems(ref));
      });
      row.appendChild(eyeToggle(ref));
      container.appendChild(row);
    }
  }

  // Built once per model, not per render: the pane is redrawn for every filter
  // keystroke and folder toggle, and the file list has not changed for either.
  const worktreeTrees = new WeakMap();

  function worktreeTree(worktree) {
    let rows = worktreeTrees.get(worktree);
    if (!rows) {
      rows = diffView.buildFileTree(worktree.files);
      worktreeTrees.set(worktree, rows);
    }
    return rows;
  }

  /** An italic line in the tree, indented to sit where a row's label would. */
  function treeNote(depth, text) {
    const note = el('div', 'empty', text);
    note.style.paddingLeft = 2 + depth * 14 + 38 + 'px';
    return note;
  }

  /**
   * Each worktree's uncommitted changes, beside the branches they share. Not in
   * Visual Studio - see src/git/worktrees.ts for why it is here at all, and for
   * the cap that keeps this unwindowed pane bounded.
   */
  function renderWorktrees(container) {
    const worktrees = state.model.worktrees || [];
    if (!worktrees.length) {
      return;
    }
    const groupOpen = isOpen('worktrees');
    const group = treeRow({
      kind: 'group-node',
      depth: 1,
      open: groupOpen,
      codicon: 'folder-library',
      label: 'Worktrees',
    });
    group.addEventListener('click', function () {
      toggleTree('worktrees');
    });
    container.appendChild(group);
    if (!groupOpen) {
      return;
    }

    for (const worktree of worktrees) {
      const key = 'wt:' + worktree.path;
      const open = isOpen(key);
      const row = treeRow({
        kind: 'worktree',
        depth: 2,
        open: open,
        codicon: 'repo-forked',
        label: worktree.name,
        suffix: worktree.branch,
        current: worktree.current,
      });
      row.title = worktree.path;
      if (worktree.total) {
        row.appendChild(el('span', 'count', String(worktree.total)));
      }
      row.addEventListener('click', function () {
        toggleTree(key);
      });
      container.appendChild(row);
      if (!open) {
        continue;
      }

      if (worktree.note) {
        container.appendChild(treeNote(3, worktree.note));
      }
      for (const item of diffView.visibleTreeRows(worktreeTree(worktree), state.treeClosed, key)) {
        container.appendChild(
          item.kind === 'dir' ? worktreeDirRow(key, item) : worktreeFileRow(worktree, item)
        );
      }
      if (worktree.total > worktree.files.length) {
        container.appendChild(
          treeNote(3, worktree.total - worktree.files.length + ' more not listed.')
        );
      }
    }
  }

  function worktreeDirRow(prefix, item) {
    const key = prefix + item.key;
    const open = isOpen(key);
    const node = treeRow({
      kind: 'group-node',
      depth: 3 + item.depth,
      open: open,
      codicon: open ? 'folder-opened' : 'folder',
      label: item.label,
    });
    node.addEventListener('click', function () {
      toggleTree(key);
    });
    return node;
  }

  function worktreeFileRow(worktree, item) {
    const file = item.file;
    const node = treeRow({
      kind: 'change-file',
      depth: 3 + item.depth,
      codicon: 'file',
      label: item.label,
      suffix: file.status,
    });
    node.classList.add('st-' + file.status);
    node.title = file.origPath
      ? file.path + String.fromCharCode(10) + '(was ' + file.origPath + ')'
      : file.path;
    node.addEventListener('click', function () {
      post({
        type: 'openWorktreeChange',
        worktree: worktree.path,
        path: file.path,
        origPath: file.origPath,
        status: file.status,
      });
    });
    return node;
  }

  function renderLeft() {
    const model = state.model;
    const pane = el('div', 'left');

    const filterWrap = el('div', 'pane-filter');
    const filter = el('input', 'filter-input');
    filter.type = 'text';
    filter.placeholder = 'Filter';
    filter.value = state.refFilter;
    filter.addEventListener('input', function () {
      state.refFilter = filter.value;
      render();
    });
    filterWrap.appendChild(filter);
    pane.appendChild(filterWrap);

    const scroll = el('div', 'scroll');
    scroll.setAttribute('role', 'tree');

    const needle = state.refFilter.trim().toLowerCase();
    const refs = needle
      ? model.refs.filter(function (r) {
          return r.short.toLowerCase().indexOf(needle) !== -1;
        })
      : model.refs;

    const rootOpen = isOpen('branchesTags');
    const rootRow = treeRow({
      kind: 'group-node',
      depth: 0,
      open: rootOpen,
      codicon: 'git-branch',
      label: 'Branches / Tags',
    });
    rootRow.addEventListener('click', function () {
      toggleTree('branchesTags');
    });
    scroll.appendChild(rootRow);

    if (rootOpen) {
      const current = model.refs.find(function (r) {
        return r.current;
      });
      const repoOpen = isOpen('repo');
      const repoRow = treeRow({
        kind: 'repo',
        depth: 1,
        open: repoOpen,
        codicon: 'repo',
        label: model.repoName + (current ? ' (' + current.short + ')' : ''),
      });
      repoRow.addEventListener('click', function () {
        toggleTree('repo');
      });
      scroll.appendChild(repoRow);

      if (repoOpen) {
        const heads = refs.filter(function (r) { return r.kind === 'head'; });
        renderNested(scroll, graphView.nestRefs(heads, function (r) { return r.short; }), 2, 'heads');

        const remotes = refs.filter(function (r) { return r.kind === 'remote'; });
        if (remotes.length) {
          const byRemote = new Map();
          for (const ref of remotes) {
            const remote = ref.short.split('/')[0];
            if (!byRemote.has(remote)) {
              byRemote.set(remote, []);
            }
            byRemote.get(remote).push(ref);
          }
          for (const [remote, list] of byRemote) {
            const key = 'remotes/' + remote;
            const open = isOpen(key);
            const row = treeRow({
              kind: 'group-node',
              depth: 2,
              open: open,
              codicon: 'cloud',
              label: 'remotes/' + remote,
            });
            row.addEventListener('click', function () {
              toggleTree(key);
            });
            scroll.appendChild(row);
            if (open) {
              // Nest by the path after the remote name, so origin/feature/x
              // appears as feature > x while the leaf keeps "origin/feature/x".
              renderNested(
                scroll,
                graphView.nestRefs(list, function (r) {
                  return r.short.substring(remote.length + 1);
                }),
                3,
                key
              );
            }
          }
        }

        const tags = refs.filter(function (r) { return r.kind === 'tag'; });
        if (tags.length) {
          const open = isOpen('tags');
          const row = treeRow({
            kind: 'group-node',
            depth: 2,
            open: open,
            codicon: 'tag',
            label: 'tags',
          });
          row.addEventListener('click', function () {
            toggleTree('tags');
          });
          scroll.appendChild(row);
          if (open) {
            renderNested(scroll, graphView.nestRefs(tags, function (r) { return r.short; }), 3, 'tags');
          }
        }
      }

      renderWorktrees(scroll);
    }

    // Placeholder: populating this needs the provider's API and a token.
    // The label follows the provider because GitLab calls these merge requests.
    const review = model.review || { provider: 'unknown', label: 'Pull Requests' };
    if (review.provider !== 'none') {
      const prOpen = isOpen('pullRequests');
      const prRow = treeRow({
        kind: 'group-node',
        depth: 0,
        open: prOpen,
        codicon: 'git-pull-request',
        label: review.label,
      });
      prRow.addEventListener('click', function () {
        toggleTree('pullRequests');
      });
      scroll.appendChild(prRow);
      if (prOpen) {
        const note = review.host
          ? 'Not implemented yet (' + review.host +
            (review.provider === 'unknown'
              ? ' - set vsGitStyle.reviewProvider'
              : ', ' + review.provider) + ').'
          : 'No origin remote.';
        scroll.appendChild(el('div', 'empty', note));
      }
    }

    pane.appendChild(scroll);
    return pane;
  }

  // ------------------------------------------------------------- right pane

  function renderRight() {
    const pane = el('div', 'right');

    const header = el('div', 'grid-row col-header');
    ['Branch / Tag', 'Graph', 'Message', 'Author', 'Date', 'ID'].forEach(function (title) {
      header.appendChild(el('span', null, title));
    });
    pane.appendChild(header);

    const rows = el('div', 'rows');
    rows.setAttribute('role', 'table');
    rows.addEventListener('scroll', queueSync);
    if (rowsObserver) {
      // The previous scroller is gone with the rest of the render.
      rowsObserver.disconnect();
      rowsObserver.observe(rows);
    }
    pane.appendChild(rows);
    fillRows(rows);
    return pane;
  }

  function renderRowsOnly() {
    const rows = root.querySelector('.rows');
    if (!rows) {
      render();
      return;
    }
    // Emptying the container collapses its height, which drags the scroll
    // position to the top with it, so put it back once the windows are sized
    // for the whole list again.
    const scrollTop = rows.scrollTop;
    rows.textContent = '';
    fillRows(rows);
    rows.scrollTop = scrollTop;
    syncWindows();
  }

  /**
   * A region of commit rows of which only the visible slice is in the DOM. The
   * rows scrolled out of sight are replaced by padding of exactly their height,
   * so the scrollbar, and every offset below the region, stay where the whole
   * list would have put them.
   */
  function rowWindow(rows, maxLanes) {
    const host = el('div', 'row-window');
    host.setAttribute('role', 'rowgroup');
    // Sized for the full list before a single row exists, so that the first
    // measurement of a region below this one already lands in the right place.
    host.style.paddingBottom = rows.length * ROW_H + 'px';
    windows.push({ host: host, rows: rows, maxLanes: maxLanes, start: -1, end: -1 });
    return host;
  }

  function syncWindows() {
    const scroller = root.querySelector('.rows');
    if (!scroller || windows.length === 0) {
      return;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight;

    for (const region of windows) {
      // Measured rather than computed: group headers, their borders and the
      // empty-state placeholders all sit between the regions. A region's own
      // height never changes, so this stays correct as the windows fill in.
      const offset = region.host.getBoundingClientRect().top - scrollerTop + scrollTop;
      const range = visibleRange({
        total: region.rows.length,
        rowHeight: ROW_H,
        overscan: OVERSCAN,
        offset: offset,
        scrollTop: scrollTop,
        viewportHeight: viewportHeight,
      });
      if (range.start === region.start && range.end === region.end) {
        continue;
      }
      region.start = range.start;
      region.end = range.end;
      region.host.textContent = '';
      region.host.style.paddingTop = range.start * ROW_H + 'px';
      region.host.style.paddingBottom = (region.rows.length - range.end) * ROW_H + 'px';
      for (let i = range.start; i < range.end; i++) {
        region.host.appendChild(commitRow(region.rows[i], region.maxLanes));
      }
    }
  }

  let syncQueued = false;

  // Scrolling fires far more often than the screen is painted; one sync per
  // frame is enough, and each one is a no-op unless the range actually moved.
  function queueSync() {
    if (syncQueued) {
      return;
    }
    syncQueued = true;
    requestAnimationFrame(function () {
      syncQueued = false;
      syncWindows();
    });
  }

  // How many rows are needed follows the height of the scroller, which changes
  // for more reasons than the window being resized: the icon font arriving
  // retags the toolbar's height, the splitters move the panes about, and a
  // webview that was hidden when it first rendered measures nothing at all
  // until it is shown. Watching the element itself covers every one of them.
  const rowsObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(queueSync) : null;
  if (!rowsObserver) {
    window.addEventListener('resize', queueSync);
  }

  function fillRows(container) {
    const graph = state.model.graph;
    windows = [];
    const visible = graph.rows.filter(matches);
    const incoming = visible.filter(function (r) { return r.group === 'incoming'; });
    const local = visible.filter(function (r) { return r.group === 'local'; });

    container.appendChild(
      groupHeader('incoming', 'Incoming (' + graph.incoming + ')', [
        link('Fetch', function () { post({ type: 'remote', op: 'fetch' }); }),
        el('span', 'link-sep', '|'),
        link('Pull', function () { post({ type: 'remote', op: 'pull' }); }),
      ])
    );
    if (!state.collapsed.incoming) {
      if (incoming.length === 0) {
        container.appendChild(el('div', 'empty', 'Nothing incoming.'));
      } else {
        container.appendChild(rowWindow(incoming, graph.maxLanes));
      }
    }

    container.appendChild(
      groupHeader(
        'local',
        'Local History (' + graph.outgoing + ' Outgoing)',
        [
          link('Push', function () { post({ type: 'remote', op: 'push' }); }),
          el('span', 'link-sep', '|'),
          link('Sync', function () { post({ type: 'remote', op: 'sync' }); }),
        ]
      )
    );
    if (!state.collapsed.local) {
      if (local.length === 0) {
        container.appendChild(el('div', 'empty', 'No commits match the filter.'));
      } else {
        container.appendChild(rowWindow(local, graph.maxLanes));
        if (graph.hasMore && !state.filter.trim()) {
          const more = el('div', 'load-more');
          more.appendChild(link('Load more commits', function () { post({ type: 'loadMore' }); }));
          container.appendChild(more);
        }
      }
    }
  }

  function groupHeader(key, title, links) {
    const header = el('div', 'group-header');
    header.setAttribute('role', 'button');
    const open = !state.collapsed[key];
    header.setAttribute('aria-expanded', String(open));
    header.appendChild(icon(open ? 'chevron-down' : 'chevron-right', 'chev'));
    header.appendChild(el('span', 'title', title));
    const linkWrap = el('div', 'links');
    links.forEach(function (node) {
      linkWrap.appendChild(node);
    });
    header.appendChild(linkWrap);
    header.addEventListener('click', function () {
      state.collapsed[key] = open;
      save();
      renderRowsOnly();
    });
    return header;
  }

  const MAX_CHIPS = 2;

  function refChips(commit) {
    const wrap = el('div', 'chips');
    const ranked = graphView.rankRefs(commit.refs, MAX_CHIPS);

    for (const entry of ranked.shown) {
      const chip = el('span', 'chip ' + entry.kind);
      chip.appendChild(icon(entry.kind === 'tag' ? 'tag' : 'git-branch'));
      chip.appendChild(el('span', null, entry.label));
      chip.title = entry.raw;
      wrap.appendChild(chip);
    }
    if (ranked.hidden.length) {
      const more = el('span', 'chip remote', '+' + ranked.hidden.length);
      more.title = ranked.hidden.join(String.fromCharCode(10));
      wrap.appendChild(more);
    }
    return wrap;
  }

  function commitRow(row, maxLanes) {
    const commit = row.commit;
    const node = el('div', 'grid-row commit-row');
    if (state.selected === commit.hash) {
      node.classList.add('selected');
    }

    node.appendChild(refChips(commit));
    node.appendChild(graphCell(row, maxLanes));

    const message = el('div', 'cell msg');
    if (row.outgoing) {
      const marker = icon('arrow-up');
      marker.title = 'Not pushed yet';
      marker.style.color = 'var(--vsg-lane-1)';
      message.appendChild(marker);
    }
    message.appendChild(el('span', null, commit.subject));
    message.title = commit.subject;
    node.appendChild(message);

    const author = el('div', 'cell author');
    const initial = (commit.author || '?').trim().charAt(0).toUpperCase();
    const avatar = el('span', 'avatar', initial);
    author.appendChild(avatar);
    author.appendChild(el('span', null, commit.author));
    author.title = commit.author;
    node.appendChild(author);

    const date = el('div', 'cell date', formatDate(commit.date));
    date.title = commit.date;
    node.appendChild(date);

    node.appendChild(el('div', 'cell id', commit.shortHash));

    node.addEventListener('click', function () {
      selectCommit(commit.hash);
    });
    node.addEventListener('dblclick', function () {
      post({ type: 'showCommit', hash: commit.hash });
    });
    node.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      event.stopPropagation();
      hideHoverCard();
      selectCommit(commit.hash);
      // The entries depend on the commit - whether it is a merge, the root, or
      // where HEAD already is - and a history is far too many rows to send a
      // menu for each with the model. Asked for here, opened on the reply.
      pendingCommitMenu = { hash: commit.hash, at: { x: event.clientX, y: event.clientY } };
      post({ type: 'commitMenu', hash: commit.hash });
    });
    installHoverCard(node, commit);

    return node;
  }

  // ------------------------------------------------------------- hover card

  /**
   * How long the pointer has to rest on a row before its card appears.
   * Short enough not to feel like a wait, long enough that running the pointer
   * down the list does not flash a card per row.
   */
  const HOVER_DELAY = 450;

  let hoverTimer = null;
  let hoverCard = null;

  function hideHoverCard() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (hoverCard) {
      hoverCard.remove();
      hoverCard = null;
    }
  }

  /**
   * Visual Studio's hover card: who wrote the commit, who recorded it, when
   * each happened, where the repository is, and what the commit says.
   *
   * The committer rows are always shown rather than only when they differ,
   * because the card is read to answer exactly that question.
   */
  function showHoverCard(commit, row) {
    hideHoverCard();

    const card = el('div', 'hover-card');
    const grid = el('div', 'fields');
    function field(key, value, className) {
      grid.appendChild(el('span', 'k', key));
      grid.appendChild(el('span', 'v' + (className ? ' ' + className : ''), value));
    }

    field('Commit:', commit.hash, 'mono');
    field('Author:', commit.author + ' <' + (commit.authorEmail || '') + '>');
    field('Author Date:', formatDate(commit.date));
    field('Committer:', (commit.committer || commit.author) + ' <' + (commit.committerEmail || '') + '>');
    field('Commit Date:', formatDate(commit.committerDate || commit.date));
    field('Repository Path:', state.model.root, 'path');
    card.appendChild(grid);

    card.appendChild(el('div', 'hover-subject', commit.subject));

    document.body.appendChild(card);
    hoverCard = card;

    // Measured after it is in the page, then kept on screen the same way the
    // context menu is. Offset below the row so the card does not sit under the
    // pointer and take the hover from it.
    const box = row.getBoundingClientRect();
    const size = card.getBoundingClientRect();
    const at = format.menuPosition(
      { x: box.left + 40, y: box.bottom + 4 },
      { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    card.style.left = at.x + 'px';
    card.style.top = at.y + 'px';
  }

  /** Arms the card for a row, and disarms it when the pointer leaves. */
  function installHoverCard(node, commit) {
    node.addEventListener('mouseenter', function () {
      hideHoverCard();
      hoverTimer = setTimeout(function () {
        hoverTimer = null;
        // The row may have been scrolled out from under the pointer by the
        // windowing while the delay ran.
        if (node.isConnected) {
          showHoverCard(commit, node);
        }
      }, HOVER_DELAY);
    });
    node.addEventListener('mouseleave', hideHoverCard);
    node.addEventListener('mousedown', hideHoverCard);
  }

  // ------------------------------------------------------------ details pane

  /** The right-click waiting for its entries; see the commit row's handler. */
  let pendingCommitMenu = null;

  function commitMenuItems(hash, entries) {
    const items = [];
    for (const entry of entries || []) {
      items.push({
        label: entry.disabled ? entry.label + '  —  ' + entry.why : entry.label,
        icon: entry.icon,
        shortcut: entry.shortcut,
        checked: entry.checked,
        disabled: entry.disabled,
        run: entry.disabled
          ? function () {}
          : function () {
              post({ type: 'commitOp', op: entry.op, hash: hash });
            },
      });
      if (entry.breakAfter) {
        items.push('-');
      }
    }
    return items;
  }

  /**
   * Brings a commit into view after a jump to its parent or child. The row may
   * not be built - the list is windowed - so the scroller is moved by index and
   * the windowing fills it in.
   */
  function scrollCommitIntoView(hash) {
    const scroller = root.querySelector('.rows');
    if (!scroller || !state.model) {
      return;
    }
    const visible = state.model.graph.rows.filter(matches);
    const at = visible.findIndex(function (row) {
      return row.commit.hash === hash;
    });
    if (at === -1) {
      return;
    }
    const top = at * ROW_H;
    if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - ROW_H * 2) {
      scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
      queueSync();
    }
  }

  function selectCommit(hash) {
    state.selected = hash;
    state.details = null;
    state.detailsError = null;
    state.detailsLoading = true;
    state.detailsFile = null;
    post({ type: 'selectCommit', hash: hash });
    renderRowsOnly();
    renderDetailsOnly();
  }

  /**
   * Brings the details pane back. The commit is already selected - opening the
   * menu selected it - so the pane only has to be on screen to show it, and
   * this is the way back from the close button in its own header.
   */
  function showDetailsPane() {
    if (state.detailsVisible) {
      return;
    }
    state.detailsVisible = true;
    save();
    render();
  }

  function renderDetailsOnly() {
    if (!state.detailsVisible) {
      return;
    }
    const existing = root.querySelector('.details');
    if (!existing) {
      render();
      return;
    }
    const next = renderDetails();
    next.style.flexBasis = state.detailsWidth + 'px';
    // The rail is rebuilt whole on every file click, so without this the tree
    // jumps back to the top and the file just clicked scrolls out of reach.
    const railTop = railScrollTop();
    existing.replaceWith(next);
    restoreRailScroll(railTop);
  }

  function railScrollTop() {
    const scroller = root.querySelector('.meta-rail .scroll');
    return scroller ? scroller.scrollTop : 0;
  }

  function restoreRailScroll(top) {
    const scroller = root.querySelector('.meta-rail .scroll');
    if (scroller && top) {
      scroller.scrollTop = top;
    }
  }

  function renderDetails() {
    const pane = el('div', 'details');
    pane.appendChild(renderDetailsHead());

    if (state.detailsError) {
      pane.appendChild(el('div', 'placeholder', state.detailsError));
      return pane;
    }
    const d = state.details;
    if (!d) {
      pane.appendChild(
        el(
          'div',
          'placeholder',
          state.detailsLoading ? 'Loading…' : 'Select a commit to see its details.'
        )
      );
      return pane;
    }

    pane.appendChild(renderMetaRail(d));
    return pane;
  }

  function renderDetailsHead() {
    const head = el('div', 'head');
    const title = state.details ? 'Commit ' + state.details.shortHash : 'Commit details';
    head.appendChild(el('span', 'title', title));
    head.appendChild(el('div', 'spacer'));
    head.appendChild(
      iconButton('close', 'Hide commit details', function () {
        state.detailsVisible = false;
        save();
        render();
      })
    );
    return head;
  }

  // ------------------------------------------------------------------- diff

  /**
   * Shows one file's change in VS Code's own diff editor, which the extension
   * opens in an editor group beneath this window - Visual Studio docks the
   * diff under its history the same way. A webview cannot host that editor,
   * so the window does not draw a diff of its own: the real one brings the
   * overview ruler, the user's theme, search and the rest for nothing.
   */
  function openFile(d, file, keep) {
    state.detailsFile = file.path;
    post({
      type: 'openFileDiff',
      hash: d.hash,
      path: file.path,
      origPath: file.origPath,
      status: file.status,
      keep: !!keep,
    });
  }

  // -------------------------------------------------------------- meta rail

  function renderMetaRail(d) {
    const rail = el('div', 'meta-rail');
    const scroll = el('div', 'scroll');

    const idRow = el('div', 'id-row');
    idRow.appendChild(el('span', 'k', 'ID:'));
    idRow.appendChild(el('span', 'v mono', d.shortHash));
    idRow.appendChild(el('div', 'spacer'));
    idRow.appendChild(
      link('Copy ID', function () {
        post({ type: 'copyId', hash: d.hash });
      })
    );
    idRow.appendChild(
      link('Full patch', function () {
        post({ type: 'showCommit', hash: d.hash });
      })
    );
    idRow.appendChild(
      link('New branch…', function () {
        post({ type: 'branchFrom', hash: d.hash });
      })
    );
    scroll.appendChild(idRow);

    scroll.appendChild(el('div', 'section-label', 'Message:'));
    const message = el('div', 'message');
    message.appendChild(el('div', 'subject', d.subject));
    if (d.body) {
      message.appendChild(el('div', 'message-body', d.body));
    }
    scroll.appendChild(message);

    const who = el('div', 'who');
    who.appendChild(icon('account'));
    who.appendChild(el('span', 'name', d.author.name));
    who.appendChild(el('div', 'spacer'));
    who.appendChild(el('span', 'when', formatDate(d.author.date)));
    who.title = d.author.name + ' <' + d.author.email + '>';
    scroll.appendChild(who);

    scroll.appendChild(renderRailMeta(d));
    scroll.appendChild(renderChangesTree(d));
    rail.appendChild(scroll);
    return rail;
  }

  /**
   * The rows worth showing only when they say something: a commit made in one
   * go by its own author needs no committer line, and most commits carry one
   * parent and no refs.
   */
  function renderRailMeta(d) {
    const meta = el('div', 'meta');
    function addMeta(key, value) {
      meta.appendChild(el('span', 'k', key));
      const cell = el('span', 'v');
      if (typeof value === 'string') {
        cell.textContent = value;
        cell.title = value;
      } else {
        cell.appendChild(value);
      }
      meta.appendChild(cell);
    }

    if (d.committer.name !== d.author.name || d.committer.date !== d.author.date) {
      addMeta('Committer', d.committer.name + ' <' + d.committer.email + '>');
      addMeta('Committed', formatDate(d.committer.date));
    }

    if (d.parents.length) {
      const wrap = el('div', 'parents');
      for (const parent of d.parents) {
        const node = el('span', 'parent', parent.slice(0, 7));
        node.title = parent;
        node.addEventListener('click', function () {
          selectCommit(parent);
        });
        wrap.appendChild(node);
      }
      addMeta(d.parents.length > 1 ? 'Parents' : 'Parent', wrap);
    }

    if (d.refs.length) {
      addMeta('Refs', d.refs.join(', '));
    }
    return meta;
  }

  function renderChangesTree(d) {
    const wrap = el('div', 'changes');

    const head = el('div', 'changes-head');
    head.appendChild(el('span', null, 'Changes (' + d.files.length + ')'));
    if (d.isMerge) {
      head.appendChild(el('span', 'note', 'against the first parent'));
    }
    if (d.truncated) {
      head.appendChild(el('span', 'note', 'list truncated'));
    }
    wrap.appendChild(head);

    if (!d.files.length) {
      wrap.appendChild(el('div', 'placeholder', 'No file changes.'));
      return wrap;
    }

    const rows = diffView.visibleTreeRows(diffView.buildFileTree(d.files), state.changesClosed);
    for (const row of rows) {
      wrap.appendChild(row.kind === 'dir' ? changesDirRow(row) : changesFileRow(d, row));
    }
    return wrap;
  }

  function changesDirRow(row) {
    const open = !state.changesClosed.has(row.key);
    const node = treeRow({
      kind: 'group-node',
      depth: row.depth,
      open: open,
      codicon: open ? 'folder-opened' : 'folder',
      label: row.label,
    });
    node.addEventListener('click', function () {
      if (open) {
        state.changesClosed.add(row.key);
      } else {
        state.changesClosed.delete(row.key);
      }
      save();
      renderDetailsOnly();
    });
    return node;
  }

  function changesFileRow(d, row) {
    const file = row.file;
    const node = treeRow({
      kind: 'change-file',
      depth: row.depth,
      codicon: 'file',
      label: row.label,
      suffix: file.status,
      selected: file.path === state.detailsFile,
    });
    node.classList.add('st-' + file.status);
    node.title = file.origPath
      ? file.path + String.fromCharCode(10) + '(was ' + file.origPath + ')'
      : file.path;
    node.addEventListener('click', function () {
      openFile(d, file);
      renderDetailsOnly();
    });
    // As in VS Code's own explorer: a click opens the diff in the one preview
    // tab the next click replaces, a double click keeps it open as a tab of
    // its own.
    node.addEventListener('dblclick', function () {
      openFile(d, file, true);
    });
    return node;
  }

  // ------------------------------------------------------------------------
  // PLACEHOLDER - keyboard navigation and screen-reader support.
  //
  // Deferred for the MVP, same as in the Git Changes view. Rows already carry
  // role/aria-level/aria-expanded, so a later pass needs only a roving
  // tabindex, arrow/Home/End/PageUp/PageDown handling and focus restoration
  // across re-renders. Note that a focused row can now be scrolled out of the
  // DOM entirely, so such a pass has to drive the scroll position and let
  // syncWindows() rebuild the row rather than move focus between live nodes.
  // ------------------------------------------------------------------------
  function installKeyboardNavigation(_container) {
    /* intentionally empty - see comment above */
  }

  // ---------------------------------------------------------------- messages

  window.addEventListener('message', function (event) {
    const message = event.data;
    switch (message.type) {
      case 'model':
        state.model = message.model;
        render();
        break;
      case 'commitDetails':
        state.detailsLoading = false;
        state.details = message.details || null;
        state.detailsError = message.error || null;
        state.detailsFile = null;
        // Visual Studio opens a commit already showing its first file, so the
        // diff beneath is never left on the commit before. Details for a
        // commit the user has since clicked past open nothing.
        if (
          state.details &&
          state.details.hash === state.selected &&
          state.details.files.length
        ) {
          openFile(state.details, state.details.files[0]);
        }
        renderDetailsOnly();
        break;
      case 'commitMenu':
        if (pendingCommitMenu && pendingCommitMenu.hash === message.hash) {
          dom.showMenuAt(menuEl, pendingCommitMenu.at, commitMenuItems(message.hash, message.entries));
          pendingCommitMenu = null;
        }
        break;
      case 'revealDetails':
        selectCommit(message.hash);
        showDetailsPane();
        scrollCommitIntoView(message.hash);
        break;
      case 'busy':
        state.busy = message.busy;
        {
          const bar = root.querySelector('.progress');
          if (bar) {
            bar.className = 'progress' + (state.busy ? ' busy' : '');
          } else {
            render();
          }
        }
        break;
    }
  });

  /**
   * Anything the webview throws would otherwise be invisible: it goes to a
   * devtools console nobody has open. Sent across so it lands in the log beside
   * what the extension host was doing at the time.
   */
  window.addEventListener('error', function (event) {
    post({
      type: 'diag',
      label: 'uncaught',
      failed: true,
      detail: {
        message: String(event.message),
        source: String(event.filename || '') + ':' + String(event.lineno || 0),
      },
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    post({
      type: 'diag',
      label: 'unhandledRejection',
      failed: true,
      detail: { message: String((event.reason && event.reason.message) || event.reason) },
    });
  });

  render();
  post({ type: 'ready' });
})();
