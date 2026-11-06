import test from 'node:test';
import assert from 'node:assert/strict';
import { completionToken, matchingSuggestions } from '../src/completion';

test('tag completion replaces only the tag at the cursor, including its suffix', () => {
  const text = '记录 #工作/项目 其他内容';
  const cursor = '记录 #工作'.length;
  assert.deepEqual(completionToken(text, cursor), { kind: 'tag', query: '工作', start: 3, end: '记录 #工作/项目'.length });
  assert.equal(completionToken(text, cursor, cursor + 1), null);
  for (const value of ['https://a/#test', '\\#test', '##', '`#test', '```js\n#test', '~~~\n#test']) {
    assert.equal(completionToken(value, value.length), null, value);
  }
  const afterFence = '```\ncode\n```\n#工作';
  assert.equal(completionToken(afterFence, afterFence.length)?.kind, 'tag');
});
test('link completion handles duplicate-name paths and an existing closing bracket without eating neighboring text', () => {
  const text = '前 [[项目/笔记]] 后';
  const cursor = '前 [[项目'.length;
  assert.deepEqual(completionToken(text, cursor), { kind: 'link', start: 2, end: '前 [[项目/笔记]]'.length, query: '项目' });
  const unfinished = '前 [[项目';
  assert.equal(completionToken(unfinished, unfinished.length)?.end, unfinished.length);
  for (const text of ['[[笔记|别名', '[[笔记#标题', '\\[[笔记', '[[笔记]]']) assert.equal(completionToken(text, text.length), null);
  assert.equal(completionToken('[[笔记|别名]]', 3), null);
  assert.equal(completionToken('[[笔记#标题]]', 3), null);
  assert.deepEqual(matchingSuggestions(['B/笔记', 'A/笔记', 'A/笔记'], '笔记'), ['A/笔记', 'B/笔记']);
  assert.deepEqual(matchingSuggestions(['Beta', 'alphabet', 'Alpha'], 'AL'), ['Alpha', 'alphabet']);
});
