/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const menuEl = document.getElementById('menu');

  const persisted = vscode.getState() || {};

  /** @type {{model: any, expanded: Set<string>, sections: Record<string, boolean>, message: string, amend: boolean, selected: string|null, busy: boolean, generating: boolean, error: string|null}} */
  const state = {
    model: null,
    expanded: new Set(persisted.expanded || ['unstaged:#repo', 'staged:#repo']),
    sections: Object.assign({ changes: true, staged: true, stashes: true }, persisted.sections),
    message: persisted.message || '',
    amend: false,
    selected: null,
    busy: false,
    generating: false,
    error: null,
  };

  function save() {
    vscode.setState({
      expanded: [...state.expanded],
      sections: state.sections,
      message: state.message,
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

  // ---------------------------------------------------------- context menus

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
    // Measure, then clamp inside the view.
    const rect = menuEl.getBoundingClientRect();
    const x = Math.min(event.clientX, Math.max(0, window.innerWidth - rect.width - 4));
    const y = Math.min(event.clientY, Math.max(0, window.innerHeight - rect.height - 4));
    menuEl.style.left = x + 'px';
    menuEl.style.top = y + 'px';
  }

  function hideMenu() {
    menuEl.hidden = true;
  }

  document.addEventListener('click', hideMenu);
  document.addEventListener('contextmenu', function (event) {
    if (!event.target.closest('[data-menu]')) {
      hideMenu();
    }
  });
  window.addEventListener('blur', hideMenu);

  // --------------------------------------------------------------- rendering

  function render() {
    const scroller = root.querySelector('.content');
    const scrollTop = scroller ? scroller.scrollTop : 0;

    root.textContent = '';
    root.appendChild(renderProgress());

    const active = state.model && state.model.active;
    if (!state.model) {
      root.appendChild(el('div', 'empty', 'Loading\u2026'));
      return;
    }
    if (!active) {
      root.appendChild(
        el('div', 'empty', 'No Git repository found in this workspace.')
      );
      return;
    }

    root.appendChild(renderHeader(active));
    root.appendChild(renderCommitArea(active));

    const content = el('div', 'content');
    content.appendChild(renderFilesSection(active, 'unstaged'));
    // Visual Studio only shows the staged section once something is staged.
    if (active.staged.length > 0) {
      content.appendChild(renderFilesSection(active, 'staged'));
    }
    content.appendChild(renderStashesSection(active));
    root.appendChild(content);
    content.scrollTop = scrollTop;

    installKeyboardNavigation(content);
  }

  function renderProgress() {
    return el('div', 'progress' + (state.busy ? ' busy' : ''));
  }

  function renderHeader(active) {
    const header = el('div', 'header');

    const branchRow = el('div', 'branch-row');
    const wrap = el('div', 'branch-wrap');
    const select = el('select', 'branch-select');
    select.title = active.upstream
      ? active.branch + ' \u2192 ' + active.upstream
      : active.branch + ' (no upstream)';

    const branches = active.branches.slice();
    if (branches.indexOf(active.branch) === -1) {
      branches.unshift(active.branch);
    }
    for (const branch of branches) {
      const option = el('option', null, branch);
      option.value = branch;
      if (branch === active.branch) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.disabled = active.detached || state.busy;
    select.addEventListener('change', function () {
      post({ type: 'checkout', branch: select.value });
    });
    wrap.appendChild(select);
    branchRow.appendChild(wrap);

    branchRow.appendChild(
      iconButton('cloud-download', 'Fetch', function () {
        post({ type: 'remote', op: 'fetch' });
      }, state.busy)
    );
    branchRow.appendChild(
      iconButton('arrow-down', 'Pull', function () {
        post({ type: 'remote', op: 'pull' });
      }, state.busy)
    );
    branchRow.appendChild(
      iconButton('arrow-up', 'Push', function () {
        post({ type: 'remote', op: 'push' });
      }, state.busy)
    );
    branchRow.appendChild(
      iconButton('sync', 'Sync (pull then push)', function () {
        post({ type: 'remote', op: 'sync' });
      }, state.busy)
    );
    branchRow.appendChild(
      iconButton('ellipsis', 'More actions', function (event) {
        showMenu(event, [
          { label: 'Refresh', run: function () { post({ type: 'refresh' }); } },
          '-',
          {
            label: 'Open Git Repository Window',
            run: function () { post({ type: 'openRepositoryWindow' }); },
          },
        ]);
      })
    );
    header.appendChild(branchRow);

    const syncRow = el('div', 'sync-row');
    const counts = el('span', 'counts');
    counts.appendChild(icon('arrow-up'));
    counts.appendChild(icon('arrow-down'));
    counts.appendChild(document.createTextNode(' ' + active.ahead + ' / ' + active.behind));
    counts.title = active.ahead + ' outgoing, ' + active.behind + ' incoming';
    syncRow.appendChild(counts);

    const allCommits = el('a', 'link', 'View all commits');
    allCommits.addEventListener('click', function () {
      post({ type: 'openRepositoryWindow' });
    });
    syncRow.appendChild(allCommits);
    header.appendChild(syncRow);

    return header;
  }

  function renderCommitArea(active) {
    const area = el('div', 'commit-area');

    const box = el('div', 'commit-box');
    const textarea = el('textarea');
    textarea.placeholder = 'Enter a message <Required>';
    textarea.value = state.message;
    textarea.spellcheck = false;
    textarea.addEventListener('input', function () {
      state.message = textarea.value;
      save();
    });
    textarea.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        commit('all');
      }
    });
    box.appendChild(textarea);

    const generate = iconButton(
      state.generating ? 'loading' : 'sparkle',
      'Generate a commit message with AI',
      function () {
        post({ type: 'generateMessage' });
      },
      state.generating || !state.model.canGenerateMessage
    );
    generate.classList.add('generate');
    if (state.generating) {
      generate.classList.add('spinning');
    }
    box.appendChild(generate);
    area.appendChild(box);

    const row = el('div', 'commit-row');
    const split = el('div', 'split-button');

    // Visual Studio promotes "Commit Staged" the moment anything is staged,
    // because that is then what the button would actually do.
    const hasStaged = active.staged.length > 0;
    const hasAnything = hasStaged || active.unstaged.length > 0;
    const primaryMode = hasStaged ? 'staged' : 'all';

    const primary = el('button', 'primary', hasStaged ? 'Commit Staged' : 'Commit All');
    primary.disabled = state.busy || (!hasAnything && !state.amend);
    primary.addEventListener('click', function () {
      commit(primaryMode, 'none');
    });
    const caret = el('button', 'caret');
    caret.title = 'More commit options';
    caret.appendChild(icon('chevron-down'));
    caret.disabled = state.busy;
    caret.addEventListener('click', function (event) {
      const primaryLabel = hasStaged ? 'Commit Staged' : 'Commit All';
      const otherMode = hasStaged ? 'all' : 'staged';
      const otherLabel = hasStaged ? 'Commit All' : 'Commit Staged';
      showMenu(event, [
        { label: primaryLabel, run: function () { commit(primaryMode, 'none'); } },
        { label: primaryLabel + ' and Push', run: function () { commit(primaryMode, 'push'); } },
        { label: primaryLabel + ' and Sync', run: function () { commit(primaryMode, 'sync'); } },
        '-',
        { label: otherLabel, run: function () { commit(otherMode, 'none'); } },
      ]);
    });
    split.appendChild(primary);
    split.appendChild(caret);
    row.appendChild(split);

    const amendLabel = el('label', 'check');
    const amend = el('input');
    amend.type = 'checkbox';
    amend.checked = state.amend;
    amend.addEventListener('change', function () {
      state.amend = amend.checked;
      render();
    });
    amendLabel.appendChild(amend);
    amendLabel.appendChild(el('span', null, 'Amend'));
    row.appendChild(amendLabel);

    area.appendChild(row);
    return area;
  }

  function commit(mode, after) {
    post({
      type: 'commit',
      message: state.message,
      amend: state.amend,
      mode: mode,
      after: after,
    });
  }

  function sectionHeader(key, title, actions, keepActions) {
    const open = state.sections[key] !== false;
    const header = el('div', 'section-header' + (keepActions ? ' keep-actions' : ''));
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(open));
    header.appendChild(icon(open ? 'chevron-down' : 'chevron-right', 'chev'));
    header.appendChild(el('span', 'title', title));
    header.appendChild(el('span', 'spacer'));

    const actionBar = el('div', 'actions');
    for (const action of actions) {
      actionBar.appendChild(action);
    }
    header.appendChild(actionBar);

    header.addEventListener('click', function () {
      state.sections[key] = !open;
      save();
      render();
    });
    return header;
  }

  /**
   * Renders one of the two file sections. Visual Studio keeps "Changes" and
   * "Staged Changes" apart, and a file edited, staged, then edited again shows
   * up in both - so expansion state is namespaced per section rather than
   * keyed on the path alone.
   */
  function renderFilesSection(active, kind) {
    const isStaged = kind === 'staged';
    const changes = isStaged ? active.staged : active.unstaged;
    const nodes = isStaged ? active.stagedTree : active.unstagedTree;
    const sectionKey = isStaged ? 'staged' : 'changes';
    const prefix = kind + ':';

    const actions = [
      iconButton('collapse-all', 'Collapse all folders', function () {
        for (const key of [...state.expanded]) {
          if (key.indexOf(prefix) === 0) {
            state.expanded.delete(key);
          }
        }
        state.expanded.add(prefix + '#repo');
        save();
        render();
      }),
    ];

    if (isStaged) {
      actions.push(
        iconButton('remove', 'Unstage all changes', function () {
          post({ type: 'unstage', paths: ['.'] });
        })
      );
      actions.push(
        iconButton('ellipsis', 'More staged actions', function (event) {
          showMenu(event, [
            { label: 'Unstage All', run: function () { post({ type: 'unstage', paths: ['.'] }); } },
            '-',
            { label: 'Refresh', run: function () { post({ type: 'refresh' }); } },
          ]);
        })
      );
    } else {
      actions.push(
        iconButton('add', 'Stage all changes', function () {
          post({ type: 'stage', paths: ['.'] });
        })
      );
      actions.push(
        iconButton('ellipsis', 'More change actions', function (event) {
          showMenu(event, [
            { label: 'Stage All', run: function () { post({ type: 'stage', paths: ['.'] }); } },
            { label: 'Stash All Changes…', run: function () { post({ type: 'stashPush' }); } },
            '-',
            { label: 'Refresh', run: function () { post({ type: 'refresh' }); } },
          ]);
        })
      );
    }

    const section = el('div', 'section');
    section.appendChild(
      sectionHeader(
        sectionKey,
        (isStaged ? 'Staged Changes (' : 'Changes (') + changes.length + ')',
        actions
      )
    );

    if (state.sections[sectionKey] === false) {
      return section;
    }

    const tree = el('div');
    tree.setAttribute('role', 'tree');

    if (changes.length === 0) {
      tree.appendChild(el('div', 'empty', isStaged ? 'No staged changes.' : 'No changes.'));
      section.appendChild(tree);
      return section;
    }

    // The repository root row, matching Visual Studio's full repository path.
    const repoKey = prefix + '#repo';
    const repoOpen = state.expanded.has(repoKey);
    const repoRow = row('repo', 0, repoOpen, active.displayRoot, 'repo', null);
    repoRow.addEventListener('click', function () {
      toggle(repoKey, repoOpen);
    });
    tree.appendChild(repoRow);

    if (repoOpen) {
      renderNodes(tree, nodes, 1, prefix);
    }

    section.appendChild(tree);
    return section;
  }

  function renderNodes(container, nodes, depth, prefix) {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        const key = prefix + node.key;
        const open = state.expanded.has(key);
        const folderRow = row(
          'folder',
          depth,
          open,
          node.label,
          open ? 'folder-opened' : 'folder',
          null
        );
        folderRow.title = node.label + ' \u2014 ' + node.fileCount + ' file(s)';
        folderRow.addEventListener('click', function () {
          toggle(key, open);
        });
        container.appendChild(folderRow);
        if (open) {
          renderNodes(container, node.children, depth + 1, prefix);
        }
      } else {
        container.appendChild(fileRow(node, depth));
      }
    }
  }

  function toggle(key, open) {
    if (open) {
      state.expanded.delete(key);
    } else {
      state.expanded.add(key);
    }
    save();
    render();
  }

  function row(kind, depth, open, label, codicon, statusClass) {
    const node = el('div', 'row ' + kind);
    node.setAttribute('role', 'treeitem');
    node.setAttribute('aria-level', String(depth + 1));
    node.style.paddingLeft = 2 + depth * 14 + 'px';

    if (open === null) {
      node.appendChild(el('span', 'chev'));
    } else {
      node.appendChild(icon(open ? 'chevron-down' : 'chevron-right', 'chev'));
      node.setAttribute('aria-expanded', String(open));
    }

    const iconWrap = el('span', 'icon' + (statusClass ? ' ' + statusClass : ''));
    iconWrap.appendChild(icon(codicon));
    node.appendChild(iconWrap);
    node.appendChild(el('span', 'label', label));
    return node;
  }

  const STATUS_ICONS = {
    added: ['diff-added', 'status-added'],
    modified: ['diff-modified', 'status-modified'],
    deleted: ['diff-removed', 'status-deleted'],
    renamed: ['diff-renamed', 'status-renamed'],
    untracked: ['diff-added', 'status-untracked'],
    conflict: ['warning', 'status-conflict'],
    ignored: ['diff-ignored', 'status-ignored'],
  };

  function fileRow(node, depth) {
    const change = node.change;
    const mapped = STATUS_ICONS[change.status] || STATUS_ICONS.modified;
    const fileNode = row('file', depth, null, node.label, mapped[0], mapped[1]);
    fileNode.dataset.menu = '1';
    fileNode.title =
      change.path + (change.origPath ? '  (was ' + change.origPath + ')' : '');

    if (state.selected === change.path) {
      fileNode.classList.add('selected');
    }

    const actions = el('div', 'row-actions');
    actions.appendChild(
      iconButton('git-compare', 'Open changes', function () {
        post({ type: 'openChange', path: change.path });
      })
    );
    if (change.staged) {
      actions.appendChild(
        iconButton('remove', 'Unstage', function () {
          post({ type: 'unstage', paths: [change.path] });
        })
      );
    } else {
      actions.appendChild(
        iconButton('add', 'Stage', function () {
          post({ type: 'stage', paths: [change.path] });
        })
      );
    }
    actions.appendChild(
      iconButton('discard', 'Discard changes', function () {
        post({ type: 'discard', path: change.path });
      })
    );
    fileNode.appendChild(actions);

    fileNode.addEventListener('click', function () {
      state.selected = change.path;
      render();
    });
    fileNode.addEventListener('dblclick', function () {
      post({ type: 'openChange', path: change.path });
    });
    fileNode.addEventListener('contextmenu', function (event) {
      state.selected = change.path;
      showMenu(event, [
        {
          label: 'Open Changes',
          run: function () { post({ type: 'openChange', path: change.path }); },
        },
        '-',
        change.staged
          ? { label: 'Unstage', run: function () { post({ type: 'unstage', paths: [change.path] }); } }
          : { label: 'Stage', run: function () { post({ type: 'stage', paths: [change.path] }); } },
        {
          label: 'Discard Changes\u2026',
          run: function () { post({ type: 'discard', path: change.path }); },
        },
      ]);
    });

    return fileNode;
  }

  function renderStashesSection(active) {
    const section = el('div', 'section');
    section.appendChild(
      sectionHeader('stashes', 'Stashes (' + active.stashes.length + ')', [
        iconButton('add', 'Stash all changes', function () {
          post({ type: 'stashPush' });
        }),
      ])
    );

    if (state.sections.stashes === false) {
      return section;
    }

    if (active.stashes.length === 0) {
      section.appendChild(el('div', 'empty', 'No stashes.'));
      return section;
    }

    const dropAll = el('div', 'sub-link');
    const link = el('a', 'link', 'Drop All');
    link.addEventListener('click', function () {
      post({ type: 'stashClear' });
    });
    dropAll.appendChild(link);
    section.appendChild(dropAll);

    for (const stash of active.stashes) {
      const stashRow = row(
        'stash',
        0,
        null,
        '{ ' + stash.index + ' }  ' + stash.label,
        'archive',
        null
      );
      stashRow.dataset.menu = '1';
      stashRow.title = stash.label;
      stashRow.addEventListener('contextmenu', function (event) {
        showMenu(event, [
          {
            label: 'Apply',
            run: function () { post({ type: 'stash', op: 'apply', index: stash.index }); },
          },
          {
            label: 'Pop (apply and drop)',
            run: function () { post({ type: 'stash', op: 'pop', index: stash.index }); },
          },
          '-',
          {
            label: 'Drop\u2026',
            run: function () { post({ type: 'stash', op: 'drop', index: stash.index }); },
          },
        ]);
      });
      section.appendChild(stashRow);
    }

    return section;
  }

  // ------------------------------------------------------------------------
  // PLACEHOLDER - keyboard navigation and screen-reader support.
  //
  // Deliberately deferred for the MVP. The structural groundwork is already in
  // place (role="tree" / role="treeitem" / aria-level / aria-expanded on every
  // row), so a future pass only needs to add a roving tabindex, arrow/Home/End
  // handling and focus restoration after re-render. Nothing in the current UI
  // depends on this function.
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
        state.error = null;
        render();
        break;
      case 'busy':
        state.busy = message.busy;
        render();
        break;
      case 'generating':
        state.generating = message.generating;
        render();
        break;
      case 'message':
        state.message = message.message;
        save();
        render();
        break;
      case 'committed':
        state.message = '';
        state.amend = false;
        save();
        render();
        break;
      case 'error':
        state.error = message.message;
        break;
    }
  });

  render();
  post({ type: 'ready' });
})();
