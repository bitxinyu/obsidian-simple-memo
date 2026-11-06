import type { Memo, MemoFilter, MemoMeta, SavedFilter } from './types';

export const PERIOD_LABELS: Record<MemoFilter['period'], string> = {
  all: '不限日期', custom: '自定义日期', today: '今天', last7: '最近七天', thisWeek: '本周', thisMonth: '本月',
};
export const STATUS_LABELS: Record<MemoFilter['status'], string> = { any: '不限状态', open: '未完成待办', done: '已完成待办', note: '普通便签' };
export function emptyFilter(): MemoFilter {
  return { feed: 'all', text: '', tags: [], status: 'any', period: 'all', from: '', to: '', oldestFirst: false };
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function splitTags(text: string): string[] {
  return [...new Set(text.split(/\s+/).map(tag => tag.replace(/^#/, '')).filter(Boolean))];
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localDate(date) === value;
}
/** Validate persisted presets as well as form values before using them. */
export function validateFilter(value: unknown): MemoFilter {
  if (!value || typeof value !== 'object') throw new Error('筛选条件格式不正确');
  const f = value as Partial<MemoFilter>;
  if (!['all', 'today', 'tasks', 'pinned', 'archived', 'trash'].includes(f.feed ?? '') ||
      !Object.prototype.hasOwnProperty.call(PERIOD_LABELS, f.period ?? '') || !Object.prototype.hasOwnProperty.call(STATUS_LABELS, f.status ?? '') ||
      typeof f.text !== 'string' || !Array.isArray(f.tags) || !f.tags.every(tag => typeof tag === 'string') ||
      typeof f.oldestFirst !== 'boolean') throw new Error('筛选条件格式不正确');
  if (f.period === 'custom' && ((f.from && !validDate(f.from)) || (f.to && !validDate(f.to)) ||
      (f.from && f.to && f.from > f.to))) throw new Error('请填写有效日期，开始日期不能晚于结束日期');
  return { feed: f.feed!, text: f.text.trim(), tags: splitTags(f.tags.join(' ')), status: f.status!, period: f.period!,
    from: f.period === 'custom' ? f.from || '' : '', to: f.period === 'custom' ? f.to || '' : '', oldestFirst: f.oldestFirst };
}
export function readSavedFilters(value: unknown): SavedFilter[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Partial<SavedFilter>;
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    try {
      const filter = validateFilter(entry.filter);
      ids.add(entry.id);
      return [{ id: entry.id, name: entry.name.trim(), filter }];
    } catch { return []; }
  });
}
export function dateBounds(filter: MemoFilter, now = new Date(), weekStart = 0): { from: string; to: string } {
  if (filter.period === 'all') return { from: '', to: '' };
  if (filter.period === 'custom') return { from: filter.from, to: filter.to };
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  if (filter.period === 'last7') start.setDate(start.getDate() - 6);
  if (filter.period === 'thisWeek') {
    start.setDate(start.getDate() - (start.getDay() - weekStart + 7) % 7);
    end.setTime(start.getTime()); end.setDate(end.getDate() + 6);
  }
  if (filter.period === 'thisMonth') { start.setDate(1); end.setMonth(end.getMonth() + 1, 0); }
  return { from: localDate(start), to: localDate(end) };
}
export function matchesMemo(memo: Memo, filter: MemoFilter, bounds = dateBounds(filter)): boolean {
  if ((bounds.from && memo.date < bounds.from) || (bounds.to && memo.date > bounds.to)) return false;
  if (filter.status !== 'any' && memo.task !== (filter.status === 'note' ? null : filter.status)) return false;
  const tags = memo.tags.map(tag => tag.replace(/^#/, '').toLocaleLowerCase());
  if (!filter.tags.every(tag => tags.some(value => value === tag.toLocaleLowerCase() || value.startsWith(`${tag.toLocaleLowerCase()}/`)))) return false;
  const text = memo.content.toLocaleLowerCase();
  return filter.text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => term.startsWith('#')
    ? tags.some(tag => tag.startsWith(term.slice(1))) : text.includes(term));
}
export function filterMemos(memos: Memo[], filter: MemoFilter, meta: Record<string, MemoMeta>,
  options: { now?: Date; weekStart?: number; hideDone?: boolean } = {}): Memo[] {
  const now = options.now ?? new Date();
  const bounds = dateBounds(filter, now, options.weekStart);
  return memos.filter(memo => {
    const state = meta[memo.key] ?? {};
    if ((filter.feed === 'archived') !== Boolean(state.archived)) return false;
    if (filter.feed === 'today' && memo.date !== localDate(now)) return false;
    if (filter.feed === 'tasks' && !memo.task) return false;
    if (filter.feed === 'pinned' && !state.pinned) return false;
    // An explicit status query takes precedence over the general display preference.
    if (options.hideDone && filter.status === 'any' && memo.task === 'done') return false;
    return matchesMemo(memo, filter, bounds);
  }).sort((a, b) => {
    if (filter.feed === 'all') {
      const pins = Number(Boolean(meta[b.key]?.pinned)) - Number(Boolean(meta[a.key]?.pinned));
      if (pins) return pins;
    }
    const order = `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.path.localeCompare(b.path) || a.line - b.line;
    return filter.oldestFirst ? order : -order;
  });
}
export function memoLink(memo: Memo): string {
  return `[[${memo.path.replace(/\.md$/, '')}${memo.blockId ? `#^${memo.blockId}` : ''}]]`;
}
/** Export complete content in chronological groups, independently of pagination and pins. */
export function memosToMarkdown(memos: Memo[], includeLinks: boolean): string {
  let day = '';
  const parts: string[] = [];
  const sorted = [...memos].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.path.localeCompare(b.path) || a.line - b.line);
  for (const memo of sorted) {
    if (memo.date !== day) { day = memo.date; parts.push(`## ${day}`); }
    const task = memo.task ? `- [${memo.task === 'done' ? 'x' : ' '}] ` : '';
    parts.push(`${task}${memo.time}${includeLinks ? ` · ${memoLink(memo)}` : ''}\n\n${memo.content}`);
  }
  return parts.length ? parts.join('\n\n') + '\n' : '';
}
