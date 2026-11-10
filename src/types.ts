export interface Settings {
    storageMode: 'daily' | 'file' | 'multi';
    singleFile: string;
    multiFolder: string;
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
    storage?: {
        mode: 'file' | 'multi';
        id: string;
        createdAt: string;
        deletedAt: string;
        pinned: boolean;
        archived: boolean;
    };
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
    storagePaths?: { singleFile: string; multiFolder: string };
    source: string;
    importedAt: string;
    mapped: string[];
    warnings: string[];
}
export type MemoFeed = 'all' | 'today' | 'tasks' | 'pinned' | 'archived' | 'trash';
export interface MemoFilter {
    feed: MemoFeed;
    text: string;
    tags: string[];
    status: 'any' | 'open' | 'done' | 'note';
    period: 'all' | 'custom' | 'today' | 'last7' | 'thisWeek' | 'thisMonth';
    from: string;
    to: string;
    oldestFirst: boolean;
}
export interface SavedFilter {
    id: string;
    name: string;
    filter: MemoFilter;
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
    savedFilters?: SavedFilter[];
}
export interface MemoController {
    settings: Settings;
    data: PluginData;
    list(): Memo[];
    listTrash(): TrashEntry[];
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
    saveFilter(name: string, filter: MemoFilter, id?: string): Promise<string>;
    deleteFilter(id: string): Promise<void>;
    refresh(): Promise<void>;
}
