'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { languageFor, highlightLines, mergeSegments } = require('../media/syntax.js');

/** The tokens of one line, as "type:text" pairs. */
function tokensOf(line, language) {
  const tokens = highlightLines([line], language)[0] || [];
  return tokens.map((t) => t.type + ':' + line.slice(t.start, t.end));
}

// ------------------------------------------------------------- language map

test('a path picks its lexer from the extension', () => {
  assert.equal(languageFor('src/changesView.ts'), 'clike');
  assert.equal(languageFor('Mcs/Api/Controller.cs'), 'clike');
  assert.equal(languageFor('tools/deploy.py'), 'python');
  assert.equal(languageFor('db/schema.sql'), 'sql');
  assert.equal(languageFor('media/repo.css'), 'css');
  assert.equal(languageFor('app.csproj'), 'markup');
  assert.equal(languageFor('package.json'), 'json');
});

test('a file with no useful lexer is left plain rather than guessed at', () => {
  assert.equal(languageFor('LICENSE'), null);
  assert.equal(languageFor('notes.md'), null);
  assert.equal(languageFor('.gitignore'), null, 'a leading dot is not an extension');
  assert.equal(languageFor(''), null);
  assert.equal(languageFor(null), null);
});

test('an unknown language colours nothing at all', () => {
  assert.deepEqual(highlightLines(['const x = 1;'], null), [null]);
  assert.deepEqual(highlightLines(['const x = 1;'], 'klingon'), [null]);
});

// -------------------------------------------------------------------- clike

test('keywords, types, strings and numbers are picked out', () => {
  assert.deepEqual(tokensOf('const count = 42;', 'clike'), ['keyword:const', 'number:42']);
  assert.deepEqual(tokensOf('return "hello";', 'clike'), ['keyword:return', 'string:"hello"']);
  assert.deepEqual(tokensOf('int total = 0;', 'clike'), ['type:int', 'number:0']);
});

test('a line comment swallows the rest of the line, code and all', () => {
  assert.deepEqual(tokensOf('x = 1; // const "quoted" 42', 'clike'), [
    'number:1',
    'comment:// const "quoted" 42',
  ]);
});

test('a keyword inside a string is not a keyword', () => {
  assert.deepEqual(tokensOf('var s = "return const";', 'clike'), [
    'keyword:var',
    'string:"return const"',
  ]);
});

test('an escaped quote does not end the string', () => {
  assert.deepEqual(tokensOf('a = "he said \\"no\\" twice";', 'clike'), [
    'string:"he said \\"no\\" twice"',
  ]);
});

test('a keyword needs whole-word boundaries', () => {
  assert.deepEqual(tokensOf('constant = ifology;', 'clike'), [], 'no keyword inside a longer word');
});

test('an unterminated quote stops at the end of its line', () => {
  // A stray apostrophe - "don't" in a comment, a possessive in a message - must
  // not paint every line below it as a string.
  const lines = highlightLines(["a = 'unterminated", 'const b = 2;'], 'clike');
  assert.deepEqual(
    lines[1].map((t) => t.type),
    ['keyword', 'number'],
    'the next line is read as code'
  );
});

// --------------------------------------------------------- multi-line state

test('a block comment carries across lines and closes on the right one', () => {
  const lines = ['/* opening', ' still comment', ' closing */ const x = 1;', 'const y = 2;'];
  const out = highlightLines(lines, 'clike');

  assert.deepEqual(out[0].map((t) => t.type), ['comment']);
  assert.deepEqual(out[1].map((t) => t.type), ['comment']);
  assert.deepEqual(
    out[2].map((t) => t.type),
    ['comment', 'keyword', 'number'],
    'code after the terminator is code again'
  );
  assert.deepEqual(out[3].map((t) => t.type), ['keyword', 'number']);
});

test('a blank row on one side does not break a comment that spans it', () => {
  // null is the blank opposite an insertion, and elided context. What git left
  // out is unchanged text, so a comment open before it is still open after.
  const out = highlightLines(['/* opening', null, ' closing */'], 'clike');
  assert.equal(out[1], null, 'the blank row gets no tokens');
  assert.deepEqual(out[2].map((t) => t.type), ['comment']);
});

test("python's triple quotes carry the same way", () => {
  const out = highlightLines(['def f():', '    """A docstring', '    over two lines."""', '    return 1'], 'python');
  assert.deepEqual(out[1].map((t) => t.type), ['string']);
  assert.deepEqual(out[2].map((t) => t.type), ['string']);
  assert.deepEqual(out[3].map((t) => t.type), ['keyword', 'number']);
});

test('a one-line block comment does not leak into the next line', () => {
  const out = highlightLines(['/* short */ const x = 1;', 'const y = 2;'], 'clike');
  assert.deepEqual(out[1].map((t) => t.type), ['keyword', 'number']);
});

// -------------------------------------------------------- other languages

test('SQL comments start with two dashes and keywords ignore case', () => {
  assert.deepEqual(tokensOf('SELECT * FROM t -- a note', 'sql'), [
    'keyword:SELECT',
    'keyword:FROM',
    'comment:-- a note',
  ]);
  assert.deepEqual(tokensOf('select 1', 'sql'), ['keyword:select', 'number:1']);
});

test('case only matters where the language says it does', () => {
  assert.deepEqual(tokensOf('CONST x = 1;', 'clike'), ['number:1'], 'C is case sensitive');
});

test('a hash opens a comment in python, ruby, shell and yaml', () => {
  for (const language of ['python', 'ruby', 'shell', 'yaml']) {
    assert.deepEqual(
      tokensOf('value # trailing', language),
      ['comment:# trailing'],
      language + ' treats # as a comment'
    );
  }
});

test('markup colours the tag and its attribute names and values', () => {
  assert.deepEqual(tokensOf('<PackageReference Include="Newtonsoft" />', 'markup'), [
    'keyword:<PackageReference',
    'type:Include',
    'string:"Newtonsoft"',
    'keyword:>',
  ]);
});

test('text between markup tags is left uncoloured', () => {
  assert.deepEqual(tokensOf('<name>Franjo Misetic</name>', 'markup'), [
    'keyword:<name',
    'keyword:>',
    'keyword:</name',
    'keyword:>',
  ]);
});

test('an XML comment carries across lines', () => {
  const out = highlightLines(['<!-- opening', 'still comment', 'closing --><tag>'], 'markup');
  assert.deepEqual(out[1].map((t) => t.type), ['comment']);
  assert.deepEqual(out[2].map((t) => t.type), ['comment', 'keyword', 'keyword']);
});

// ----------------------------------------------------------- merging spans

test('a line with neither colour nor highlight stays one segment', () => {
  const merged = mergeSegments(10, [], []);
  assert.deepEqual(merged, [{ start: 0, end: 10, type: null, word: false }]);
});

test('a colour and a highlight split the line at both their edges', () => {
  const text = 'const x = 1;';
  //            0----5
  const tokens = [{ start: 0, end: 5, type: 'keyword' }];
  const spans = [[3, 8]];
  const merged = mergeSegments(text.length, tokens, spans);

  assert.deepEqual(
    merged.map((s) => text.slice(s.start, s.end) + '|' + s.type + '|' + s.word),
    ['con|keyword|false', 'st|keyword|true', ' x |null|true', '= 1;|null|false']
  );
});

test('neighbouring pieces that agree on both are merged back together', () => {
  const tokens = [
    { start: 0, end: 3, type: 'keyword' },
    { start: 3, end: 6, type: 'keyword' },
  ];
  const merged = mergeSegments(6, tokens, []);
  assert.equal(merged.length, 1, 'two touching keyword tokens are one segment');
});

test('every character of the line lands in exactly one segment', () => {
  const merged = mergeSegments(
    20,
    [{ start: 2, end: 7, type: 'string' }, { start: 12, end: 15, type: 'number' }],
    [[5, 13]]
  );

  let at = 0;
  for (const segment of merged) {
    assert.equal(segment.start, at, 'segments are contiguous');
    at = segment.end;
  }
  assert.equal(at, 20, 'and they cover the whole line');
});

test('an empty line yields no segments', () => {
  assert.deepEqual(mergeSegments(0, [], []), []);
});

// ------------------------------------------------------------- termination
//
// A branch that matches a character but consumes none of it spins forever.
// `@` did: it opens a word without being a word character, so the identifier
// reader took nothing and the loop came round to it again. Every one of these
// hung the webview outright - a Java file with an annotation in it was enough.
//
// The timeouts are the assertion. A regression here fails the run rather than
// wedging it.

const SOON = { timeout: 5000 };

test('an annotation does not spin the lexer', SOON, () => {
  assert.deepEqual(highlightLines(['    @Override'], 'clike')[0], []);
});

test('every language survives the characters that open a word without being one', SOON, () => {
  const awkward = [
    '@Override',
    '@app.route("/x")',
    '@media (min-width: 40px) {',
    'var s = @"c:\\temp";',
    '<Tag @attr="v" />',
    'email@example.com',
    '@',
    '@@',
    ' @ ',
    '$',
    '$$scope',
    '#{interpolated}',
  ];
  for (const language of ['clike', 'python', 'ruby', 'shell', 'sql', 'css', 'json', 'yaml', 'markup']) {
    for (const line of awkward) {
      const tokens = highlightLines([line], language)[0];
      assert.ok(Array.isArray(tokens), language + ' on ' + JSON.stringify(line));
    }
  }
});

test('tokens stay inside the line and never overlap, whatever the input', SOON, () => {
  // The guard advances the index by one when a branch consumes nothing, which
  // must not be allowed to produce a token that runs off the end.
  const lines = ['@Override', '@', '<a @b="c">', '@media{', 'x @ y'];
  for (const language of ['clike', 'css', 'markup']) {
    for (const line of lines) {
      let at = 0;
      for (const token of highlightLines([line], language)[0] || []) {
        assert.ok(token.start >= at, 'tokens are in order in ' + JSON.stringify(line));
        assert.ok(token.end <= line.length, 'and inside the line');
        assert.ok(token.end > token.start, 'and not empty');
        at = token.end;
      }
    }
  }
});

test('a real Java file with annotations is coloured without hanging', SOON, () => {
  const file = [
    'package toniarts.openkeeper.gui.nifty;',
    '',
    '@Override',
    'public void onStartScreen() {',
    '    @SuppressWarnings("unchecked")',
    '    List<String> names = new ArrayList<>();',
    '}',
  ];
  const out = highlightLines(file, 'clike');
  assert.equal(out.length, file.length);
  assert.ok(
    out[3].some((t) => t.type === 'keyword'),
    'the ordinary lines are still coloured'
  );
  assert.ok(
    out[4].some((t) => t.type === 'string'),
    'including the string inside the annotation'
  );
});

// -------------------------------------------------------------------- limits
//
// Every segment becomes an element and the diff draws a screenful of rows at a
// time, so a line that becomes a node per token can put hundreds of thousands
// of elements on the page. These are the bounds that stops it.

test('a line past the lexing limit is not coloured at all', () => {
  const long = 'var a=1;'.repeat(2000); // 16,000 characters
  assert.equal(highlightLines([long], 'clike')[0], null);
});

test('a line within the limit is still coloured', () => {
  const ordinary = 'const x = 1; // fine';
  assert.ok(highlightLines([ordinary], 'clike')[0].length > 0);
});

test('a line needing too many pieces keeps its highlight and loses its colour', () => {
  // What changed is the point of a diff; the colour is a convenience.
  const tokens = [];
  for (let i = 0; i < 400; i++) {
    tokens.push({ start: i * 4, end: i * 4 + 2, type: 'keyword' });
  }
  const merged = mergeSegments(1600, tokens, [[0, 40]]);

  assert.ok(merged.length <= 120, 'under the cap: ' + merged.length);
  assert.ok(merged.some((s) => s.word), 'the change is still marked');
  assert.ok(!merged.some((s) => s.type), 'the colouring is what was dropped');
});

test('a line needing far too many pieces is drawn as one', () => {
  const spans = [];
  for (let i = 0; i < 500; i++) {
    spans.push([i * 4, i * 4 + 2]);
  }
  const merged = mergeSegments(2000, [], spans);
  assert.deepEqual(merged, [{ start: 0, end: 2000, type: null, word: false }]);
});

test('an ordinary line of code is nowhere near the cap', () => {
  const text = '        if (Util.isEmpty(this._defaultVrstePrijema)) { return null; }';
  const merged = mergeSegments(text.length, highlightLines([text], 'clike')[0], [[12, 27]]);
  assert.ok(merged.length < 30, 'it took ' + merged.length + ' pieces');
  assert.ok(merged.some((s) => s.type), 'and it is still coloured');
});

test('merging stays linear as a line grows', () => {
  // It used to rescan every token for every piece, which is the shape that
  // hangs a renderer on a minified file.
  const build = (n) => {
    const tokens = [];
    for (let i = 0; i < n; i++) {
      tokens.push({ start: i * 4, end: i * 4 + 2, type: 'keyword' });
    }
    const started = process.hrtime.bigint();
    mergeSegments(n * 4, tokens, []);
    return Number(process.hrtime.bigint() - started);
  };
  build(1000); // warm up
  const small = Math.max(build(2000), 1);
  const large = build(20000);

  // Ten times the tokens must not cost a hundred times the work.
  assert.ok(large < small * 40, 'ten times the input took ' + (large / small).toFixed(1) + 'x');
});

test('a span reaching past the end of the line does not invent a segment', () => {
  const merged = mergeSegments(5, [], [[3, 99]]);
  assert.equal(merged[merged.length - 1].end, 5);
});
