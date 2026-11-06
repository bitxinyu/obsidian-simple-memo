import { App, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, moment as obsidianMoment } from 'obsidian';
import type momentType from 'moment';
const moment = obsidianMoment as unknown as typeof momentType;
import type { Memo, MemoController, MemoFilter, MemoMeta, PluginData, Settings } from './types';
import { asRecord, defaultSettings, importThinoSettings, safePath, validateSettings } from './settings';
import { parseMemos, formatMemo, insertMemo, replaceMemo, editMemoRaw, toggleMemoRaw, getMemoFields, transformMemoFields, withMemoBlockId } from './core';
import { MemoView, VIEW_TYPE, addIndentAction, registerSaveShortcut } from './view';
import { memoLink, readSavedFilters, validateFilter } from './filters';
import { attachSuggestions } from './suggest';
const deleted = (raw: string) => [...getMemoFields(raw).join(' ').matchAll(/\[deleted::([^\]]+)\]/gi)].some(m => !['', 'false', '0'].includes(m[1].trim().toLowerCase()));
const legacyMeta = (raw: string): MemoMeta => ({ pinned: /\[pinned::\s*true\s*\]/i.test(getMemoFields(raw).join(' ')), archived: /\[archived::\s*true\s*\]/i.test(getMemoFields(raw).join(' ')) });
const uid = () => `st-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
export default class SimpleMemoPlugin extends Plugin implements MemoController {
    data!: PluginData;
    settings!: Settings;
    private memos: Memo[] = [];
    private listeners = new Set<() => void>();
    private saveQueue: Promise<void> = Promise.resolve();
    private operationQueue: Promise<unknown> = Promise.resolve();
    private refreshTimer?: number;
    private draftTimer?: number;
    private generation = 0;
    private stopped = false;
    async onload() {
        let saved = await this.loadData() as PluginData | null;
        let migrated = false;
        if (saved == null) {
            const legacyPath = `${this.app.vault.configDir}/plugins/simple-thino/data.json`;
            if (await this.app.vault.adapter.exists(legacyPath)) {
                saved = JSON.parse(await this.app.vault.adapter.read(legacyPath)) as PluginData;
                if (saved?.version !== 1)
                    throw new Error('旧版 Simple Memo 数据格式不受支持，无法自动迁移。旧文件已保留。');
                migrated = true;
            }
        }
        if (saved != null && saved.version !== 1)
            throw new Error('Simple Memo 数据版本不受支持，请检查插件版本。');
        if (saved?.version === 1) {
            this.data = { ...saved, settings: validateSettings({ ...defaultSettings, ...saved.settings }), meta: saved.meta ?? {}, trash: saved.trash ?? [], draft: saved.draft ?? '' };
            if (migrated)
                await this.persist();
        }
        else {
            const imported = await this.readThino();
            this.data = { version: 1, settings: imported?.settings ?? { ...defaultSettings }, imported: imported?.report, meta: {}, trash: [], draft: '' };
            await this.persist();
        }
        if (this.data.savedFilters !== undefined) this.data.savedFilters = readSavedFilters(this.data.savedFilters);
        this.settings = this.data.settings;
        this.registerView(VIEW_TYPE, leaf => new MemoView(leaf, this));
        this.addRibbonIcon('notebook-pen', 'Simple Memo', () => void this.openView());
        this.addCommand({ id: 'open', name: '打开便签', callback: () => void this.openView() });
        this.addCommand({ id: 'capture', name: '快速记录', callback: () => new CaptureModal(this.app, this).open() });
        this.addCommand({ id: 'refresh', name: '刷新便签', callback: () => void this.refresh().catch(e => this.notifyError(e)) });
        this.addCommand({ id: 'capture-selection', name: '将选中文本复制为便签', editorCallback: editor => { const text = editor.getSelection(); if (text.trim())
                void this.capture(text).then(() => new Notice('已保存便签')).catch(e => this.notifyError(e));
            else
                new Notice('请先选中文本'); } });
        this.addSettingTab(new MemoSettingsTab(this.app, this));
        const changed = () => { window.clearTimeout(this.refreshTimer); this.refreshTimer = window.setTimeout(() => void this.refresh().catch(e => this.notifyError(e)), 300); };
        for (const event of ['create', 'modify', 'delete', 'rename'] as const)
            this.registerEvent(this.app.vault.on(event as 'modify', (file) => { if (file instanceof TFile && file.extension === 'md')
                changed(); }));
        this.app.workspace.onLayoutReady(() => { if (!this.stopped)
            void this.refresh().then(() => this.importLegacyTrash()).then(() => { if (this.settings.autoOpen)
                return this.openView(); }).catch(e => this.notifyError(e)); });
    }
    onunload() { this.stopped = true; this.generation++; window.clearTimeout(this.refreshTimer); window.clearTimeout(this.draftTimer); if (this.data) void this.persist(); this.listeners.clear(); }
    notifyError(error: unknown) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
    async readThino() {
        const base = this.app.vault.configDir;
        const read = async (path: string) => { if (!await this.app.vault.adapter.exists(path))
            return {}; return asRecord(JSON.parse(await this.app.vault.adapter.read(path)) as unknown); };
        const thinoPath = `${base}/plugins/obsidian-memos/data.json`;
        if (!await this.app.vault.adapter.exists(thinoPath))
            return null;
        return importThinoSettings(await read(thinoPath), await read(`${base}/daily-notes.json`), await read(`${base}/plugins/periodic-notes/data.json`));
    }
    async reimportSettings() { const result = await this.readThino(); if (!result)
        throw new Error('未找到 Thino 配置'); this.data.settings = result.settings; this.settings = result.settings; this.data.imported = result.report; await this.persist(); await this.refresh(); }
    persist() { const snapshot = JSON.parse(JSON.stringify(this.data)) as PluginData; const saving = this.saveQueue.then(() => this.saveData(snapshot)); this.saveQueue = saving.catch(() => { }); return saving; }
    private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.operationQueue.then(action); this.operationQueue = next.catch(() => { }); return next; }
    list() { return this.memos; }
    saveFilter(name: string, filter: MemoFilter, id?: string): Promise<string> {
        const cleanName = name.trim();
        const conditions = validateFilter(filter);
        return this.serial(async () => {
            if (!cleanName) throw new Error('请为筛选命名');
            const previous = this.data.savedFilters;
            const entries = previous ?? [];
            if (id && !entries.some(entry => entry.id === id)) throw new Error('该筛选已被删除，请重新打开筛选窗口');
            if (entries.some(entry => entry.name === cleanName && entry.id !== id)) throw new Error('已存在同名筛选，请选择它后更新，或使用其他名称');
            const entry = { id: id ?? uid(), name: cleanName, filter: conditions };
            this.data.savedFilters = id ? entries.map(value => value.id === id ? entry : value) : [...entries, entry];
            try { await this.persist(); } catch (error) { this.data.savedFilters = previous; throw error; }
            this.emit();
            return entry.id;
        });
    }
    deleteFilter(id: string): Promise<void> {
        return this.serial(async () => {
            const previous = this.data.savedFilters;
            this.data.savedFilters = (previous ?? []).filter(entry => entry.id !== id);
            try { await this.persist(); } catch (error) { this.data.savedFilters = previous; throw error; }
            this.emit();
        });
    }
    subscribe(callback: () => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
    private emit() { for (const callback of this.listeners)
        callback(); }
    private dateFor(path: string): string | null {
        const folder = this.settings.folder;
        const prefix = folder ? `${folder}/` : '';
        if (!path.startsWith(prefix) || !path.endsWith('.md'))
            return null;
        const name = path.slice(prefix.length, -3);
        const date = moment(name, this.settings.dateFormat, true);
        return date.isValid() && date.format(this.settings.dateFormat) === name ? date.format('YYYY-MM-DD') : null;
    }
    async refresh() {
        const generation = ++this.generation;
        const entries: Memo[] = [];
        const files = this.app.vault.getMarkdownFiles().filter(f => this.dateFor(f.path));
        // Bound concurrency: large iCloud vaults should not get hundreds of simultaneous reads.
        for (let start = 0; start < files.length; start += 16) {
            const batch = await Promise.all(files.slice(start, start + 16).map(async (file) => parseMemos(await this.app.vault.cachedRead(file), file.path, this.dateFor(file.path)!, this.settings)));
            for (const group of batch)
                entries.push(...group);
        }
        if (generation !== this.generation || this.stopped)
            return;
        this.memos = entries.filter(m => !deleted(m.raw)).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`) || b.line - a.line);
        for (const memo of this.memos)
            this.data.meta[memo.key] = legacyMeta(memo.raw);
        this.emit();
    }
    private async ensureFolder(path: string) {
        const parent = path.slice(0, path.lastIndexOf('/'));
        if (!path.includes('/') || !parent)
            return;
        let current = '';
        for (const part of parent.split('/')) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                try {
                    await this.app.vault.createFolder(current);
                }
                catch (e) {
                    if (!this.app.vault.getAbstractFileByPath(current))
                        throw e;
                }
            }
        }
    }
    private async ensureFile(path: string, date = moment()): Promise<TFile> {
        safePath(path);
        const found = this.app.vault.getAbstractFileByPath(path);
        if (found instanceof TFile)
            return found;
        if (found)
            throw new Error('保存路径被文件夹占用');
        await this.ensureFolder(path);
        let content = '';
        if (this.settings.template) {
            const t = this.app.vault.getAbstractFileByPath(this.settings.template.endsWith('.md') ? this.settings.template : `${this.settings.template}.md`);
            if (!(t instanceof TFile))
                throw new Error('找不到日记模板，请检查 Simple Memo 设置');
            content = (await this.app.vault.read(t)).replace(/\{\{date(?::([^}]+))?\}\}/g, (_, format: string | undefined) => date.format(format || this.settings.dateFormat)).replace(/\{\{time(?::([^}]+))?\}\}/g, (_, format: string | undefined) => date.format(format || this.settings.timeFormat)).replace(/\{\{title\}\}/g, date.format(this.settings.dateFormat));
        }
        try {
            return await this.app.vault.create(path, content);
        }
        catch (e) {
            const f = this.app.vault.getAbstractFileByPath(path);
            if (f instanceof TFile)
                return f;
            throw e;
        }
    }
    capture(content: string, task = this.settings.defaultTask) {
        return this.serial(async () => {
            if (!content.trim())
                throw new Error('请输入便签内容');
            const settings = validateSettings(this.settings);
            const now = moment();
            const path = normalizePath([settings.folder, `${now.format(settings.dateFormat)}.md`].filter(Boolean).join('/'));
            let body = `${settings.fixedPrefix}${content}${settings.fixedSuffix}`;
            if (settings.defaultTag.trim())
                body += `\n\n${settings.defaultTag.trim().split(/\s+/).map(t => t.startsWith('#') ? t : `#${t}`).join(' ')}`;
            const raw = withMemoBlockId(formatMemo(body, now.format(settings.timeFormat), task, settings), uid());
            const file = await this.ensureFile(path, now);
            await this.app.vault.process(file, source => insertMemo(source, raw, settings.insertHeading));
            await this.refreshAfterWrite();
        });
    }
    private async changeRaw(memo: Memo, raw: string | null) {
        const file = this.app.vault.getAbstractFileByPath(memo.path);
        if (!(file instanceof TFile))
            throw new Error('原日记已移动或删除，请刷新后重试');
        await this.app.vault.process(file, source => replaceMemo(source, memo, raw));
        await this.refreshAfterWrite();
    }
    private async refreshAfterWrite() { try {
        await this.refresh();
    }
    catch (e) {
        this.notifyError(new Error('笔记已保存，但刷新失败，请稍后刷新：' + String(e)));
    } }
    edit(memo: Memo, content: string) { return this.serial(async () => { if (!content.trim())
        throw new Error('便签内容不能为空'); await this.changeRaw(memo, editMemoRaw(memo, content)); }); }
    toggleTask(memo: Memo) { return this.serial(() => this.changeRaw(memo, toggleMemoRaw(memo, this.settings.appendCompletionDate ? moment().format('YYYY-MM-DD') : undefined))); }
    setMeta(memo: Memo, patch: MemoMeta) {
        return this.serial(async () => {
            let raw = editMemoRaw(memo, memo.content);
            for (const field of ['pinned', 'archived'] as const)
                if (patch[field] !== undefined) {
                    raw = transformMemoFields(raw, value => new RegExp(`^\\[${field}::`, 'i').test(value) ? '' : value);
                    if (patch[field])
                        raw = raw.replace(/^[^\r\n]*/, line => { const id = line.match(/ \^[\w-]+\s*$/)?.[0] ?? ''; return line.slice(0, line.length - id.length).trimEnd() + ` [${field}::true]` + id; });
                }
            await this.changeRaw(memo, raw);
        });
    }
    remove(memo: Memo) {
        return this.serial(async () => {
            const entry = { id: uid(), memo: { ...memo }, deletedAt: new Date().toISOString(), meta: { ...this.data.meta[memo.key] } };
            this.data.trash.push(entry);
            try {
                await this.persist();
            }
            catch (e) {
                this.data.trash = this.data.trash.filter(t => t.id !== entry.id);
                throw e;
            }
            try {
                await this.changeRaw(memo, null);
            }
            catch (e) {
                this.data.trash = this.data.trash.filter(t => t.id !== entry.id);
                await this.persist();
                throw e;
            }
            this.emit();
        });
    }
    restore(id: string) {
        return this.serial(async () => {
            const entry = this.data.trash.find(t => t.id === id);
            if (!entry)
                return;
            const file = await this.ensureFile(entry.memo.path, moment(entry.memo.date));
            await this.app.vault.process(file, source => {
                if (parseMemos(source, entry.memo.path, entry.memo.date, this.settings).some(m => m.raw.replace(/\r\n|\r/g, '\n') === entry.memo.raw.replace(/\r\n|\r/g, '\n')))
                    return source;
                if (entry.memo.blockId && new RegExp(`\\^${entry.memo.blockId}(?:\\s|$)`).test(source))
                    throw new Error('原文件中已存在相同块引用，请检查原文后再恢复');
                return insertMemo(source, entry.memo.raw, this.settings.insertHeading);
            });
            this.data.trash = this.data.trash.filter(t => t.id !== id);
            try {
                await this.persist();
            }
            catch (e) {
                this.data.trash.push(entry);
                await this.refreshAfterWrite();
                throw e;
            }
            await this.refreshAfterWrite();
        });
    }
    async importLegacyTrash() {
        if (this.data.legacyTrashImported)
            return;
        for (const file of this.app.vault.getMarkdownFiles()) {
            const date = this.dateFor(file.path);
            if (!date)
                continue;
            for (const memo of parseMemos(await this.app.vault.cachedRead(file), file.path, date, this.settings))
                if (deleted(memo.raw)) {
                    // A snapshot is imported; original Thino records remain untouched.
                    const raw = withMemoBlockId(transformMemoFields(memo.raw, field => /^\[deleted::/i.test(field) ? '' : field), uid());
                    const copy = parseMemos(raw, memo.path, date, this.settings)[0];
                    if (copy)
                        this.data.trash.push({ id: uid(), memo: copy, deletedAt: moment(date).toISOString(), legacy: true });
                }
        }
        const legacySettingsPath = `${this.app.vault.configDir}/plugins/obsidian-memos/data.json`;
        if (await this.app.vault.adapter.exists(legacySettingsPath)) {
            const thino = asRecord(JSON.parse(await this.app.vault.adapter.read(legacySettingsPath)) as unknown);
            const name = typeof thino.DeleteFileName === 'string' ? thino.DeleteFileName : 'delete';
            const path = normalizePath([this.settings.folder, `${safePath(name).replace(/\.md$/, '')}.md`].filter(Boolean).join('/'));
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile)
                for (const line of (await this.app.vault.cachedRead(file)).split(/\r?\n/)) {
                    const match = line.match(/^- (\d{12})\d{3}\s+(.*)$/);
                    if (!match)
                        continue;
                    const date = moment(match[1], 'YYYYMMDDHHmm', true);
                    if (!date.isValid())
                        continue;
                    const target = normalizePath([this.settings.folder, `${date.format(this.settings.dateFormat)}.md`].filter(Boolean).join('/'));
                    const raw = withMemoBlockId(formatMemo(match[2], date.format(this.settings.timeFormat), false, this.settings), uid());
                    const memo = parseMemos(raw, target, date.format('YYYY-MM-DD'), this.settings)[0];
                    if (memo)
                        this.data.trash.push({ id: uid(), memo, deletedAt: date.toISOString(), legacy: true });
                }
        }
        this.data.legacyTrashImported = true;
        await this.persist();
        this.emit();
    }
    async openSource(memo: Memo) { const file = this.app.vault.getAbstractFileByPath(memo.path); if (!(file instanceof TFile))
        throw new Error('原文件不存在'); const leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(file, { eState: { line: Math.max(0, memo.line - 1) } }); if (leaf.view instanceof MarkdownView)
        leaf.view.editor.setCursor({ line: Math.max(0, memo.line - 1), ch: 0 }); }
    async copyLink(memo: Memo) { await navigator.clipboard.writeText(memoLink(memo)); new Notice(memo.blockId ? '已复制块引用' : '已复制原日记链接（此便签无块 ID）'); }
    // eslint-disable-next-line no-control-regex -- Strip control characters from attachment file names.
    async attach(file: File) { const name = file.name.replace(/[\\/:*?"<>|[\]#^\x00-\x1f]/g, '-') || 'attachment'; const path = normalizePath(`附件/${Date.now()}-${uid()}-${name}`); await this.ensureFolder(path); const created = await this.app.vault.createBinary(path, await file.arrayBuffer()); return `${file.type.startsWith('image/') ? '!' : ''}[[${created.path}]]`; }
    saveQuickDraft(text: string) { this.data.quickDraft = text; window.clearTimeout(this.draftTimer); this.draftTimer = window.setTimeout(() => void this.persist().catch(e => this.notifyError(e)), 400); }
    saveDraft(text: string) { this.data.draft = text; window.clearTimeout(this.draftTimer); this.draftTimer = window.setTimeout(() => void this.persist().catch(e => this.notifyError(e)), 400); }
    async openView() { let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (!leaf) {
        leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    else if (!(leaf.view instanceof MemoView)) {
        await leaf.setViewState({ type: 'empty' });
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
    } await this.app.workspace.revealLeaf(leaf); }
}
class CaptureModal extends Modal {
    private clearSuggestions?: () => void;
    constructor(app: App, private plugin: SimpleMemoPlugin) { super(app); }
    onOpen() {
        this.titleEl.setText('随手记');
        const textarea = this.contentEl.createEl('textarea', { cls: 'st-quick-capture', attr: { placeholder: '记录此刻的想法…', rows: '7' } });
        textarea.value = this.plugin.data.quickDraft ?? '';
        this.clearSuggestions = attachSuggestions(this.app, this.plugin, textarea, this.scope);
        textarea.addEventListener('input', () => this.plugin.saveQuickDraft(textarea.value));
        let task = this.plugin.settings.defaultTask;
        let busy = false;
        const save = async () => { if (busy)
            return; busy = true; button.disabled = true; try {
            await this.plugin.capture(textarea.value, task);
            this.plugin.saveQuickDraft('');
            this.close();
            new Notice('已保存便签');
        }
        catch (e) {
            this.plugin.notifyError(e);
        }
        finally {
            busy = false;
            button.disabled = false;
        } };
        new Setting(this.contentEl).setName('作为任务').addToggle(t => t.setValue(task).onChange(v => { task = v; }));
        const actions = this.contentEl.createDiv({ cls: 'st-modal-actions' });
        addIndentAction(actions, textarea);
        const button = actions.createEl('button', { text: '保存 · ⌘/Ctrl + Enter', cls: 'mod-cta' });
        button.onclick = () => void save();
        registerSaveShortcut(this.scope, textarea, () => { void save(); });
        window.setTimeout(() => textarea.focus(), 50);
    }
    onClose() { this.clearSuggestions?.(); this.contentEl.empty(); }
}
class MemoSettingsTab extends PluginSettingTab {
    private renderId = 0;
    constructor(app: App, private plugin: SimpleMemoPlugin) { super(app, plugin); }
    display() {
        const renderId = ++this.renderId;
        const el = this.containerEl;
        el.empty();
        const save = async (key: keyof Settings, value: unknown) => { try {
            this.plugin.data.settings = validateSettings({ ...this.plugin.settings, [key]: value });
            this.plugin.settings = this.plugin.data.settings;
            await this.plugin.persist();
            await this.plugin.refresh();
        }
        catch (e) {
            this.plugin.notifyError(e);
        } };
        const text = (key: keyof Settings, name: string, desc: string) => new Setting(el).setName(name).setDesc(desc).addText(t => { t.setValue(String(this.plugin.settings[key])); t.inputEl.addEventListener('change', () => void save(key, t.getValue().trim())); });
        text('folder', '日记目录', '笔记库内相对目录；留空表示根目录。');
        text('dateFormat', '日期格式', '例如 YYYY-MM-DD 或 YYYY/MM/DD。');
        text('template', '日记模板', '可选模板路径，支持 {{date}}、{{time}}、{{title}}。');
        new Setting(el).setName('时间格式').addDropdown(d => d.addOptions({ 'HH:mm': 'HH:mm', 'HH:mm:ss': 'HH:mm:ss' }).setValue(this.plugin.settings.timeFormat).onChange(v => void save('timeFormat', v)));
        text('processHeading', '读取标题', '留空读取整篇日记；示例 ## 便签。');
        text('insertHeading', '写入标题', '留空追加到日记末尾；标题不存在时自动创建。');
        text('defaultTag', '默认标签', '可填多个标签，用空格分隔。');
        text('saveLabel', '记录按钮文字', '例如 记录、NOTE。');
        text('fixedPrefix', '固定前缀', '每条新便签开头添加的文字。');
        text('fixedSuffix', '固定后缀', '每条新便签结尾添加的文字。');
        new Setting(el).setName('每日目标').addText(t => { t.setValue(String(this.plugin.settings.dailyTarget)); t.inputEl.type = 'number'; t.inputEl.addEventListener('change', () => void save('dailyTarget', Number(t.getValue()))); });
        new Setting(el).setName('编辑器位置').addDropdown(d => d.addOptions({ top: '顶部', bottom: '底部' }).setValue(this.plugin.settings.editorPosition).onChange(v => void save('editorPosition', v)));
        const toggles: [
            keyof Settings,
            string
        ][] = [['defaultTask', '默认保存为任务'], ['hideDone', '隐藏已完成任务'], ['appendCompletionDate', '完成任务时追加日期'], ['showDate', '显示日期'], ['showTime', '显示时间'], ['showSource', '显示来源文件'], ['showSidebar', '宽窗口默认显示日历与标签'], ['autoOpen', '启动时打开便签'], ['focusEditor', '打开时聚焦编辑器']];
        for (const [key, name] of toggles)
            new Setting(el).setName(name).addToggle(t => t.setValue(Boolean(this.plugin.settings[key])).onChange(v => void save(key, v)));
        void this.renderImport(el, renderId).catch(e => this.plugin.notifyError(e));
    }
    hide() { this.renderId++; }
    private async renderImport(el: HTMLElement, renderId: number) {
        const path = `${this.app.vault.configDir}/plugins/obsidian-memos/data.json`;
        if (!await this.app.vault.adapter.exists(path) || renderId !== this.renderId)
            return;
        const details = el.createEl('details', { cls: 'st-settings-import' });
        details.createEl('summary', { text: '从 Thino 导入设置' });
        new Setting(details).setName('导入配置').setDesc('替换当前设置。').addButton(b => b.setButtonText('导入').onClick(async () => {
            b.setDisabled(true);
            try {
                await this.plugin.reimportSettings();
                const warnings = this.plugin.data.imported?.warnings ?? [];
                new Notice(['已导入设置', ...warnings].join('\n'), warnings.length ? 10000 : 4000);
                this.display();
            } catch (e) {
                this.plugin.notifyError(e);
            } finally {
                b.setDisabled(false);
            }
        }));
        for (const message of this.plugin.data.imported?.warnings ?? [])
            details.createEl('p', { text: message, cls: 'mod-warning' });
    }
}
