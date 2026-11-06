export interface CompletionToken { kind: 'tag' | 'link'; start: number; end: number; query: string }

export function completionToken(text: string, cursor: number, selectionEnd = cursor): CompletionToken | null {
  if (cursor !== selectionEnd) return null;
  const prefix = text.slice(0, cursor);
  const lines = prefix.split('\n');
  let fence = '';
  for (const line of lines) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = '';
    }
  }
  if (fence) return null;
  const line = lines[lines.length - 1];
  let inline = 0;
  for (const match of line.matchAll(/(?<!\\)`+/g)) {
    if (!inline) inline = match[0].length;
    else if (inline === match[0].length) inline = 0;
  }
  if (inline) return null;
  const link = /(?<!\\)\[\[([^[\]\n|#]*)$/.exec(line);
  if (link) {
    // Leave heading/block links and aliases intact when editing their target.
    const suffix = text.slice(cursor);
    if (/^[^[\]\n]*[|#][^[\]\n]*\]\]/.test(suffix)) return null;
    const tail = /^[^[\]\n|#]*\]\]/.exec(suffix);
    return { kind: 'link', start: cursor - link[0].length, end: cursor + (tail?.[0].length ?? 0), query: link[1] };
  }
  const tag = /(?:^|[\s(（])#([\p{L}\p{N}\p{M}_/-]*)$/u.exec(line);
  if (!tag) return null;
  const tail = /^[\p{L}\p{N}\p{M}_/-]*/u.exec(text.slice(cursor))![0];
  return { kind: 'tag', start: cursor - tag[1].length - 1, end: cursor + tail.length, query: tag[1] };
}
export function matchingSuggestions(values: string[], query: string, limit = 20): string[] {
  const needle = query.toLocaleLowerCase();
  return [...new Set(values)].filter(value => value.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.toLocaleLowerCase().startsWith(needle)) - Number(a.toLocaleLowerCase().startsWith(needle)) || a.localeCompare(b))
    .slice(0, limit);
}
