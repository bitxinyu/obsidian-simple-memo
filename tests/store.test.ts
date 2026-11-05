import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defaultSettings } from '../src/settings';
import { parseMemos } from '../src/core';
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
type FakeFile = { __file: true; path: string; extension: string };

async function fixture(source = '') {
  const PluginClass = await loadPlugin;
  const state = {
    contents: new Map<string, string>(), files: new Map<string, FakeFile>(), folders: new Set(['Journal']),
    durable: undefined as PluginData | undefined, saves: [] as PluginData[], notices: [] as string[],
    views: [] as string[], adapterReads: [] as string[], failAdapterRead: false,
    failRead: false, failProcess: false, failSave: false, processDelay: 0, activeProcesses: 0, maxProcesses: 0,
  };
  const addFile = (path: string, content: string) => {
    const file: FakeFile = { __file: true, path, extension: 'md' };
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
