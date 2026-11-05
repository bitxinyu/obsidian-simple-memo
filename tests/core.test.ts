import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemos, formatMemo, insertMemo, replaceMemo, editMemoRaw, toggleMemoRaw, getMemoFields, transformMemoFields, withMemoBlockId, removeCommonIndent } from '../src/core';
import type { Settings } from '../src/types';

const settings = { timeFormat: 'HH:mm', processHeading: '' } as Settings;
const parse = (source: string, patch: Partial<Settings> = {}) => parseMemos(source, 'Journal/2026-10-22.md', '2026-10-22', { ...settings, ...patch });

test('timestamp-only Thino entries, tabs, nested indentation and metadata survive editing', () => {
  const source = '- 09:10\n\t第一行 #工作/笔记<br>第二行\n\t\n\t\t\t\tcode\n\t    nested\n\tmeta[archived::true]\n- 10:11 next ^abc12\n';
  const memos = parse(source);
  assert.equal(memos.length, 2);
  assert.equal(memos[0].content, '第一行 #工作/笔记<br>第二行\n\n\t\t\tcode\n    nested\nmeta');
  assert.deepEqual(memos[0].tags, ['工作/笔记']);
  assert.equal(memos[1].blockId, 'abc12');
  const edited = replaceMemo(source, memos[0], editMemoRaw(memos[0], 'new\n\tindented'));
  assert.equal(parse(edited)[0].content, 'new\n\tindented');
  assert.match(parse(edited)[0].raw, /\[archived::true\]/);
  assert.ok(edited.endsWith('- 10:11 next ^abc12\n'));
});

test('frontmatter, fenced examples, unknown siblings and paragraphs are protected', () => {
  const source = '---\nexample: |\n  - 01:00 yaml\n---\n```md\n- 02:00 example\n```\n- 03:00 real\n  continuation\n- ordinary sibling\nparagraph\n- 04:00 next\n';
  const memos = parse(source);
  assert.deepEqual(memos.map(m => m.time), ['03:00', '04:00']);
  assert.equal(memos[0].raw, '- 03:00 real\n  continuation');
  const deleted = replaceMemo(source, memos[0], null);
  assert.equal(deleted, source.replace('- 03:00 real\n  continuation', ''));
  assert.ok(deleted.includes('- ordinary sibling\nparagraph'));
});

test('heading scope includes child headings and ends at a peer or parent', () => {
  const source = '# Daily\n- 08:00 outside\n## Memos\n- 09:00 inside\n### Child\n- 10:00 child\n## Work\n- 11:00 outside\n';
  assert.deepEqual(parse(source, { processHeading: 'Memos' }).map(m => m.time), ['09:00', '10:00']);
  assert.equal(parse(source, { processHeading: '# Memos' }).length, 0);
  const inserted = insertMemo(source, '- 12:00 new', '## Memos');
  assert.ok(inserted.includes('- 10:00 child\n- 12:00 new\n\n## Work\n- 11:00 outside'));
  assert.deepEqual(parse(inserted, { processHeading: 'Memos' }).map(m => m.time), ['09:00', '10:00', '12:00']);
});

test('creation respects YAML, creates absent headings, and refuses ambiguous or unfinished documents', () => {
  const source = '---\nkind: diary\n---\n';
  assert.equal(insertMemo(source, '- 09:00 first', 'Memos'), source + '\n## Memos\n\n- 09:00 first\n');
  assert.throws(() => insertMemo('# Memos\n# Memos\n', '- 09:00 first', 'Memos'), /多个/);
  assert.throws(() => insertMemo('---\nkind: diary', '- 09:00 first', ''), /未闭合/);
  assert.throws(() => insertMemo('```\nexample', '- 09:00 first', ''), /未闭合/);
});

test('CAS allows unique entries to move, but rejects modified, extended or duplicate entries', () => {
  const original = '- 09:00 one\n- 10:00 two\n';
  const memo = parse(original)[0];
  assert.equal(replaceMemo('# New\n' + original, memo, '- 09:00 edited'), '# New\n- 09:00 edited\n- 10:00 two\n');
  assert.throws(() => replaceMemo(original.replace('one', 'changed'), memo, null), /修改/);
  assert.throws(() => replaceMemo(original.replace('one\n', 'one\n\tadded\n'), memo, null), /修改/);
  const duplicates = '- 09:00 one\n- 09:00 one\n';
  assert.notEqual(parse(duplicates)[0].key, parse(duplicates)[1].key);
  assert.throws(() => replaceMemo(duplicates, parse(duplicates)[0], null), /完全相同/);
});

test('CRLF and surrounding mixed newlines remain unchanged', () => {
  const source = '---\nkind: diary\n---\n- 09:00 old\r\n\tmore\r\n- ordinary\n';
  const memo = parse(source)[0];
  assert.equal(replaceMemo(source, memo, memo.raw), source);
  assert.equal(replaceMemo(source, memo, editMemoRaw(memo, 'new\nnext')),
    '---\nkind: diary\n---\n- 09:00 new\r\n\tnext\r\n- ordinary\n');
  const oneLine = '- 09:00 old\r\n';
  assert.equal(replaceMemo(oneLine, parse(oneLine)[0], editMemoRaw(parse(oneLine)[0], 'new\nnext')), '- 09:00 new\r\n\tnext\r\n');
  assert.equal(insertMemo(oneLine, '- 10:00 new\n\tsecond', ''), oneLine + '- 10:00 new\r\n\tsecond\r\n');
});

test('configured seconds and twelve-hour clocks parse without accepting invalid timestamps', () => {
  const source = '- 09:10:11 seconds\n- 09:12 minute\n- 24:00 invalid\n- 12:99 invalid\n- 2:30 PM afternoon\n';
  assert.deepEqual(parse(source, { timeFormat: 'h:mm A' }).map(m => m.time), ['09:10:11', '09:12', '2:30 PM']);
});

test('legacy timestamp-only notes unwrap their common container while explicit separators preserve code', () => {
  const source = '- 09:00\n\t\t\t\tcode\n\t\t\t\tmore';
  const memo = parse(source)[0];
  assert.equal(memo.content, 'code\nmore');
  const edited = editMemoRaw(memo, memo.content);
  assert.equal(edited, source);
  assert.equal(parse(edited)[0].content, memo.content);
  const explicit = '- 09:00\n\t\n\t\t\t\tcode\n\t\t\t\tmore';
  assert.equal(parse(explicit)[0].content, '\t\t\tcode\n\t\t\tmore');
  const formatted = formatMemo('\t\tcode\nnext', '10:00', false, settings);
  assert.equal(parse(formatted)[0].content, '\t\tcode\nnext');
});

test('formatting indents every continuation and does not inject capture preferences', () => {
  assert.equal(formatMemo('first\n\n- nested\n\tcode', '09:10', true,
    { ...settings, fixedPrefix: 'ignored', defaultTag: '#ignored' }), '- [ ] 09:10\n\t\n\tfirst\n\t\n\t- nested\n\t\tcode');
  assert.equal(formatMemo('', '09:10', false, settings), '- 09:10');
  assert.throws(() => formatMemo('x', '09:10\n- 10:00 injected', false, settings));
});

test('edits preserve task state, time, block ID and hidden legacy inline fields', () => {
  const original = '- [X] 09:10 original[deleted::20261022101010] [pinned::true] ^abc-12\n';
  const memo = parse(original)[0];
  assert.equal(memo.content, 'original');
  assert.equal(memo.task, 'done');
  const changed = parse(replaceMemo(original, memo, editMemoRaw(memo, 'replacement\nsecond')))[0];
  assert.equal(changed.content, 'replacement\nsecond');
  assert.equal(changed.key, memo.key);
  assert.equal(changed.task, 'done');
  assert.equal(changed.time, '09:10');
  assert.match(changed.raw, /\[deleted::20261022101010\]/);
  assert.match(changed.raw, /\[pinned::true\]/);
});

test('task completion preserves metadata and IDs and reopening removes its completion date', () => {
  const original = '- [ ] 09:10 work[archived::true] ^id123\n\tmore';
  const memo = parse(original)[0];
  const done = toggleMemoRaw(memo, '2026-10-22');
  assert.equal(done, '- [x] 09:10 work[archived::true] ✅ 2026-10-22 ^id123\n\tmore');
  const doneMemo = parse(done)[0];
  assert.equal(doneMemo.task, 'done');
  assert.equal(doneMemo.blockId, 'id123');
  assert.equal(toggleMemoRaw(doneMemo), original);
  assert.equal(toggleMemoRaw(parse('- 09:00 ordinary')[0]), '- [x] 09:00 ordinary');
});

test('fenced, indented and inline code markers remain literal content through edits', () => {
  const content = 'Use `[deleted::true]` and ``[pinned::true] `quoted` ``\n```text\n[archived::true]\n^example\n```\n\n    [deleted::true]\n    ^indented-example';
  const raw = formatMemo(content, '09:00', false, settings);
  const memo = parse(raw)[0];
  assert.equal(memo.content, content);
  assert.equal(memo.blockId, undefined);
  assert.deepEqual(getMemoFields(raw), []);
  assert.equal(transformMemoFields(raw, () => ''), raw);
  const edited = editMemoRaw(memo, memo.content);
  assert.equal(parse(edited)[0].content, content);
  assert.equal(parse(edited)[0].blockId, undefined);
  assert.deepEqual(getMemoFields(edited), []);
});

test('real first-line and continuation fields remain editable alongside identical code examples', () => {
  const raw = '- 09:00 `[pinned::true]` [pinned::true] ^real-id\r\n\t```text\r\n\t[archived::true]\r\n\t^example\r\n\t```\r\n\tNormal[archived::true]\r\n\t\t[deleted::true]';
  const memo = parse(raw)[0];
  assert.deepEqual(getMemoFields(raw), ['[pinned::true]', '[archived::true]']);
  assert.equal(memo.blockId, 'real-id');
  assert.ok(memo.content.includes('```text\n[archived::true]\n^example\n```'));
  assert.ok(memo.content.endsWith('\t[deleted::true]'));
  const transformed = transformMemoFields(raw, field => field.startsWith('[pinned') ? '' : '[archived::false]');
  assert.ok(transformed.startsWith('- 09:00 `[pinned::true]`  ^real-id\r\n'));
  assert.ok(transformed.includes('\tNormal[archived::false]\r\n'));
  assert.ok(transformed.includes('\t[archived::true]\r\n\t^example'));
  const edited = editMemoRaw(memo, memo.content);
  assert.deepEqual(getMemoFields(edited), ['[pinned::true]', '[archived::true]']);
  assert.equal(parse(edited)[0].content, memo.content);
});

test('multiline inline code spans and escaped fields cannot become memo state or block IDs', () => {
  const content = 'Use `code\n[deleted::true] ^example\nend` and \\[archived::true]';
  const raw = formatMemo(content, '09:00', false, settings);
  const memo = parse(raw)[0];
  assert.equal(memo.content, content);
  assert.equal(memo.blockId, undefined);
  assert.deepEqual(getMemoFields(raw), []);
});

test('assigning and replacing block IDs preserves literal examples and multiline inline code', () => {
  const source = '- 09:00 example ^old-id\r\n\t```text\r\n\t^old-id\r\n\t```';
  const replaced = withMemoBlockId(source, 'new-id');
  assert.equal(replaced, source.replace('example ^old-id', 'example ^new-id'));
  assert.equal(parse(replaced)[0].blockId, 'new-id');
  const content = 'Use `code\n[deleted::true] ^example\nend` literally';
  const raw = withMemoBlockId(formatMemo(content, '09:00', false, settings), '^assigned-id');
  assert.ok(raw.startsWith('- 09:00 ^assigned-id\n'));
  assert.equal(parse(raw)[0].content, content);
  assert.equal(parse(raw)[0].blockId, 'assigned-id');
  assert.deepEqual(getMemoFields(raw), []);
});

test('new multiline block IDs use a separate timestamp paragraph and preserve attachments and state', () => {
  const raw = '- [ ] 09:10 first [pinned::true]\r\n\t![[image.png]]\r\n\tlast';
  const assigned = withMemoBlockId(raw, 'new-id');
  assert.equal(assigned, '- [ ] 09:10 [pinned::true] ^new-id\r\n\t\r\n\tfirst\r\n\t![[image.png]]\r\n\tlast');
  const memo = parse(assigned)[0];
  assert.equal(memo.content, 'first\n![[image.png]]\nlast');
  assert.equal(memo.task, 'open');
  assert.equal(memo.blockId, 'new-id');
  assert.deepEqual(getMemoFields(assigned), ['[pinned::true]']);
  assert.equal(withMemoBlockId(assigned, 'replacement-id'), assigned.replace('^new-id', '^replacement-id'));
});

test('editing an ID-bearing multiline memo separates the header without changing logical content', () => {
  const original = '- [x] 09:10 first [archived::true] ^existing\n\t![[image.png]]';
  const memo = parse(original)[0];
  const content = 'updated\n```text\n[deleted::true]\n^example\n```\n![[image.png]]';
  const edited = editMemoRaw(memo, content);
  assert.ok(edited.startsWith('- [x] 09:10 [archived::true] ^existing\n\t\n\tupdated\n'));
  const parsed = parse(edited)[0];
  assert.equal(parsed.content, content);
  assert.equal(parsed.blockId, 'existing');
  assert.equal(parsed.task, 'done');
  assert.deepEqual(getMemoFields(edited), ['[archived::true]']);
  assert.equal(editMemoRaw(parsed, parsed.content), edited);
});

test('explicit common-indent removal cleans the two-tab pasted resource note', () => {
  const content = '\t\t命令行的艺术\n\t\tgithub.com/jlevy/the-art-of-command-line/\n\t\t#资源';
  assert.equal(removeCommonIndent(content), '命令行的艺术\ngithub.com/jlevy/the-art-of-command-line/\n#资源');
});

test('common-indent removal preserves relative nested-list and fenced-code indentation', () => {
  const list = '\t\t- parent\n\t\t  - child\n\t\t    continuation\n\t\t- sibling';
  assert.equal(removeCommonIndent(list), '- parent\n  - child\n    continuation\n- sibling');
  const code = '\t\t```js\n\t\t  const answer = 42;\n\t\t    nested();\n\t\t```';
  assert.equal(removeCommonIndent(code), '```js\n  const answer = 42;\n    nested();\n```');
});

test('common-indent removal preserves blank lines and original mixed line endings', () => {
  const source = '\r\n\t\tfirst\r\n\t \r\t\tsecond\n\t\t\n';
  assert.equal(removeCommonIndent(source), '\r\nfirst\r\n\t \rsecond\n\t\t\n');
  assert.equal(removeCommonIndent('\t \r\n  \r\n'), '\t \r\n  \r\n');
  assert.equal(removeCommonIndent(''), '');
});

test('indent removal uses an exact shared prefix rather than treating tabs as spaces', () => {
  assert.equal(removeCommonIndent('\tone\n  two'), '\tone\n  two');
  assert.equal(removeCommonIndent('plain\n\tindented'), 'plain\n\tindented');
  assert.equal(removeCommonIndent('\t  one\n\t\ttwo'), '  one\n\ttwo');
});

test('normal format, parse and edit retain deliberate indented code unless cleanup is explicitly called', () => {
  const content = '    first code line\n      nested code line';
  const raw = withMemoBlockId(formatMemo(content, '19:48', false, settings), 'code-id');
  const memo = parse(raw)[0];
  assert.equal(memo.content, content);
  const edited = editMemoRaw(memo, memo.content);
  assert.equal(parse(edited)[0].content, content);
  assert.equal(edited, raw);
  assert.equal(removeCommonIndent(content), 'first code line\n  nested code line');
});

test('legacy paragraph containers support four tabs, two tabs and four spaces without rewriting on read', () => {
  for (const indentation of ['\t\t\t\t', '\t\t', '    ']) {
    const content = '从0开始写服务器 https://example.com/project\nhttps://example.com/source\n#资源';
    const raw = '- 23:15 \r\n' + content.split('\n').map(line => indentation + line).join('\r\n');
    const memo = parse(raw)[0];
    assert.equal(memo.content, content);
    assert.deepEqual(memo.tags, ['资源']);
    assert.equal(editMemoRaw(memo, memo.content), raw);
    const updated = editMemoRaw(memo, content.replace('写服务器', '写一个服务器'));
    assert.equal(updated.split('\r\n')[1], indentation, 'changed timestamp-only bodies gain an explicit original-width separator');
    assert.equal(parse(updated)[0].content, content.replace('写服务器', '写一个服务器'));
    assert.ok(!updated.replace(/\r\n/g, '').includes('\n'));
  }
});

test('legacy unwrapping retains relative list levels, fenced code and literal code metadata', () => {
  const content = '- parent\n\t- nested\n\t  continuation\n\n```js\n  const marker = "[deleted::true]";\n    nested();\n^example\n```\n#资源';
  const raw = '- 23:16\n' + content.split('\n').map(line => '\t\t\t\t' + line).join('\n');
  const memo = parse(raw)[0];
  assert.equal(memo.content, content);
  assert.equal(memo.blockId, undefined);
  assert.deepEqual(getMemoFields(raw), []);
  const changed = editMemoRaw(memo, content.replace('parent', 'updated parent'));
  assert.equal(parse(changed)[0].content, content.replace('parent', 'updated parent'));
});

test('legacy field and ID operations use the same container baseline as content parsing', () => {
  const raw = '- 23:16 [pinned::true] ^legacy-id\r\n\t\t\t\tparagraph\r\n\t\t\t\tsecond[archived::true]';
  const memo = parse(raw)[0];
  assert.equal(memo.content, 'paragraph\nsecond');
  assert.equal(memo.blockId, 'legacy-id');
  assert.deepEqual(getMemoFields(raw), ['[pinned::true]', '[archived::true]']);
  const unpinned = transformMemoFields(raw, field => field.startsWith('[pinned') ? '' : field);
  assert.equal(parse(unpinned)[0].content, memo.content);
  assert.deepEqual(getMemoFields(unpinned), ['[archived::true]']);
  assert.equal(withMemoBlockId(raw, 'new-id'), raw.replace('^legacy-id', '^new-id'));
  const updated = editMemoRaw(memo, 'updated\nsecond');
  assert.equal(updated.split('\r\n')[1], '\t\t\t\t');
  assert.equal(parse(updated)[0].content, 'updated\nsecond');
  assert.equal(parse(updated)[0].blockId, 'legacy-id');
});

test('task completion dates do not change legacy continuation interpretation', () => {
  const raw = '- [ ] 23:16\n\t\t\t\tparagraph\n\t\t\t\t#资源';
  const done = toggleMemoRaw(parse(raw)[0], '2026-10-22');
  assert.equal(parse(done)[0].content, '✅ 2026-10-22\nparagraph\n#资源');
  assert.equal(toggleMemoRaw(parse(done)[0]), raw);
});

test('ordinary first-line prose and explicit code separators keep intentional continuation indentation', () => {
  assert.equal(parse('- 09:00 Introduction\n\t\tindented code')[0].content, 'Introduction\n\tindented code');
  for (const code of ['\t[deleted::true]\n\t^example', '    [deleted::true]\n    ^example']) {
    const formatted = formatMemo(code, '09:00', false, settings);
    assert.ok(formatted.startsWith('- 09:00\n\t\n'));
    const memo = parse(formatted)[0];
    assert.equal(memo.content, code);
    assert.equal(memo.blockId, undefined);
    assert.deepEqual(getMemoFields(formatted), []);
    const legacy = parse('- 09:00\n\t\t\t\told paragraph')[0];
    assert.equal(parse(editMemoRaw(legacy, code))[0].content, code);
  }
});

test('a blank continuation after first-line prose cannot promote code literals into metadata', () => {
  const raw = '- 09:00 Introduction\r\n\t\t\r\n\t\t[deleted::true]\r\n\t\t^example';
  const memo = parse(raw)[0];
  assert.equal(memo.content, 'Introduction\n\t\n\t[deleted::true]\n\t^example');
  assert.equal(memo.blockId, undefined);
  assert.deepEqual(getMemoFields(raw), []);
  assert.equal(transformMemoFields(raw, () => ''), raw);
  assert.equal(editMemoRaw(memo, memo.content), raw);
});

test('an unindented blank separator preserves code after an otherwise empty timestamp header', () => {
  for (const [indentation, logicalIndentation] of [['\t\t', '\t'], ['        ', '      ']]) {
    const raw = `- 09:00 [pinned::true] ^container\r\n\r\n${indentation}[deleted::true]\r\n${indentation}^example`;
    const memo = parse(raw)[0];
    assert.equal(memo.content, `${logicalIndentation}[deleted::true]\n${logicalIndentation}^example`);
    assert.equal(memo.blockId, 'container');
    assert.deepEqual(getMemoFields(raw), ['[pinned::true]']);
    assert.equal(transformMemoFields(raw, field => field), raw);
    assert.equal(transformMemoFields(raw, () => ''), raw.replace('[pinned::true]', ''));
    assert.equal(editMemoRaw(memo, memo.content), raw);
  }
});

test('removing the only shallow metadata continuation freezes the original container baseline', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const indentation of ['\t', '  ']) {
      const codeIndentation = indentation === '\t' ? '\t' : '    ';
      const raw = [
        '- 09:00 [pinned::true] ^real-id',
        `${indentation}${codeIndentation}code`,
        `${indentation}${codeIndentation}[deleted::true]`,
        `${indentation}${codeIndentation}^example`,
        `${indentation}[archived::true]`,
      ].join(newline);
      const memo = parse(raw)[0];
      assert.deepEqual(getMemoFields(raw), ['[pinned::true]', '[archived::true]']);
      assert.equal(transformMemoFields(raw, field => field), raw);
      assert.equal(transformMemoFields(raw, field => field.replace('true', 'false')), raw.replace('[pinned::true]', '[pinned::false]').replace('[archived::true]', '[archived::false]'));

      const cleared = transformMemoFields(raw, () => '');
      assert.equal(cleared, raw.replace('[pinned::true]', '').replace('[archived::true]', '').replace(newline, newline + indentation + newline));
      assert.equal(parse(cleared)[0].content, memo.content);
      assert.equal(parse(cleared)[0].blockId, 'real-id');
      assert.deepEqual(getMemoFields(cleared), []);
      assert.equal(transformMemoFields(cleared, () => ''), cleared);
      const replaced = withMemoBlockId(cleared, 'updated-id');
      assert.equal(parse(replaced)[0].content, memo.content);
      assert.equal(parse(replaced)[0].blockId, 'updated-id');
      assert.ok(replaced.includes(`${codeIndentation}^example`));
    }
  }
  const mixedIndentation = '- 09:00\n\t\tcode\n  [archived::true]';
  const cleared = transformMemoFields(mixedIndentation, () => '');
  assert.equal(cleared, '- 09:00\n\n\t\tcode\n  ');
  assert.equal(parse(cleared)[0].content, parse(mixedIndentation)[0].content);
});
