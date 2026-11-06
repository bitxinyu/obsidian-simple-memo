import { App, Scope } from 'obsidian';
import type { MemoController } from './types';
import { completionToken, matchingSuggestions } from './completion';

/** Shared by all three textarea editors; returns lifecycle cleanup for the view/modal. */
export function attachSuggestions(app: App, controller: MemoController, editor: HTMLTextAreaElement, scope: Scope): () => void {
  const anchor = editor.parentElement!.createDiv({ cls: 'st-completion-anchor' });
  editor.before(anchor); anchor.append(editor);
  const id = `st-suggest-${crypto.randomUUID()}`;
  const panel = anchor.createDiv({ cls: 'st-suggestions', attr: { id, role: 'listbox', 'aria-label': '输入建议' } });
  panel.hidden = true;
  editor.setAttribute('aria-autocomplete', 'list');
  editor.setAttribute('aria-controls', id);
  editor.setAttribute('aria-expanded', 'false');
  let token: ReturnType<typeof completionToken> = null;
  let items: string[] = [];
  let selected = 0;
  let composing = false;
  const close = () => {
    panel.hidden = true; token = null; items = [];
    editor.setAttribute('aria-expanded', 'false'); editor.removeAttribute('aria-activedescendant');
  };
  const highlight = () => {
    Array.from(panel.children).forEach((el, index) => {
      el.toggleClass('is-selected', index === selected); el.setAttribute('aria-selected', String(index === selected));
    });
    editor.setAttribute('aria-activedescendant', `${id}-${selected}`);
    panel.children[selected]?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (index: number) => {
    const current = completionToken(editor.value, editor.selectionStart, editor.selectionEnd);
    if (!token || !current || composing || editor.disabled || current.start !== token.start || current.query !== token.query || current.kind !== token.kind) { close(); return; }
    const value = token.kind === 'tag' ? `#${items[index]}` : `[[${items[index]}]]`;
    editor.focus(); editor.setSelectionRange(current.start, current.end);
    // Native insertion keeps completion in the textarea's undo history.
    if (!editor.ownerDocument.execCommand('insertText', false, value)) {
      editor.setRangeText(value, current.start, current.end, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
    close();
  };
  const refresh = () => {
    if (composing || editor.disabled || editor.ownerDocument.activeElement !== editor) { close(); return; }
    token = completionToken(editor.value, editor.selectionStart, editor.selectionEnd);
    if (!token) { close(); return; }
    const values = token.kind === 'tag' ? controller.list().flatMap(memo => memo.tags)
      : app.vault.getMarkdownFiles().map(file => file.path.replace(/\.md$/, ''));
    items = matchingSuggestions(values, token.query);
    if (!items.length) { close(); return; }
    selected = 0; panel.empty(); panel.hidden = false;
    editor.setAttribute('aria-expanded', 'true');
    items.forEach((value, index) => {
      const row = panel.createDiv({ cls: 'st-suggestion', text: token?.kind === 'tag' ? `#${value}` : value,
        attr: { id: `${id}-${index}`, role: 'option', 'aria-selected': 'false' } });
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => choose(index));
    });
    highlight();
  };
  const handlers = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].map(key => scope.register([], key, event => {
    // Some IMEs report 229 before isComposing becomes true.
    if (panel.hidden || event.target !== editor || composing || event.isComposing || event.keyCode === 229) return;
    if (key === 'Escape') close();
    else if (key === 'Enter' || key === 'Tab') choose(selected);
    else { selected = (selected + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; highlight(); }
    return false;
  }));
  const caret = (event: KeyboardEvent) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refresh(); };
  const startComposition = () => { composing = true; close(); };
  const endComposition = () => { composing = false; refresh(); };
  editor.addEventListener('input', refresh); editor.addEventListener('click', refresh);
  editor.addEventListener('keyup', caret); editor.addEventListener('blur', close);
  editor.addEventListener('compositionstart', startComposition); editor.addEventListener('compositionend', endComposition);
  return () => {
    close(); panel.remove(); handlers.forEach(handler => scope.unregister(handler));
    editor.removeEventListener('input', refresh); editor.removeEventListener('click', refresh);
    editor.removeEventListener('keyup', caret); editor.removeEventListener('blur', close);
    editor.removeEventListener('compositionstart', startComposition); editor.removeEventListener('compositionend', endComposition);
  };
}
