import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '../src/settings';
import { parseMemos } from '../src/core';
import { emptyFilter } from '../src/filters';
import type SimpleMemoPlugin from '../src/main';
import type { PluginData } from '../src/types';

// Bundle the production controller with only its Obsidian UI boundary replaced.
// The vault below implements atomic process callbacks and injectable I/O failures.
const loadPlugin = (async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['moment'],
    plugins: [{ name: 'obsidian-test-boundary', setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
      builder.onResolve({ filter: /^\.\/view$/ }, () => ({ path: 'view', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'view'
        ? 'export const VIEW_TYPE="test-memos"; export class MemoView {} export function addIndentAction() {} export function registerSaveShortcut() {}'
        : `export { default as moment } from 'moment';
           export class Plugin {
             constructor(app) { this.app=app; }
             loadData() { return this.app.loadData(); }
             saveData(data) { return this.app.saveData(data); }
             registerView(type) { this.app.views.push(type); }
             addRibbonIcon() {} addCommand() {} addSettingTab() {} registerEvent() {}
           }
           export class TFile { static [Symbol.hasInstance](value) { return value?.__file === true; } }
           export class Modal {} export class PluginSettingTab {} export class MarkdownView {}
           export class Notice {} export class Setting {} export class App {}
           export const normalizePath = path => path.replace(/\\\\/g, '/').replace(/\\/+/g, '/');`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'js' }));
    } }],
  });
  const module = { exports: {} as { default: new (app: unknown) => SimpleMemoPlugin } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports.default;
})();

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const journalPath = 'Journal/2026-10-22.md';
type FakeFile = { __file: true; path: string; extension: string; stat: { ctime: number } };

async function fixture(source = '') {
  const PluginClass = await loadPlugin;
  const state = {
    contents: new Map<string, string>(), files: new Map<string, FakeFile>(), folders: new Set(['Journal']),
    durable: undefined as PluginData | undefined, saves: [] as PluginData[], notices: [] as string[],
    views: [] as string[], adapterReads: [] as string[], failAdapterRead: false,
    failRead: false, failProcess: false, failSave: false, processDelay: 0, activeProcesses: 0, maxProcesses: 0,
  };
  const addFile = (path: string, content: string) => {
    const file: FakeFile = { __file: true, path, extension: 'md', stat: { ctime: new Date(2025, 0, 2, 3, 4, 5).valueOf() } };
    state.files.set(path, file); state.contents.set(path, content); return file;
  };
  if (source) addFile(journalPath, source);
  const vault = {
    configDir: '.obsidian',
    adapter: {
      async exists(path: string) { return state.contents.has(path); },
      async read(path: string) {
        state.adapterReads.push(path);
        if (state.failAdapterRead) throw new Error('injected adapter read failure');
        if (!state.contents.has(path)) throw new Error(`missing file: ${path}`);
        return state.contents.get(path)!;
      },
    },
    on() { return {}; },
    getMarkdownFiles: () => [...state.files.values()],
    getAbstractFileByPath: (path: string) => state.files.get(path) ?? (state.folders.has(path) ? { path } : null),
    async createFolder(path: string) { state.folders.add(path); },
    async create(path: string, content: string) {
      if (state.files.has(path)) throw new Error('already exists');
      return addFile(path, content);
    },
    async read(file: FakeFile) { return state.contents.get(file.path)!; },
    async cachedRead(file: FakeFile) {
      if (state.failRead) throw new Error('injected read failure');
      return state.contents.get(file.path)!;
    },
    async process(file: FakeFile, transform: (source: string) => string) {
      if (state.failProcess) throw new Error('injected process failure');
      state.activeProcesses++; state.maxProcesses = Math.max(state.maxProcesses, state.activeProcesses);
      try {
        const before = state.contents.get(file.path)!;
        if (state.processDelay) await new Promise(resolve => setTimeout(resolve, state.processDelay));
        const after = transform(before); state.contents.set(file.path, after); return after;
      } finally { state.activeProcesses--; }
    },
  };
  const app = { vault, views: state.views, workspace: { onLayoutReady() {} },
    async loadData() { return state.durable ? clone(state.durable) : null; },
    async saveData(data: PluginData) {
    if (state.failSave) { state.failSave = false; throw new Error('injected save failure'); }
    state.durable = clone(data); state.saves.push(clone(data));
  } };
  const createPlugin = (saved?: PluginData) => {
    const plugin = new PluginClass(app);
    plugin.data = saved ? clone(saved) : { version: 1, settings: { ...defaultSettings }, meta: {}, trash: [], draft: '' };
    plugin.settings = plugin.data.settings;
    plugin.notifyError = error => { state.notices.push(String(error)); };
    return plugin;
  };
  const plugin = createPlugin();
  await plugin.refresh();
  return { plugin, state, createPlugin, vault };
}

test('first load migrates all legacy plugin data to the new identity without changing old files', async () => {
  const { plugin, state, createPlugin, vault } = await fixture('- 09:00 recover me ^rename-recovery\n');
  await plugin.remove(plugin.list()[0]);
  plugin.data.settings.folder = 'Daily';
  plugin.data.draft = 'unfinished memo\nsecond line';
  plugin.data.quickDraft = 'unfinished quick capture';
  plugin.data.legacyTrashImported = true;
  plugin.data.meta['saved-key'] = { pinned: true };
  const expected = clone(plugin.data);
  vault.configDir = '.custom-obsidian';
  const legacyPath = `${vault.configDir}/plugins/simple-thino/data.json`;
  state.contents.set(legacyPath, JSON.stringify(expected));
  const originals = new Map(state.contents);
  state.durable = undefined;
  state.saves.length = 0;

  const migrated = createPlugin();
  await migrated.onload();
  assert.deepEqual(migrated.data, expected);
  assert.deepEqual(migrated.settings, expected.settings);
  assert.deepEqual(state.durable, expected, 'migration must be persisted before the plugin becomes usable');
  assert.equal(state.saves.length, 1);
  assert.deepEqual(state.contents, originals, 'legacy data and journal files are read-only during migration');
  assert.deepEqual(state.adapterReads, [legacyPath]);

  state.contents.set(legacyPath, 'invalid obsolete data');
  await createPlugin().onload();
  assert.equal(state.saves.length, 1, 'subsequent loads must use the new data instead of reimporting');
});

test('current plugin data takes precedence over legacy data', async () => {
  const { plugin, state, createPlugin } = await fixture();
  plugin.data.draft = 'current draft';
  state.durable = clone(plugin.data);
  state.contents.set('.obsidian/plugins/simple-thino/data.json', 'invalid obsolete data');
  const current = createPlugin();
  await current.onload();
  assert.equal(current.data.draft, 'current draft');
  assert.deepEqual(state.adapterReads, []);
  assert.equal(state.saves.length, 0);
});

test('a fresh installation initializes defaults when no legacy plugin data exists', async () => {
  const { state, createPlugin } = await fixture();
  const fresh = createPlugin();
  await fresh.onload();
  assert.deepEqual(fresh.settings, defaultSettings);
  assert.deepEqual(state.durable, clone(fresh.data));
});

test('invalid legacy data blocks initialization instead of overwriting recovery data with defaults', async () => {
  for (const raw of ['{broken', 'null', '{"version":2}', '{"version":1,"settings":{"folder":"../outside"}}']) {
    const { state, createPlugin } = await fixture();
    const path = '.obsidian/plugins/simple-thino/data.json';
    state.contents.set(path, raw);
    await assert.rejects(createPlugin().onload());
    assert.equal(state.contents.get(path), raw);
    assert.equal(state.durable, undefined);
    assert.equal(state.saves.length, 0);
    assert.deepEqual(state.views, [], 'failed migration must not register a usable view');
  }
});

test('failed legacy reads leave data untouched and allow retry', async () => {
  const { plugin, state, createPlugin } = await fixture();
  const path = '.obsidian/plugins/simple-thino/data.json';
  const raw = JSON.stringify(plugin.data);
  state.contents.set(path, raw);
  state.failAdapterRead = true;
  await assert.rejects(createPlugin().onload(), /adapter read failure/);
  assert.equal(state.contents.get(path), raw);
  assert.equal(state.durable, undefined);
  state.failAdapterRead = false;
  await createPlugin().onload();
  assert.deepEqual(state.durable, plugin.data);
});

test('failed migration persistence prevents activation and can be retried from intact legacy data', async () => {
  const { plugin, state, createPlugin } = await fixture();
  const path = '.obsidian/plugins/simple-thino/data.json';
  const raw = JSON.stringify(plugin.data);
  state.contents.set(path, raw);
  state.failSave = true;
  await assert.rejects(createPlugin().onload(), /save failure/);
  assert.equal(state.contents.get(path), raw);
  assert.equal(state.durable, undefined);
  assert.deepEqual(state.views, []);
  await createPlugin().onload();
  assert.deepEqual(state.durable, plugin.data);
});

test('a post-delete refresh failure retains the durable recovery snapshot', async () => {
  const source = '- 09:00 valuable note ^unique-one\n';
  const { plugin, state } = await fixture(source);
  const memo = plugin.list()[0];
  state.failRead = true;
  await plugin.remove(memo);
  assert.equal(state.contents.get(journalPath), '\n');
  assert.equal(plugin.data.trash.length, 1);
  assert.equal(plugin.data.trash[0].memo.raw, memo.raw);
  assert.equal(state.durable?.trash[0].memo.raw, memo.raw);
  assert.match(state.notices.join('\n'), /已保存.*刷新失败/);
});

test('a failed atomic deletion leaves source intact and rolls back the unused trash record', async () => {
  const source = '- 09:00 untouched note ^unique-two\n';
  const { plugin, state } = await fixture(source);
  state.failProcess = true;
  await assert.rejects(plugin.remove(plugin.list()[0]), /process failure/);
  assert.equal(state.contents.get(journalPath), source);
  assert.equal(plugin.data.trash.length, 0);
  assert.equal(state.durable?.trash.length, 0);
  assert.equal(state.saves[0].trash.length, 1, 'backup must be persisted before attempting source deletion');
});

test('failed backup persistence prevents source deletion entirely', async () => {
  const source = '- 09:00 important note ^unique-three\n';
  const { plugin, state } = await fixture(source);
  state.failSave = true;
  await assert.rejects(plugin.remove(plugin.list()[0]), /save failure/);
  assert.equal(state.contents.get(journalPath), source);
  assert.equal(plugin.data.trash.length, 0);
});

test('concurrent captures are serialized and retain both notes with unique block IDs', async () => {
  const { plugin, state } = await fixture();
  state.processDelay = 10;
  await Promise.all([plugin.capture('first\nsecond line'), plugin.capture('another note')]);
  assert.equal(state.maxProcesses, 1);
  const notes = plugin.list();
  assert.equal(notes.length, 2);
  assert.deepEqual(new Set(notes.map(note => note.content)), new Set(['first\nsecond line', 'another note']));
  assert.equal(new Set(notes.map(note => note.blockId)).size, 2);
  assert.ok(notes.every(note => note.raw.split('\n')[0].endsWith(`^${note.blockId}`)));
});

test('restore retries after a settings-save failure do not duplicate the restored note', async () => {
  const source = '- 09:00 recover me ^unique-four\n';
  const { plugin, state, createPlugin } = await fixture(source);
  await plugin.remove(plugin.list()[0]);
  const id = plugin.data.trash[0].id;
  state.failSave = true;
  await assert.rejects(plugin.restore(id), /save failure/);
  assert.equal(parseMemos(state.contents.get(journalPath)!, journalPath, '2026-10-22', defaultSettings).length, 1);
  assert.equal(state.durable?.trash.length, 1, 'disk still contains the pre-restore recovery record');
  const restarted = createPlugin(state.durable);
  await restarted.restore(id);
  assert.equal(parseMemos(state.contents.get(journalPath)!, journalPath, '2026-10-22', defaultSettings).length, 1);
  assert.equal(state.durable?.trash.length, 0);
});

test('restore retry matches a complete legacy entry after LF to CRLF conversion', async () => {
  const { plugin, state, createPlugin } = await fixture('- 09:00 legacy note\n\tsecond line\n');
  await plugin.remove(plugin.list()[0]);
  const id = plugin.data.trash[0].id;
  state.contents.set(journalPath, '# Journal\r\n');
  state.failSave = true;
  await assert.rejects(plugin.restore(id), /save failure/);
  assert.match(state.contents.get(journalPath)!, /legacy note\r\n\tsecond line/);
  const restarted = createPlugin(state.durable);
  await restarted.restore(id);
  const entries = parseMemos(state.contents.get(journalPath)!, journalPath, '2026-10-22', defaultSettings);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, 'legacy note\nsecond line');
  assert.equal(state.durable?.trash.length, 0);
});

test('restoration does not mistake a raw prefix in another memo for a complete restored entry', async () => {
  const { plugin, state } = await fixture('- 09:00 legacy note\n');
  await plugin.remove(plugin.list()[0]);
  state.contents.set(journalPath, '- 09:00 legacy note extended by user\n');
  await plugin.restore(plugin.data.trash[0].id);
  assert.deepEqual(new Set(plugin.list().map(memo => memo.content)), new Set(['legacy note', 'legacy note extended by user']));
});

test('capturing a fenced snippet keeps its ID on the timestamp line and allows later captures', async () => {
  const { plugin } = await fixture();
  const content = '```ts\nconst answer = 42;\n```';
  await plugin.capture(content);
  const memo = plugin.list()[0];
  assert.equal(memo.content, content);
  assert.match(memo.raw.split('\n')[0], /^- \d\d:\d\d \^st-[a-f0-9]+$/);
  assert.equal(memo.raw.split('\n')[1], '\t');
  assert.equal(memo.raw.split('\n')[2], '\t```ts');
  assert.ok(memo.raw.endsWith('\n\t```'));
  await plugin.capture('after the snippet');
  assert.equal(plugin.list().length, 2);
});

test('default tags follow a fenced snippet on their own line without changing the closing fence', async () => {
  const { plugin } = await fixture();
  plugin.settings.defaultTag = 'work #review';
  const content = '```ts\nconst answer = 42;\n```';
  await plugin.capture(content);
  const memo = plugin.list()[0];
  assert.equal(memo.content, content + '\n\n#work #review');
  assert.deepEqual(memo.tags, ['work', 'review']);
  await plugin.capture('another note');
  assert.equal(plugin.list().length, 2);
});

test('literal code samples cannot hide, archive or pin a memo and survive metadata updates', async () => {
  const { plugin } = await fixture();
  const content = '```text\n[deleted::true]\n[archived::true]\n[pinned::true]\n^example\n```';
  await plugin.capture(content);
  assert.equal(plugin.list().length, 1);
  const memo = plugin.list()[0];
  assert.equal(memo.content, content);
  assert.notEqual(memo.blockId, 'example');
  assert.deepEqual(plugin.data.meta[memo.key], { pinned: false, archived: false });
  await plugin.setMeta(memo, { archived: true });
  const archived = plugin.list()[0];
  assert.equal(archived.content, content);
  assert.equal(plugin.data.meta[archived.key].archived, true);
  await plugin.setMeta(archived, { archived: false });
  assert.equal(plugin.list()[0].content, content);
  assert.equal(plugin.data.meta[plugin.list()[0].key].archived, false);
});

test('saved filters survive reload and updates without changing journal content or drafts', async () => {
  const { plugin, state, createPlugin } = await fixture('- 09:00 original #工作 ^original\n');
  const notes = new Map(state.contents);
  plugin.data.draft = '未完成的草稿';
  const filter = { ...emptyFilter(), tags: ['工作'], period: 'thisWeek' as const };
  const id = await plugin.saveFilter('本周工作', filter);
  filter.tags.push('不应该改变已保存的筛选');
  const reloaded = createPlugin();
  await reloaded.onload();
  assert.equal(reloaded.data.savedFilters?.[0].id, id);
  assert.deepEqual(reloaded.data.savedFilters?.[0].filter.tags, ['工作']);
  assert.equal(reloaded.data.draft, '未完成的草稿');
  await reloaded.saveFilter('本周未完成', { ...emptyFilter(), status: 'open', period: 'thisWeek' }, id);
  assert.equal(state.durable?.savedFilters?.length, 1);
  assert.equal(state.durable?.savedFilters?.[0].filter.status, 'open');
  assert.deepEqual(state.contents, notes);
  await reloaded.deleteFilter(id);
  assert.deepEqual(state.durable?.savedFilters, []);
  assert.deepEqual(state.contents, notes);
});

test('failed preset writes roll back in memory and can be retried', async () => {
  const { plugin, state } = await fixture();
  state.failSave = true;
  await assert.rejects(plugin.saveFilter('工作', emptyFilter()));
  assert.equal(plugin.data.savedFilters, undefined);
  const id = await plugin.saveFilter('工作', emptyFilter());
  const previous = clone(plugin.data.savedFilters);
  state.failSave = true;
  await assert.rejects(plugin.saveFilter('改名', emptyFilter(), id));
  assert.deepEqual(plugin.data.savedFilters, previous);
  state.failSave = true;
  await assert.rejects(plugin.deleteFilter(id));
  assert.deepEqual(plugin.data.savedFilters, previous);
});

test('concurrent preset saves retain all entries and reject duplicate names', async () => {
  const { plugin, state } = await fixture();
  await Promise.all([plugin.saveFilter('甲', emptyFilter()), plugin.saveFilter('乙', emptyFilter())]);
  assert.equal(state.durable?.savedFilters?.length, 2);
  await assert.rejects(plugin.saveFilter('甲', emptyFilter()), /同名/);
  await assert.rejects(plugin.saveFilter('无效', emptyFilter(), 'deleted'), /已被删除/);
  assert.equal(plugin.data.savedFilters?.length, 2);
});

test('Thino single files round-trip in place and ignore callout examples in code fences', async () => {
  const { plugin, state, vault } = await fixture('- 09:00 daily\n');
  const path = 'Archive/basic.thino.md';
  const header = '> [!thino] 2025/04/05 18:16:15 %% [id::abc123] [webId::keep] [thinoType::TASK-TODO] %%';
  const prefix = '# 2025-04-05\r\n\r\n~~~md\r\n' + header + '\r\n> example\r\n~~~\r\n\r\n';
  const suffix = '\r\n\r\n# After\r\nkeep\r\n';
  await vault.create(path, prefix + header + '\r\n> first\r\n> \r\n> > quote' + suffix);
  await plugin.refresh();
  const memo = () => plugin.list().find(m => m.path === path)!;
  assert.equal(plugin.list().length, 2);
  assert.equal(memo().content, 'first\n\n> quote');
  assert.equal(memo().date + ' ' + memo().time, '2025-04-05 18:16:15');
  await plugin.edit(memo(), 'changed\n\n> quote\n#标签');
  assert.deepEqual(memo().tags, ['标签']);
  await plugin.toggleTask(memo());
  await plugin.setMeta(memo(), { pinned: true, archived: true });
  assert.equal(memo().task, 'done');
  assert.deepEqual(plugin.data.meta[memo().key], { pinned: true, archived: true });
  await plugin.remove(memo());
  assert.equal(memo(), undefined);
  assert.match(state.contents.get(path)!, /\[deleted::\d{14}\]/);
  await plugin.restore(plugin.listTrash()[0].id);
  assert.equal(plugin.listTrash().length, 0);
  assert.equal(memo().content, 'changed\n\n> quote\n#标签');
  assert.ok(state.contents.get(path)!.startsWith(prefix));
  assert.ok(state.contents.get(path)!.endsWith(suffix));
  assert.match(memo().raw, /\[webId::keep\]/);
  const stale = memo();
  state.contents.set(path, state.contents.get(path)!.replace('> changed', '> externally changed'));
  await assert.rejects(plugin.edit(stale, 'would overwrite'), /修改/);
  await plugin.refresh();
  state.contents.set(path, state.contents.get(path)! + '\n' + header + '\n> duplicate id');
  await assert.rejects(plugin.remove(memo()), /标识重复/);
});

test('multi-file metadata changes preserve unrelated YAML, Markdown and concurrent edits', async () => {
  const { plugin, state, vault } = await fixture();
  const path = 'Thino/sub/existing.md';
  const extra = '# properties\r\ncustom: {original: "0001"}\r\ntags: [one, two]\r\n';
  const original = '---\r\n' + extra + 'id: abc\r\ncreatedAt: 20250405181615\r\nupdatedAt: "2025/04/05 18:16:15" # keep comment\r\nthinoType: TASK-TODO\r\n---\r\n';
  const body = '正文 #三\r\n\r\n---\r\n\r\n> end\r\n';
  await vault.create(path, original + body);
  await vault.create('Thino-unrelated/note.md', 'unrelated');
  await plugin.refresh();
  const memo = () => plugin.list()[0];
  assert.equal(plugin.list().length, 1);
  assert.equal(memo().date + ' ' + memo().time, '2025-04-05 18:16:15');
  assert.deepEqual(memo().tags, ['三', 'one', 'two']);
  await plugin.toggleTask(memo());
  await plugin.setMeta(memo(), { pinned: true, archived: true });
  await plugin.remove(memo());
  assert.equal(plugin.list().length, 0);
  await plugin.restore(plugin.listTrash()[0].id);
  assert.equal(memo().task, 'done');
  const raw = state.contents.get(path)!;
  assert.ok(raw.startsWith('---\r\n' + extra));
  assert.ok(raw.endsWith(body));
  assert.match(raw, / # keep comment\r\n/);
  assert.match(raw, /rowStatus: ARCHIVED/);
  assert.match(raw, /thinoType: TASK-DONE/);
  const stale = memo();
  await plugin.edit(memo(), 'new content\n\n  code');
  assert.equal(memo().content, 'new content\n\n  code');
  await assert.rejects(plugin.remove(stale), /修改/);
  assert.equal(memo().storage?.id, 'abc');
});

test('native storage uses memo markers, keeps all sources visible and preserves same-second memos', async () => {
  const { plugin, state } = await fixture('- 09:00 daily\n');
  assert.equal(plugin.settings.singleFile, 'memo.md');
  assert.equal(plugin.settings.multiFolder, 'Memo');
  plugin.settings.template = 'nonexistent-daily-template';
  plugin.settings.storageMode = 'file';
  await Promise.all([plugin.capture('first\n\n> quotation'), plugin.capture('second', true)]);
  const file = state.contents.get(plugin.settings.singleFile)!;
  assert.match(file, /^# \d{4}-\d\d-\d\d/);
  assert.match(file, /> quotation\n\n> \[!memo\]/);
  assert.doesNotMatch(file, /thino/i);
  assert.match(file, /\[memoType::JOURNAL\]/);
  assert.match(file, /\[memoType::TASK-TODO\]/);
  assert.equal((file.match(/^# /gm) || []).length, 1);
  plugin.settings.storageMode = 'multi';
  await Promise.all([plugin.capture('third'), plugin.capture('fourth', true)]);
  const multi = plugin.list().filter(m => m.storage?.mode === 'multi');
  assert.equal(multi.length, 2);
  for (const memo of multi) {
    assert.doesNotMatch(memo.raw, /thino/i);
    assert.match(memo.raw, /memoType: (?:TASK-TODO|JOURNAL)/);
    assert.match(memo.path, /^Memo\/\d{8}-[\da-f]{16}\.md$/);
    assert.match(memo.raw, /createdAt: \d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d/);
  }
  plugin.settings.storageMode = 'daily';
  await plugin.refresh();
  assert.equal(plugin.list().length, 5);
  assert.equal(new Set(plugin.list().map(m => m.key)).size, 5);
});

test('ordinary notes in the multi folder are indexed without a write and get an id on first edit', async () => {
  const { plugin, state, vault } = await fixture();
  const path = 'Thino/unprocessed.md';
  await vault.create(path, 'raw body');
  await plugin.refresh();
  const [memo] = plugin.list();
  assert.equal(memo.date, '2025-01-02');
  assert.equal(state.contents.get(path), 'raw body');
  await plugin.edit(memo, 'updated');
  assert.match(state.contents.get(path)!, /id: ["']?[0-9a-f]{16}/);
  assert.equal(plugin.list()[0].content, 'updated');
  assert.equal(plugin.list()[0].storage?.createdAt, '2025/01/02 03:04:05');
});

test('date-named multi memos survive overlapping directories and daily writes refuse occupied paths', async () => {
  const { plugin, state, vault } = await fixture();
  plugin.settings.multiFolder = plugin.settings.folder;
  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const path = 'Journal/' + day + '.md';
  const raw = '---\nid: dedicated\ncreatedAt: 2025/04/05 18:16:15\npinned:\n---\nbody';
  await vault.create(path, raw);
  await plugin.refresh();
  assert.equal(plugin.list()[0].storage?.id, 'dedicated');
  await assert.rejects(plugin.capture('must not append'), /占用/);
  assert.equal(state.contents.get(path), raw);
  await plugin.setMeta(plugin.list()[0], { pinned: true });
  assert.equal(plugin.list()[0].storage?.pinned, true);
  assert.equal(plugin.list()[0].content, 'body');
});

test('both callout formats can coexist and each task keeps its own marker and metadata', async () => {
  const { plugin, state, vault } = await fixture();
  const path = 'Collection/mixed.memo.md';
  const stamp = '2026/11/01 09:10:11';
  const source = '> [!thino] ' + stamp + ' %% [id::old] [thinoType::TASK-TODO] [webId::original] %%\n> old text\n> [!memo] literal example\n'
    + '> [!memo] ' + stamp + ' %% [id::new] [memoType::TASK-TODO] %%\n> new text\n> [!thino] literal example';
  await vault.create(path, source);
  await plugin.refresh();
  const find = (id: string) => plugin.list().find(m => m.storage?.id === id)!;
  assert.equal(find('old').content, 'old text\n[!memo] literal example');
  assert.equal(find('new').content, 'new text\n[!thino] literal example');
  for (const id of ['old', 'new']) await plugin.toggleTask(find(id));
  assert.match(find('old').raw, /\[thinoType::TASK-DONE\]/);
  assert.match(find('old').raw, /\[webId::original\]/);
  assert.match(find('new').raw, /\[memoType::TASK-DONE\]/);
  plugin.settings.storageMode = 'file';
  plugin.settings.singleFile = path;
  await plugin.capture('new card');
  assert.match(state.contents.get(path)!, /> \[!memo\] [^\n]+\[memoType::JOURNAL\] %%\n> new card/);
});

test('first install reads imported sources while new memos use native paths and fields', async () => {
  const { createPlugin, state, vault } = await fixture();
  const oldFile = 'Custom/shared.md', oldFolder = 'OldCards';
  const config = { MemoSaveLocation: 'FILE', MemoOtherSaveLocation: { MemoDefaultSingleFilePath: oldFile, MemoDefaultMultiFilePath: oldFolder } };
  state.contents.set('.obsidian/plugins/obsidian-memos/data.json', JSON.stringify(config));
  const header = '> [!thino] 2025/04/05 18:16:15 %% [id::original] [thinoType::JOURNAL] %%\n> original';
  await vault.create(oldFile, header);
  await vault.create(oldFolder + '/one.md', '---\nid: old\ncreatedAt: 2025/04/05 18:16:15\nthinoType: TASK-TODO\n---\nold task');
  const plugin = createPlugin();
  await plugin.onload();
  await plugin.capture('native file');
  assert.match(state.contents.get('memo.md')!, /> \[!memo\]/);
  plugin.settings.storageMode = 'multi';
  await plugin.capture('native task', true);
  assert.equal(plugin.list().length, 4);
  const task = () => plugin.list().find(m => m.content === 'native task')!;
  await plugin.toggleTask(task());
  assert.match(task().path, /^Memo\//);
  assert.match(task().raw, /memoType: TASK-DONE/);
  assert.doesNotMatch(task().raw, /thino/i);
  assert.equal(state.contents.get(oldFile), header);

  await plugin.reimportSettings();
  await plugin.capture('shared card', true);
  assert.match(state.contents.get(oldFile)!, /> \[!thino\] [^\n]+\[thinoType::TASK-TODO\] %%\n> shared card/);
  plugin.settings.storageMode = 'multi';
  await plugin.capture('shared task', true);
  const shared = plugin.list().find(m => m.content === 'shared task')!;
  assert.match(shared.path, /^OldCards\//);
  assert.match(shared.raw, /thinoType: TASK-TODO/);
  assert.equal(plugin.list().length, 6);
});
