/* Мини-рендерер Markdown для ответов модели — без внешних зависимостей.
 *
 * Панель работает локально и не должна тянуть CDN, поэтому разметка
 * разбирается своим кодом. Порядок обработки:
 *   1) HTML в исходном тексте экранируется (&, <, >, ", ') — разметка из
 *      ответа модели никогда не попадает на страницу как HTML;
 *   2) блочные конструкции: ```код```, заголовки, цитаты, списки (с вложением),
 *      таблицы, горизонтальные линии, абзацы;
 *   3) внутристрочные: `код`, ссылки и картинки (только безопасные схемы),
 *      **жирный**, *курсив*, ~~зачёркнутый~~.
 * Наружу отдаётся единственная функция: window.OllamaMarkdown.render(text).
 */
(function () {
  'use strict';

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/[&<>"']/g, (char) => ESCAPES[char]);
  }

  /** Пропускает только безопасные адреса: javascript:, data: и прочее отсекаются. */
  function safeUrl(url) {
    const value = String(url || '').trim().replace(/^<|>$/g, '');
    if (!value) return '';
    if (/^(https?:\/\/|mailto:|\/|\.{1,2}\/|#)/i.test(value)) return value;
    return '';
  }

  // --- защита уже готовых фрагментов HTML от последующих правил -----------
  // Готовые куски (<code>, <a>, <img>) складываются в stash, а в тексте
  // остаётся маркер \u0000S0\u0000 — он не содержит символов разметки.
  let stash = [];

  function protect(html) {
    stash.push(html);
    return `\u0000S${stash.length - 1}\u0000`;
  }

  function restore(html) {
    return html.replace(/\u0000S(\d+)\u0000/g, (match, index) => {
      const value = stash[Number(index)];
      return value === undefined ? match : value;
    });
  }

  // --- внутристрочная разметка -------------------------------------------
  function renderInline(text) {
    let out = String(text);

    // `код` — содержимое не разбирается дальше
    out = out.replace(/`([^`\n]+)`/g, (match, code) => protect(`<code>${code}</code>`));

    // ![подпись](ссылка) — картинки
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, url) => {
      const src = safeUrl(url);
      if (!src) return match;
      return protect(`<img src="${src}" alt="${alt}" loading="lazy">`);
    });

    // [текст](ссылка)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const href = safeUrl(url);
      if (!href) return match;
      return protect(
        `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>`
      );
    });

    // «голые» ссылки: https://example.com
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()\u0000]+)/g, (match, prefix, url) => {
      const tailMatch = url.match(/[.,;:!?]+$/);
      const tail = tailMatch ? tailMatch[0] : '';
      const clean = tail ? url.slice(0, -tail.length) : url;
      if (!clean) return match;
      return (
        prefix +
        protect(`<a href="${clean}" target="_blank" rel="noreferrer noopener">${clean}</a>`) +
        tail
      );
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    out = out.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');

    out = out.replace(/\n/g, '<br>');
    return restore(out);
  }


  // --- блочные конструкции ------------------------------------------------
  const FENCE = /^\s*(```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/;
  const HEADING = /^(#{1,6})\s+(.*)$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s*(?:>|&gt;)\s?/;   // «>» в тексте уже экранировано в &gt;
  const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/;

  function isTableStart(lines, index) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!line || !next) return false;
    if (!line.includes('|') || !next.includes('|')) return false;
    return TABLE_DIVIDER.test(next) && /-/.test(next);
  }

  function isBlockStart(lines, index) {
    const line = lines[index];
    if (!line || !line.trim()) return true;
    if (FENCE.test(line) || HEADING.test(line) || RULE.test(line)) return true;
    if (QUOTE.test(line) || ITEM.test(line)) return true;
    return isTableStart(lines, index);
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  /** ```код``` — содержимое уже экранировано, кнопку «копировать» добавит чат. */
  function renderCodeBlock(lines, start) {
    const fence = lines[start].match(FENCE);
    const marker = fence[1];
    const language = fence[2] || '';
    const closer = new RegExp(`^\\s*${marker}\\s*$`);
    const body = [];
    let index = start + 1;
    while (index < lines.length && !closer.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) index += 1;   // закрывающий маркер

    const langLabel = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
    const langClass = language ? ` class="language-${escapeHtml(language)}"` : '';
    const html =
      `<div class="md-code"><div class="code-bar">${langLabel}</div>` +
      `<pre><code${langClass}>${body.join('\n')}</code></pre></div>`;
    return { html, next: index };
  }

  /** Списки с поддержкой вложения (по отступу). */
  function renderList(lines, start) {
    const first = lines[start].match(ITEM);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sameKind = (marker) => /\d/.test(marker) === ordered;
    const items = [];
    let current = null;
    let index = start;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        const nextItem = (lines[index + 1] || '').match(ITEM);
        // пустая строка внутри списка допустима, если дальше снова свой пункт
        if (nextItem && nextItem[1].length >= indent && sameKind(nextItem[2])) {
          index += 1;
          continue;
        }
        break;
      }
      const match = line.match(ITEM);
      if (match) {
        if (match[1].length < indent) break;
        if (match[1].length === indent && !sameKind(match[2])) break;   // начался другой список
        if (match[1].length > indent) {
          if (!current) break;
          current.extra.push(line);      // вложенный список
          index += 1;
          continue;
        }
        if (current) items.push(current);
        current = { text: match[3], extra: [] };
        index += 1;
        continue;
      }
      if (/^\s/.test(line) && current) {
        current.extra.push(line.replace(new RegExp(`^\\s{0,${indent + 2}}`), ''));
        index += 1;
        continue;
      }
      break;
    }
    if (current) items.push(current);

    const tag = ordered ? 'ol' : 'ul';
    const html =
      `<${tag}>` +
      items
        .map((item) => {
          const extra = item.extra.length ? renderBlocks(item.extra) : '';
          return `<li>${renderInline(item.text)}${extra}</li>`;
        })
        .join('') +
      `</${tag}>`;
    return { html, next: index };
  }

  function renderTable(lines, start) {
    const head = splitRow(lines[start]).map((cell) => renderInline(cell));
    let index = start + 2;
    const rows = [];
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
      rows.push(splitRow(lines[index]).map((cell) => renderInline(cell)));
      index += 1;
    }
    const headHtml = head.map((cell) => `<th>${cell}</th>`).join('');
    const bodyHtml = rows
      .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
      .join('');
    return {
      html: `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
      next: index,
    };
  }

  function renderBlocks(lines) {
    const out = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      if (FENCE.test(line)) {
        const block = renderCodeBlock(lines, index);
        out.push(block.html);
        index = block.next;
        continue;
      }

      const heading = line.match(HEADING);
      if (heading) {
        const level = Math.min(3 + heading[1].length - 1, 6);
        out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
        index += 1;
        continue;
      }

      if (RULE.test(line)) {
        out.push('<hr>');
        index += 1;
        continue;
      }

      if (isTableStart(lines, index)) {
        const table = renderTable(lines, index);
        out.push(table.html);
        index = table.next;
        continue;
      }

      if (QUOTE.test(line)) {
        const body = [];
        while (index < lines.length && QUOTE.test(lines[index])) {
          body.push(lines[index].replace(QUOTE, ''));
          index += 1;
        }
        out.push(`<blockquote>${renderInline(body.join('\n'))}</blockquote>`);
        continue;
      }

      if (ITEM.test(line)) {
        const list = renderList(lines, index);
        out.push(list.html);
        index = list.next;
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
        paragraph.push(lines[index]);
        index += 1;
      }
      out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
    }

    return out.join('\n');
  }

  /** Превращает Markdown-текст в безопасный HTML. */
  function render(text) {
    stash = [];
    const source = escapeHtml(String(text === null || text === undefined ? '' : text))
      .replace(/\r\n?/g, '\n');
    return restore(renderBlocks(source.split('\n')));
  }

  window.OllamaMarkdown = { render, escapeHtml };
})();
