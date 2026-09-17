/*
 * The arithmetic behind the Git Changes view's file sections: the extension a
 * file is grouped by, and the folder keys an expand-all has to touch.
 *
 * Kept free of the DOM so it can be fed directly from tests. Loaded as a plain
 * script by the webview (where it defines `VsgChangesView`) and required as a
 * module by tests/changesview.test.js.
 */
(function (scope) {
  'use strict';

  /**
   * The extension a file is grouped under, lower-cased.
   *
   * A dotfile such as `.gitignore` has no extension in the usual sense - the
   * leading dot starts the name, it does not separate one - so the whole name
   * is taken as the group. That is also how the file shows up in the list, so
   * grouping and labelling agree.
   */
  function extensionOf(name) {
    const lower = name.toLowerCase();
    if (lower.indexOf('.') <= 0) {
      return lower.replace(/^\./, '');
    }
    return lower.slice(lower.lastIndexOf('.') + 1);
  }

  /**
   * Every folder key in a tree, parents before their children.
   *
   * `prefix` scopes the keys to one section, so the same folder appearing under
   * Staged and under Changes can be open in one and shut in the other.
   */
  function collectFolderKeys(nodes, prefix) {
    const out = [];
    walk(nodes);
    return out;

    function walk(list) {
      for (const node of list) {
        if (node.kind === 'folder') {
          out.push(prefix + node.key);
          walk(node.children);
        }
      }
    }
  }

  const api = {
    extensionOf: extensionOf,
    collectFolderKeys: collectFolderKeys,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgChangesView = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
