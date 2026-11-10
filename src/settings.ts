import type { Settings, ImportReport } from './types';
export const defaultSettings: Settings = {
    storageMode: 'daily', singleFile: 'memo.md', multiFolder: 'Memo',
    folder: 'Journal', dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm', template: '',
    processHeading: '', insertHeading: '', defaultTask: false, defaultTag: '',
    username: '', saveLabel: '记录', editorPosition: 'top', showTime: true, showDate: true,
    hideDone: false, showSource: false, showSidebar: true, autoOpen: false, focusEditor: true,
    appendCompletionDate: false, dailyTarget: 5, weekStart: 0, fixedPrefix: '', fixedSuffix: '',
};
export function safePath(value: string): string {
    const p = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    // eslint-disable-next-line no-control-regex -- Control characters are invalid in vault paths.
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(s => s === '..' || s === '.') || /[\x00-\x1f]/.test(p))
        throw new Error('路径必须是笔记库内的相对路径，且不能包含 ..');
    return p;
}
export function validateSettings(s: Settings): Settings {
    const result = { ...s, folder: safePath(s.folder), template: safePath(s.template) };
    result.singleFile = safePath(s.singleFile);
    result.multiFolder = safePath(s.multiFolder);
    if (!result.singleFile.endsWith('.md') || !result.multiFolder ||
        [result.singleFile, result.multiFolder].some(path => path.split('/').some(part => !part || part.startsWith('.'))))
        throw new Error('单文件须为笔记库内的 .md 文件，多文件目录须为可见且非空的目录。');
    if (result.singleFile === result.multiFolder || result.multiFolder.startsWith(result.singleFile + '/'))
        throw new Error('单文件路径不能同时作为文件夹使用。');
    if (!['daily', 'file', 'multi'].includes(result.storageMode))
        throw new Error('未知的便签保存方式');
    if (!s.dateFormat.trim() || !/Y/.test(s.dateFormat) || !/M/.test(s.dateFormat) || !/D/.test(s.dateFormat))
        throw new Error('日期格式需要包含年、月、日，例如 YYYY-MM-DD');
    safePath(s.dateFormat);
    if (!['HH:mm', 'HH:mm:ss'].includes(s.timeFormat))
        throw new Error('时间格式仅支持 HH:mm 或 HH:mm:ss');
    if (!Number.isFinite(s.dailyTarget) || s.dailyTarget < 1 || s.dailyTarget > 10000)
        throw new Error('每日目标应为 1–10000');
    if (!['top', 'bottom'].includes(s.editorPosition))
        result.editorPosition = 'top';
    return result;
}
export function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function importThinoSettings(thino: Record<string, unknown>, daily: Record<string, unknown> = {}, periodic: Record<string, unknown> = {}): {
    settings: Settings;
    report: ImportReport;
} {
    const settings = { ...defaultSettings };
    const mapped: string[] = [];
    const warnings: string[] = [];
    const map = <K extends keyof Settings>(source: string, target: K, transform: (value: unknown) => Settings[K]) => {
        if (thino[source] !== undefined && thino[source] !== null) {
            settings[target] = transform(thino[source]);
            mapped.push(source);
        }
    };
    const journalSettings = asRecord(thino.JournalSettings);
    let journal = thino.UseDailyOrPeriodic === 'Periodic' ? asRecord(periodic.daily ?? daily) : daily;
    const independent = journalSettings.useIndependentSettings;
    if (independent && journalSettings.daily)
        journal = asRecord(journalSettings.daily);
    for (const [from, to] of [['folder', 'folder'], ['format', 'dateFormat'], ['template', 'template']] as const) {
        if (typeof journal[from] === 'string' && (journal[from] || from !== 'format'))
            settings[to] = journal[from];
    }
    // Core daily notes defaults to the vault root if no folder is configured.
    if (journal.folder === undefined)
        settings.folder = '';
    mapped.push(independent ? 'JournalSettings.daily' : 'Daily/Periodic Notes');
    const stringKeys: Record<string, keyof Settings> = { UserName: 'username', SaveMemoButtonLabel: 'saveLabel', DefaultTimePrefix: 'timeFormat', ProcessEntriesBelow: 'processHeading', InsertAfter: 'insertHeading' };
    for (const [from, to] of Object.entries(stringKeys))
        map(from, to, String);
    const boolKeys: Record<string, keyof Settings> = { ShowTime: 'showTime', ShowDate: 'showDate', HideDoneTasks: 'hideDone', ShowSourcePath: 'showSource', ShowLeftSideBar: 'showSidebar', OpenMemosAutomatically: 'autoOpen', FocusOnEditor: 'focusEditor', AppendDateWhenTaskDone: 'appendCompletionDate' };
    for (const [from, to] of Object.entries(boolKeys))
        if (typeof thino[from] === 'boolean')
            map(from, to, Boolean);
    map('DefaultPrefix', 'defaultTask', v => /task|todo/i.test(String(v)));
    map('DefaultEditorLocation', 'editorPosition', v => String(v).toLowerCase() === 'bottom' ? 'bottom' : 'top');
    map('StartDate', 'weekStart', v => v === 'Monday' ? 1 : 0);
    if (Number.isFinite(Number(thino.MemoDailyTarget)))
        map('MemoDailyTarget', 'dailyTarget', v => Math.max(1, Math.min(10000, Number(v))));
    if (thino.UseMemoFixedStrings) {
        map('MemoFixedPrefix', 'fixedPrefix', String);
        map('MemoFixedSuffix', 'fixedSuffix', String);
    }
    if (!['HH:mm', 'HH:mm:ss'].includes(settings.timeFormat)) {
        warnings.push(`时间格式 ${settings.timeFormat} 暂不支持，使用 HH:mm。`);
        settings.timeFormat = 'HH:mm';
    }
    // Preserve the original locations for reading even when new memos go elsewhere.
    settings.singleFile = 'basic.thino.md';
    settings.multiFolder = 'Thino';
    const locations = asRecord(thino.MemoOtherSaveLocation);
    for (const [from, to] of [['MemoDefaultSingleFilePath', 'singleFile'], ['MemoDefaultMultiFilePath', 'multiFolder']] as const) {
        if (typeof locations[from] !== 'string' || !locations[from]) continue;
        try {
            settings[to] = validateSettings({ ...settings, [to]: locations[from] })[to];
            mapped.push(from);
        } catch { warnings.push(`未导入无效路径：${from}`); }
    }
    const enabled = thino.EnabledLocationList;
    const mode = Array.isArray(enabled) && enabled.length === 1 ? asRecord(enabled[0]).value ?? thino.MemoSaveLocation : thino.MemoSaveLocation;
    if (mode === 'FILE' || mode === 'MULTI') {
        settings.storageMode = mode === 'FILE' ? 'file' : 'multi';
        mapped.push('MemoSaveLocation');
    } else if (mode && mode !== 'DAILY' && mode !== 'JOURNAL') {
        warnings.push('未支持此保存来源，新便签将写入日记。');
    }
    if (journalSettings.granularity && journalSettings.granularity !== 'day')
        warnings.push('周/月/年日记尚不支持，仅导入每日笔记设置。');
    if (thino.DefaultMemoComposition && thino.DefaultMemoComposition !== '{TIME} {CONTENT}')
        warnings.push('自定义便签组合模板未导入，使用标准时间戳列表格式。');
    if (thino.FetchMemosFromNote)
        warnings.push('任意笔记中的标签抓取尚不支持。');
    if (thino.addTagAutomatically)
        warnings.push('自动添加标签规则未导入，可在设置中指定默认标签。');
    if (thino.UseButtonToShowEditor)
        warnings.push('编辑器默认直接显示。');
    return { settings: validateSettings(settings), report: { storagePaths: { singleFile: settings.singleFile, multiFolder: settings.multiFolder }, source: 'obsidian-memos/data.json', importedAt: new Date().toISOString(), mapped, warnings } };
}
