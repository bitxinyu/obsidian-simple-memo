/** Read-only compatibility audit. Note bodies and credentials never appear in output. */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import moment from 'moment';
import { editMemoRaw, parseMemos, replaceMemo } from '../src/core';
import { importThinoSettings } from '../src/settings';

const vaultArgument = process.argv[2];
if (!vaultArgument) {
  console.error('Usage: npm run check:vault -- "/absolute/path/to/vault"');
  process.exit(2);
}
const vault = path.resolve(vaultArgument);

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(vault, relativePath), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read JSON configuration: ${relativePath}`);
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
  }
  return files.sort();
}

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function markers(raw: string): string[] {
  return [...raw.matchAll(/\[(?:pinned|archived|deleted)\s*::?\s*[^\]]+\]/gi)]
    .map(match => match[0]).sort();
}

function hasMarker(raw: string, name: 'pinned' | 'archived' | 'deleted'): boolean {
  const values = [...raw.matchAll(new RegExp(`\\[${name}\\s*::?\\s*([^\\]]+)\\]`, 'gi'))]
    .map(match => match[1].trim().toLowerCase());
  return name === 'deleted'
    ? values.some(value => value !== 'false' && value !== '0' && value !== '')
    : values.includes('true');
}

async function main(): Promise<void> {
  const [thino, daily, periodic] = await Promise.all([
    readJson('.obsidian/plugins/obsidian-memos/data.json'),
    readJson('.obsidian/daily-notes.json'),
    readJson('.obsidian/plugins/periodic-notes/data.json'),
  ]);
  const { settings, report } = importThinoSettings(thino, daily, periodic);
  const journal = path.resolve(vault, settings.folder);
  if (journal !== vault && !journal.startsWith(`${vault}${path.sep}`)) {
    throw new Error('Configured daily-note folder is outside the vault. Audit stopped.');
  }
  const files = await markdownFiles(journal);
  const counts = {
    markdownFiles: files.length,
    dateFiles: 0,
    emptyDateFiles: 0,
    memos: 0,
    normal: 0,
    archived: 0,
    deleted: 0,
    pinned: 0,
    tasks: 0,
    withTags: 0,
    withBlockIds: 0,
    timestampOnly: 0,
    legacyTrashEntries: 0,
    exactReplacementsChecked: 0,
    editRoundtripsChecked: 0,
    sourceHashesVerified: 0,
  };
  const failures: string[] = [];
  const roundtripFailures = { count: 0, missingEntry: 0, content: 0, blockId: 0, metadata: 0 };
  const originalHashes = new Map<string, string>();

  for (const file of files) {
    const relativeToJournal = path.relative(journal, file).split(path.sep).join('/');
    const source = await readFile(file, 'utf8');
    originalHashes.set(file, digest(source));
    const date = moment(relativeToJournal.slice(0, -3), settings.dateFormat, true);
    if (!date.isValid()) {
      if (path.basename(file) === `${typeof thino.DeleteFileName === 'string' ? thino.DeleteFileName : 'delete'}.md`) {
        counts.legacyTrashEntries += [...source.matchAll(/^- \d{15}(?:\s|$)/gm)].length;
      }
      continue;
    }
    counts.dateFiles++;
    if (!source.trim()) counts.emptyDateFiles++;
    const sourcePath = path.relative(vault, file).split(path.sep).join('/');
    const dateString = date.format('YYYY-MM-DD');
    const memos = parseMemos(source, sourcePath, dateString, settings);
    counts.memos += memos.length;

    // This independent candidate count covers the user's existing HH:mm format.
    if (!settings.processHeading && settings.timeFormat === 'HH:mm') {
      const candidates = [...source.matchAll(/^[-*+] (?:\[[ xX]\] )?\d{2}:\d{2}(?=\s|$)/gm)].length;
      if (memos.length !== candidates) failures.push('A daily note has a timestamp-entry count mismatch.');
    }

    for (let index = 0; index < memos.length; index++) {
      const memo = memos[index];
      const deleted = hasMarker(memo.raw, 'deleted');
      const archived = hasMarker(memo.raw, 'archived');
      if (deleted) counts.deleted++;
      else if (archived) counts.archived++;
      else counts.normal++;
      if (hasMarker(memo.raw, 'pinned')) counts.pinned++;
      if (memo.task) counts.tasks++;
      if (memo.tags.length) counts.withTags++;
      if (memo.blockId) counts.withBlockIds++;
      if (/^[-*+] (?:\[[ xX]\] )?\d{2}:\d{2}\s*$/.test(memo.raw.split(/\r?\n/)[0])) counts.timestampOnly++;

      const unchanged = replaceMemo(source, memo, memo.raw);
      if (unchanged !== source) failures.push('Replacing an entry with its original raw text changed the source.');
      counts.exactReplacementsChecked++;

      const edited = editMemoRaw(memo, memo.content);
      const updated = replaceMemo(source, memo, edited);
      const reparsed = parseMemos(updated, sourcePath, dateString, settings);
      const corresponding = reparsed[index];
      if (reparsed.length !== memos.length) roundtripFailures.count++;
      if (!corresponding) roundtripFailures.missingEntry++;
      if (corresponding && corresponding.content !== memo.content) roundtripFailures.content++;
      if (corresponding && corresponding.blockId !== memo.blockId) roundtripFailures.blockId++;
      if (corresponding && JSON.stringify(markers(corresponding.raw)) !== JSON.stringify(markers(memo.raw))) roundtripFailures.metadata++;
      if (reparsed.length !== memos.length || !corresponding || corresponding.content !== memo.content || corresponding.blockId !== memo.blockId || JSON.stringify(markers(corresponding.raw)) !== JSON.stringify(markers(memo.raw))) {
        failures.push('An in-memory edit roundtrip changed content, metadata, block ID, or entry count.');
      }
      counts.editRoundtripsChecked++;
    }
  }

  for (const [file, original] of originalHashes) {
    if (digest(await readFile(file, 'utf8')) !== original) failures.push('A source file changed during the read-only audit (possibly external sync).');
    counts.sourceHashesVerified++;
  }
  console.log(JSON.stringify({
    readOnly: true,
    configuration: {
      folder: settings.folder,
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      processHeading: settings.processHeading,
      insertHeading: settings.insertHeading,
      defaultTask: settings.defaultTask,
    },
    importWarnings: report.warnings,
    counts,
    roundtripFailures,
    passed: failures.length === 0,
    failures: [...new Set(failures)],
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Vault audit failed.');
  process.exitCode = 1;
});
