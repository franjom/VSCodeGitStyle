/*
 * The handful of DOM idioms both webviews are built from.
 *
 * This is the one module here that needs a browser, so it has no unit tests of
 * its own; it is exercised through tools/preview-check.js, which drives the
 * real thing. Anything that can be decided without a document belongs in a
 * sibling module instead, where node can test it - see media/format.js for the
 * arithmetic this file used to carry inline.
 */
(function (scope) {
  'use strict';

  const format = typeof require === 'function' ? require('./format.js') : scope.VsgFormat;

  /**
   * An element, its class and its text in one call. Text goes in as text, never
   * as markup, which is what keeps a commit message full of angle brackets a
   * commit message.
   */
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

  /**
   * A toolbar button. The title doubles as the accessible name, because every
   * one of these is an icon with no text beside it.
   */
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

  /**
   * A context menu at the pointer, from a list of `{ label, icon, run }` and the
   * string '-' for a separator.
   *
   * Visual Studio's menus lead with an icon column and the entries without one
   * still line up with it, so the slot is always there.
   */
  function showMenu(menuEl, event, items) {
    event.preventDefault();
    event.stopPropagation();
    menuEl.textContent = '';

    for (const item of items) {
      if (item === '-') {
        menuEl.appendChild(el('div', 'separator'));
        continue;
      }
      const row = el('div', 'item');
      row.appendChild(item.icon ? icon(item.icon, 'menu-icon') : el('span', 'menu-icon'));
      row.appendChild(el('span', null, item.label));
      row.addEventListener('click', function () {
        hideMenu(menuEl);
        item.run();
      });
      menuEl.appendChild(row);
    }

    // Shown before it is placed, because it has to be laid out before there is
    // a size to keep on screen.
    menuEl.hidden = false;
    const rect = menuEl.getBoundingClientRect();
    const at = format.menuPosition(
      { x: event.clientX, y: event.clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    menuEl.style.left = at.x + 'px';
    menuEl.style.top = at.y + 'px';
  }

  function hideMenu(menuEl) {
    menuEl.hidden = true;
  }

  const api = {
    el: el,
    icon: icon,
    iconButton: iconButton,
    link: link,
    showMenu: showMenu,
    hideMenu: hideMenu,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgDom = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
