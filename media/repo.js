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
    detailsWidth: persisted.detailsWidth || 340,
    detailsVisible: persisted.detailsVisible !== false,
    details: null,
    detailsError: null,
    detailsLoading: false,
  };

  // The row regions currently on screen, rebuilt with the rows themselves.
  let windows = [];

  function save() {
    vscode.setState({
      collapsed: state.collapsed,
      treeClosed: [...state.treeClosed],
      leftWidth: state.leftWidth,
      detailsWidth: state.detailsWidth,
      detailsVisible: state.detailsVisible,
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

    const body = el('div', 'body');
    const left = renderLeft();
    left.style.flexBasis = state.leftWidth + 'px';
    body.appendChild(left);
    body.appendChild(renderSplitter(left, 'left'));
    body.appendChild(renderRight());
    if (state.detailsVisible) {
      const details = renderDetails();
      details.style.flexBasis = state.detailsWidth + 'px';
      body.appendChild(renderSplitter(details, 'right'));
      body.appendChild(details);
    }
    root.appendChild(body);

    const newScroller = root.querySelector('.rows');
    if (newScroller) {
      newScroller.scrollTop = scrollTop;
    }
    // Only now is the pane laid out, which is what the row windows measure
    // themselves against.
    syncWindows();

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
  function renderSplitter(pane, side) {
    const splitter = el('div', 'splitter');
    splitter.addEventListener('mousedown', function (event) {
      event.preventDefault();
      splitter.classList.add('dragging');
      const startX = event.clientX;
      const startWidth = pane.getBoundingClientRect().width;

      function move(e) {
        // Dragging the right-hand splitter left must widen its pane, so the
        // delta is inverted for that side.
        const delta = side === 'right' ? startX - e.clientX : e.clientX - startX;
        const next = Math.max(200, Math.min(720, startWidth + delta));
        if (side === 'right') {
          state.detailsWidth = next;
        } else {
          state.leftWidth = next;
        }
        pane.style.flexBasis = next + 'px';
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
        { label: 'View Commit Details', run: function () { post({ type: 'showCommit', hash: commit.hash }); } },
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
    post({ type: 'selectCommit', hash: hash });
    renderRowsOnly();
    renderDetailsOnly();
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
    existing.replaceWith(next);
  }

  function renderDetails() {
    const pane = el('div', 'details');
    const details = state.details;

    const head = el('div', 'head');
    head.appendChild(el('span', 'title', 'Commit details'));
    head.appendChild(el('div', 'spacer'));
    if (details) {
      head.appendChild(el('span', 'hash', details.shortHash));
    }
    head.appendChild(
      iconButton('close', 'Hide commit details', function () {
        state.detailsVisible = false;
        save();
        render();
      })
    );
    pane.appendChild(head);

    const scroll = el('div', 'scroll');
    if (state.detailsError) {
      scroll.appendChild(el('div', 'placeholder', state.detailsError));
    } else if (details) {
      fillDetails(scroll, details);
    } else if (state.detailsLoading) {
      scroll.appendChild(el('div', 'placeholder', 'Loading…'));
    } else {
      scroll.appendChild(el('div', 'placeholder', 'Select a commit to see its details.'));
    }
    pane.appendChild(scroll);
    return pane;
  }

  function fillDetails(container, d) {
    container.appendChild(el('div', 'subject', d.subject));
    if (d.body) {
      container.appendChild(el('div', 'message-body', d.body));
    }

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

    addMeta('Author', d.author.name + ' <' + d.author.email + '>');
    addMeta('Date', formatDate(d.author.date));
    // Only worth the rows when the commit was not authored and committed in
    // one go - a rebase, a cherry-pick, or a patch applied by someone else.
    if (d.committer.name !== d.author.name || d.committer.date !== d.author.date) {
      addMeta('Committer', d.committer.name + ' <' + d.committer.email + '>');
      addMeta('Committed', formatDate(d.committer.date));
    }
    addMeta('Commit', d.hash);

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
    container.appendChild(meta);

    const filesHead = el('div', 'files-head');
    filesHead.appendChild(el('span', null, 'Changes (' + d.files.length + ')'));
    if (d.isMerge) {
      filesHead.appendChild(el('span', 'note', 'against the first parent'));
    }
    if (d.truncated) {
      filesHead.appendChild(el('span', 'note', 'list truncated'));
    }
    container.appendChild(filesHead);

    if (!d.files.length) {
      container.appendChild(el('div', 'placeholder', 'No file changes.'));
    } else {
      for (const file of d.files) {
        container.appendChild(detailsFileRow(d, file));
      }
    }

    const actions = el('div', 'actions');
    actions.appendChild(
      link('View full patch', function () {
        post({ type: 'showCommit', hash: d.hash });
      })
    );
    actions.appendChild(
      link('Copy ID', function () {
        post({ type: 'copyId', hash: d.hash });
      })
    );
    actions.appendChild(
      link('New branch here…', function () {
        post({ type: 'branchFrom', hash: d.hash });
      })
    );
    container.appendChild(actions);
  }

  function detailsFileRow(d, file) {
    const row = el('div', 'file');
    const segments = file.path.split('/');
    const name = segments.pop();

    row.appendChild(el('span', 'st st-' + file.status, file.status));
    row.appendChild(el('span', 'name', name));
    if (segments.length) {
      row.appendChild(el('span', 'dir', segments.join('/')));
    }
    row.title = file.origPath
      ? file.path + String.fromCharCode(10) + '(was ' + file.origPath + ')'
      : file.path;
    row.addEventListener('click', function () {
      post({
        type: 'openFileDiff',
        hash: d.hash,
        path: file.path,
        origPath: file.origPath,
        status: file.status,
      });
    });
    return row;
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
        renderDetailsOnly();
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
