/*
 * Syntax colouring for the side-by-side diff, kept free of the DOM so it can be
 * fed directly from tests. Loaded as a plain script by the webview (where it
 * defines `VsgSyntax`) and required as a module by tests/syntax.test.js.
 *
 * This is a lexer, not a parser: it knows comments, strings, numbers and each
 * language's keywords, which is what carries the shape of a line. It will never
 * tell a type from a variable the way a language server would, and it is not
 * meant to - the diff is there to be read, not edited.
 */
(function (scope) {
  'use strict';

  // Words that open a block in most of the C family, shared rather than
  // repeated per language so the lists below only carry what is peculiar.
  const C_LIKE = (
    'break case catch class const continue default delete do else enum export ' +
    'extends false finally for function if import in instanceof interface let ' +
    'new null of return static super switch this throw true try typeof var ' +
    'void while with yield async await'
  ).split(' ');

  const TYPES = (
    'bool boolean byte char decimal double float int long number object sbyte ' +
    'short string uint ulong ushort var void any unknown never symbol bigint'
  ).split(' ');

  /**
   * Each language is the same lexer with different punctuation: what opens a
   * comment, what quotes a string, and which words are keywords.
   */
  const LANGUAGES = {
    clike: {
      line: '//',
      blockStart: '/*',
      blockEnd: '*/',
      quotes: ['"', "'", '`'],
      // Type names live in `types` alone: a word in both lists would only ever
      // be found as a keyword, since keywords are matched first.
      keywords: C_LIKE.concat(
        ('abstract as base checked delegate event explicit extern fixed foreach ' +
          'get implicit implements internal is lock namespace operator out override ' +
          'params private protected public readonly ref sealed set sizeof ' +
          'stackalloc struct throws transient unchecked unsafe using virtual ' +
          'volatile when where declare type keyof infer satisfies package func ' +
          'defer go chan map range select fallthrough mut fn impl trait pub crate ' +
          'match loop unless elif').split(' ')
      ),
      types: TYPES,
    },
    python: {
      line: '#',
      quotes: ['"', "'"],
      blocks: ['"""', "'''"],
      keywords: (
        'and as assert async await break class continue def del elif else except ' +
        'False finally for from global if import in is lambda None nonlocal not or ' +
        'pass raise return True try while with yield match case self'
      ).split(' '),
      types: ('bool bytes dict float frozenset int list set str tuple').split(' '),
    },
    ruby: {
      line: '#',
      quotes: ['"', "'"],
      keywords: (
        'alias and begin break case class def defined do else elsif end ensure ' +
        'false for if in module next nil not or redo rescue retry return self ' +
        'super then true undef unless until when while yield require attr_accessor'
      ).split(' '),
      types: [],
    },
    shell: {
      line: '#',
      quotes: ['"', "'"],
      keywords: (
        'if then else elif fi case esac for while until do done function return ' +
        'local export readonly declare unset shift break continue in select time ' +
        'param begin end process foreach'
      ).split(' '),
      types: [],
    },
    sql: {
      line: '--',
      blockStart: '/*',
      blockEnd: '*/',
      quotes: ["'", '"'],
      caseInsensitive: true,
      keywords: (
        'add all alter and as asc begin between by case cast column commit ' +
        'constraint create cross delete desc distinct drop else end exists foreign ' +
        'from full group having if in index inner insert into is join key left ' +
        'like limit not null offset on or order outer primary references right ' +
        'rollback select set table then top transaction union unique update values ' +
        'view when where with'
      ).split(' '),
      types: ('bigint bit char date datetime decimal float int nvarchar text ' +
        'timestamp uniqueidentifier varchar').split(' '),
    },
    css: {
      blockStart: '/*',
      blockEnd: '*/',
      // Line comments are not CSS, but they are SCSS and LESS, and a stylesheet
      // holding them is far more likely than a literal "//" outside a string.
      line: '//',
      quotes: ['"', "'"],
      keywords: (
        'and from important include extend mixin media supports keyframes import ' +
        'use forward function return if else each for while charset font-face ' +
        'namespace page not only'
      ).split(' '),
      types: [],
    },
    json: {
      quotes: ['"'],
      keywords: ['true', 'false', 'null'],
      types: [],
    },
    yaml: {
      line: '#',
      quotes: ['"', "'"],
      keywords: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'],
      types: [],
    },
    markup: {
      markup: true,
      blockStart: '<!--',
      blockEnd: '-->',
      quotes: ['"', "'"],
    },
  };

  const BY_EXTENSION = {
    ts: 'clike', tsx: 'clike', js: 'clike', jsx: 'clike', mjs: 'clike', cjs: 'clike',
    mts: 'clike', cts: 'clike',
    cs: 'clike', java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cxx: 'clike',
    cc: 'clike', hpp: 'clike', hxx: 'clike', m: 'clike', mm: 'clike',
    go: 'clike', rs: 'clike', swift: 'clike', kt: 'clike', kts: 'clike',
    scala: 'clike', php: 'clike', dart: 'clike', groovy: 'clike', gradle: 'clike',
    proto: 'clike', jsonc: 'clike',
    py: 'python', pyi: 'python',
    rb: 'ruby', rake: 'ruby',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', psm1: 'shell',
    sql: 'sql',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    json: 'json',
    yml: 'yaml', yaml: 'yaml',
    html: 'markup', htm: 'markup', xml: 'markup', xaml: 'markup', svg: 'markup',
    csproj: 'markup', vbproj: 'markup', props: 'markup', targets: 'markup',
    config: 'markup', resx: 'markup', xsd: 'markup', xsl: 'markup', vue: 'markup',
  };

  /**
   * Which lexer a path gets, or null for a file this module has nothing useful
   * to say about - rendered as plain text rather than guessed at.
   */
  function languageFor(filePath) {
    if (!filePath) {
      return null;
    }
    const name = filePath.split('/').pop();
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
      return null;
    }
    return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] || null;
  }

  /**
   * Colours a whole side of the diff in one pass, because a block comment or a
   * triple-quoted string carries from one line to the next.
   *
   * `lines` holds the text of each row, or null where this side has no line -
   * the blank opposite an insertion, or elided context. The lexer state carries
   * across those: what git left out is unchanged text, so a comment open before
   * the gap is still open after it.
   *
   * Returns one array of tokens per line, and null where the input was null.
   */
  function highlightLines(lines, language) {
    const lang = LANGUAGES[language];
    if (!lang) {
      return lines.map(function () {
        return null;
      });
    }

    let state = null;
    return lines.map(function (line) {
      if (line === null || line === undefined) {
        return null;
      }
      const result = lang.markup ? lexMarkup(line, lang, state) : lexCode(line, lang, state);
      state = result.state;
      return result.tokens;
    });
  }

  /** Whether `word` is one of the language's, honouring SQL's indifference to case. */
  function isKeyword(list, word, caseInsensitive) {
    if (!list || !list.length) {
      return false;
    }
    if (!caseInsensitive) {
      return list.indexOf(word) !== -1;
    }
    const lower = word.toLowerCase();
    for (const candidate of list) {
      if (candidate.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  function lexCode(line, lang, state) {
    const tokens = [];
    let i = 0;

    // Finish whatever the previous line left open before reading anything new.
    if (state) {
      const at = line.indexOf(state.end);
      if (at === -1) {
        push(tokens, 0, line.length, state.type);
        return { tokens: tokens, state: state };
      }
      push(tokens, 0, at + state.end.length, state.type);
      i = at + state.end.length;
      state = null;
    }

    while (i < line.length) {
      const ch = line[i];

      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }

      if (lang.line && line.startsWith(lang.line, i)) {
        push(tokens, i, line.length, 'comment');
        return { tokens: tokens, state: null };
      }

      if (lang.blockStart && line.startsWith(lang.blockStart, i)) {
        const at = line.indexOf(lang.blockEnd, i + lang.blockStart.length);
        if (at === -1) {
          push(tokens, i, line.length, 'comment');
          return { tokens: tokens, state: { type: 'comment', end: lang.blockEnd } };
        }
        push(tokens, i, at + lang.blockEnd.length, 'comment');
        i = at + lang.blockEnd.length;
        continue;
      }

      // Python's triple quotes, which are both its multi-line string and its
      // docstring, so they are worth carrying across lines.
      const block = openerAt(lang.blocks, line, i);
      if (block) {
        const at = line.indexOf(block, i + block.length);
        if (at === -1) {
          push(tokens, i, line.length, 'string');
          return { tokens: tokens, state: { type: 'string', end: block } };
        }
        push(tokens, i, at + block.length, 'string');
        i = at + block.length;
        continue;
      }

      if (lang.quotes && lang.quotes.indexOf(ch) !== -1) {
        i = readString(line, i, ch, tokens);
        continue;
      }

      if (isDigit(ch) || (ch === '.' && isDigit(line[i + 1]))) {
        const start = i;
        while (i < line.length && /[0-9a-fA-FxXoObB_.]/.test(line[i])) {
          i++;
        }
        push(tokens, start, i, 'number');
        continue;
      }

      if (isWordStart(ch)) {
        const start = i;
        while (i < line.length && isWordChar(line[i])) {
          i++;
        }
        const word = line.slice(start, i);
        if (isKeyword(lang.keywords, word, lang.caseInsensitive)) {
          push(tokens, start, i, 'keyword');
        } else if (isKeyword(lang.types, word, lang.caseInsensitive)) {
          push(tokens, start, i, 'type');
        }
        continue;
      }

      i++;
    }

    return { tokens: tokens, state: null };
  }

  /**
   * Tags, attribute names and attribute values. Text between tags is left
   * uncoloured, which is what makes an XML file read as structure rather than
   * as a wall of one colour.
   */
  function lexMarkup(line, lang, state) {
    const tokens = [];
    let i = 0;

    if (state) {
      const at = line.indexOf(state.end);
      if (at === -1) {
        push(tokens, 0, line.length, state.type);
        return { tokens: tokens, state: state };
      }
      push(tokens, 0, at + state.end.length, state.type);
      i = at + state.end.length;
      state = null;
    }

    while (i < line.length) {
      if (line.startsWith('<!--', i)) {
        const at = line.indexOf('-->', i + 4);
        if (at === -1) {
          push(tokens, i, line.length, 'comment');
          return { tokens: tokens, state: { type: 'comment', end: '-->' } };
        }
        push(tokens, i, at + 3, 'comment');
        i = at + 3;
        continue;
      }

      if (line[i] !== '<') {
        i++;
        continue;
      }

      // The tag name, including a closing slash or a processing instruction.
      const nameStart = i;
      i++;
      while (i < line.length && /[/?!]/.test(line[i])) {
        i++;
      }
      while (i < line.length && /[\w.:-]/.test(line[i])) {
        i++;
      }
      push(tokens, nameStart, i, 'keyword');

      // Attributes up to the tag's end.
      while (i < line.length && line[i] !== '>') {
        const ch = line[i];
        if (ch === '"' || ch === "'") {
          i = readString(line, i, ch, tokens);
          continue;
        }
        if (isWordStart(ch)) {
          const start = i;
          while (i < line.length && /[\w.:-]/.test(line[i])) {
            i++;
          }
          push(tokens, start, i, 'type');
          continue;
        }
        i++;
      }
      if (i < line.length) {
        push(tokens, i, i + 1, 'keyword');
        i++;
      }
    }

    return { tokens: tokens, state: null };
  }

  /** Reads a quoted run, honouring backslash escapes. Returns where it ended. */
  function readString(line, at, quote, tokens) {
    let i = at + 1;
    while (i < line.length) {
      if (line[i] === '\\') {
        i += 2;
        continue;
      }
      if (line[i] === quote) {
        i++;
        break;
      }
      i++;
    }
    // An unterminated quote stops at the end of the line rather than carrying:
    // an apostrophe in a comment or a word like "don't" would otherwise paint
    // the rest of the file as a string.
    push(tokens, at, Math.min(i, line.length), 'string');
    return Math.min(i, line.length);
  }

  function openerAt(openers, line, at) {
    if (!openers) {
      return null;
    }
    for (const opener of openers) {
      if (line.startsWith(opener, at)) {
        return opener;
      }
    }
    return null;
  }

  function push(tokens, start, end, type) {
    if (end > start) {
      tokens.push({ start: start, end: end, type: type });
    }
  }

  function isDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  function isWordStart(ch) {
    return /[A-Za-z_$@]/.test(ch);
  }

  function isWordChar(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
  }

  /**
   * Cuts a line into the pieces one pass of spans can draw.
   *
   * A line carries two independent markings - what the lexer coloured and what
   * the diff highlighted as changed - and they overlap freely: half a string
   * literal can be the part that was edited. Splitting at every boundary of
   * both leaves each piece with one colour and one highlight, and neighbours
   * that agree on both are merged again so a line of plain text stays one node.
   */
  function mergeSegments(length, tokens, spans) {
    if (length <= 0) {
      return [];
    }
    const cuts = [0, length];
    for (const token of tokens || []) {
      cuts.push(token.start, token.end);
    }
    for (const span of spans || []) {
      cuts.push(span[0], span[1]);
    }

    const points = cuts
      .filter(function (p) {
        return p >= 0 && p <= length;
      })
      .sort(function (a, b) {
        return a - b;
      });

    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      if (end <= start) {
        continue;
      }
      const type = typeAt(tokens, start);
      const word = inSpan(spans, start);
      const last = out[out.length - 1];
      if (last && last.end === start && last.type === type && last.word === word) {
        last.end = end;
        continue;
      }
      out.push({ start: start, end: end, type: type, word: word });
    }
    return out;
  }

  function typeAt(tokens, at) {
    for (const token of tokens || []) {
      if (at >= token.start && at < token.end) {
        return token.type;
      }
    }
    return null;
  }

  function inSpan(spans, at) {
    for (const span of spans || []) {
      if (at >= span[0] && at < span[1]) {
        return true;
      }
    }
    return false;
  }

  const api = {
    languageFor: languageFor,
    highlightLines: highlightLines,
    mergeSegments: mergeSegments,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    scope.VsgSyntax = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
