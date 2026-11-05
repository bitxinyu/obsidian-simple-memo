export interface Settings {
    folder: string;
    dateFormat: string;
    timeFormat: string;
    template: string;
    processHeading: string;
    insertHeading: string;
    defaultTask: boolean;
    defaultTag: string;
    username: string;
    saveLabel: string;
    editorPosition: 'top' | 'bottom';
    showTime: boolean;
    showDate: boolean;
    hideDone: boolean;
    showSource: boolean;
    showSidebar: boolean;
    autoOpen: boolean;
    focusEditor: boolean;
    appendCompletionDate: boolean;
    dailyTarget: number;
    weekStart: number;
    fixedPrefix: string;
    fixedSuffix: string;
}
export interface Memo {
    key: string;
    path: string;
    date: string;
    time: string;
    content: string;
    raw: string;
    start: number;
    end: number;
    line: number;
    task: 'open' | 'done' | null;
    tags: string[];
    blockId?: string;
}
export interface MemoMeta {
    pinned?: boolean;
    archived?: boolean;
}
export interface TrashEntry {
    id: string;
    memo: Memo;
    deletedAt: string;
    meta?: MemoMeta;
    legacy?: boolean;
}
export interface ImportReport {
    source: string;
    importedAt: string;
    mapped: string[];
    warnings: string[];
}
export interface PluginData {
    version: 1;
    settings: Settings;
    imported?: ImportReport;
    meta: Record<string, MemoMeta>;
    trash: TrashEntry[];
    draft: string;
    quickDraft?: string;
    legacyTrashImported?: boolean;
}
export interface MemoController {
    settings: Settings;
    data: PluginData;
    list(): Memo[];
    subscribe(callback: () => void): () => void;
    capture(content: string, task?: boolean): Promise<void>;
    edit(memo: Memo, content: string): Promise<void>;
    toggleTask(memo: Memo): Promise<void>;
    setMeta(memo: Memo, patch: MemoMeta): Promise<void>;
    remove(memo: Memo): Promise<void>;
    restore(id: string): Promise<void>;
    openSource(memo: Memo): Promise<void>;
    copyLink(memo: Memo): Promise<void>;
    attach(file: File): Promise<string>;
    saveDraft(text: string): void;
    refresh(): Promise<void>;
}
