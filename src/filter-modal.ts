import { App, Modal, Notice } from 'obsidian';
import type { MemoController, MemoFilter } from './types';
import { PERIOD_LABELS, STATUS_LABELS, splitTags, validateFilter } from './filters';

export const FEEDS: { id: MemoFilter['feed']; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'today', label: '今天' }, { id: 'tasks', label: '待办' },
  { id: 'pinned', label: '置顶' }, { id: 'archived', label: '归档' }, { id: 'trash', label: '回收站' },
];

export class FilterModal extends Modal {
  private busy = false;
  constructor(app: App, private controller: MemoController, private filter: MemoFilter,
    private apply: (filter: MemoFilter, id?: string) => void, private selectedId = '') { super(app); }

  onOpen(): void {
    this.modalEl.addClass('st-filter-modal');
    this.titleEl.setText('筛选与保存');
    this.renderForm();
  }

  private renderForm(): void {
    const root = this.contentEl;
    root.empty();
    const field = (name: string) => {
      const label = root.createEl('label', { cls: 'st-filter-field' });
      label.createSpan({ text: name });
      return label;
    };
    const preset = field('已保存的筛选').createEl('select', { attr: { 'aria-label': '已保存的筛选' } });
    preset.createEl('option', { text: '新建筛选', value: '' });
    for (const entry of this.controller.data.savedFilters ?? []) preset.createEl('option', { text: entry.name, value: entry.id });
    preset.value = this.selectedId;
    preset.onchange = () => {
      this.selectedId = preset.value;
      const entry = this.controller.data.savedFilters?.find(value => value.id === this.selectedId);
      if (entry) this.filter = validateFilter(entry.filter);
      this.renderForm();
    };
    const name = field('筛选名称').createEl('input', { type: 'text', attr: { placeholder: '例如：本周工作', 'aria-label': '筛选名称' } });
    name.value = this.controller.data.savedFilters?.find(entry => entry.id === this.selectedId)?.name ?? '';
    const select = (label: string, values: Record<string, string>, value: string) => {
      const input = field(label).createEl('select', { attr: { 'aria-label': label } });
      for (const key of Object.keys(values)) input.createEl('option', { text: values[key], value: key });
      input.value = value;
      return input;
    };
    const feed = select('分类', Object.fromEntries(FEEDS.map(value => [value.id, value.label])), this.filter.feed);
    const text = field('关键词').createEl('input', { type: 'text', attr: { placeholder: '多个关键词用空格分隔', 'aria-label': '关键词' } });
    text.value = this.filter.text;
    const tags = field('标签（同时包含）').createEl('input', { type: 'text', attr: { placeholder: '#工作 #项目', 'aria-label': '筛选标签' } });
    tags.value = this.filter.tags.map(tag => `#${tag}`).join(' ');
    const status = select('待办状态', STATUS_LABELS, this.filter.status);
    const period = select('日期范围', PERIOD_LABELS, this.filter.period);
    const dates = root.createDiv({ cls: 'st-filter-dates' });
    const dateInput = (label: string, value: string) => {
      const wrap = dates.createEl('label', { cls: 'st-filter-field' });
      wrap.createSpan({ text: label });
      return wrap.createEl('input', { type: 'date', value, attr: { 'aria-label': label } });
    };
    const from = dateInput('开始日期', this.filter.from);
    const to = dateInput('结束日期', this.filter.to);
    const updateDates = () => { dates.hidden = period.value !== 'custom'; };
    period.onchange = updateDates; updateDates();
    root.createEl('p', { cls: 'st-muted', text: '所有条件同时满足。日期包含首尾两天，可只填一端；本周按设置中的每周起始日计算，相对日期会自动滚动。指定待办状态时优先于“隐藏已完成”。' });
    const error = root.createDiv({ cls: 'st-inline-error', attr: { role: 'alert' } });
    const actions = root.createDiv({ cls: 'st-modal-actions' });
    const read = () => validateFilter({ ...this.filter, feed: feed.value, text: text.value, tags: splitTags(tags.value),
      status: status.value, period: period.value, from: from.value, to: to.value });
    const execute = async (operation: () => Promise<void>) => {
      if (this.busy) return;
      this.busy = true;
      const controls = root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select');
      controls.forEach(control => { control.disabled = true; });
      try { await operation(); } catch (cause) { error.setText(cause instanceof Error ? cause.message : String(cause)); }
      finally { this.busy = false; controls.forEach(control => { control.disabled = false; }); }
    };
    if (this.selectedId) {
      const remove = actions.createEl('button', { text: '删除筛选', attr: { type: 'button' } });
      remove.onclick = () => { void execute(async () => {
        await this.controller.deleteFilter(this.selectedId);
        this.selectedId = ''; this.renderForm(); new Notice('已删除保存的筛选，便签不受影响');
      }); };
    }
    const apply = actions.createEl('button', { text: '应用筛选', attr: { type: 'button' } });
    apply.onclick = () => { void execute(async () => { this.apply(read()); this.close(); }); };
    const save = actions.createEl('button', { text: this.selectedId ? '更新并应用' : '保存并应用', cls: 'mod-cta', attr: { type: 'button' } });
    save.onclick = () => { void execute(async () => {
      const filter = read();
      const id = await this.controller.saveFilter(name.value, filter, this.selectedId || undefined);
      this.apply(filter, id); this.close(); new Notice('已保存筛选');
    }); };
  }
  onClose(): void { this.contentEl.empty(); }
}
