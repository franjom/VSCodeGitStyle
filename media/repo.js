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

  // Height of one line in the side-by-side diff. The two sides only stay in
  // step because every row is exactly this tall, so the value is pushed into
  // the stylesheet rather than being written down in both places.
  const CODE_ROW_H = 18;

  // Beyond this many diff rows the unchanged stretches are collapsed. Large
  // enough that an ordinary source file is shown whole, small enough that a
  // generated one does not put tens of thousands of rows in the DOM.
  const MAX_DIFF_ROWS = 4000;

  // Rows kept in the DOM beyond each edge of the viewport, so a small scroll is
  // already covered by the time the next frame runs.
  const OVERSCAN = 8;

  const visibleRange = self.VsgVirtual.visibleRange;
  const diffView = self.VsgDiffView;
  const syntax = self.VsgSyntax;

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
    // The details pane is docked across the bottom, so it is sized by height;
    // the metadata rail inside it is the only part still sized by width.
    detailsHeight: persisted.detailsHeight || 380,
    metaWidth: persisted.metaWidth || 300,
    detailsMax: persisted.detailsMax || false,
    details: null,
    detailsError: null,
    detailsLoading: false,
    /** Path of the file whose diff the pane is showing. */
    detailsFile: null,
    fileDiff: null,
    fileDiffError: null,
    fileDiffLoading: false,
    changesClosed: new Set(persisted.changesClosed || []),
  };

  // The row regions currently on screen, rebuilt with the rows themselves.
  let windows = [];

  function save() {
    vscode.setState({
      collapsed: state.collapsed,
      treeClosed: [...state.treeClosed],
      leftWidth: state.leftWidth,
      detailsVisible: state.detailsVisible,
      detailsHeight: state.detailsHeight,
      metaWidth: state.metaWidth,
      detailsMax: state.detailsMax,
      changesClosed: [...state.changesClosed],
    });
  }

  function post(message) {
    vscode.postMessage(message);
  }

  // ------------------------------------------------------------- dom helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function icon(name, extraClass) {
    const node = el('i', 'codicon codicon-' + name + (extraClass ? ' ' + extraClass : ''));
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function iconButton(codicon, title, onClick, disabled) {
    const button = el('button', 'icon-btn');
    button.title = title;
    button.setAttribute('aria-label', title);
    button.appendChild(icon(codicon));
    if (disabled) {
      button.disabled = true;
    }
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick(event);
    });
    return button;
  }

  function link(text, onClick) {
    const node = el('a', 'link', text);
    node.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick();
    });
    return node;
  }

  function showMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    menuEl.textContent = '';
    for (const item of items) {
      if (item === '-') {
        menuEl.appendChild(el('div', 'separator'));
        continue;
      }
      const row = el('div', 'item', item.label);
      row.addEventListener('click', function () {
        hideMenu();
        item.run();
      });
      menuEl.appendChild(row);
    }
    menuEl.hidden = false;
    const rect = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(event.clientX, Math.max(0, window.innerWidth - rect.width - 4)) + 'px';
    menuEl.style.top = Math.min(event.clientY, Math.max(0, window.innerHeight - rect.height - 4)) + 'px';
  }

  function hideMenu() {
    menuEl.hidden = true;
  }

  document.addEventListener('click', hideMenu);
  window.addEventListener('blur', hideMenu);

  // ------------------------------------------------------------ graph drawing

  function laneX(lane) {
    return 8 + lane * LANE_W;
  }

  function color(index) {
    return 'var(--vsg-lane-' + (((index % LANE_COLORS) + LANE_COLORS) % LANE_COLORS) + ')';
  }

  function path(d, stroke) {
    const node = document.createElementNS(SVG_NS, 'path');
    node.setAttribute('d', d);
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', '1.6');
    node.setAttribute('fill', 'none');
    return node;
  }

  function graphWidth(maxLanes) {
    return Math.max(laneX(maxLanes - 1) + 10, 28);
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

    root.style.setProperty('--vsg-code-row', CODE_ROW_H + 'px');

    // Visual Studio docks commit details across the bottom of the window, so
    // the refs and the history share an upper band and the pane spans the
    // whole width beneath them rather than taking a column beside them.
    const body = el('div', 'body');
    const upper = el('div', 'upper' + (state.detailsVisible && state.detailsMax ? ' hidden' : ''));
    const left = renderLeft();
    left.style.flexBasis = state.leftWidth + 'px';
    upper.appendChild(left);
    upper.appendChild(
      renderSplitter({
        selector: '.left',
        axis: 'x',
        min: 140,
        max: 720,
        apply: function (size) {
          state.leftWidth = size;
        },
      })
    );
    upper.appendChild(renderRight());
    body.appendChild(upper);

    if (state.detailsVisible) {
      if (!state.detailsMax) {
        body.appendChild(
          renderSplitter({
            selector: '.details',
            axis: 'y',
            // Dragging the divider up has to make the pane below it taller.
            invert: true,
            min: 150,
            max: Math.max(200, window.innerHeight - 160),
            apply: function (size) {
              state.detailsHeight = size;
            },
          })
        );
      }
      const details = renderDetails();
      if (!state.detailsMax) {
        details.style.flexBasis = state.detailsHeight + 'px';
      }
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
    installDiffScroll();

    installKeyboardNavigation(root);
  }

  function renderToolbar() {
    const bar = el('div', 'toolbar');
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
   * for a pane that grows as the pointer travels toward its own edge - both the
   * bottom dock and the right-hand rail do - and `apply` records the new size.
   */
  function renderSplitter(options) {
    const horizontal = options.axis !== 'y';
    const splitter = el('div', 'splitter ' + (horizontal ? 'vertical' : 'horizontal'));
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

  /**
   * Nests refs on "/" so feature/x sits under a "feature" node. `displayOf`
   * gives the path to nest by, which lets origin/feature/x nest under the
   * remote's own node while the leaf keeps its real ref name for checkout.
   */
  function nest(refs, displayOf) {
    const tree = { dirs: new Map(), leaves: [] };
    for (const ref of refs) {
      const segments = displayOf(ref).split('/');
      const name = segments.pop();
      let node = tree;
      for (const segment of segments) {
        let next = node.dirs.get(segment);
        if (!next) {
          next = { dirs: new Map(), leaves: [] };
          node.dirs.set(segment, next);
        }
        node = next;
      }
      node.leaves.push({ ref, name });
    }
    return tree;
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
        const items = [
          { label: 'View History', run: function () { post({ type: 'setScope', scope: ref.short }); } },
        ];
        if (ref.kind !== 'remote' && !ref.current) {
          items.push('-');
          items.push({
            label: 'Checkout ' + ref.short,
            run: function () { post({ type: 'checkout', ref: ref.short }); },
          });
        }
        showMenu(event, items);
      });
      container.appendChild(row);
    }
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
        renderNested(scroll, nest(heads, function (r) { return r.short; }), 2, 'heads');

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
                nest(list, function (r) {
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
            renderNested(scroll, nest(tags, function (r) { return r.short; }), 3, 'tags');
          }
        }
      }
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

  function matches(row) {
    const needle = state.filter.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    const commit = row.commit;
    return (
      commit.subject.toLowerCase().indexOf(needle) !== -1 ||
      commit.author.toLowerCase().indexOf(needle) !== -1 ||
      commit.hash.toLowerCase().indexOf(needle) !== -1
    );
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

  function formatDate(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
      return iso;
    }
    return (
      date.toLocaleDateString() +
      ' ' +
      date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    );
  }

  const MAX_CHIPS = 2;

  function refChips(commit) {
    const wrap = el('div', 'chips');
    // A commit that several branches point at would otherwise fill the column;
    // show the first few and fold the rest into a "+n" chip.
    // Rank so the checked-out branch and tags survive the cap ahead of the
    // remote-tracking refs, which are the least interesting to see here.
    const RANK = { current: 0, local: 1, tag: 2, remote: 3 };
    const classified = commit.refs
      .map(function (raw) {
        if (raw.indexOf('HEAD -> ') === 0) {
          return { raw: raw, label: raw.substring(8), kind: 'current' };
        }
        if (raw === 'HEAD') {
          return { raw: raw, label: raw, kind: 'current' };
        }
        if (raw.indexOf('tag: ') === 0) {
          return { raw: raw, label: raw.substring(5), kind: 'tag' };
        }
        return { raw: raw, label: raw, kind: raw.indexOf('/') !== -1 ? 'remote' : 'local' };
      })
      .sort(function (a, b) {
        return RANK[a.kind] - RANK[b.kind];
      });

    const shown = classified.slice(0, MAX_CHIPS);
    const hidden = classified.slice(MAX_CHIPS).map(function (c) { return c.raw; });
    for (const entry of shown) {
      const raw = entry.raw;
      const label = entry.label;
      const kind = entry.kind;
      const chip = el('span', 'chip ' + kind);
      chip.appendChild(icon(kind === 'tag' ? 'tag' : 'git-branch'));
      chip.appendChild(el('span', null, label));
      chip.title = raw;
      wrap.appendChild(chip);
    }
    if (hidden.length) {
      const more = el('span', 'chip remote', '+' + hidden.length);
      more.title = hidden.join('\n');
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
      selectCommit(commit.hash);
      showMenu(event, [
        { label: 'View Commit Details', run: showDetailsPane },
        { label: 'Copy Commit ID', run: function () { post({ type: 'copyId', hash: commit.hash }); } },
        '-',
        { label: 'New Branch from Here…', run: function () { post({ type: 'branchFrom', hash: commit.hash }); } },
      ]);
    });

    return node;
  }

  // ------------------------------------------------------------ details pane

  function selectCommit(hash) {
    state.selected = hash;
    state.details = null;
    state.detailsError = null;
    state.detailsLoading = true;
    state.detailsFile = null;
    state.fileDiff = null;
    state.fileDiffError = null;
    state.fileDiffLoading = false;
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
    if (!state.detailsMax) {
      next.style.flexBasis = state.detailsHeight + 'px';
    }
    // The rail is rebuilt whole on every file click, so without this the tree
    // jumps back to the top and the file just clicked scrolls out of reach.
    const railTop = railScrollTop();
    existing.replaceWith(next);
    restoreRailScroll(railTop);
    installDiffScroll();
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
    const pane = el('div', 'details' + (state.detailsMax ? ' max' : ''));
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

    pane.appendChild(renderDiffToolbar(d));

    const inner = el('div', 'details-body');
    inner.appendChild(renderDiffArea(d));
    inner.appendChild(
      renderSplitter({
        selector: '.meta-rail',
        axis: 'x',
        // The rail sits at the right edge, so dragging left has to widen it.
        invert: true,
        min: 220,
        max: 620,
        apply: function (size) {
          state.metaWidth = size;
        },
      })
    );
    const rail = renderMetaRail(d);
    rail.style.flexBasis = state.metaWidth + 'px';
    inner.appendChild(rail);
    pane.appendChild(inner);
    return pane;
  }

  function renderDetailsHead() {
    const head = el('div', 'head');
    const title = state.details ? 'Commit ' + state.details.shortHash : 'Commit details';
    head.appendChild(el('span', 'title', title));
    head.appendChild(el('div', 'spacer'));
    head.appendChild(
      iconButton(
        state.detailsMax ? 'chevron-down' : 'chevron-up',
        state.detailsMax ? 'Restore' : 'Maximize',
        function () {
          state.detailsMax = !state.detailsMax;
          save();
          render();
          installDiffScroll();
        }
      )
    );
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

  /** The rows actually drawn, which is the parsed diff after any collapsing. */
  function diffRows() {
    const diff = state.fileDiff;
    if (!diff || !diff.rows.length) {
      return [];
    }
    return diffView.collapseRows(diff.rows, MAX_DIFF_ROWS);
  }

  function renderDiffToolbar(d) {
    const bar = el('div', 'details-toolbar');
    const diff = state.fileDiff;
    const anchors = diff ? diffView.changeAnchors(diffRows()) : [];

    bar.appendChild(
      iconButton(
        'arrow-up',
        'Previous change',
        function () {
          gotoChange(-1);
        },
        anchors.length === 0
      )
    );
    bar.appendChild(
      iconButton(
        'arrow-down',
        'Next change',
        function () {
          gotoChange(1);
        },
        anchors.length === 0
      )
    );

    const count = anchors.length;
    bar.appendChild(el('span', 'count', count === 1 ? '1 change' : count + ' changes'));
    if (diff) {
      bar.appendChild(el('span', 'tally minus', '-' + diff.removed));
      bar.appendChild(el('span', 'tally plus', '+' + diff.added));
    }

    if (state.detailsFile) {
      const name = el('span', 'file-name', state.detailsFile.split('/').pop());
      name.title = state.detailsFile;
      bar.appendChild(name);
    }

    bar.appendChild(el('div', 'spacer'));
    if (state.detailsFile) {
      bar.appendChild(
        iconButton('go-to-file', 'Open this diff in an editor', function () {
          openSelectedInEditor(d);
        })
      );
    }
    return bar;
  }

  function renderDiffArea(d) {
    const area = el('div', 'diff-area');

    if (!state.detailsFile) {
      area.appendChild(el('div', 'placeholder', 'Select a file to see its changes.'));
      return area;
    }
    if (state.fileDiffError) {
      area.appendChild(el('div', 'placeholder', state.fileDiffError));
      return area;
    }
    if (state.fileDiffLoading || !state.fileDiff) {
      area.appendChild(el('div', 'placeholder', 'Loading…'));
      return area;
    }
    if (state.fileDiff.binary) {
      area.appendChild(el('div', 'placeholder', 'Binary file - no text diff to show.'));
      return area;
    }

    const rows = diffRows();
    if (!rows.length) {
      area.appendChild(el('div', 'placeholder', 'No changes in this file.'));
      return area;
    }

    const name = state.detailsFile.split('/').pop();
    const parent = d.parents.length ? d.parents[0].slice(0, 7) : 'empty tree';
    const oldName = state.fileDiff.origPath ? state.fileDiff.origPath.split('/').pop() : name;

    const titles = el('div', 'diff-titles');
    titles.appendChild(el('div', 'diff-title', oldName + ' (' + parent + ')'));
    titles.appendChild(el('div', 'diff-title', name + ' (' + d.shortHash + ')'));
    area.appendChild(titles);

    const scroll = el('div', 'diff-scroll');
    scroll.appendChild(renderDiffSide(rows, 'old'));
    scroll.appendChild(renderDiffSide(rows, 'new'));
    area.appendChild(scroll);

    if (state.fileDiff.truncated) {
      area.appendChild(
        el('div', 'diff-note', 'Too large to show whole; unchanged regions are elided.')
      );
    }
    return area;
  }

  /**
   * One column of the diff. Both columns hold exactly the same number of rows,
   * each a fixed height, which is what lets the two scroll in step and what
   * keeps a deleted line opposite the line that replaced it.
   */
  function renderDiffSide(rows, side) {
    const column = el('div', 'diff-side');
    column.dataset.side = side;
    const list = el('div', 'diff-rows');
    const isOld = side === 'old';

    // Colouring is done for the side in one pass rather than line by line: a
    // block comment or a docstring only makes sense in the context of the lines
    // above it. A renamed file may well change language, so each side asks
    // about its own name.
    const named = isOld ? state.fileDiff.origPath || state.fileDiff.path : state.fileDiff.path;
    const highlights = syntax.highlightLines(
      rows.map(function (row) {
        return isOld ? row.oldText : row.newText;
      }),
      syntax.languageFor(named)
    );

    let at = -1;
    for (const row of rows) {
      at++;
      const text = isOld ? row.oldText : row.newText;
      const lineNo = isOld ? row.oldNo : row.newNo;

      let kind = row.kind;
      if (row.kind !== 'gap' && text === null) {
        // The blank standing opposite a line this side does not have.
        kind = 'empty';
      } else if (row.kind === 'add' || row.kind === 'del' || row.kind === 'change') {
        // An edited line reads as removed on the left and added on the right;
        // the word highlight inside it says what actually moved.
        kind = isOld ? 'del' : 'add';
      }

      const node = el('div', 'diff-row k-' + kind);
      node.appendChild(el('span', 'ln', lineNo === null ? '' : String(lineNo)));

      if (row.kind === 'gap') {
        const skipped = row.skipped || 0;
        node.appendChild(
          el(
            'span',
            'code gap-label',
            skipped === 1 ? '1 unchanged line' : skipped + ' unchanged lines'
          )
        );
      } else {
        node.appendChild(
          renderCode(text, isOld ? row.oldSpans : row.newSpans, highlights[at])
        );
      }
      list.appendChild(node);
    }

    column.appendChild(list);
    return column;
  }

  /**
   * A line of code, carrying both its syntax colouring and the parts the diff
   * found changed. The two overlap freely, so the line is cut at every boundary
   * of either and each piece gets whichever of the two apply to it.
   *
   * Text goes in as text nodes rather than as markup, so a line containing
   * angle brackets stays a line of code.
   */
  function renderCode(text, spans, tokens) {
    const node = el('span', 'code');
    if (text === null) {
      return node;
    }
    const segments = syntax.mergeSegments(text.length, tokens, spans);
    // The overwhelmingly common case: a line with nothing to mark, which is
    // one text node rather than a span.
    if (segments.length <= 1 && (!segments[0] || (!segments[0].type && !segments[0].word))) {
      node.textContent = text;
      return node;
    }

    for (const segment of segments) {
      const piece = text.slice(segment.start, segment.end);
      if (!segment.type && !segment.word) {
        node.appendChild(document.createTextNode(piece));
        continue;
      }
      const classes = [];
      if (segment.type) {
        classes.push('tok-' + segment.type);
      }
      if (segment.word) {
        classes.push('word');
      }
      node.appendChild(el('span', classes.join(' '), piece));
    }
    return node;
  }

  /**
   * Keeps the two sides level.
   *
   * Assigning a scrollTop that is already set fires no event, so the two
   * handlers settle after one hop rather than chasing each other. Horizontal
   * scrolling is left independent, the way Visual Studio gives each side its
   * own bar.
   */
  function installDiffScroll() {
    const sides = root.querySelectorAll('.diff-side');
    if (sides.length !== 2) {
      return;
    }
    for (const side of sides) {
      side.addEventListener('scroll', function () {
        const other = side === sides[0] ? sides[1] : sides[0];
        if (other.scrollTop !== side.scrollTop) {
          other.scrollTop = side.scrollTop;
        }
      });
    }
  }

  /**
   * Steps to the next or previous run of changed lines, measuring from what is
   * on screen rather than from a remembered index, so scrolling by hand and
   * then pressing the button goes where the user is looking.
   */
  function gotoChange(delta) {
    const sides = root.querySelectorAll('.diff-side');
    if (!sides.length) {
      return;
    }
    const anchors = diffView.changeAnchors(diffRows());
    if (!anchors.length) {
      return;
    }

    const firstVisible = Math.round(sides[0].scrollTop / CODE_ROW_H);
    const at = diffView.currentAnchor(anchors, firstVisible);
    let next;
    if (delta > 0) {
      next = at + 1;
    } else {
      // Sitting on a change, "previous" means the one before it; sitting below
      // one, it means going back to it.
      next = anchors[at] === firstVisible ? at - 1 : at;
    }
    next = Math.max(0, Math.min(anchors.length - 1, next));

    // A few rows of context above the change, so it does not land tight
    // against the column titles.
    const top = Math.max(0, (anchors[next] - 3) * CODE_ROW_H);
    for (const side of sides) {
      side.scrollTop = top;
    }
  }

  function openSelectedInEditor(d) {
    const file = (d.files || []).find(function (f) {
      return f.path === state.detailsFile;
    });
    if (file) {
      post({
        type: 'openFileDiff',
        hash: d.hash,
        path: file.path,
        origPath: file.origPath,
        status: file.status,
      });
    }
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
      selectDetailsFile(file);
    });
    // A double click opens the same diff in a real editor, which is the way to
    // a full-size view with search and the editor's own navigation.
    node.addEventListener('dblclick', function () {
      post({
        type: 'openFileDiff',
        hash: d.hash,
        path: file.path,
        origPath: file.origPath,
        status: file.status,
      });
    });
    return node;
  }

  /**
   * Points the diff at one file and asks for it. `quiet` is for the selection
   * made while the details themselves are being drawn, where the caller is
   * about to render anyway.
   */
  function selectDetailsFile(file, quiet) {
    state.detailsFile = file.path;
    state.fileDiff = null;
    state.fileDiffError = null;
    state.fileDiffLoading = true;
    post({
      type: 'fileDiff',
      hash: state.details.hash,
      path: file.path,
      origPath: file.origPath,
    });
    if (!quiet) {
      renderDetailsOnly();
    }
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
        state.fileDiff = null;
        state.fileDiffError = null;
        state.fileDiffLoading = false;
        // Visual Studio opens a commit already showing its first file, so the
        // pane is never a blank frame waiting to be clicked.
        if (state.details && state.details.files.length) {
          selectDetailsFile(state.details.files[0], true);
        }
        renderDetailsOnly();
        break;
      case 'fileDiff':
        // A reply for a file or commit the user has since moved off is stale.
        if (
          state.details &&
          message.hash === state.details.hash &&
          message.path === state.detailsFile
        ) {
          state.fileDiffLoading = false;
          state.fileDiff = message.diff || null;
          state.fileDiffError = message.error || null;
          renderDetailsOnly();
        }
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

  render();
  post({ type: 'ready' });
})();
