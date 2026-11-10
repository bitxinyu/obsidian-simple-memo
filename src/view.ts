import {
  App, Component, ItemView, MarkdownRenderer, Menu, Modal, Notice,
  Scope, setIcon, WorkspaceLeaf,
} from 'obsidian';
import type { Memo, MemoController, MemoFilter, TrashEntry } from './types';
import { attachSuggestions } from './suggest';
import { FilterModal, FEEDS } from './filter-modal';
import { emptyFilter, dateBounds, filterMemos, localDate, matchesMemo, memosToMarkdown, PERIOD_LABELS, STATUS_LABELS, validateFilter } from './filters';
import { removeCommonIndent } from './core';

export const VIEW_TYPE = 'simple-memo-view';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function button(parent: HTMLElement, label: string, icon?: string, className = ''): HTMLButtonElement {
  const el = parent.createEl('button', { cls: className, attr: { type: 'button', 'aria-label': label, title: label } });
  if (icon) {
    const iconEl = el.createSpan({ cls: 'st-icon' });
    setIcon(iconEl, icon);
  }
  if (!className.includes('st-icon-button')) el.createSpan({ text: label });
  return el;
}

function normalizeTag(tag: string): string { return tag.replace(/^#/, ''); }

function hasSelectionWithin(element: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.containsNode(element, true));
}

/** Handle save before Obsidian's global shortcuts consume the key event. */
export function registerSaveShortcut(scope: Scope, editor: HTMLTextAreaElement, save: () => void): void {
  for (const modifier of ['Meta', 'Ctrl'] as const) {
    scope.register([modifier], 'Enter', event => {
      if (event.isComposing || event.target !== editor) return;
      save();
      return false;
    });
  }
}

/** Keep pasted Markdown intact; removing a shared indent is an explicit editor action. */
export function addIndentAction(parent: HTMLElement, editor: HTMLTextAreaElement): () => void {
  const action = button(parent, '取消整体缩进', 'outdent', 'st-icon-button st-indent-action');
  action.title = '取消整体缩进，保留内部层级';
  const refresh = () => { action.hidden = removeCommonIndent(editor.value) === editor.value; };
  editor.addEventListener('input', refresh);
  action.onclick = () => {
    if (editor.disabled) return;
    const content = removeCommonIndent(editor.value);
    if (content === editor.value) return;
    editor.focus({ preventScroll: true });
    editor.select();
    // Native insertion participates in the textarea's undo history.
    if (!editor.ownerDocument.execCommand('insertText', false, content)) {
      editor.setRangeText(content, 0, editor.value.length, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    refresh();
  };
  refresh();
  return refresh;
}

/** Only the memo's own task checkbox writes to the note; nested Markdown tasks are previews. */
async function renderMarkdown(app: App, memo: Memo, parent: HTMLElement, component: Component): Promise<void> {
  try {
    await MarkdownRenderer.render(app, memo.content, parent, memo.path, component);
    if (!parent.isConnected) return;
    parent.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => {
      input.disabled = true;
      input.title = '在编辑便签中修改正文里的待办';
    });
  } catch (error) {
    if (parent.isConnected) {
      parent.createDiv({ cls: 'st-inline-error', text: `正文预览失败：${errorMessage(error)}` });
      new Notice(`便签预览失败：${errorMessage(error)}`, 6500);
    }
  }
}

export class MemoView extends ItemView {
  private readonly controller: MemoController;
  private unsubscribe?: () => void;
  private filter = emptyFilter();
  private activeFilterId = '';
  private clearSuggestions?: () => void;
  private searchInput!: HTMLInputElement;
  private limit = 50;
  private calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private showSidebar: boolean;
  private rendering: Component[] = [];
  private captureBusy = false;
  private attachmentBusy = false;
  private closed = false;
  private editor!: HTMLTextAreaElement;
  private taskInput!: HTMLInputElement;
  private saveButton!: HTMLButtonElement;
  private attachButton!: HTMLButtonElement;
  private composer!: HTMLElement;
  private feedWrap!: HTMLElement;
  private main!: HTMLElement;
  private sidebar!: HTMLElement;
  private listEl!: HTMLElement;
  private feedSelect!: HTMLSelectElement;
  private resultCount!: HTMLElement;
  private dailyGoal!: HTMLElement;
  private filterRow!: HTMLElement;
  private dateButton!: HTMLButtonElement;
  private sidebarButton!: HTMLButtonElement;
  private activityMode: 'calendar' | 'heatmap' = 'heatmap';

  constructor(leaf: WorkspaceLeaf, controller: MemoController) {
    super(leaf);
    this.controller = controller;
    this.showSidebar = controller.settings.showSidebar;
    this.scope = new Scope(this.app.scope);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Simple Memo'; }
  getIcon(): string { return 'notebook-pen'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    const root = this.contentEl;
    root.empty();
    root.addClass('simple-memo-root');
    // A narrow pane opens its optional filters on demand, above the composer.
    if (root.clientWidth > 0 && root.clientWidth <= 682) this.showSidebar = false;
    const body = root.createDiv({ cls: 'st-layout' });
    this.main = body.createDiv({ cls: 'st-main' });
    this.createFilters();
    this.createComposer();
    this.feedWrap = this.main.createDiv({ cls: 'st-feed' });
    this.listEl = this.feedWrap.createDiv({ cls: 'st-memos', attr: { 'aria-label': '便签列表' } });
    this.sidebar = body.createEl('aside', { cls: 'st-sidebar', attr: { 'aria-label': '日历与标签' } });
    this.unsubscribe = this.controller.subscribe(() => this.update());
    this.update();
    await this.action(() => this.controller.refresh());
    if (!this.closed && this.controller.settings.focusEditor) this.editor.focus();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearRendering();
    this.clearSuggestions?.();
  }

  private async action(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { new Notice(errorMessage(error), 6500); }
  }

  private createComposer(): void {
    this.composer = this.main.createDiv({ cls: 'st-composer' });
    this.editor = this.composer.createEl('textarea', {
      cls: 'st-editor',
      attr: { placeholder: '现在想记点什么？', 'aria-label': '便签正文', rows: '2' },
    });
    this.editor.value = this.controller.data.draft;
    this.clearSuggestions = attachSuggestions(this.app, this.controller, this.editor, this.scope!);
    this.editor.oninput = () => this.controller.saveDraft(this.editor.value);
    registerSaveShortcut(this.scope!, this.editor, () => { void this.capture(); });
    this.editor.addEventListener('paste', event => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        void this.insertAttachments(files);
      }
    });
    this.composer.addEventListener('dragover', event => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        this.composer.addClass('is-dragging');
      }
    });
    this.composer.addEventListener('dragleave', event => {
      if (!this.composer.contains(event.relatedTarget as Node | null)) this.composer.removeClass('is-dragging');
    });
    this.composer.addEventListener('drop', event => {
      this.composer.removeClass('is-dragging');
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      void this.insertAttachments(files);
    });
    const bottom = this.composer.createDiv({ cls: 'st-composer-bottom' });
    const tools = bottom.createDiv({ cls: 'st-composer-tools' });
    const taskLabel = tools.createEl('label', { cls: 'st-task-label' });
    this.taskInput = taskLabel.createEl('input', { type: 'checkbox' });
    this.taskInput.checked = this.controller.settings.defaultTask;
    taskLabel.createSpan({ text: '待办' });
    const upload = tools.createEl('input', { type: 'file', attr: { multiple: '', 'aria-label': '选择附件' } });
    upload.hidden = true;
    upload.onchange = () => {
      const files = Array.from(upload.files ?? []);
      upload.value = '';
      if (files.length) void this.insertAttachments(files);
    };
    this.attachButton = button(tools, '添加附件', 'paperclip', 'st-icon-button');
    this.attachButton.onclick = () => upload.click();
    addIndentAction(tools, this.editor);
    this.dailyGoal = bottom.createSpan({ cls: 'st-daily-goal' });
    this.saveButton = button(bottom, this.controller.settings.saveLabel || '记录', undefined, 'mod-cta st-save');
    this.saveButton.title = '保存便签（⌘ / Ctrl + Enter）';
    this.saveButton.onclick = () => { void this.capture(); };
  }

  private async capture(): Promise<void> {
    if (this.captureBusy || this.attachmentBusy) return;
    const content = this.editor.value;
    if (!content.trim()) { this.editor.focus(); return; }
    this.captureBusy = true;
    this.saveButton.disabled = true;
    try {
      await this.controller.capture(content, this.taskInput.checked);
      if (this.editor.value === content) {
        this.editor.value = '';
        this.editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this.editor.focus();
      new Notice('已记录');
    } catch (error) {
      new Notice(errorMessage(error), 6500);
    } finally {
      this.captureBusy = false;
      this.saveButton.disabled = false;
    }
  }

  private async insertAttachments(files: File[]): Promise<void> {
    if (this.attachmentBusy) { new Notice('附件正在保存，请稍候'); return; }
    this.attachmentBusy = true;
    this.attachButton.disabled = true;
    this.saveButton.disabled = true;
    try {
      for (const file of files) {
        const markdown = await this.controller.attach(file);
        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        const leading = start > 0 && this.editor.value[start - 1] !== '\n' ? '\n' : '';
        this.editor.setRangeText(`${leading}${markdown}\n`, start, end, 'end');
        this.editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this.editor.focus();
    } catch (error) {
      new Notice(`附件保存失败：${errorMessage(error)}`, 6500);
    } finally {
      this.attachmentBusy = false;
      this.attachButton.disabled = false;
      this.saveButton.disabled = this.captureBusy;
    }
  }

  private createFilters(): void {
    const controls = this.main.createDiv({ cls: 'st-controls' });
    const toolbar = controls.createDiv({ cls: 'st-toolbar' });
    const picker = toolbar.createDiv({ cls: 'st-feed-picker' });
    this.feedSelect = picker.createEl('select', { cls: 'st-feed-select', attr: { 'aria-label': '便签分类' } });
    setIcon(picker.createSpan({ cls: 'st-feed-chevron' }), 'chevron-down');
    for (const feed of FEEDS) this.feedSelect.createEl('option', { value: feed.id, text: feed.label });
    this.feedSelect.onchange = () => {
      this.filter.feed = this.feedSelect.value as MemoFilter['feed'];
      if (this.filter.feed === 'today') { this.filter.period = 'all'; this.filter.from = ''; this.filter.to = ''; }
      this.activeFilterId = ''; this.limit = 50; this.update();
    };
    this.resultCount = toolbar.createSpan({ cls: 'st-result-count', attr: { 'aria-live': 'polite' } });
    const searchWrap = toolbar.createDiv({ cls: 'st-search' });
    const searchIcon = searchWrap.createSpan({ cls: 'st-icon' });
    setIcon(searchIcon, 'search');
    this.searchInput = searchWrap.createEl('input', { type: 'search', attr: { placeholder: '搜索', 'aria-label': '搜索便签', title: '搜索内容或 #标签' } });
    this.searchInput.oninput = () => {
      this.filter.text = this.searchInput.value; this.activeFilterId = ''; this.limit = 50;
      this.updateFilters(); this.renderResults();
    };
    this.dateButton = button(toolbar, '筛选与保存', 'list-filter', 'st-icon-button');
    this.dateButton.onclick = () => this.openFilters();
    const more = button(toolbar, '列表选项', 'ellipsis', 'st-icon-button');
    more.onclick = event => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle('最近优先').setChecked(!this.filter.oldestFirst).onClick(() => { this.filter.oldestFirst = false; this.renderResults(); }));
      menu.addItem(item => item.setTitle('最早优先').setChecked(this.filter.oldestFirst).onClick(() => { this.filter.oldestFirst = true; this.renderResults(); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle('筛选与保存').setIcon('list-filter').onClick(() => this.openFilters()));
      menu.addItem(item => item.setTitle('复制全部筛选结果').setIcon('copy').onClick(() => { void this.action(() => this.copyResults(false)); }));
      menu.addItem(item => item.setTitle('复制全部筛选结果（含来源链接）').setIcon('link').onClick(() => { void this.action(() => this.copyResults(true)); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle('随机回顾').setIcon('shuffle').setDisabled(this.filter.feed === 'trash').onClick(() => {
        const memos = this.filteredMemos();
        if (!memos.length) { new Notice('当前筛选下还没有便签'); return; }
        new ReviewModal(this.app, this.controller, memos, memo => this.edit(memo)).open();
      }));
      menu.addItem(item => item.setTitle('重新读取笔记').setIcon('refresh-cw').onClick(() => { void this.action(() => this.controller.refresh()); }));
      menu.showAtMouseEvent(event);
    };
    this.sidebarButton = button(toolbar, '日历与标签', 'panel-right', 'st-icon-button');
    this.sidebarButton.onclick = () => {
      this.showSidebar = !this.showSidebar;
      this.updateSidebarVisibility();
    };
    this.filterRow = controls.createDiv({ cls: 'st-active-filters' });
  }

  private openFilters(): void {
    new FilterModal(this.app, this.controller, validateFilter(this.filter), (filter, id) => this.applyFilter(filter, id), this.activeFilterId).open();
  }

  private applyFilter(filter: MemoFilter, id = ''): void {
    this.filter = validateFilter(filter); this.activeFilterId = id; this.limit = 50;
    this.searchInput.value = this.filter.text;
    this.update();
  }

  private hasFilters(): boolean {
    return Boolean(this.filter.text || this.filter.tags.length || this.filter.period !== 'all' || this.filter.status !== 'any');
  }

  private updateFilters(): void {
    this.feedSelect.value = this.filter.feed;
    this.filterRow.empty();
    this.filterRow.hidden = !this.hasFilters();
    const chip = (label: string, clear: () => void) => {
      const el = button(this.filterRow, label, 'x', 'st-filter-chip');
      el.title = `取消筛选：${label}`;
      el.onclick = () => { clear(); this.activeFilterId = ''; this.limit = 50; this.update(); };
    };
    if (this.filter.period !== 'all') {
      const label = this.filter.period === 'custom' ? `${this.filter.from || '不限'} ～ ${this.filter.to || '不限'}` : PERIOD_LABELS[this.filter.period];
      chip(label, () => { this.filter.period = 'all'; this.filter.from = ''; this.filter.to = ''; });
    }
    for (const tag of this.filter.tags) chip(`#${tag}`, () => { this.filter.tags = this.filter.tags.filter(value => value !== tag); });
    if (this.filter.status !== 'any') chip(STATUS_LABELS[this.filter.status], () => { this.filter.status = 'any'; });
    const clear = button(this.filterRow, '清除筛选', undefined, 'st-clear-filters');
    clear.onclick = () => this.applyFilter({ ...emptyFilter(), oldestFirst: this.filter.oldestFirst });
    this.dateButton.toggleClass('is-active', this.hasFilters());
  }

  private update(): void {
    if (this.closed || !this.listEl) return;
    const settings = this.controller.settings;
    this.contentEl.setAttribute('aria-label', settings.username ? `${settings.username} 的便签` : '便签');
    const label = this.saveButton.querySelector('span:last-child');
    if (label) label.setText(settings.saveLabel || '记录');
    const bottom = settings.editorPosition === 'bottom';
    this.main.toggleClass('st-editor-bottom', bottom);
    // CSS controls composer placement, so live refreshes never detach the focused editor.
    const all = this.controller.list();
    const todayCount = all.filter(memo => memo.date === localDate()).length;
    this.dailyGoal.hidden = settings.dailyTarget <= 0;
    this.dailyGoal.setText(`今日 ${todayCount} / ${settings.dailyTarget}`);
    this.dailyGoal.title = `今天已记录 ${todayCount} 条，目标 ${settings.dailyTarget} 条`;
    this.updateFilters();
    this.renderResults();
    this.renderSidebar();
    this.updateSidebarVisibility();
  }

  private updateSidebarVisibility(): void {
    this.sidebar.hidden = !this.showSidebar;
    this.sidebarButton.toggleClass('is-active', this.showSidebar);
    this.sidebarButton.setAttribute('aria-pressed', String(this.showSidebar));
    this.contentEl.toggleClass('st-has-sidebar', this.showSidebar);
  }

  private matchingTrash(): TrashEntry[] {
    const bounds = dateBounds(this.filter, new Date(), this.controller.settings.weekStart);
    return this.controller.listTrash().filter(entry => matchesMemo(entry.memo, this.filter, bounds))
      .sort((a, b) => this.filter.oldestFirst ? a.deletedAt.localeCompare(b.deletedAt) : b.deletedAt.localeCompare(a.deletedAt));
  }

  private filteredMemos(): Memo[] {
    return filterMemos(this.controller.list(), this.filter, this.controller.data.meta, this.controller.settings);
  }

  private async copyResults(includeLinks: boolean): Promise<void> {
    const memos = this.filter.feed === 'trash' ? this.matchingTrash().map(entry => entry.memo) : this.filteredMemos();
    if (!memos.length) { new Notice('当前筛选下没有可复制的便签'); return; }
    await navigator.clipboard.writeText(memosToMarkdown(memos, includeLinks));
    new Notice(`已按日期复制 ${memos.length} 条便签${includeLinks ? '（含来源链接）' : ''}`);
  }

  private clearRendering(): void {
    this.rendering.forEach(component => component.unload());
    this.rendering = [];
  }

  private component(): Component {
    const component = new Component();
    component.load();
    this.rendering.push(component);
    return component;
  }

  private renderResults(): void {
    this.clearRendering();
    this.listEl.empty();
    const trash = this.filter.feed === 'trash';
    const entries = trash
      ? this.matchingTrash()
      : [];
    const memos = trash ? entries.map(entry => entry.memo) : this.filteredMemos();
    this.resultCount.setText(String(memos.length));
    this.resultCount.setAttribute('aria-label', `${memos.length} 条便签`);
    if (trash && entries.length) {
      this.listEl.createDiv({ cls: 'st-trash-note', text: '可将删除的便签恢复到原笔记。' });
    }
    if (!memos.length) {
      const empty = this.listEl.createDiv({ cls: 'st-empty' });
      const icon = empty.createDiv({ cls: 'st-empty-icon' });
      setIcon(icon, this.hasFilters() ? 'search' : 'feather');
      empty.createEl('h3', { text: this.hasFilters() ? '没有找到匹配的便签' : this.filter.feed === 'trash' ? '回收站是空的' : '给今天留下一点记录' });
      empty.createEl('p', { text: this.hasFilters() ? '试试其他关键词，或清除日期和标签筛选。' : this.filter.feed === 'all' || this.filter.feed === 'today' ? '写下一句话，就从这里开始。' : '符合当前分类的便签会出现在这里。' });
      return;
    }
    memos.slice(0, this.limit).forEach((memo, index) => this.renderMemo(memo, trash ? entries[index] : undefined));
    if (memos.length > this.limit) {
      const more = button(this.listEl, `加载更多 · 还有 ${memos.length - this.limit} 条`, 'chevron-down', 'st-load-more');
      more.onclick = () => { this.limit += 50; this.renderResults(); };
    }
  }

  private renderMemo(memo: Memo, trash?: TrashEntry): void {
    const meta = trash?.meta ?? this.controller.data.meta[memo.key] ?? {};
    const card = this.listEl.createEl('article', { cls: 'st-memo' });
    card.toggleClass('is-pinned', Boolean(meta.pinned));
    card.toggleClass('is-done', memo.task === 'done');
    const head = card.createDiv({ cls: 'st-memo-head' });
    const stamp = head.createDiv({ cls: 'st-memo-stamp' });
    if (memo.task) {
      const check = stamp.createEl('input', { type: 'checkbox', cls: 'st-memo-check', attr: { 'aria-label': memo.task === 'done' ? '标记为未完成' : '标记为已完成' } });
      check.checked = memo.task === 'done';
      check.disabled = Boolean(trash);
      check.onchange = () => { void this.action(async () => {
        check.disabled = true;
        try { await this.controller.toggleTask(memo); }
        catch (error) { check.checked = memo.task === 'done'; throw error; }
        finally { check.disabled = false; }
      }); };
    }
    const date = [this.controller.settings.showDate ? memo.date : '', this.controller.settings.showTime ? memo.time : ''].filter(Boolean).join(' · ');
    if (date) stamp.createEl('time', { text: date, attr: { datetime: memo.date } });
    if (meta.pinned) {
      const pin = stamp.createSpan({ cls: 'st-pin-mark', attr: { 'aria-label': '已置顶', title: '已置顶' } });
      setIcon(pin, 'pin');
    }
    if (trash) {
      const restore = button(head, '恢复', 'rotate-ccw', 'st-restore');
      restore.onclick = () => { void this.action(async () => {
        restore.disabled = true;
        try { await this.controller.restore(trash.id); new Notice('已恢复便签'); }
        finally { restore.disabled = false; }
      }); };
    } else {
      const actions = head.createDiv({ cls: 'st-memo-actions' });
      const menu = button(actions, '更多操作', 'ellipsis', 'st-icon-button');
      menu.onclick = event => this.memoMenu(memo, event);
      card.oncontextmenu = event => {
        if ((event.target as HTMLElement).closest('a, input')) return;
        event.preventDefault();
        const selectedText = hasSelectionWithin(card) ? card.ownerDocument.getSelection()?.toString() : '';
        this.memoMenu(memo, event, selectedText);
      };
    }
    const content = card.createDiv({ cls: 'st-memo-content markdown-rendered' });
    // Prevent preview checkboxes from receiving clicks before asynchronous rendering completes.
    content.addEventListener('click', event => {
      if ((event.target as HTMLElement).matches('input[type="checkbox"]')) {
        event.preventDefault();
        event.stopPropagation();
      }
      const tag = (event.target as HTMLElement).closest<HTMLAnchorElement>('a.tag');
      if (tag && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (hasSelectionWithin(content)) return;
        this.filter.tags = [normalizeTag(tag.textContent?.trim() ?? '')];
        this.activeFilterId = '';
        this.limit = 50;
        this.update();
      }
    }, true);
    void renderMarkdown(this.app, memo, content, this.component());
    if (this.controller.settings.showSource) {
      const source = button(stamp, memo.path.split('/').pop() ?? memo.path, 'file-text', 'st-source');
      source.title = memo.path;
      source.onclick = () => { void this.action(() => this.controller.openSource(memo)); };
    }
  }

  private edit(memo: Memo): void { new EditMemoModal(this.app, this.controller, memo).open(); }

  private memoMenu(memo: Memo, event: MouseEvent, selectedText = ''): void {
    const meta = this.controller.data.meta[memo.key] ?? {};
    const menu = new Menu();
    if (selectedText) {
      menu.addItem(item => item.setTitle('复制所选文字').setIcon('copy').onClick(() => { void this.action(async () => { await navigator.clipboard.writeText(selectedText); new Notice('已复制所选文字'); }); }));
      menu.addSeparator();
    }
    menu.addItem(item => item.setTitle('编辑便签').setIcon('pencil').onClick(() => this.edit(memo)));
    menu.addItem(item => item.setTitle('复制正文').setIcon('copy').onClick(() => { void this.action(async () => { await navigator.clipboard.writeText(memo.content); new Notice('已复制正文'); }); }));
    menu.addItem(item => item.setTitle('复制便签链接').setIcon('link').onClick(() => { void this.action(() => this.controller.copyLink(memo)); }));
    menu.addItem(item => item.setTitle('在笔记中打开').setIcon('file-text').onClick(() => { void this.action(() => this.controller.openSource(memo)); }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(meta.pinned ? '取消置顶' : '置顶').setIcon('pin').onClick(() => { void this.action(() => this.controller.setMeta(memo, { pinned: !meta.pinned })); }));
    menu.addItem(item => item.setTitle(meta.archived ? '取消归档' : '归档').setIcon('archive').onClick(() => { void this.action(() => this.controller.setMeta(memo, { archived: !meta.archived })); }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('移入回收站…').setIcon('trash-2').onClick(() => new DeleteMemoModal(this.app, this.controller, memo).open()));
    menu.showAtMouseEvent(event);
  }

  private get selectedDate(): string { return this.filter.period === 'custom' && this.filter.from === this.filter.to ? this.filter.from : ''; }

  private setDate(date: string): void {
    this.filter.period = date ? 'custom' : 'all';
    this.filter.from = date; this.filter.to = date; this.activeFilterId = '';
    if (date) {
      const [year, month] = date.split('-').map(Number);
      this.calendarMonth = new Date(year, month - 1, 1);
      if (this.filter.feed === 'today') this.filter.feed = 'all';
    }
    this.limit = 50;
    this.update();
  }

  private renderSidebar(): void {
    this.sidebar.empty();
    const presets = this.controller.data.savedFilters ?? [];
    if (presets.length) {
      const section = this.sidebar.createDiv({ cls: 'st-saved-filters' });
      section.createEl('h3', { text: '已保存的筛选' });
      for (const preset of presets) {
        const entry = button(section, preset.name, 'list-filter', 'st-tag-row');
        entry.toggleClass('is-active', preset.id === this.activeFilterId);
        entry.onclick = () => this.applyFilter(preset.filter, preset.id);
      }
    }
    const memos = this.controller.list();
    const counts = new Map<string, number>();
    memos.forEach(memo => counts.set(memo.date, (counts.get(memo.date) ?? 0) + 1));
    const activity = this.sidebar.createDiv({ cls: 'st-activity' });
    const header = activity.createDiv({ cls: 'st-calendar-header' });
    if (this.activityMode === 'calendar') {
      const prev = button(header, '上个月', 'chevron-left', 'st-icon-button');
      prev.onclick = () => { this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() - 1, 1); this.renderSidebar(); };
      const month = button(header, `${this.calendarMonth.getFullYear()} 年 ${this.calendarMonth.getMonth() + 1} 月`, undefined, 'st-calendar-title');
      month.title = '回到本月';
      month.onclick = () => { this.calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); this.renderSidebar(); };
      const next = button(header, '下个月', 'chevron-right', 'st-icon-button');
      next.onclick = () => { this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + 1, 1); this.renderSidebar(); };
    } else {
      header.createEl('h3', { text: '最近 12 周' });
    }
    const toggle = button(header, this.activityMode === 'calendar' ? '切换到热力图' : '切换到月历', this.activityMode === 'calendar' ? 'grid-3x3' : 'calendar-days', 'st-icon-button');
    toggle.onclick = () => {
      this.activityMode = this.activityMode === 'calendar' ? 'heatmap' : 'calendar';
      this.renderSidebar();
    };
    if (this.activityMode === 'calendar') this.renderCalendar(activity, counts);
    else this.renderHeatmap(activity, counts);
    const section = this.sidebar.createDiv({ cls: 'st-tags-section' });
    section.createEl('h3', { text: '标签' });
    const tags = section.createDiv({ cls: 'st-sidebar-tags' });
    const tagCounts = new Map<string, number>();
    memos.forEach(memo => new Set(memo.tags.map(normalizeTag)).forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)));
    if (!tagCounts.size) section.createEl('p', { cls: 'st-muted', text: '还没有标签' });
    Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([tag, count]) => {
      const row = button(tags, `#${tag}`, undefined, 'st-tag-row');
      row.createSpan({ cls: 'st-tag-count', text: String(count) });
      row.toggleClass('is-active', this.filter.tags.includes(tag));
      row.setAttribute('aria-pressed', String(this.filter.tags.includes(tag)));
      row.onclick = () => { this.filter.tags = this.filter.tags.includes(tag) ? this.filter.tags.filter(value => value !== tag) : [...this.filter.tags, tag]; this.activeFilterId = ''; this.limit = 50; this.update(); };
    });
  }

  private renderCalendar(calendar: HTMLElement, counts: Map<string, number>): void {
    const grid = calendar.createDiv({ cls: 'st-calendar-grid' });
    const weekStart = ((this.controller.settings.weekStart % 7) + 7) % 7;
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    for (let day = 0; day < 7; day++) grid.createSpan({ cls: 'st-weekday', text: weekdays[(day + weekStart) % 7] });
    const offset = (this.calendarMonth.getDay() - weekStart + 7) % 7;
    for (let index = 0; index < offset; index++) grid.createSpan();
    const days = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + 1, 0).getDate();
    const today = localDate();
    for (let day = 1; day <= days; day++) {
      const date = localDate(new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth(), day));
      const count = counts.get(date) ?? 0;
      const cell = button(grid, String(day), undefined, 'st-calendar-day');
      cell.title = `${date} · ${count} 条记录`;
      cell.setAttribute('aria-label', cell.title);
      cell.setAttribute('aria-pressed', String(this.selectedDate === date));
      cell.toggleClass('has-memos', count > 0);
      cell.toggleClass('is-today', date === today);
      cell.toggleClass('is-selected', date === this.selectedDate);
      cell.onclick = () => this.setDate(this.selectedDate === date ? '' : date);
    }
  }

  private renderHeatmap(activity: HTMLElement, counts: Map<string, number>): void {
    const heatmap = activity.createDiv({ cls: 'st-heatmap', attr: { 'aria-label': '最近 84 天记录数量' } });
    for (let index = 83; index >= 0; index--) {
      const day = new Date();
      day.setDate(day.getDate() - index);
      const date = localDate(day);
      const count = counts.get(date) ?? 0;
      const cell = button(heatmap, `${date} · ${count} 条`, undefined, 'st-heat-cell st-icon-button');
      cell.dataset.level = String(Math.min(count, 4));
      cell.toggleClass('is-selected', date === this.selectedDate);
      cell.onclick = () => this.setDate(this.selectedDate === date ? '' : date);
    }
    const legend = activity.createDiv({ cls: 'st-heat-legend' });
    legend.createSpan({ text: '少' });
    for (let level = 0; level <= 4; level++) {
      const square = legend.createSpan({ cls: 'st-heat-cell' });
      square.dataset.level = String(level);
    }
    legend.createSpan({ text: '多' });
  }
}

class EditMemoModal extends Modal {
  private readonly controller: MemoController;
  private readonly memo: Memo;
  private saving = false;
  private clearSuggestions?: () => void;
  constructor(app: App, controller: MemoController, memo: Memo) {
    super(app);
    this.controller = controller;
    this.memo = memo;
  }
  onOpen(): void {
    this.modalEl.addClass('st-edit-modal');
    this.titleEl.setText('编辑便签');
    this.contentEl.createEl('p', { cls: 'st-muted', text: `${this.memo.date} ${this.memo.time} · ${this.memo.path}` });
    const editor = this.contentEl.createEl('textarea', { cls: 'st-modal-editor', attr: { 'aria-label': '编辑便签正文', rows: '12' } });
    editor.value = this.memo.content;
    this.clearSuggestions = attachSuggestions(this.app, this.controller, editor, this.scope);
    const error = this.contentEl.createDiv({ cls: 'st-inline-error', attr: { role: 'alert' } });
    const actions = this.contentEl.createDiv({ cls: 'st-modal-actions' });
    const cancel = button(actions, '取消');
    cancel.onclick = () => this.close();
    const source = button(actions, '打开原笔记', 'file-text');
    source.onclick = () => { void this.controller.openSource(this.memo).catch(error => new Notice(errorMessage(error))); };
    addIndentAction(actions, editor);
    const save = button(actions, '保存修改', undefined, 'mod-cta');
    const submit = async (): Promise<void> => {
      if (this.saving) return;
      if (!editor.value.trim()) { error.setText('正文不能为空。删除便签请使用「移入回收站」。'); return; }
      this.saving = true;
      save.disabled = true;
      editor.disabled = true;
      cancel.disabled = true;
      error.empty();
      try {
        await this.controller.edit(this.memo, editor.value);
        this.close();
        new Notice('已保存修改');
      } catch (cause) {
        // Keep the user's text intact if another app changed the source meanwhile.
        error.setText(`${errorMessage(cause)}\n你的修改仍保留在此处，可复制后打开原笔记核对。`);
        new Notice(errorMessage(cause), 6500);
      } finally {
        this.saving = false;
        save.disabled = false;
        editor.disabled = false;
        cancel.disabled = false;
      }
    };
    save.onclick = () => { void submit(); };
    registerSaveShortcut(this.scope, editor, () => { void submit(); });
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
  onClose(): void { this.clearSuggestions?.(); this.contentEl.empty(); }
}

class DeleteMemoModal extends Modal {
  constructor(app: App, private readonly controller: MemoController, private readonly memo: Memo) { super(app); }
  onOpen(): void {
    this.titleEl.setText('将这条便签移入回收站？');
    this.contentEl.createEl('p', { text: '这条便签会从原 Markdown 笔记中移除，并保存在Simple Memo回收站中，之后可以恢复。' });
    this.contentEl.createEl('blockquote', { cls: 'st-delete-preview', text: this.memo.content.slice(0, 240) });
    const error = this.contentEl.createDiv({ cls: 'st-inline-error', attr: { role: 'alert' } });
    const actions = this.contentEl.createDiv({ cls: 'st-modal-actions' });
    const cancel = button(actions, '取消');
    cancel.onclick = () => this.close();
    const remove = button(actions, '移入回收站', undefined, 'mod-warning');
    remove.onclick = () => {
      remove.disabled = true;
      void this.controller.remove(this.memo).then(() => { this.close(); new Notice('已移入回收站'); }).catch(cause => {
        remove.disabled = false;
        error.setText(errorMessage(cause));
      });
    };
    cancel.focus();
  }
  onClose(): void { this.contentEl.empty(); }
}

class ReviewModal extends Modal {
  private component?: Component;
  private current?: Memo;
  constructor(app: App, private readonly controller: MemoController, private readonly memos: Memo[], private readonly editMemo: (memo: Memo) => void) { super(app); }
  onOpen(): void { this.modalEl.addClass('st-review-modal'); this.titleEl.setText('随机回顾'); this.showNext(); }
  private showNext(): void {
    this.component?.unload();
    this.component = new Component();
    this.component.load();
    this.contentEl.empty();
    const candidates = this.memos.length > 1 ? this.memos.filter(memo => memo.key !== this.current?.key) : this.memos;
    const memo = candidates[Math.floor(Math.random() * candidates.length)];
    this.current = memo;
    this.contentEl.createDiv({ cls: 'st-muted', text: `${memo.date} · ${memo.time}` });
    const content = this.contentEl.createDiv({ cls: 'st-review-content markdown-rendered' });
    content.addEventListener('click', event => {
      if ((event.target as HTMLElement).matches('input[type="checkbox"]')) { event.preventDefault(); event.stopPropagation(); }
    }, true);
    void renderMarkdown(this.app, memo, content, this.component);
    const actions = this.contentEl.createDiv({ cls: 'st-modal-actions' });
    const source = button(actions, '打开原笔记', 'file-text');
    source.onclick = () => { void this.controller.openSource(memo).catch(error => new Notice(errorMessage(error))); };
    const edit = button(actions, '编辑', 'pencil');
    edit.onclick = () => { this.close(); this.editMemo(memo); };
    const next = button(actions, '再看一条', 'shuffle', 'mod-cta');
    next.disabled = this.memos.length < 2;
    next.onclick = () => this.showNext();
  }
  onClose(): void { this.component?.unload(); this.contentEl.empty(); }
}
