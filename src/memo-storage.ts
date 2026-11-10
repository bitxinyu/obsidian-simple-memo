import { Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { moment as obsidianMoment } from 'obsidian';
import type momentType from 'moment';
import { contentTags, insertMemo, linesOf, newlineOf, protectedLines, withNewline } from './core';
import type { Memo, MemoMeta } from './types';

const moment = obsidianMoment as unknown as typeof momentType;
export const storageTime = 'YYYY/MM/DD HH:mm:ss';
type Format = 'memo' | 'thino';
const callout = /^> \[!(memo|thino)\]/;
type Storage = NonNullable<Memo['storage']>;
type Change = MemoMeta & { content?: string; task?: 'open' | 'done'; deleted?: boolean };

function scalarText(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function timestamp(value: unknown): string {
    const parsed = moment(scalarText(value), [storageTime, 'YYYYMMDDHHmmss'], true);
    return parsed.isValid() ? parsed.format(storageTime) : '';
}

function taskType(task: Memo['task']): string {
    if (task === 'open') return 'TASK-TODO';
    if (task === 'done') return 'TASK-DONE';
    return 'JOURNAL';
}

function memoAt(path: string, storage: Storage, type: unknown, content: string, raw: string, start: number, line: number): Memo {
    const [day, time] = storage.createdAt.split(' ');
    return {
        key: JSON.stringify([storage.mode, path, storage.mode === 'file' ? storage.id : '']),
        path, storage, date: day.replace(/\//g, '-'), time, content, raw, start, end: start + raw.length, line,
        task: type === 'TASK-TODO' ? 'open' : type === 'TASK-DONE' ? 'done' : null,
        tags: contentTags(content),
    };
}

function cardHeader(text: string) {
    const marker = callout.exec(text);
    if (!marker) return null;
    const header = text.slice(marker[0].length).trimStart();
    const createdAt = timestamp(header.split(/\s+%%|\s+\[/)[0].trim());
    if (!createdAt) return null;
    const fields = new Map([...header.matchAll(/\[([\w-]+)::([^\]]*)\]/g)].map(m => [m[1].toLowerCase(), m[2].trim()]));
    const id = fields.get('id');
    return id ? { id, createdAt, format: marker[1] as Format, fields } : null;
}

export function readSingleFile(source: string, path: string): Memo[] {
    const lines = linesOf(source);
    const { flags } = protectedLines(lines);
    const result: Memo[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (flags[i]) continue;
        const header = cardHeader(line.text);
        if (!header) continue;
        const { id, createdAt, fields, format } = header;
        const body: string[] = [];
        let last = i;
        while (last + 1 < lines.length) {
            const next = lines[last + 1].text;
            if (!next.startsWith('>') || cardHeader(next) || (format === 'thino' && next.startsWith('> [!thino]'))) break;
            body.push(next.replace(/^> ?/, ''));
            last++;
        }
        const storage: Storage = { mode: 'file', id, createdAt, deletedAt: fields.get('deleted') || '',
            pinned: fields.get('pinned') === 'true', archived: fields.get('archived') === 'true' };
        result.push(memoAt(path, storage, fields.get(format + 'type'), body.join('\n'),
            source.slice(line.start, lines[last].end), line.start, i + 1));
        i = last;
    }
    return result;
}

function quoteBody(content: string, format: Format): string {
    const lines = withNewline(content, '\n').split('\n').map(line => '> ' + line);
    if (lines.some(line => cardHeader(line) || (format === 'thino' && line.startsWith('> [!thino]'))))
        throw new Error('正文中有一行会被识别为新便签，请在该行前加空格。');
    return lines.join('\n');
}

export function appendSingleFile(source: string, path: string, content: string, task: boolean, id: string, now: string, legacyPath: boolean): string {
    const cards = readSingleFile(source, path);
    const format: Format = cards.length ? (cards.every(card => card.raw.startsWith('> [!thino]')) ? 'thino' : 'memo')
        : legacyPath ? 'thino' : 'memo';
    const header = `> [!${format}] ${now} %% [id::${id}] [${format}Type::${taskType(task ? 'open' : null)}] %%`;
    const raw = header + '\n' + quoteBody(content, format);
    const date = now.slice(0, 10).replace(/\//g, '-');
    // A blank line also separates consecutive callouts in Obsidian's Markdown renderer.
    return insertMemo(source, '\n' + raw, '# ' + date);
}

function updateHeader(header: string, field: string, value?: string): string {
    const pattern = new RegExp(' ?\\[' + field + '::[^\\]]*\\]', 'gi');
    const clean = header.replace(pattern, '');
    if (!value) return clean;
    const token = `[${field}::${value}]`;
    const end = clean.lastIndexOf('%%');
    if (end >= 0 && end !== clean.indexOf('%%'))
        return clean.slice(0, end).trimEnd() + ' ' + token + ' ' + clean.slice(end);
    return clean + ' ' + token;
}

function updateSingle(source: string, memo: Memo, change: Change, now: string): string {
    const matches = readSingleFile(source, memo.path).filter(item => item.key === memo.key);
    if (matches.length !== 1 || matches[0].raw !== memo.raw) throw conflict();
    const target = matches[0];
    const newline = newlineOf(/[\r\n]/.test(target.raw) ? target.raw : source);
    const first = linesOf(target.raw)[0];
    let header = first.text;
    const format = header.startsWith('> [!thino]') ? 'thino' : 'memo';
    if (change.task) header = updateHeader(header, format + 'Type', taskType(change.task));
    if (change.deleted !== undefined) header = updateHeader(header, 'deleted', change.deleted ? now.replace(/\D/g, '') : undefined);
    for (const key of ['pinned', 'archived'] as const)
        if (change[key] !== undefined) header = updateHeader(header, key, change[key] ? 'true' : undefined);
    const body = change.content === undefined ? target.raw.slice(first.end) : newline + withNewline(quoteBody(change.content, format), newline);
    return source.slice(0, target.start) + header + body + source.slice(target.end);
}

function frontmatter(source: string) {
    const opening = /^\uFEFF?---[ \t]*(\r\n|\n|\r)/.exec(source);
    const closing = opening ? /^(?:---|\.\.\.)[ \t]*(?:\r\n|\r|\n|$)/m.exec(source.slice(opening[0].length)) : null;
    if (opening && !closing) return null;
    const yaml = closing && opening ? source.slice(opening[0].length, opening[0].length + closing.index) : '';
    const bodyStart = opening && closing ? opening[0].length + closing.index + closing[0].length : 0;
    const doc = parseDocument(yaml);
    if (doc.errors.length || (doc.contents && !isMap(doc.contents))) return null;
    return { doc, yaml, bodyStart, opening: opening?.[0], closing: closing?.[0], body: source.slice(bodyStart) };
}

export function readMultiFile(source: string, path: string, fileCreatedAt?: string): Memo[] {
    const fm = frontmatter(source);
    if (!fm || !fm.body.trim()) return [];
    const { doc, body } = fm;
    const createdAt = timestamp(doc.get('createdAt')) || fileCreatedAt;
    if (!createdAt) return [];
    const storage: Storage = { mode: 'multi', id: scalarText(doc.get('id')), createdAt,
        deletedAt: scalarText(doc.get('deletedAt')), pinned: doc.get('pinned') === true, archived: doc.get('rowStatus') === 'ARCHIVED' };
    const line = 1 + (source.slice(0, fm.bodyStart).match(/\r\n|\r|\n/g)?.length ?? 0);
    const memo = memoAt(path, storage, doc.get('memoType') ?? doc.get('thinoType'), withNewline(body, '\n'), source, 0, line);
    const tags = doc.get('tags');
    const frontTags: unknown[] = isSeq(tags) ? tags.items.map(item => isScalar(item) ? item.value : null)
        : typeof tags === 'string' ? tags.split(/[\s,]+/) : [];
    memo.tags = [...new Set([...memo.tags, ...frontTags.filter((t): t is string => typeof t === 'string' && !!t).map(t => t.replace(/^#/, ''))])];
    return [memo];
}

export function newMultiFile(content: string, task: boolean, id: string, now: string, legacyFolder: boolean): string {
    const doc = new Document({ id, createdAt: now, updatedAt: now, [legacyFolder ? 'thinoType' : 'memoType']: taskType(task ? 'open' : null) });
    return '---\n' + doc.toString() + '---\n' + content;
}

function conflict(): Error { return new Error('便签已被修改或标识重复，请刷新并核对原文件后重试。'); }

export function changeStoredMemo(source: string, memo: Memo, change: Change, now: string, newId: string, legacyFolder: boolean): string {
    const storage = memo.storage!;
    if (storage.mode === 'file') return updateSingle(source, memo, change, now);
    if (source !== memo.raw) throw conflict();
    const fm = frontmatter(source);
    if (!fm) throw conflict();
    const { doc } = fm;
    const fields: Record<string, string | boolean> = { updatedAt: now };
    if (!storage.id) fields.id = newId;
    if (!timestamp(doc.get('createdAt'))) fields.createdAt = storage.createdAt;
    if (change.task) {
        const type = taskType(change.task);
        if (doc.has('thinoType') || (!doc.has('memoType') && legacyFolder)) fields.thinoType = type;
        if (doc.has('memoType') || !('thinoType' in fields)) fields.memoType = type;
    }
    if (change.pinned !== undefined) fields.pinned = change.pinned;
    if (change.archived !== undefined) fields.rowStatus = change.archived ? 'ARCHIVED' : 'NORMAL';
    if (change.deleted !== undefined) fields.deletedAt = change.deleted ? now : '';
    const newline = newlineOf(source);

    // Patch scalar spans in ordinary block frontmatter, leaving unrelated YAML byte-for-byte intact.
    const patches: { start: number; end: number; text: string }[] = [];
    const additions = new Document();
    let rewrite = !!(isMap(doc.contents) && doc.contents.flow);
    for (const [key, value] of Object.entries(fields)) {
        const node = doc.get(key, true);
        if (isScalar(node) && node.value === value) continue;
        if (!doc.has(key)) additions.set(key, value);
        else if (isScalar(node) && node.range && node.range[0] < node.range[1] && !node.anchor && !node.tag && ['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(node.type ?? ''))
            patches.push({ start: node.range[0], end: node.range[1], text: new Document(value).toString().trimEnd() });
        else rewrite = true;
        doc.set(key, value);
    }
    let yaml = fm.yaml;
    if (rewrite) yaml = withNewline(doc.toString({ lineWidth: 0 }), newline);
    else {
        for (const patch of patches.sort((a, b) => b.start - a.start))
            yaml = yaml.slice(0, patch.start) + patch.text + yaml.slice(patch.end);
        if (additions.contents) yaml += withNewline(additions.toString(), newline);
    }
    return (fm.opening ?? '---' + newline) + yaml + (fm.closing ?? '---' + newline)
        + (change.content === undefined ? fm.body : withNewline(change.content, newline));
}
