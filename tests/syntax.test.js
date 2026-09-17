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

test('a span reaching past the end of the line does not invent a segment', () => {
  const merged = mergeSegments(5, [], [[3, 99]]);
  assert.equal(merged[merged.length - 1].end, 5);
});
