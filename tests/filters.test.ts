import test from 'node:test';
import assert from 'node:assert/strict';
import { dateBounds, emptyFilter, filterMemos, matchesMemo, memosToMarkdown, readSavedFilters, validateFilter } from '../src/filters';
import type { Memo } from '../src/types';

function memo(overrides: Partial<Memo> = {}): Memo {
  return { key: 'a', path: 'Journal/2026-11-06.md', date: '2026-11-06', time: '09:00', content: '发布 #工作/项目A #跟进',
    raw: '', start: 0, end: 0, line: 1, task: 'open', tags: ['工作/项目A', '跟进'], blockId: 'a', ...overrides };
}
test('relative periods use calendar days and configured week start, and roll on reapplication', () => {
  const filter = { ...emptyFilter(), period: 'last7' as const };
  assert.deepEqual(dateBounds(filter, new Date(2026, 0, 3)), { from: '2025-12-28', to: '2026-01-03' });
  assert.deepEqual(dateBounds(filter, new Date(2026, 0, 4)), { from: '2025-12-29', to: '2026-01-04' });
  assert.deepEqual(dateBounds({ ...filter, period: 'thisWeek' }, new Date(2026, 10, 1), 1), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(dateBounds({ ...filter, period: 'thisWeek' }, new Date(2026, 10, 1), 0), { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(dateBounds({ ...filter, period: 'thisMonth' }, new Date(2024, 1, 20)), { from: '2024-02-01', to: '2024-02-29' });
});
test('text, all selected tags, task status and inclusive date bounds combine', () => {
  const filter = { ...emptyFilter(), text: '发布 #跟', tags: ['工作', '跟进'], status: 'open' as const,
    period: 'custom' as const, from: '2026-11-05', to: '2026-11-06' };
  assert.equal(matchesMemo(memo(), filter), true);
  assert.equal(matchesMemo(memo({ date: '2026-11-05' }), filter), true);
  assert.equal(matchesMemo(memo({ date: '2026-11-07' }), filter), false);
  assert.equal(matchesMemo(memo({ tags: ['工作/项目A'] }), filter), false);
  assert.equal(matchesMemo(memo({ tags: ['工作室', '跟进'] }), filter), false);
  assert.equal(matchesMemo(memo({ task: 'done' }), filter), false);
  assert.equal(matchesMemo(memo({ content: '其他内容 #跟进' }), filter), false);
  assert.equal(matchesMemo(memo({ date: '2020-01-01' }), { ...filter, from: '' }), true);
  assert.equal(matchesMemo(memo({ date: '2030-01-01' }), { ...filter, to: '' }), true);
});
test('feeds retain archive and pin semantics while explicit completed queries override hideDone', () => {
  const memos = [memo(), memo({ key: 'b', task: 'done' }), memo({ key: 'c', task: null })];
  const meta = { a: { archived: true }, c: { pinned: true } };
  assert.deepEqual(filterMemos(memos, emptyFilter(), meta).map(m => m.key), ['c', 'b']);
  assert.deepEqual(filterMemos(memos, { ...emptyFilter(), feed: 'archived' }, meta).map(m => m.key), ['a']);
  assert.deepEqual(filterMemos(memos, { ...emptyFilter(), feed: 'tasks', status: 'done' }, meta, { hideDone: true }).map(m => m.key), ['b']);
  assert.deepEqual(filterMemos(memos, { ...emptyFilter(), status: 'note' }, meta).map(m => m.key), ['c']);
  assert.equal(filterMemos(memos, { ...emptyFilter(), feed: 'today' }, meta, { now: new Date(2026, 10, 7) }).length, 0);
});
test('invalid ranges and corrupted presets cannot become active queries', () => {
  for (const from of ['2026-02-30', '2026-13-01', 'yesterday']) assert.throws(() => validateFilter({ ...emptyFilter(), period: 'custom', from }));
  assert.throws(() => validateFilter({ ...emptyFilter(), period: 'custom', from: '2026-11-07', to: '2026-11-06' }));
  const entry = { id: 'one', name: '工作', filter: emptyFilter() };
  assert.deepEqual(readSavedFilters([null, { id: 'bad' }, entry, entry]), [entry]);
  assert.deepEqual(validateFilter({ ...emptyFilter(), tags: ['#工作', '工作', '跟进'] }).tags, ['工作', '跟进']);
});
test('export includes more than 50 results, groups chronologically, preserves Markdown and optional source links', () => {
  const content = '段落\n\n```ts\nconst x = 1;\n```\n\n- 子项\n\n![[附件/图.png]]';
  const memos = Array.from({ length: 65 }, (_, index) => memo({ key: `${index}`, blockId: `id-${index}`, line: index + 1,
    date: index === 64 ? '2026-11-05' : '2026-11-06', content: `${content}\n记录 ${index}`, task: index % 2 ? 'done' : null }));
  const original = memos.map(m => m.key);
  const output = memosToMarkdown(memos, true);
  assert.equal((output.match(/记录 \d+/g) ?? []).length, 65);
  assert.equal((output.match(/^## /gm) ?? []).length, 2);
  assert.ok(output.startsWith('## 2026-11-05'));
  assert.ok(output.includes(content));
  assert.ok(output.includes('- [x] 09:00'));
  assert.ok(output.includes('[[Journal/2026-11-06#^id-64]]'));
  assert.deepEqual(memos.map(m => m.key), original);
  assert.ok(!memosToMarkdown(memos, false).includes('#^id-'));
  assert.ok(memosToMarkdown([memo({ blockId: undefined })], true).includes('[[Journal/2026-11-06]]'));
  assert.equal(memosToMarkdown([], true), '');
});
