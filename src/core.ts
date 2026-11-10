import type { Memo, Settings } from './types';

interface Line { text: string; start: number; end: number; fullEnd: number; eol: string }
interface Heading { level: number; title: string }
const inlineField = /\[(?:archived|deleted|pinned)::[^\]\r\n]*\]/gi;

export function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = newline.exec(source))) {
    lines.push({ text: source.slice(start, match.index), start, end: match.index,
      fullEnd: newline.lastIndex, eol: match[0] });
    start = newline.lastIndex;
  }
  if (start < source.length) lines.push({ text: source.slice(start), start,
    end: source.length, fullEnd: source.length, eol: '' });
  return lines;
}

export function newlineOf(source: string): string { return /\r\n|\n|\r/.exec(source)?.[0] ?? '\n'; }
export function withNewline(text: string, newline: string): string { return text.replace(/\r\n|\n|\r/g, newline); }
function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Explicit editor action only: preserve intentional indentation during normal saves. */
export function removeCommonIndent(content: string): string {
  const lines = linesOf(content);
  let prefix: string | undefined;
  for (const line of lines) {
    if (/^[ \t]*$/.test(line.text)) continue;
    const indentation = /^[ \t]*/.exec(line.text)![0];
    if (prefix === undefined) prefix = indentation;
    else {
      let length = 0;
      while (length < prefix.length && prefix[length] === indentation[length]) length++;
      prefix = prefix.slice(0, length);
    }
    if (!prefix) return content;
  }
  if (!prefix) return content;
  return lines.map(line => (/^[ \t]*$/.test(line.text) ? line.text : line.text.slice(prefix.length)) + line.eol).join('');
}

/** Mark YAML and fenced code before parsing: timestamp-looking examples are never notes. */
export function protectedLines(lines: Line[]): { flags: boolean[]; unclosed: boolean } {
  const flags = lines.map(() => false);
  let yaml = lines[0]?.text.replace(/^\uFEFF/, '') === '---';
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    if (yaml) {
      flags[i] = true;
      if (i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(text)) yaml = false;
      continue;
    }
    if (fence) {
      flags[i] = true;
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(text);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      flags[i] = true;
    }
  }
  return { flags, unclosed: yaml || !!fence };
}

function headingOf(text: string): Heading | undefined {
  const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(text);
  if (!match) return undefined;
  return { level: match[1].length, title: match[2].replace(/[ \t]+#+[ \t]*$/, '').trim() };
}

function requestedHeading(value: string): { title: string; level?: number } {
  const heading = headingOf(value.trim());
  return heading ?? { title: value.trim() };
}

function matchesHeading(actual: Heading, wanted: { title: string; level?: number }): boolean {
  return actual.title === wanted.title && (wanted.level === undefined || actual.level === wanted.level);
}

function timePattern(format: string): string {
  const tokens: Record<string, string> = {
    HH: '(?:[01][0-9]|2[0-3])', H: '(?:[0-9]|1[0-9]|2[0-3])',
    hh: '(?:0[1-9]|1[0-2])', h: '(?:[1-9]|1[0-2])',
    mm: '[0-5][0-9]', m: '(?:[0-9]|[1-5][0-9])',
    ss: '[0-5][0-9]', s: '(?:[0-9]|[1-5][0-9])', A: '(?:AM|PM)', a: '(?:am|pm)',
  };
  let pattern = '';
  for (let i = 0; i < format.length;) {
    if (format[i] === '[' && format.indexOf(']', i + 1) !== -1) {
      const end = format.indexOf(']', i + 1);
      pattern += escapeRegex(format.slice(i + 1, end)); i = end + 1; continue;
    }
    const token = Object.keys(tokens).find(token => format.startsWith(token, i));
    pattern += token ? tokens[token] : escapeRegex(format[i]);
    i += token?.length ?? 1;
  }
  return pattern;
}

/** An unindented paragraph or sibling always terminates an entry. */
function entryEndLine(lines: Line[], start: number): number {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i].text;
    if (/^(?:\t| {2,})/.test(text)) { end = i; continue; }
    // Empty separator lines belong to the memo only if a continuation follows.
    if (/^[ \t]*$/.test(text)) continue;
    break;
  }
  return end;
}

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Logical memo content, after removing the list's structural indentation. */
function proseMasks(lines: string[]): boolean[][] {
  let fence: { char: string; length: number } | undefined;
  const masks = lines.map(text => {
    const mask = Array<boolean>(text.length).fill(true);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
      return mask.fill(false);
    }
    if (/^(?:\t| {4})/.test(text)) return mask.fill(false);
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      return mask.fill(false);
    }
    return mask;
  });
  // Inline code spans may cross a line break. Only a matching backtick run closes them.
  const text = lines.join('\n');
  const flat = masks.flatMap((mask, i) => i === masks.length - 1 ? mask : [...mask, true]);
  for (let i = 0; i < text.length; i++) {
    if (!flat[i] || text[i] !== '`' || escaped(text, i)) continue;
    const size = /^`+/.exec(text.slice(i))![0].length;
    let closed = false;
    for (let j = i + size; j < text.length;) {
      if (!flat[j] || text.slice(j, j + 2) === '\n\n') break;
      if (text[j] !== '`') { j++; continue; }
      const run = /^`+/.exec(text.slice(j))![0].length;
      if (run === size) { flat.fill(false, i, j + run); i = j + run - 1; closed = true; break; }
      j += run;
    }
    if (!closed) i += size - 1;
  }
  let offset = 0;
  return lines.map(line => { const mask = flat.slice(offset, offset + line.length); offset += line.length + 1; return mask; });
}

interface FieldRange { line: number; start: number; end: number; value: string }
function fieldRanges(lines: string[]): FieldRange[] {
  const masks = proseMasks(lines);
  return lines.flatMap((line, index) => [...line.matchAll(inlineField)]
    .filter(match => !escaped(line, match.index) && masks[index].slice(match.index, match.index + match[0].length).every(Boolean))
    .map(match => ({ line: index, start: match.index, end: match.index + match[0].length, value: match[0] })));
}

function blockIdRange(lines: string[]): FieldRange | undefined {
  const masks = proseMasks(lines);
  for (let index = 0; index < lines.length; index++) {
    const match = /(?:[ \t]+|^)\^([A-Za-z0-9-]+)(?=[ \t]*(?:\[(?:archived|deleted|pinned)::[^\]\r\n]*\][ \t]*)*$)/i.exec(lines[index]);
    if (!match) continue;
    const start = match.index + match[0].indexOf('^');
    const end = start + match[1].length + 1;
    if (masks[index].slice(start, end).every(Boolean)) return { line: index, start, end, value: match[1] };
  }
  return undefined;
}

function needsEmptyTimestamp(lines: string[]): boolean {
  // Probe where metadata would be added, including code spans crossing a line break.
  const first = (lines[0] ?? '') + ' x';
  return !proseMasks([first, ...lines.slice(1)])[0][first.length - 1];
}

function oneIndent(text: string): string { return /^(?:\t| {2})/.exec(text)?.[0] ?? ''; }

function continuationIndent(lines: Line[], headerBody: string): string | undefined {
  const headingContent = visibleContent([headerBody]).content.trim();
  // Completion dates decorate an otherwise empty timestamp header, like its ID.
  if (headingContent && !/^✅[ \t]+\d{4}-\d{2}-\d{2}$/.test(headingContent)) return undefined;
  // A separated empty header records its container width. An unindented blank
  // line instead keeps ordinary Markdown's single structural indentation level.
  const anchor = lines[1]?.text;
  if (anchor !== undefined && /^[ \t]*$/.test(anchor)) return anchor || undefined;
  let prefix: string | undefined;
  for (const line of lines.slice(1)) {
    if (/^[ \t]*$/.test(line.text)) continue;
    const indentation = /^[ \t]*/.exec(line.text)![0];
    if (prefix === undefined) prefix = indentation;
    else {
      let length = 0;
      while (length < prefix.length && prefix[length] === indentation[length]) length++;
      prefix = prefix.slice(0, length);
    }
    if (!prefix) return undefined;
  }
  return prefix || undefined;
}

function logicalRawLines(raw: string, firstBody?: string): { text: string; start: number }[] {
  const lines = linesOf(raw);
  if (!lines.length) return [];
  const headerLength = firstBody === undefined
    ? (/^[-*+] (?:\[[ xX]\][ \t]+)?\d{1,2}:\d{2}(?::\d{2})?(?:[ \t]+[AaPp][Mm])?(?:[ \t]|$)/.exec(lines[0].text)?.[0].length ?? 0)
    : lines[0].text.length - firstBody.length;
  const indentation = continuationIndent(lines, lines[0].text.slice(headerLength));
  return lines.map((line, index) => {
    const length = index === 0 ? headerLength
      : indentation && line.text.startsWith(indentation) ? indentation.length : oneIndent(line.text).length;
    return { text: line.text.slice(length), start: line.start + length };
  });
}

export function getMemoFields(raw: string): string[] {
  return fieldRanges(logicalRawLines(raw).map(line => line.text)).map(range => range.value);
}

export function transformMemoFields(raw: string, transform: (field: string) => string): string {
  const lines = logicalRawLines(raw);
  const indentation = continuationIndent(linesOf(raw), lines[0]?.text ?? '');
  const changes = fieldRanges(lines.map(line => line.text)).map(range => ({ ...range, replacement: transform(range.value) }));
  for (const change of changes.reverse()) {
    const offset = lines[change.line].start;
    raw = raw.slice(0, offset + change.start) + change.replacement + raw.slice(offset + change.end);
  }
  const changedLines = linesOf(raw);
  if (changedLines.length > 1
    && continuationIndent(changedLines, changedLines[0].text.slice(lines[0].start)) !== indentation) {
    // Removing the only shallow metadata line must not promote deeper code to prose.
    // Record the original container before any newly inferred baseline can take over.
    const header = changedLines[0];
    raw = raw.slice(0, header.fullEnd) + (indentation ?? '') + header.eol + raw.slice(header.fullEnd);
  }
  return raw;
}

function separatedBlockRaw(prefix: string, fields: string[], id: string, body: string[], newline: string, indentation = '\t'): string {
  const header = `${prefix}${fields.length ? ` ${fields.join(' ')}` : ''} ^${id}`;
  // Obsidian recognizes this paragraph's ID only when the continuation is separated.
  return header + newline + indentation + newline + body.map(line => indentation + line).join(newline);
}

export function withMemoBlockId(raw: string, id: string): string {
  id = id.replace(/^\^/, '');
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('块 ID 格式无效。');
  const lines = logicalRawLines(raw);
  if (!lines.length) throw new Error('便签原文为空。');
  const existing = blockIdRange(lines.map(line => line.text));
  if (existing) {
    const offset = lines[existing.line].start;
    return raw.slice(0, offset + existing.start) + `^${id}` + raw.slice(offset + existing.end);
  }
  if (lines.length > 1 || needsEmptyTimestamp(lines.map(line => line.text))) {
    const body = visibleContent(lines.map(line => line.text)).content.split('\n');
    return separatedBlockRaw(raw.slice(0, lines[0].start).trimEnd(), getMemoFields(raw), id, body, newlineOf(raw));
  }
  const end = linesOf(raw)[0].end;
  return raw.slice(0, end).trimEnd() + ` ^${id}` + raw.slice(end);
}

function visibleContent(lines: string[]): { content: string; blockId?: string } {
  const clean = [...lines];
  for (const field of fieldRanges(lines).reverse()) {
    clean[field.line] = clean[field.line].slice(0, field.start) + clean[field.line].slice(field.end);
  }
  const block = blockIdRange(clean);
  if (block) clean[block.line] = clean[block.line].slice(0, block.start).trimEnd();
  clean.forEach((line, index) => { if (line !== lines[index]) clean[index] = line.trimEnd(); });
  while (clean.length && /^[ \t]*$/.test(clean[0])) clean.shift();
  while (clean.length && /^[ \t]*$/.test(clean[clean.length - 1])) clean.pop();
  return { content: clean.join('\n'), blockId: block?.value };
}

function hash(text: string): string {
  let value = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    value ^= BigInt(text.charCodeAt(i));
    value = BigInt.asUintN(64, value * 0x100000001b3n);
  }
  return value.toString(16).padStart(16, '0');
}

export function contentTags(content: string): string[] {
  return [...new Set([...content.matchAll(/(?:^|[\s(])#([\p{L}\p{N}\p{M}_/-]+)/gu)]
    .map(tag => tag[1]).filter(tag => !/^\d+$/.test(tag)))];
}

export function parseMemos(source: string, path: string, date: string, settings: Settings): Memo[] {
  const lines = linesOf(source);
  const protected_ = protectedLines(lines).flags;
  // Retain older entries when the user changes their timestamp precision.
  const formats = [...new Set([settings.timeFormat || 'HH:mm', 'HH:mm:ss', 'HH:mm'])];
  const header = new RegExp(`^[-*+] (?:\\[([ xX])\\][ \\t]+)?(${formats.map(timePattern).join('|')})(?:[ \\t](.*)|$)`);
  const wanted = requestedHeading(settings.processHeading || '');
  let scopeLevel: number | undefined;
  const occurrences = new Map<string, number>();
  const memos: Memo[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (protected_[i]) continue;
    const heading = headingOf(lines[i].text);
    if (heading) {
      if (scopeLevel !== undefined && heading.level <= scopeLevel) scopeLevel = undefined;
      if (wanted.title && matchesHeading(heading, wanted)) scopeLevel = heading.level;
      continue;
    }
    if (wanted.title && scopeLevel === undefined) continue;
    const match = header.exec(lines[i].text);
    if (!match) continue;
    const last = entryEndLine(lines, i);
    const raw = source.slice(lines[i].start, lines[last].end);
    const { content, blockId } = visibleContent(logicalRawLines(raw, match[3] ?? '').map(line => line.text));
    const digest = hash(raw);
    const occurrence = occurrences.get(digest) ?? 0;
    occurrences.set(digest, occurrence + 1);
    const tags = contentTags(content);
    memos.push({ key: `${path}::${blockId ? `^${blockId}` : `${digest}:${occurrence}`}`,
      path, date, time: match[2], content, raw, start: lines[i].start, end: lines[last].end,
      line: i + 1, task: match[1] === undefined ? null : match[1] === ' ' ? 'open' : 'done', tags, blockId });
    i = last;
  }
  return memos;
}

export function formatMemo(content: string, time: string, task: boolean, _settings: Settings): string {
  if (!time || /[\r\n]/.test(time)) throw new Error('便签时间无效。');
  const lines = content.replace(/\r\n|\r/g, '\n').split('\n');
  const prefix = `- ${task ? '[ ] ' : ''}${time}`;
  // Explicitly separate new multiline bodies so their own indentation is unambiguous.
  if (lines.length > 1 || needsEmptyTimestamp(lines)) return prefix + '\n\t\n' + lines.map(line => `\t${line}`).join('\n');
  return prefix + (lines[0] ? ` ${lines[0]}` : '');
}

export function insertMemo(source: string, raw: string, heading: string): string {
  if (!raw || /[\r\n]$/.test(raw)) throw new Error('便签格式无效。');
  const lines = linesOf(source);
  const protected_ = protectedLines(lines);
  if (protected_.unclosed) throw new Error('日记存在未闭合的 frontmatter 或代码块，请修复后再保存。');
  const wanted = requestedHeading(heading);
  const newline = newlineOf(source);
  const entry = withNewline(raw, newline);
  const matches: number[] = [];
  if (wanted.title) for (let i = 0; i < lines.length; i++) {
    if (protected_.flags[i]) continue;
    const actual = headingOf(lines[i].text);
    if (actual && matchesHeading(actual, wanted)) matches.push(i);
  }
  if (matches.length > 1) throw new Error('日记中存在多个同名目标标题，无法安全确定保存位置。');
  if (matches.length === 1) {
    const start = matches[0];
    const level = headingOf(lines[start].text)!.level;
    let boundary = source.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (protected_.flags[i]) continue;
      const next = headingOf(lines[i].text);
      if (next && next.level <= level) { boundary = lines[i].start; break; }
    }
    const before = source.slice(0, boundary);
    const prefix = before && !/[\r\n]$/.test(before) ? newline : '';
    return before + prefix + entry + newline + (boundary < source.length ? newline : '') + source.slice(boundary);
  }
  if (wanted.title) {
    const trailing = /(?:\r\n|\n|\r){1,}$/.exec(source)?.[0];
    const count = trailing?.match(/\r\n|\n|\r/g)?.length ?? 0;
    const prefix = source ? newline.repeat(Math.max(0, 2 - count)) : '';
    const title = `${'#'.repeat(wanted.level ?? 2)} ${wanted.title}`;
    return source + prefix + title + newline + newline + entry + newline;
  }
  return source + (source && !/[\r\n]$/.test(source) ? newline : '') + entry + newline;
}

/** Re-locate only an exact, complete, unique entry; never overwrite a changed memo. */
export function replaceMemo(source: string, memo: Memo, newRaw: string | null): string {
  if (!memo.raw) throw new Error('便签原文为空，无法安全修改。');
  const lines = linesOf(source);
  const protected_ = protectedLines(lines).flags;
  const matches: { start: number; end: number; newline: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (protected_[i] || !/^[-*+] /.test(lines[i].text)) continue;
    const last = entryEndLine(lines, i);
    if (source.slice(lines[i].start, lines[last].end) === memo.raw) {
      matches.push({ start: lines[i].start, end: lines[last].end,
        newline: lines[i].eol || newlineOf(source) });
    }
  }
  if (matches.length === 0) throw new Error('便签已在其他位置被修改，请刷新后重试。');
  if (matches.length > 1) throw new Error('存在内容完全相同的便签，无法安全确定要修改哪一条；请先在原文中添加唯一块 ID。');
  const target = matches[0];
  return source.slice(0, target.start) + (newRaw === null ? '' : withNewline(newRaw, target.newline)) + source.slice(target.end);
}

export function editMemoRaw(memo: Memo, content: string): string {
  if (content === memo.content) return memo.raw;
  const newline = newlineOf(memo.raw);
  const firstLine = memo.raw.split(/\r\n|\n|\r/)[0];
  const prefixEnd = firstLine.indexOf(memo.time) + memo.time.length;
  if (prefixEnd < memo.time.length || !/^[-*+] /.test(firstLine)) throw new Error('便签原始格式无效。');
  const prefix = firstLine.slice(0, prefixEnd);
  const fields = getMemoFields(memo.raw);
  const parts = content.replace(/\r\n|\r/g, '\n').split('\n');
  const incomingFields = fieldRanges(parts).map(field => field.value);
  const sourceLines = linesOf(memo.raw);
  const indentation = continuationIndent(sourceLines, firstLine.slice(prefixEnd).replace(/^[ \t]/, ''))
    ?? sourceLines.slice(1).map(line => oneIndent(line.text)).find(Boolean) ?? '\t';
  if (memo.blockId && (parts.length > 1 || /[\r\n]/.test(memo.raw))) {
    return separatedBlockRaw(prefix, fields.filter(field => !incomingFields.includes(field)), memo.blockId, parts, newline, indentation);
  }
  // Thino commonly keeps its timestamp line empty, including for indented code.
  // Retaining that shape avoids moving intentional content indentation into the header.
  const emptyFirst = !visibleContent([firstLine.slice(prefixEnd).replace(/^[ \t]/, '')]).content
    || needsEmptyTimestamp(parts);
  let first = emptyFirst ? '' : parts.shift() ?? '';
  for (const field of fields) if (!incomingFields.includes(field)) first += `${first ? ' ' : ''}${field}`;
  if (memo.blockId && !new RegExp(`(?:^|[ \\t])\\^${escapeRegex(memo.blockId)}(?:[ \\t]|$)`).test(first)) {
    first += `${first ? ' ' : ''}^${memo.blockId}`;
  }
  return prefix + (first ? ` ${first}` : '') + (emptyFirst && parts.length ? newline + indentation : '')
    + parts.map(line => `${newline}${indentation}${line}`).join('');
}

export function toggleMemoRaw(memo: Memo, completionDate?: string): string {
  if (completionDate && !/^\d{4}-\d{2}-\d{2}$/.test(completionDate)) throw new Error('完成日期格式无效。');
  const done = memo.task !== 'done';
  let raw = memo.raw.replace(/^([-*+] )(?:\[[ xX]\][ \t]+)?/, `$1[${done ? 'x' : ' '}] `);
  const newline = newlineOf(raw);
  const lines = raw.split(/\r\n|\n|\r/);
  if (!done) {
    lines[0] = lines[0].replace(/[ \t]+✅[ \t]+\d{4}-\d{2}-\d{2}(?=[ \t]*(?:\[(?:archived|deleted|pinned)::[^\]]*\][ \t]*)*(?:\^[A-Za-z0-9-]+[ \t]*)?$)/, '');
  } else if (completionDate && !/✅[ \t]+\d{4}-\d{2}-\d{2}/.test(lines[0])) {
    const id = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/.exec(lines[0]);
    const position = id?.index ?? lines[0].length;
    lines[0] = lines[0].slice(0, position) + ` ✅ ${completionDate}` + lines[0].slice(position);
  }
  return lines.join(newline);
}
