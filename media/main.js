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
    collapsedNodes: new Set(persisted.collapsedNodes || []),
    sections: Object.assign(
      { changes: true, staged: true, conflicts: true, stashes: true },
      persisted.sections
    ),
    message: persisted.message || '',
    amend: false,
    selected: null,
    busy: false,
    generating: false,
    error: null,
  };

  function save() {
    vscode.setState({
      collapsedNodes: [...state.collapsedNodes],
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

  function link(text, onClick) {
    const node = el('a', 'link', text);
    node.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick();
    });
    return node;
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
      const row = el('div', 'item');
      // Visual Studio's menus lead with an icon column, and the entries without
      // one still line up with it, so the slot is always there.
      row.appendChild(item.icon ? icon(item.icon, 'menu-icon') : el('span', 'menu-icon'));
      row.appendChild(el('span', null, item.label));
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
    if (active.operation) {
      root.appendChild(renderOperationBanner(active));
    }
    root.appendChild(renderCommitArea(active));

    const content = el('div', 'content');
    // Unresolved conflicts block the commit entirely, so they go first.
    if (active.conflicts.length > 0) {
      content.appendChild(renderFilesSection(active, 'conflicts'));
    }
    // Visual Studio puts Staged Changes above Changes, and only shows it once
    // something is actually staged.
    if (active.staged.length > 0) {
      content.appendChild(renderFilesSection(active, 'staged'));
    }
    content.appendChild(renderFilesSection(active, 'unstaged'));
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

  const OPERATION_LABELS = {
    merge: 'Merging',
    rebase: 'Rebasing onto',
    'cherry-pick': 'Cherry-picking',
    revert: 'Reverting',
  };

  function renderOperationBanner(active) {
    const op = active.operation;
    const banner = el('div', 'op-banner' + (active.conflicts.length ? ' blocked' : ''));
    banner.appendChild(icon(active.conflicts.length ? 'warning' : 'git-merge'));

    // The count lives in the Merge Conflicts header already; repeating it here
    // only made the line too long for a sidebar and truncated the branch name.
    const label = ((OPERATION_LABELS[op.kind] || op.kind) + ' ' + (op.ref || '')).trim();
    const text = el('span', 'text', label);
    text.title = active.conflicts.length
      ? label + ' - resolve ' + active.conflicts.length + ' conflict(s) to continue'
      : label + ' - conflicts resolved, ready to commit';
    banner.appendChild(text);
    if (!active.conflicts.length) {
      banner.appendChild(el('span', 'ready', 'ready to commit'));
    }

    banner.appendChild(
      link('Abort', function () {
        post({ type: 'abortOperation' });
      })
    );
    return banner;
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

    const blocked = active.conflicts.length > 0;
    const primary = el('button', 'primary', hasStaged ? 'Commit Staged' : 'Commit All');
    primary.disabled = state.busy || blocked || (!hasAnything && !state.amend);
    if (blocked) {
      primary.title = 'Resolve the merge conflicts first.';
    }
    primary.addEventListener('click', function () {
      commit(primaryMode, 'none');
    });
    const caret = el('button', 'caret');
    caret.title = 'More commit options';
    caret.appendChild(icon('chevron-down'));
    caret.disabled = state.busy || blocked;
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
    const isConflicts = kind === 'conflicts';
    const changes = isConflicts
      ? active.conflicts
      : isStaged
        ? active.staged
        : active.unstaged;
    const nodes = isConflicts
      ? active.conflictsTree
      : isStaged
        ? active.stagedTree
        : active.unstagedTree;
    const sectionKey = kind === 'unstaged' ? 'changes' : kind;
    const prefix = kind + ':';

    // One button that does whichever of the two is useful right now: folders
    // start expanded, so a collapse-all with no way back would be a trap.
    const folderKeys = collectFolderKeys(nodes, prefix, [prefix + '#repo']);
    const anyCollapsed = folderKeys.some(function (key) {
      return state.collapsedNodes.has(key);
    });

    const actions = [
      iconButton(
        anyCollapsed ? 'expand-all' : 'collapse-all',
        anyCollapsed ? 'Expand all folders' : 'Collapse all folders',
        function () {
          for (const key of folderKeys) {
            if (anyCollapsed) {
              state.collapsedNodes.delete(key);
            } else {
              state.collapsedNodes.add(key);
            }
          }
          save();
          render();
        }
      ),
    ];

    if (isConflicts) {
      // Nothing sensible applies to every conflict at once; resolution is per
      // file, and staging an unresolved one is what git refuses anyway.
    } else if (isStaged) {
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
        (isConflicts
          ? 'Merge Conflicts ('
          : isStaged
            ? 'Staged Changes ('
            : 'Changes (') + changes.length + ')',
        actions
      )
    );

    if (state.sections[sectionKey] === false) {
      return section;
    }

    const tree = el('div');
    tree.setAttribute('role', 'tree');

    if (changes.length === 0) {
      tree.appendChild(
        el(
          'div',
          'empty',
          isConflicts ? 'No conflicts.' : isStaged ? 'No staged changes.' : 'No changes.'
        )
      );
      section.appendChild(tree);
      return section;
    }

    // The repository root row, matching Visual Studio's full repository path.
    const repoKey = prefix + '#repo';
    const repoOpen = isNodeOpen(repoKey);
    const repoRow = row('repo', 0, repoOpen, active.displayRoot, 'repo', null);
    repoRow.addEventListener('click', function () {
      toggle(repoKey, repoOpen);
    });
    tree.appendChild(repoRow);

    if (repoOpen) {
      renderNodes(tree, nodes, 1, prefix, kind);
    }

    section.appendChild(tree);
    return section;
  }

  function renderNodes(container, nodes, depth, prefix, kind) {
    const isStagedSection = kind === 'staged';
    const isConflicts = kind === 'conflicts';
    for (const node of nodes) {
      if (node.kind === 'folder') {
        const key = prefix + node.key;
        const open = isNodeOpen(key);
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

        // Whole-folder actions on hover, as Visual Studio offers. Conflicts
        // are resolved one file at a time, so that section gets none.
        folderRow.appendChild(el('span', 'spacer'));
        const folderActions = el('div', 'row-actions');
        if (isConflicts) {
          folderActions.appendChild(el('span'));
        } else if (isStagedSection) {
          folderActions.appendChild(
            iconButton('remove', 'Unstage this folder', function () {
              post({ type: 'unstage', paths: [node.key] });
            })
          );
        } else {
          folderActions.appendChild(
            iconButton('discard', 'Discard changes in this folder', function () {
              post({ type: 'discardFolder', path: node.key });
            })
          );
          folderActions.appendChild(
            iconButton('add', 'Stage this folder', function () {
              post({ type: 'stage', paths: [node.key] });
            })
          );
        }
        folderRow.appendChild(folderActions);

        container.appendChild(folderRow);
        if (open) {
          renderNodes(container, node.children, depth + 1, prefix, kind);
        }
      } else {
        container.appendChild(fileRow(node, depth, kind));
      }
    }
  }

  function isNodeOpen(key) {
    return !state.collapsedNodes.has(key);
  }

  function toggle(key, open) {
    if (open) {
      state.collapsedNodes.add(key);
    } else {
      state.collapsedNodes.delete(key);
    }
    save();
    render();
  }

  /** Every folder key in a section, for the collapse/expand-all button. */
  function collectFolderKeys(nodes, prefix, out) {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        out.push(prefix + node.key);
        collectFolderKeys(node.children, prefix, out);
      }
    }
    return out;
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

    if (codicon) {
      const iconWrap = el('span', 'icon' + (statusClass ? ' ' + statusClass : ''));
      iconWrap.appendChild(icon(codicon));
      node.appendChild(iconWrap);
    }
    node.appendChild(el('span', 'label', label));
    return node;
  }

  // ---------------------------------------------------------- file type icons

  // VS Code gives webviews no access to the active file icon theme, so the
  // badge is built here: a short language tag in that language's own colour,
  // which is what Visual Studio's "JS" marker amounts to. Anything unmapped
  // falls back to a plain file codicon.
  const FILE_TYPES = [
    [['ts'], 'TS', '#3178c6'],
    [['tsx'], 'TSX', '#3178c6'],
    [['js', 'mjs', 'cjs'], 'JS', '#e8d44d'],
    [['jsx'], 'JSX', '#e8d44d'],
    [['cs'], 'C#', '#a074c4'],
    [['csproj', 'sln', 'props', 'targets'], 'PRJ', '#a074c4'],
    [['vb'], 'VB', '#a074c4'],
    [['json', 'jsonc'], '{ }', '#cbcb41'],
    [['html', 'htm', 'cshtml', 'razor'], '<>', '#e37933'],
    [['css'], 'CSS', '#6bb3e8'],
    [['scss', 'sass', 'less'], 'SCS', '#cf649a'],
    [['xml', 'xsd', 'xslt', 'config', 'axaml', 'xaml'], 'XML', '#e37933'],
    [['yml', 'yaml'], 'YML', '#cb7171'],
    [['md', 'markdown'], 'MD', '#6bb3e8'],
    [['sql'], 'SQL', '#e8a33d'],
    [['sh', 'bash', 'zsh'], 'SH', '#89e051'],
    [['ps1', 'psm1'], 'PS', '#5391fe'],
    [['bat', 'cmd'], 'BAT', '#89e051'],
    [['py'], 'PY', '#519aba'],
    [['java'], 'JAV', '#c1873d'],
    [['go'], 'GO', '#50b7d4'],
    [['rs'], 'RS', '#d9a066'],
    [['rb'], 'RB', '#c46a68'],
    [['php'], 'PHP', '#7e82b8'],
    [['c', 'h'], 'C', '#6bb3e8'],
    [['cpp', 'cc', 'hpp', 'cxx'], 'C++', '#6bb3e8'],
    [['vue'], 'VUE', '#41b883'],
    [['swift'], 'SWT', '#e37933'],
    [['kt', 'kts'], 'KT', '#a074c4'],
    [['dart'], 'DRT', '#50b7d4'],
    [['txt', 'log'], 'TXT', '#9aa0a6'],
    [['csv'], 'CSV', '#89e051'],
    [['toml', 'ini', 'env', 'editorconfig'], 'CFG', '#9aa0a6'],
    [['lock'], 'LCK', '#9aa0a6'],
  ];

  const ICON_TYPES = [
    [['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg'], 'file-media'],
    [['zip', 'gz', 'tar', '7z', 'rar', 'nupkg', 'vsix'], 'file-zip'],
    [['pdf'], 'file-pdf'],
    [['dll', 'exe', 'pdb', 'so', 'dylib'], 'file-binary'],
  ];

  const FILE_TYPE_MAP = (function () {
    const map = new Map();
    for (const entry of FILE_TYPES) {
      for (const ext of entry[0]) {
        map.set(ext, { label: entry[1], color: entry[2] });
      }
    }
    return map;
  })();

  const ICON_TYPE_MAP = (function () {
    const map = new Map();
    for (const entry of ICON_TYPES) {
      for (const ext of entry[0]) {
        map.set(ext, entry[1]);
      }
    }
    return map;
  })();

  function extensionOf(name) {
    const lower = name.toLowerCase();
    // Dotfiles such as .gitignore have no extension; their whole name is one.
    if (lower.indexOf('.') <= 0) {
      return lower.replace(/^\./, '');
    }
    return lower.slice(lower.lastIndexOf('.') + 1);
  }

  function fileTypeNode(name) {
    const lower = name.toLowerCase();
    if (lower.indexOf('.git') === 0 || lower === 'gitignore' || lower === 'gitattributes') {
      const wrap = el('span', 'icon');
      wrap.appendChild(icon('source-control'));
      return wrap;
    }
    if (lower === 'dockerfile' || lower.indexOf('dockerfile') === 0) {
      const wrap = el('span', 'icon');
      wrap.appendChild(icon('server-environment'));
      return wrap;
    }

    const ext = extensionOf(name);
    const codicon = ICON_TYPE_MAP.get(ext);
    if (codicon) {
      const wrap = el('span', 'icon');
      wrap.appendChild(icon(codicon));
      return wrap;
    }

    const type = FILE_TYPE_MAP.get(ext);
    if (!type) {
      const wrap = el('span', 'icon');
      wrap.appendChild(icon('file'));
      return wrap;
    }

    const badge = el('span', 'file-badge', type.label);
    badge.style.color = type.color;
    badge.title = ext.toUpperCase();
    return badge;
  }

  // Visual Studio shows a file icon on the left and a single status letter
  // right-aligned at the end of the row.
  const STATUS_LETTERS = {
    added: ['A', 'status-added', 'Added'],
    modified: ['M', 'status-modified', 'Modified'],
    deleted: ['D', 'status-deleted', 'Deleted'],
    renamed: ['R', 'status-renamed', 'Renamed'],
    untracked: ['U', 'status-untracked', 'Untracked'],
    conflict: ['!', 'status-conflict', 'Conflicted'],
    ignored: ['I', 'status-ignored', 'Ignored'],
  };

  function fileRow(node, depth, kind) {
    const change = node.change;
    const isConflict = kind === 'conflicts';
    const mapped = STATUS_LETTERS[change.status] || STATUS_LETTERS.modified;
    const fileNode = row('file', depth, null, node.label, null, null);
    fileNode.insertBefore(fileTypeNode(node.label), fileNode.querySelector('.label'));
    // Colour the name by git status as well; the type badge owns the icon slot.
    fileNode.querySelector('.label').classList.add(mapped[1]);
    fileNode.dataset.menu = '1';
    fileNode.title =
      change.path + (change.origPath ? '  (was ' + change.origPath + ')' : '');

    if (state.selected === change.path) {
      fileNode.classList.add('selected');
    }

    fileNode.appendChild(el('span', 'spacer'));

    const actions = el('div', 'row-actions');
    if (isConflict) {
      actions.appendChild(
        iconButton('git-merge', 'Open in the merge editor', function () {
          post({ type: 'openMergeEditor', path: change.path });
        })
      );
      actions.appendChild(
        iconButton('check', 'Mark as resolved', function () {
          post({ type: 'markResolved', path: change.path });
        })
      );
    } else {
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
    }
    fileNode.appendChild(actions);

    const letter = el('span', 'status-letter ' + mapped[1], mapped[0]);
    letter.title = mapped[2];
    fileNode.appendChild(letter);

    fileNode.addEventListener('click', function () {
      state.selected = change.path;
      render();
    });
    fileNode.addEventListener('dblclick', function () {
      post({ type: 'openChange', path: change.path });
    });
    fileNode.addEventListener('contextmenu', function (event) {
      state.selected = change.path;
      if (isConflict) {
        const current = state.model.active;
        const ours = current.branch;
        const theirs = (current.operation && current.operation.ref) || 'the incoming side';
        showMenu(event, [
          {
            label: 'Open in the Merge Editor',
            run: function () { post({ type: 'openMergeEditor', path: change.path }); },
          },
          '-',
          {
            label: 'Take Current (' + ours + ')',
            run: function () {
              post({ type: 'resolveConflict', path: change.path, side: 'ours' });
            },
          },
          {
            label: 'Take Incoming (' + theirs + ')',
            run: function () {
              post({ type: 'resolveConflict', path: change.path, side: 'theirs' });
            },
          },
          '-',
          {
            label: 'Mark as Resolved',
            run: function () { post({ type: 'markResolved', path: change.path }); },
          },
        ]);
        return;
      }
      // Ordered and grouped as Visual Studio's own file context menu is.
      showMenu(event, [
        {
          icon: 'go-to-file',
          label: 'Open',
          run: function () { post({ type: 'openFile', path: change.path }); },
        },
        change.staged
          ? {
              icon: 'remove',
              label: 'Unstage',
              run: function () { post({ type: 'unstage', paths: [change.path] }); },
            }
          : {
              icon: 'add',
              label: 'Stage',
              run: function () { post({ type: 'stage', paths: [change.path] }); },
            },
        {
          icon: 'discard',
          label: 'Undo Changes\u2026',
          run: function () { post({ type: 'discard', path: change.path }); },
        },
        '-',
        {
          icon: 'history',
          label: 'View History',
          run: function () { post({ type: 'viewHistory', path: change.path }); },
        },
        {
          icon: 'git-compare',
          label: 'Compare with Unmodified\u2026',
          run: function () { post({ type: 'openChange', path: change.path }); },
        },
        {
          icon: 'account',
          label: 'Blame (Annotate)',
          run: function () { post({ type: 'blame', path: change.path }); },
        },
        '-',
        {
          label: 'Ignore and Untrack item',
          run: function () { post({ type: 'ignoreAndUntrack', path: change.path }); },
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
