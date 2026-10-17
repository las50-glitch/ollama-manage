/* Окно чата с моделью — логика в стиле CLI `ollama run`.
 *
 * Файл подключается на той же странице, что и app.js, поэтому вся логика
 * завёрнута в IIFE, а наружу отдаётся только `window.OllamaChat`:
 *   OllamaChat.open('qwen3:8b') — открыть модальное окно чата;
 *   OllamaChat.close()          — закрыть его;
 *   OllamaChat.isOpen()         — открыто ли окно.
 *
 * Сообщения показываются пузырями: пользователь — справа, модель — слева,
 * ответы разбираются как Markdown модулем markdown.js (static/js/markdown.js).
 * Под сообщениями есть кнопки: «изменить» у вопроса пользователя (текст правится
 * на месте, прежний ответ отбрасывается и запрос уходит заново),
 * «перегенерировать» у ответа модели — как в Open WebUI, и «продолжить»:
 * если модель остановилась на середине, ответ уходит в модель последним
 * сообщением и она дописывает его с того же места (assistant-prefill),
 * а панель дописывает токены в тот же пузырь.
 *
 * Блоки кода html/css/js открываются в панели предпросмотра справа от чата:
 * документ собирается в srcdoc изолированного iframe (sandbox без
 * allow-same-origin, CSP без сети), поэтому код из ответа модели не получает
 * доступа к панели.
 */
(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  /** Показывает всплывающее уведомление. */
  function toast(message, kind = 'info', timeout = 6000) {
    const container = $('#toasts');
    if (!container) return;
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    container.appendChild(node);
    setTimeout(() => node.remove(), timeout);
  }

  /** Выполняет запрос к панели и разбирает JSON-ответ. */
  async function api(url, options = {}) {
    const response = await fetch(url, options);
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function postJson(url, body) {
    return api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  const pageData = document.body.dataset;
  const CONFIG = {
    model: pageData.chatModel || '',
    keepAlive: pageData.chatKeepAlive || '5m',
    preloadKeepAlive: pageData.preloadKeepAlive || '30m',
    thinkDefault: pageData.chatThink || 'auto',
    service: pageData.service || 'ollama.service',
    serviceKind: pageData.serviceKind || 'служба',
    platform: pageData.platformLabel || '',
    backend: pageData.backend || 'systemd',
    ollamaHost: pageData.ollamaHost || '',
  };

  const STORAGE_KEY = 'ollama-chat-settings';
  const HISTORY_LIMIT = 40;   // сколько последних сообщений отправлять в модель
  const THINK_MODES = ['auto', 'off', 'on'];
  const THINK_LABELS = { auto: 'авто', off: 'выкл', on: 'вкл' };

  const settings = {
    model: CONFIG.model,
    system: '',
    temperature: '',
    top_p: '',
    num_ctx: '',
    num_predict: '',
    think: THINK_MODES.includes(CONFIG.thinkDefault) ? CONFIG.thinkDefault : 'auto',
    keepAlive: CONFIG.keepAlive,
  };

  let history = [];           // [{role, content}] — только user/assistant
  let streaming = false;
  let controller = null;
  let memoryTimer = null;
  let initialized = false;

  // ----------------------------------------------------------------------
  // настройки: сохранение в localStorage
  // ----------------------------------------------------------------------
  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        Object.keys(settings).forEach((key) => {
          if (typeof saved[key] === 'string') settings[key] = saved[key];
        });
      }
    } catch (err) {
      /* localStorage может быть недоступен — работаем со значениями по умолчанию */
    }
    if (!THINK_MODES.includes(settings.think)) settings.think = 'auto';
    if (CONFIG.model) settings.model = CONFIG.model;
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      /* не критично: настройки просто не сохранятся */
    }
  }

  /** Собирает options для /api/chat (пустые поля не передаются). */
  function chatOptions() {
    const options = {};
    if (settings.temperature !== '') options.temperature = Number(settings.temperature);
    if (settings.top_p !== '') options.top_p = Number(settings.top_p);
    if (settings.num_ctx !== '') options.num_ctx = Number(settings.num_ctx);
    if (settings.num_predict !== '') options.num_predict = Number(settings.num_predict);
    return options;
  }

  /** Значение параметра think: true/false — явно, undefined — «авто». */
  function thinkPayload() {
    if (settings.think === 'off') return false;
    if (settings.think === 'on') return true;
    return undefined;
  }

  /** История для отправки: системный промпт + последние сообщения. */
  function requestMessages() {
    const messages = [];
    if (settings.system.trim()) messages.push({ role: 'system', content: settings.system.trim() });
    // копии без лишних полей: объекты истории привязаны к пузырям окна вывода
    history.slice(-HISTORY_LIMIT).forEach((item) => messages.push({ role: item.role, content: item.content }));
    return messages;
  }

  // ----------------------------------------------------------------------
  // окно вывода: пузыри сообщений и markdown
  // ----------------------------------------------------------------------
  const RENDER_INTERVAL = 80;   // мс — как часто перерисовывать markdown в потоке

  function viewEl() {
    return $('#chat-view');
  }

  function scrollDown() {
    const checkbox = $('#chat-autoscroll');
    if (checkbox && !checkbox.checked) return;
    const node = viewEl();
    node.scrollTop = node.scrollHeight;
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Разбирает markdown ответа (если markdown.js не подключён — простой текст). */
  function renderMarkdown(text) {
    const lib = window.OllamaMarkdown;
    if (lib && typeof lib.render === 'function') return lib.render(text);
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  /**
   * Служебная строка: баннер, ответ команды, ошибка, статистика.
   * Не пузырь — обычная строка во всю ширину окна вывода.
   */
  function appendLine(text, kind) {
    const line = document.createElement('div');
    line.className = kind ? `msg msg-notice ${kind}` : 'msg msg-notice';
    line.textContent = text;
    viewEl().appendChild(line);
    scrollDown();
    return line;
  }

  /** Полностью очищает окно вывода (используется при очистке контекста). */
  function clearView() {
    viewEl().innerHTML = '';
    scrollDown();
  }

  /** Кнопка действия под сообщением: «изменить» или «перегенерировать». */
  function actionButton(action, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-action';
    button.dataset.action = action;
    button.textContent = label;
    button.title = title;
    return button;
  }

  /**
   * Пузырь пользователя — справа. С пузырём связан объект из истории
   * (wrap.__chatMessage): по нему работают «изменить» и «перегенерировать».
   */
  function appendUserMessage(text, message) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    const col = document.createElement('div');
    col.className = 'msg-col';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.appendChild(actionButton('edit', '✎ Изменить', 'Изменить сообщение и отправить его заново'));
    col.append(bubble, actions);
    wrap.appendChild(col);
    if (message) wrap.__chatMessage = message;
    viewEl().appendChild(wrap);
    scrollDown();
    return { wrap, bubble };
  }

  /** Копирует текст в буфер обмена (с запасным вариантом для старых браузеров). */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      /* нет прав или нет API — пробуем через выделение */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      area.remove();
      return Boolean(ok);
    } catch (err) {
      return false;
    }
  }

  /**
   * Добавляет в блоки кода готового ответа кнопку «копировать», а в блоки
   * html/css/js — ещё и «предпросмотр» (открывает панель справа от чата).
   */
  function decorateCode(root) {
    root.querySelectorAll('.md-code').forEach((block) => {
      const bar = block.querySelector('.code-bar') || block;
      const copy = block.querySelector('.code-copy');
      const language = blockLanguage(block);
      if (!block.querySelector('.code-preview') && PREVIEW_LANGS.includes(language)) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'code-preview';
        preview.textContent = '▶ предпросмотр';
        preview.title = 'Показать этот код в панели предпросмотра справа от чата';
        if (copy) bar.insertBefore(preview, copy);
        else bar.appendChild(preview);
      }
      // «✎ в редакторе» — тот же код, но сразу в редакторе панели: правки
      // пересобирают страницу в изолированном iframe, ничего не сохраняя
      if (!block.querySelector('.code-edit') && PREVIEW_LANGS.includes(language)) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'code-edit';
        edit.textContent = '✎ в редакторе';
        edit.title = 'Открыть этот код в редакторе панели предпросмотра';
        if (copy) bar.insertBefore(edit, copy);
        else bar.appendChild(edit);
      }
      if (copy) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = 'копировать';
      button.title = 'Скопировать блок кода в буфер обмена';
      bar.appendChild(button);
    });
  }

  // ----------------------------------------------------------------------
  // предпросмотр html/css/js из ответа модели (панель справа от чата)
  // ----------------------------------------------------------------------
  // Изоляция: документ собирается в srcdoc, а iframe получает sandbox без
  // allow-same-origin — у предпросмотра свой origin, поэтому доступа к панели,
  // её DOM и localStorage нет. Внутри srcdoc стоит CSP: сеть (connect-src) и
  // отправка форм запрещены, внешние ресурсы не загружаются, а скрипты не
  // выполняются, пока пользователь не поставит флажок «скрипты».
  const PREVIEW_LANGS = ['html', 'htm', 'svg', 'css', 'js', 'javascript', 'mjs'];

  // Редактор кода панели (CodeMirror 5 из static/vendor). Если библиотеки нет
  // или её нельзя создать (например, в jsdom нет раскладки), панель работает
  // с обычной textarea — кнопки и поведение те же.
  const EDITOR_MODES = { html: 'htmlmixed', svg: 'xml', css: 'css', js: 'javascript' };
  const EDITOR_DEBOUNCE = 400; // мс: живое обновление кадра, без перезагрузки на каждую клавишу

  // Признаки, из-за которых предпросмотр может выглядеть пустым: страница
  // рисуется скриптом или тянет внешние файлы (сеть в предпросмотре закрыта).
  const PREVIEW_SCRIPT_RE = /<script[\s>]/i;
  const PREVIEW_EXTERNAL_RE = /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i;

  // Служебная разметка для CSS-блока без html: иначе стили показывать не на чем.
  const PREVIEW_DEMO_BODY = [
    '<h1>Служебная страница предпросмотра</h1>',
    '<p>В ответе нет блока <code>html</code> — показаны типовые элементы,',
    'чтобы было видно, как работает присланный CSS.</p>',
    '<div class="box card">.box / .card</div>',
    '<p><button class="btn">Кнопка</button> <a href="#">Ссылка</a></p>',
    '<ul><li>первый пункт</li><li>второй пункт</li></ul>',
    '<table><thead><tr><th>Колонка</th><th>Значение</th></tr></thead>',
    '<tbody><tr><td>строка</td><td>1</td></tr></tbody></table>',
  ].join('\n');

  let previewState = null;          // { sources, draft, title, note } — что сейчас показано
  let previewApiFullscreen = false; // разворот сделан через Fullscreen API
  let previewRenderId = 0;          // счётчик сборок: каждая перерисовка — новая загрузка
  let editorApi = null;             // обёртка редактора: CodeMirror или запасная textarea
  let editorLang = '';              // активная вкладка редактора: html | css | js
  let editorOpen = false;           // редактор показан над предпросмотром
  let editorTimer = 0;              // отложенная перерисовка кадра после правки

  /** Язык блока кода: класс language-… у <code> или подпись в .code-lang. */
  function blockLanguage(block) {
    const code = block.querySelector('code');
    const match = code ? /(?:^|\s)language-([\w.+#-]+)/i.exec(code.className || '') : null;
    if (match) return match[1].toLowerCase();
    const label = block.querySelector('.code-lang');
    return label ? label.textContent.trim().toLowerCase() : '';
  }

  /** Собирает блоки html/css/js одного сообщения. */
  function collectPreviewSources(msgWrap) {
    const sources = { html: [], css: [], js: [] };
    msgWrap.querySelectorAll('.md-code').forEach((block) => {
      const code = block.querySelector('code');
      if (!code) return;
      const language = blockLanguage(block);
      if (language === 'html' || language === 'htm' || language === 'svg') sources.html.push(code.textContent);
      else if (language === 'css') sources.css.push(code.textContent);
      else if (language === 'js' || language === 'javascript' || language === 'mjs') sources.js.push(code.textContent);
    });
    return sources;
  }

  /** CSP предпросмотра: ни сети, ни форм, ни внешних ресурсов. */
  function previewCsp(allowScripts) {
    const parts = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      'img-src data: blob:',
      'font-src data:',
      'media-src data: blob:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ];
    if (allowScripts) parts.push("script-src 'unsafe-inline'");
    return parts.join('; ');
  }

  /** Мета с CSP плюс номер сборки: документ всегда отличается от предыдущего. */
  function cspMeta(allowScripts, renderId) {
    return `<meta http-equiv="Content-Security-Policy" content="${previewCsp(allowScripts)}">\n`
      + `<!-- предпросмотр #${renderId} -->`;
  }

  /** Ставит CSP в <head> готовой страницы модели (иначе скрипты не отключить). */
  function withCsp(doc, meta) {
    if (/<head[\s>]/i.test(doc)) {
      return doc.replace(/<head([^>]*)>/i, (whole, attrs) => `<head${attrs}>\n${meta}`);
    }
    if (/<html[\s>]/i.test(doc)) {
      return doc.replace(/<html([^>]*)>/i, (whole, attrs) => `<html${attrs}>\n<head>\n${meta}\n</head>`);
    }
    // остался только doctype — мета встанет в неявный <head>
    return doc.replace(/<!doctype[^>]*>/i, (whole) => `${whole}\n${meta}`);
  }

  /** Вставляет фрагмент перед закрывающим тегом, иначе — в конец документа. */
  function injectBefore(html, markup, tag) {
    const pattern = new RegExp(`</${tag}\\s*>`, 'i');
    return pattern.test(html) ? html.replace(pattern, `${markup}\n</${tag}>`) : `${html}\n${markup}`;
  }

  /** Собирает документ для iframe из блоков ответа модели. */
  function previewDocument(sources, allowScripts, renderId) {
    const style = sources.css.length ? `<style>\n${sources.css.join('\n\n')}\n</style>` : '';
    const script = sources.js.length && allowScripts
      ? `<script>\n${sources.js.join('\n;\n')}\n</script>`
      : '';
    const base = sources.html.length ? sources.html.join('\n') : PREVIEW_DEMO_BODY;
    const isFullDocument = /<html[\s>]/i.test(base) || /<!doctype/i.test(base);
    const meta = cspMeta(allowScripts, renderId);

    // Готовая страница модели: CSP дописываем в её <head>, стили — тоже туда,
    // скрипты — в <body>. CSP обязателен и здесь: иначе «скрипты выключены»
    // держались бы только на sandbox, а его флаги меняются лишь при перезагрузке.
    if (isFullDocument) {
      let doc = withCsp(base, meta);
      if (style) doc = injectBefore(doc, style, 'head');
      if (script) doc = injectBefore(doc, script, 'body');
      return doc;
    }

    return [
      '<!DOCTYPE html>',
      '<html lang="ru">',
      '<head>',
      '<meta charset="utf-8">',
      meta,
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      style,
      '</head>',
      '<body>',
      base,
      script,
      '</body>',
      '</html>',
    ].filter(Boolean).join('\n');
  }

  /** Подпись под предпросмотром: что показано и что закрыто. */
  function previewNote(sources, allowScripts) {
    const html = sources.html.join('\n');
    const parts = [previewState.note, allowScripts ? 'скрипты разрешены' : 'скрипты выключены'];
    if (!allowScripts && (sources.js.length || PREVIEW_SCRIPT_RE.test(html))) {
      parts.push('страница рисуется скриптом — поставьте флажок «скрипты»');
    }
    if (PREVIEW_EXTERNAL_RE.test(html)) {
      parts.push('внешние файлы не загружаются: сеть в предпросмотре закрыта');
    }
    return parts.join(' · ');
  }

  /** Перерисовывает предпросмотр для текущего набора блоков. */
  function renderPreview() {
    const frame = $('#preview-frame');
    if (!frame || !previewState) return;
    const checkbox = $('#preview-scripts');
    const allowScripts = Boolean(checkbox && checkbox.checked);
    // Правки редактора (если они есть) заменяют код из ответа модели: сборка
    // документа, CSP и изоляция остаются ровно теми же.
    const sources = draftSources();
    const doc = previewDocument(sources, allowScripts, ++previewRenderId);
    // Порядок важен: флаги sandbox применяются только при следующей загрузке
    // документа, поэтому сначала выгружаем текущий srcdoc, потом меняем sandbox
    // и только затем грузим новый документ (номер сборки делает его уникальным,
    // так что перезагрузка происходит и у кнопки ⟳).
    frame.removeAttribute('srcdoc');
    frame.setAttribute('sandbox', allowScripts ? 'allow-scripts' : '');
    frame.setAttribute('srcdoc', doc);
    const title = $('#preview-title');
    if (title) title.textContent = previewState.title;
    const note = $('#preview-note');
    if (note) note.textContent = previewNote(sources, allowScripts);
  }

  /**
   * Открывает панель предпросмотра по блокам кода указанного сообщения.
   * Второй аргумент { lang: 'css' } открывает панель сразу в редакторе
   * на нужной вкладке (так работает кнопка «✎ в редакторе» у блока кода).
   */
  function openPreview(msgWrap, options) {
    const sources = collectPreviewSources(msgWrap);
    const parts = [];
    if (sources.html.length) parts.push('html');
    if (sources.css.length) parts.push('css');
    if (sources.js.length) parts.push('js');
    if (!parts.length) {
      toast('В этом сообщении нет блоков html, css или js', 'warn');
      return false;
    }
    let note = `Предпросмотр: ${parts.join(' + ')}`;
    if (!sources.html.length) note += ' (разметки нет — показана служебная страница)';
    note += ' · iframe изолирован: панель, куки и сеть недоступны';
    previewState = { sources, draft: null, title: `Предпросмотр · ${parts.join(' + ')}`, note };
    $('#chat-preview').classList.remove('hidden');
    $('#modal-chat').querySelector('.chat-modal-box').classList.add('with-preview');
    const wanted = options && options.lang ? options.lang : '';
    if (wanted) editorLang = wanted;
    // редактор остаётся открытым при смене ответа: вкладки и код пересобираются
    if (wanted || editorOpen) setEditorOpen(true);
    renderPreview();
    return true;
  }

  /** Открыт ли предпросмотр прямо сейчас. */
  function previewIsOpen() {
    const panel = $('#chat-preview');
    return Boolean(panel) && !panel.classList.contains('hidden');
  }

  /** Открывает предпросмотр по блокам кода последнего ответа модели. */
  function openPreviewFromLastAnswer() {
    const answers = viewEl().querySelectorAll('.msg-assistant');
    if (!answers.length) {
      toast('Сначала получите ответ модели: предпросмотр берёт код из ответа', 'warn');
      return false;
    }
    return openPreview(answers[answers.length - 1]);
  }

  /** Прячет панель предпросмотра (содержимое остаётся в памяти). */
  function closePreview() {
    setPreviewFullscreen(false);
    setEditorOpen(false);
    const panel = $('#chat-preview');
    if (panel) panel.classList.add('hidden');
    const modal = $('#modal-chat');
    const box = modal ? modal.querySelector('.chat-modal-box') : null;
    if (box) box.classList.remove('with-preview');
  }

  function isPreviewFullscreen() {
    const panel = $('#chat-preview');
    return Boolean(panel) && panel.classList.contains('is-fullscreen');
  }

  /** Разворот на весь экран: класс CSS плюс Fullscreen API, если он доступен. */
  function setPreviewFullscreen(on) {
    const panel = $('#chat-preview');
    if (!panel || isPreviewFullscreen() === on) return;
    panel.classList.toggle('is-fullscreen', on);
    // размеры панели изменились — редактору нужно перемерить раскладку
    if (editorApi) editorApi.refresh();
    const button = $('#btn-preview-fullscreen');
    if (button) {
      button.title = on ? 'Вернуть предпросмотр в окно (Esc)' : 'Развернуть на весь экран (Esc — вернуть)';
    }
    try {
      if (on && typeof panel.requestFullscreen === 'function' && !document.fullscreenElement) {
        previewApiFullscreen = true;
        const result = panel.requestFullscreen();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } else if (!on && document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        previewApiFullscreen = false;
        const result = document.exitFullscreen();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch (err) {
      /* Fullscreen API может быть недоступен — остаётся разворот средствами CSS */
    }
  }

  // ----------------------------------------------------------------------
  // редактор кода панели предпросмотра (CodeMirror 5 из static/vendor)
  // ----------------------------------------------------------------------

  /**
   * Можно ли создать CodeMirror: он измеряет текст через Range.getBoundingClientRect,
   * которого нет там, где нет раскладки (jsdom, старые окружения). Проверка нужна,
   * чтобы вместо исключения панель молча перешла на запасную textarea.
   */
  function editorCanUseCodeMirror() {
    if (typeof window.CodeMirror !== 'function') return false;
    try {
      const range = document.createRange();
      return typeof range.getBoundingClientRect === 'function';
    } catch (err) {
      return false;
    }
  }

  /** Запасной редактор: обычная textarea, если CodeMirror недоступен. */
  function createFallbackEditor(host, onChange) {
    const area = document.createElement('textarea');
    area.className = 'editor-fallback';
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Код предпросмотра');
    host.appendChild(area);
    area.addEventListener('input', () => onChange());
    return {
      rich: false,
      setValue: (value) => { area.value = value; },
      getValue: () => area.value,
      setMode: () => {},
      focus: () => area.focus(),
      refresh: () => {},
    };
  }

  /** Редактор на CodeMirror: подсветка, номера строк, автозакрытие тегов. */
  function createCodeMirrorEditor(host, onChange) {
    const editor = window.CodeMirror(host, {
      value: '',
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      autoCloseBrackets: true,
      autoCloseTags: true,
      matchBrackets: true,
      viewportMargin: 20, // длинный файл подсвечивается по мере прокрутки
      extraKeys: {
        'Shift-Tab': 'indentLess',
        'Ctrl-Enter': () => applyEditor(),
        'Cmd-Enter': () => applyEditor(),
        Esc: (cm, event) => {
          // событие гасится, иначе Esc дойдёт до обработчика окна и закроет панель
          if (event) event.stopPropagation();
          setEditorOpen(false);
        },
      },
    });
    let silent = false; // загрузка кода вкладки не должна выглядеть как правка
    editor.on('change', () => { if (!silent) onChange(); });
    return {
      rich: true,
      setValue: (value) => {
        if (editor.getValue() === value) return;
        silent = true;
        editor.setValue(value);
        silent = false;
        editor.clearHistory(); // история отмены не переезжает между вкладками
      },
      getValue: () => editor.getValue(),
      setMode: (lang) => editor.setOption('mode', EDITOR_MODES[lang] || 'htmlmixed'),
      focus: () => editor.focus(),
      refresh: () => editor.refresh(),
    };
  }

  /** Создаёт редактор в контейнере панели; при сбое CodeMirror — textarea. */
  function createEditor(host, onChange) {
    if (editorCanUseCodeMirror()) {
      try {
        return createCodeMirrorEditor(host, onChange);
      } catch (err) {
        host.textContent = ''; // убираем недорисованную разметку CodeMirror
      }
    }
    return createFallbackEditor(host, onChange);
  }

  /** Вкладки редактора: html — всегда (разметку можно дописать), css/js — если есть. */
  function editorLangs() {
    const sources = previewState.sources;
    const langs = ['html'];
    if (sources.css.length) langs.push('css');
    if (sources.js.length) langs.push('js');
    return langs;
  }

  /** Язык вкладки редактора для блока кода из чата. */
  function editorLangOf(block) {
    const language = blockLanguage(block);
    if (language === 'css') return 'css';
    if (language === 'js' || language === 'javascript' || language === 'mjs') return 'js';
    return 'html';
  }

  /** Черновик правок: при первом открытии редактора копируется из ответа модели. */
  function ensureDraft() {
    if (!previewState.draft) {
      previewState.draft = {
        html: previewState.sources.html.join('\n'),
        css: previewState.sources.css.join('\n'),
        js: previewState.sources.js.join('\n'),
      };
    }
    return previewState.draft;
  }

  /** Код для сборки документа: правки редактора, если они уже есть. */
  function draftSources() {
    const draft = previewState.draft;
    if (!draft) return previewState.sources;
    const pick = (lang) => (draft[lang] ? [draft[lang]] : []);
    return { html: pick('html'), css: pick('css'), js: pick('js') };
  }

  /** Пересобирает вкладки редактора под текущий ответ. */
  function buildEditorTabs() {
    const box = $('#preview-editor-tabs');
    if (!box) return;
    box.textContent = '';
    editorLangs().forEach((lang) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'btn btn-sm editor-tab';
      tab.dataset.lang = lang;
      tab.textContent = lang;
      tab.title = lang === 'html'
        ? 'Разметка страницы (html)'
        : `Правки в блоке ${lang}`;
      tab.addEventListener('click', () => showEditorLang(lang));
      box.appendChild(tab);
    });
    markEditorTabs();
  }

  /** Подсвечивает активную вкладку. */
  function markEditorTabs() {
    const box = $('#preview-editor-tabs');
    if (!box) return;
    box.querySelectorAll('.editor-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.lang === editorLang);
    });
  }

  /** Кладёт в редактор код активной вкладки, не сохраняя текущий текст. */
  function loadEditorContent() {
    if (!editorApi || !previewState) return;
    const draft = ensureDraft();
    editorApi.setMode(editorLang);
    editorApi.setValue(draft[editorLang] || '');
    markEditorTabs();
    updateEditorState(false);
  }

  /** Переключает вкладку: текст текущей сохраняется, загружается текст новой. */
  function showEditorLang(lang) {
    if (!editorApi || !previewState || !lang) return;
    if (editorLang && editorLang !== lang) ensureDraft()[editorLang] = editorApi.getValue();
    editorLang = lang;
    loadEditorContent();
    editorApi.focus();
  }

  /** Открыт ли редактор кода. */
  function editorIsOpen() {
    return editorOpen;
  }

  /** Показывает или прячет редактор; предпросмотр остаётся ниже него. */
  function setEditorOpen(on) {
    const pane = $('#preview-editor');
    const panel = $('#chat-preview');
    if (!pane || !panel) return;
    editorOpen = Boolean(on) && Boolean(previewState);
    pane.classList.toggle('hidden', !editorOpen);
    panel.classList.toggle('is-editing', editorOpen);
    const button = $('#btn-preview-edit');
    if (button) {
      button.classList.toggle('is-active', editorOpen);
      button.title = editorOpen
        ? 'Вернуться к просмотру (Esc)'
        : 'Править код в панели (Ctrl+Enter — применить)';
    }
    if (!editorOpen) return;
    const langs = editorLangs();
    if (!langs.includes(editorLang)) editorLang = langs[0];
    buildEditorTabs();
    if (!editorApi) editorApi = createEditor($('#preview-editor-host'), onEditorInput);
    loadEditorContent();
    editorApi.refresh();
    editorApi.focus();
  }

  /** Правка в редакторе: сразу запоминается, затем с задержкой уходит в кадр. */
  function onEditorInput() {
    if (!editorApi || !editorOpen || !previewState) return;
    ensureDraft()[editorLang] = editorApi.getValue();
    updateEditorState(true);
    clearTimeout(editorTimer);
    editorTimer = setTimeout(applyEditor, EDITOR_DEBOUNCE);
  }

  /** Применяет правки к предпросмотру: кнопка «применить» и Ctrl+Enter. */
  function applyEditor() {
    clearTimeout(editorTimer);
    if (!editorApi || !editorOpen || !previewState) return;
    ensureDraft()[editorLang] = editorApi.getValue();
    renderPreview();
    updateEditorState(false);
  }

  /** Возвращает код из ответа модели, отбрасывая правки. */
  function resetEditor() {
    if (!previewState) return;
    clearTimeout(editorTimer);
    previewState.draft = null;
    ensureDraft();
    if (editorApi) editorApi.setValue(previewState.draft[editorLang] || '');
    renderPreview();
    updateEditorState(false);
  }

  /** Подпись в редакторе: применены ли правки и что с ними происходит. */
  function updateEditorState(dirty) {
    const label = $('#preview-editor-state');
    if (!label || !previewState) return;
    const sources = previewState.sources;
    const draft = previewState.draft;
    const changed = Boolean(draft) && ['html', 'css', 'js']
      .some((lang) => (draft[lang] || '') !== sources[lang].join('\n'));
    if (dirty) label.textContent = 'применяем правки…';
    else if (changed) label.textContent = 'правки применены — в файлы не сохраняются';
    else label.textContent = 'код из ответа модели';
  }

  /** Кнопки и клавиши панели предпросмотра. */
  function bindPreviewEvents() {
    $('#btn-preview').addEventListener('click', () => {
      if (previewIsOpen()) closePreview();
      else openPreviewFromLastAnswer();
    });
    $('#btn-preview-close').addEventListener('click', closePreview);
    // «✎ код»: открыть редактор (при необходимости сначала открыв панель);
    // повторный клик или Esc возвращают к просмотру
    $('#btn-preview-edit').addEventListener('click', () => {
      if (editorIsOpen()) {
        setEditorOpen(false);
        return;
      }
      if (!previewIsOpen() && !openPreviewFromLastAnswer()) return;
      setEditorOpen(true);
    });
    $('#btn-editor-apply').addEventListener('click', applyEditor);
    $('#btn-editor-reset').addEventListener('click', resetEditor);
    $('#btn-preview-refresh').addEventListener('click', renderPreview);
    $('#btn-preview-fullscreen').addEventListener('click', () => setPreviewFullscreen(!isPreviewFullscreen()));
    $('#preview-scripts').addEventListener('change', renderPreview);
    // браузер вышел из полноэкранного режима сам — снимаем класс
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && previewApiFullscreen && isPreviewFullscreen()) {
        previewApiFullscreen = false;
        setPreviewFullscreen(false);
      }
    });
  }

  /**
   * Создаёт пузырь ответа модели — слева. Внутри: сворачиваемый блок
   * «размышлений» (qwen3, deepseek-r1 и подобные) и markdown-текст ответа,
   * который перерисовывается по мере поступления токенов.
   *
   * Если передан resumeWrap, новый пузырь не создаётся: панель дописывает текст
   * в уже существующий ответ (кнопка «▶ Продолжить»), а блок «размышлений»,
   * если он был, продолжает накапливать текст.
   */
  function createAnswerMessage(message, resumeWrap) {
    const wrap = resumeWrap || document.createElement('div');
    const col = resumeWrap ? resumeWrap.querySelector('.msg-col') : document.createElement('div');
    const bubble = resumeWrap ? resumeWrap.querySelector('.bubble') : document.createElement('div');
    const body = resumeWrap ? resumeWrap.querySelector('.md') : document.createElement('div');
    if (!resumeWrap) {
      wrap.className = 'msg msg-assistant';
      col.className = 'msg-col';
      bubble.className = 'bubble';
      body.className = 'md';
      bubble.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.appendChild(actionButton('regenerate', '↻ Перегенерировать', 'Получить другой ответ на этот вопрос'));
      actions.appendChild(actionButton(
        'continue',
        '▶ Продолжить',
        'Дописать этот ответ с того места, где модель остановилась ' +
        '(всё, что было после него, отбрасывается)'
      ));
      col.append(bubble, actions);
      wrap.appendChild(col);
      viewEl().appendChild(wrap);
    }
    if (message) wrap.__chatMessage = message;
    scrollDown();

    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    cursor.textContent = '▌';

    const state = {
      wrap,
      bubble,
      body,
      cursor,
      thinkBlock: null,
      thinkBody: null,
      thinkToggle: null,
      thinkingText: '',
      // при продолжении текст начинается с уже показанного ответа
      answerText: resumeWrap && message ? message.content || '' : '',
      renderedAt: 0,
      timer: null,
    };

    /** Блок «размышлений» (thinking) — у моделей qwen3, deepseek-r1 и подобных. */
    state.thinking = function thinking() {
      if (!state.thinkBlock) {
        const block = document.createElement('div');
        block.className = 'think-block is-open';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'think-toggle';
        toggle.innerHTML =
          '<span class="think-arrow">▾</span> ' +
          '<span class="think-label">модель размышляет…</span> ' +
          '<span class="think-size"></span>';
        toggle.addEventListener('click', () => {
          const open = block.classList.toggle('is-open');
          toggle.querySelector('.think-arrow').textContent = open ? '▾' : '▸';
        });

        const thinkBody = document.createElement('div');
        thinkBody.className = 'think-body';

        block.append(toggle, thinkBody);
        bubble.insertBefore(block, body);
        state.thinkBlock = block;
        state.thinkBody = thinkBody;
        state.thinkToggle = toggle;
      }
      return state.thinkBody;
    };

    /** Дописывает порцию размышлений и обновляет подпись блока. */
    state.updateThinking = function updateThinking(text) {
      state.thinkingText = text;
      state.thinking().textContent = text;
      state.thinkToggle.querySelector('.think-size').textContent = `(${text.length} симв.)`;
      scrollDown();
    };

    /** Сворачивает блок размышлений (вызывается, когда пошёл ответ). */
    state.collapseThinking = function collapseThinking() {
      if (!state.thinkBlock) return;
      const chars = state.thinkingText.length;
      state.thinkBlock.classList.remove('is-open');
      state.thinkToggle.querySelector('.think-arrow').textContent = '▸';
      state.thinkToggle.querySelector('.think-label').textContent = 'Размышления модели';
      state.thinkToggle.querySelector('.think-size').textContent =
        chars ? `(${chars} симв., нажмите чтобы раскрыть)` : '';
      state.thinkToggle.title = 'Показать или скрыть размышления модели';
    };

    /** Были ли у этого ответа размышления. */
    state.hasThinking = function hasThinking() {
      return Boolean(state.thinkBlock);
    };

    /** Перерисовывает markdown ответа. */
    function paint(final) {
      state.renderedAt = Date.now();
      state.body.innerHTML = renderMarkdown(state.answerText);
      if (final) decorateCode(state.body);
      scrollDown();
    }

    /** Перерисовка с ограничением частоты: поток токенов не должен тормозить. */
    function schedulePaint(final) {
      if (state.timer) {
        if (!final) return;
        clearTimeout(state.timer);
        state.timer = null;
      }
      const elapsed = Date.now() - state.renderedAt;
      if (final || elapsed >= RENDER_INTERVAL) {
        paint(final);
        return;
      }
      state.timer = setTimeout(() => {
        state.timer = null;
        paint(false);
      }, RENDER_INTERVAL - elapsed);
    }

    /** Дописывает текст ответа (markdown разбирается на лету). */
    state.setAnswer = function setAnswer(text) {
      state.answerText = text;
      schedulePaint(false);
    };

    /** Завершает поток: финальная отрисовка, курсор убирается, «размышления» сворачиваются. */
    state.finish = function finish() {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.collapseThinking();
      cursor.remove();
      paint(true);
    };

    /** Заглушка вместо пустого ответа. */
    state.setPlaceholder = function setPlaceholder(text) {
      const note = document.createElement('span');
      note.className = 'md-placeholder';
      note.textContent = text;
      state.body.innerHTML = '';
      state.body.appendChild(note);
      scrollDown();
    };

    // продолжение: блок «размышлений» уже в пузыре — раскрываем его и дописываем
    // текст в тот же блок, чтобы не появилось второго
    if (resumeWrap) {
      const thinkBlock = wrap.querySelector('.think-block');
      if (thinkBlock) {
        state.thinkBlock = thinkBlock;
        state.thinkBody = thinkBlock.querySelector('.think-body');
        state.thinkToggle = thinkBlock.querySelector('.think-toggle');
        state.thinkingText = state.thinkBody ? state.thinkBody.textContent : '';
        thinkBlock.classList.add('is-open');
        if (state.thinkToggle) {
          state.thinkToggle.querySelector('.think-arrow').textContent = '▾';
          state.thinkToggle.querySelector('.think-label').textContent = 'модель размышляет…';
        }
      }
    }

    bubble.appendChild(cursor);   // курсор в конце пузыря, пока идёт генерация
    scrollDown();
    return state;
  }


  // ----------------------------------------------------------------------
  // действия над сообщениями: «изменить», «перегенерировать» и «продолжить»
  // ----------------------------------------------------------------------
  /** Пока идёт генерация, менять историю нельзя. */
  function actionsLocked() {
    if (!streaming) return false;
    toast('Дождитесь ответа или нажмите «Стоп»', 'warn');
    return true;
  }

  /** Убирает из истории пустое сообщение (ответ не пришёл или был прерван). */
  function dropMessage(message) {
    const index = history.indexOf(message);
    if (index !== -1 && !message.content) history.splice(index, 1);
  }

  /**
   * Выбрасывает сообщение из истории и из окна: includeSelf — вместе с ним
   * самим, иначе — только всё, что идёт после него.
   */
  function truncateFrom(wrap, includeSelf) {
    const message = wrap.__chatMessage;
    const index = message ? history.indexOf(message) : -1;
    if (index !== -1) history.splice(includeSelf ? index : index + 1);
    let node = wrap.nextElementSibling;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }
    if (includeSelf) wrap.remove();
    updateContextBadge();
  }

  /**
   * Перегенерация ответа: старый ответ (и всё, что после него) убирается
   * из истории и окна, запрос повторяется по тому же контексту.
   */
  function regenerateAnswer(wrap) {
    if (actionsLocked()) return;
    if (!settings.model) {
      appendLine('--- сначала выберите модель ---', 'error');
      return;
    }
    truncateFrom(wrap, true);
    streamAnswer();
  }

  /**
   * Продолжение ответа: модель «затыкается» на середине (лимит num_predict,
   * обрыв потока, нажатый «Стоп») — текст ответа остаётся в истории, и запрос
   * уходит снова с ним в конце: Ollama дописывает ответ с того же места
   * (assistant-prefill), а панель дописывает токены в тот же пузырь.
   * Всё, что было после этого ответа, отбрасывается — как при «перегенерировать».
   */
  function continueAnswer(wrap) {
    if (actionsLocked()) return;
    if (!settings.model) {
      appendLine('--- сначала выберите модель ---', 'error');
      return;
    }
    const message = wrap.__chatMessage;
    if (!message || !message.content || !history.includes(message)) {
      // продолжать нечего: ответ пустой или его уже нет в истории
      regenerateAnswer(wrap);
      return;
    }
    truncateFrom(wrap, false);
    streamAnswer({ resumeWrap: wrap });
  }

  /** Пузырь последнего ответа модели (нужен команде /continue). */
  function lastAnswerWrap() {
    const last = history[history.length - 1];
    if (!last || last.role !== 'assistant') return null;
    return Array.from(viewEl().querySelectorAll('.msg-assistant'))
      .find((node) => node.__chatMessage === last) || null;
  }

  /** Продолжение последнего ответа (команда /continue). */
  function continueLastAnswer() {
    if (actionsLocked()) return;
    const wrap = lastAnswerWrap();
    if (!wrap) {
      appendLine('--- продолжать нечего: последнее сообщение в диалоге — не ответ модели ---', 'error');
      return;
    }
    continueAnswer(wrap);
  }

  /**
   * Возвращает сообщение в обычный вид: поле правки убирается, пузырь снова виден.
   * Используется кнопкой «Отмена», Esc и при начале правки другого сообщения.
   */
  function closeEditor(wrap) {
    const editor = wrap.querySelector('.msg-editor');
    if (editor) editor.remove();
    const bubble = wrap.querySelector('.bubble');
    if (bubble) bubble.classList.remove('hidden');
    wrap.classList.remove('is-editing');
  }

  /**
   * Правка сообщения пользователя: пузырь превращается в поле ввода.
   * «Отправить» заменяет текст вопроса, отбрасывает прежний ответ и
   * запускает генерацию заново; «Отмена»/Esc возвращают всё как было.
   */
  function startEditMessage(wrap) {
    if (actionsLocked()) return;
    // одновременно правится только одно сообщение
    viewEl().querySelectorAll('.msg.is-editing').forEach(closeEditor);
    if (wrap.querySelector('.msg-editor')) return;
    const message = wrap.__chatMessage;
    const bubble = wrap.querySelector('.bubble');
    const col = wrap.querySelector('.msg-col');
    if (!message || !bubble || !col) return;

    const original = message.content;
    const editor = document.createElement('div');
    editor.className = 'msg-editor';
    const area = document.createElement('textarea');
    area.className = 'input msg-editor-input';
    area.rows = 3;
    area.value = original;
    area.title = 'Enter — отправить заново, Shift+Enter — новая строка, Esc — отмена';
    const buttons = document.createElement('div');
    buttons.className = 'msg-editor-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-sm btn-primary';
    save.textContent = 'Отправить';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm';
    cancel.textContent = 'Отмена';
    buttons.append(save, cancel);
    editor.append(area, buttons);

    /** Возвращает окно в обычный вид и убирает поле правки. */
    const stopEdit = () => closeEditor(wrap);

    const commit = () => {
      const value = area.value.trim();
      if (!value) {
        toast('Сообщение не может быть пустым', 'warn');
        area.focus();
        return;
      }
      if (value === original) {   // текст не изменился — переспрашивать нечего
        stopEdit();
        return;
      }
      stopEdit();
      bubble.textContent = value;
      message.content = value;
      truncateFrom(wrap, false);   // прежний ответ больше не актуален
      streamAnswer();
    };

    save.addEventListener('click', commit);
    cancel.addEventListener('click', () => {
      stopEdit();
      $('#chat-input').focus();
    });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();   // Esc отменяет правку, но не закрывает окно чата
        stopEdit();
        $('#chat-input').focus();
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    });

    bubble.classList.add('hidden');
    wrap.classList.add('is-editing');
    col.insertBefore(editor, bubble);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    scrollDown();
  }

  function statsLine(stats) {
    const parts = [];
    if (stats.eval_count) parts.push(`${stats.eval_count} ток.`);
    if (stats.tokens_per_second) parts.push(`${stats.tokens_per_second} ток/с`);
    if (stats.eval_seconds) parts.push(`генерация ${stats.eval_seconds} с`);
    if (stats.prompt_eval_count) parts.push(`промпт ${stats.prompt_eval_count} ток.`);
    if (stats.load_seconds) parts.push(`загрузка ${stats.load_seconds} с`);
    if (stats.done_reason) parts.push(stats.done_reason);
    return parts.length ? `--- ${parts.join(' · ')} ---` : '--- готово ---';
  }

  function setBusy(busy) {
    $('#btn-send').disabled = busy;
    $('#btn-stop').disabled = !busy;
    // на время генерации кнопки сообщений не показываем (см. chat.css)
    viewEl().classList.toggle('is-busy', busy);
  }

  function updateContextBadge() {
    const badge = $('#badge-context');
    badge.textContent = `сообщений: ${history.length}`;
    badge.title = settings.system
      ? `system: ${settings.system.slice(0, 200)}`
      : 'системный промпт не задан';
  }

  /**
   * Очистка контекста: история диалога забывается и окно вывода очищается
   * целиком (кнопка «Очистить контекст», команда /clear, смена system).
   */
  function clearConversation(notice) {
    history = [];
    clearView();
    updateContextBadge();
    if (notice) appendLine(notice, 'system');
  }

  function updateModelBadge() {
    $('#badge-model').textContent = `модель: ${settings.model || '—'}`;
    $('#chat-model-title').textContent = settings.model || '—';
    $('#badge-keepalive').textContent = `keep_alive: ${settings.keepAlive}`;
  }

  /** Кнопка «Размышления: авто/выкл/вкл» в шапке окна чата. */
  function updateThinkButton() {
    const button = $('#btn-think');
    if (!button) return;
    button.textContent = `Размышления: ${THINK_LABELS[settings.think] || 'авто'}`;
    button.classList.toggle('btn-primary', settings.think === 'off');
  }

  /** Переключает размышления по кругу: авто → выкл → вкл → авто. */
  function cycleThink() {
    const order = ['auto', 'off', 'on'];
    const next = order[(order.indexOf(settings.think) + 1) % order.length];
    setThink(next, true);
  }

  function setThink(mode, announce) {
    settings.think = THINK_MODES.includes(mode) ? mode : 'auto';
    saveSettings();
    syncSettingsForm();
    if (announce) {
      const hint = settings.think === 'off'
        ? ' — модель ответит без размышлений (think=false)'
        : settings.think === 'on'
          ? ' — запрос уйдёт с think=true (модель должна уметь размышлять)'
          : ' — параметр think не передаётся, решает модель';
      appendLine(`--- размышления: ${THINK_LABELS[settings.think]}${hint} ---`, 'system');
    }
  }


  /** Показывает, загружена ли текущая модель в память (аналог `ollama ps`). */
  async function refreshMemoryBadge() {
    const badge = $('#badge-memory');
    try {
      const data = await api('/api/ps');
      const running = (data.models || []).find((item) => item.name === settings.model);
      if (running) {
        badge.textContent = `в памяти: ${running.size_human} (VRAM ${running.vram_percent}%)`;
        badge.className = 'badge ok';
        badge.title = running.expires_at
          ? `Выгрузится: ${new Date(running.expires_at).toLocaleString('ru-RU')}`
          : 'Загружена в память';
      } else {
        badge.textContent = 'в памяти: нет';
        badge.className = 'badge';
        badge.title = 'Модель загрузится автоматически при первом запросе';
      }
    } catch (err) {
      badge.textContent = 'в памяти: нет данных';
      badge.className = 'badge warn';
      badge.title = err.message;
    }
  }

  function startMemoryTimer() {
    if (memoryTimer) clearInterval(memoryTimer);
    memoryTimer = setInterval(refreshMemoryBadge, 10000);
  }

  function stopMemoryTimer() {
    if (memoryTimer) {
      clearInterval(memoryTimer);
      memoryTimer = null;
    }
  }

  async function loadModelList() {
    const select = $('#chat-model');
    try {
      const data = await api('/api/models');
      const models = data.models || [];
      select.innerHTML = '';
      models.forEach((model) => {
        const option = document.createElement('option');
        option.value = model.name;
        option.textContent = `${model.name} · ${model.size_human}`;
        select.appendChild(option);
      });
      if (!models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '(модели не найдены)';
        select.appendChild(option);
      }
      if (settings.model && models.some((model) => model.name === settings.model)) {
        select.value = settings.model;
      } else if (models.length) {
        settings.model = models[0].name;
        select.value = settings.model;
        saveSettings();
      }
    } catch (err) {
      toast(`Не удалось получить список моделей: ${err.message}`, 'err', 10000);
    }
    updateModelBadge();
  }


  // ----------------------------------------------------------------------
  // отправка сообщения и приём потока токенов
  // ----------------------------------------------------------------------
  async function sendMessage(text) {
    const message = (text || '').trim();
    if (!message || streaming) return;
    if (!settings.model) {
      appendLine('--- сначала выберите модель ---', 'error');
      return;
    }
    const record = { role: 'user', content: message };
    history.push(record);
    appendUserMessage(message, record);
    updateContextBadge();
    await streamAnswer();
  }

  async function streamAnswer({ resumeWrap = null } = {}) {
    const payload = {
      model: settings.model,
      messages: requestMessages(),
      keep_alive: settings.keepAlive,
    };
    const options = chatOptions();
    if (Object.keys(options).length) payload.options = options;
    const think = thinkPayload();
    if (think !== undefined) payload.think = think;

    streaming = true;
    setBusy(true);
    // Ответ попадает в историю сразу, но с пустым текстом: так пузырь ответа
    // знает своё место в истории (нужно для «перегенерировать» и «изменить»).
    // При продолжении ответ уже есть в истории и уходит в модель последним
    // сообщением — новый пузырь и новая запись в истории не нужны.
    const resumeMessage = resumeWrap ? resumeWrap.__chatMessage : null;
    const assistantMessage = resumeMessage || { role: 'assistant', content: '' };
    if (!resumeMessage) {
      history.push(assistantMessage);
      updateContextBadge();
    }
    const nodes = createAnswerMessage(assistantMessage, resumeWrap);
    let answer = nodes.answerText;
    let thinking = nodes.thinkingText;
    let stats = null;
    let streamError = null;
    controller = new AbortController();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch (err) { /* тело не JSON — оставляем HTTP-код */ }
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();
        chunks.forEach((chunk) => {
          const raw = chunk.split('\n').find((part) => part.startsWith('data:'));
          if (!raw) return;
          let event = null;
          try {
            event = JSON.parse(raw.slice(5).trim());
          } catch (err) {
            return;
          }
          if (event.type === 'thinking') {
            thinking += event.content || '';
            nodes.updateThinking(thinking);
          } else if (event.type === 'chunk') {
            // ответ пошёл — блок размышлений сворачиваем, он больше не нужен
            nodes.collapseThinking();
            answer += event.content || '';
            assistantMessage.content = answer;   // история обновляется на лету
            nodes.setAnswer(answer);
          } else if (event.type === 'done') {
            stats = event.stats || null;
          } else if (event.type === 'error') {
            streamError = event.message || 'неизвестная ошибка';
          }
        });
        if (streamError) break;
      }

      nodes.finish();
      if (streamError) throw new Error(streamError);
      if (!answer) {
        dropMessage(assistantMessage);   // пустой ответ в истории не нужен
        if (nodes.hasThinking()) {
          appendLine(
            '--- модель вернула только размышления: включите ответ кнопкой «Размышления: выкл» ' +
            'или увеличьте num_predict ---',
            'meta'
          );
        } else {
          nodes.setPlaceholder('(модель не вернула текст)');
        }
      }
      updateContextBadge();
      if (stats && (stats.eval_count || stats.total_seconds)) {
        const badge = $('#badge-stats');
        badge.textContent = `токенов: ${stats.eval_count} · ${stats.tokens_per_second} ток/с`;
        badge.title = `Промпт: ${stats.prompt_eval_count} ток. · всего ${stats.total_seconds} с`;
        appendLine(statsLine(stats), 'meta');
      }
      // ответ оборвался на лимите длины — подсказываем, как его дописать
      if (stats && stats.done_reason === 'length') {
        appendLine(
          '--- ответ оборван по лимиту длины (num_predict): нажмите «▶ Продолжить» ' +
          'у ответа или увеличьте num_predict ---',
          'meta'
        );
      }
    } catch (err) {
      nodes.finish();
      assistantMessage.content = answer;   // частичный ответ (если что-то успело прийти)
      if (!answer) dropMessage(assistantMessage);
      updateContextBadge();
      if (err.name === 'AbortError') {
        appendLine('--- генерация прервана (Стоп) ---', 'system');
        if (!answer) nodes.setPlaceholder('(генерация прервана)');
      } else {
        appendLine(`--- ошибка: ${err.message} ---`, 'error');
        if (!answer) nodes.setPlaceholder('(ответ не получен)');
        if (/does not support thinking/i.test(err.message)) {
          appendLine(
            '--- эта модель не умеет размышлять: переключите «Размышления» в «авто» или «выкл» ---',
            'meta'
          );
        }
        if (resumeWrap) {
          appendLine(
            '--- продолжить не удалось: прежний ответ ушёл в модель как начало, ' +
            'но она его не приняла — попробуйте «↻ Перегенерировать» ---',
            'meta'
          );
        }
        toast(`Ошибка чата: ${err.message}`, 'err', 12000);
      }
    } finally {
      controller = null;
      streaming = false;
      setBusy(false);
      refreshMemoryBadge();
    }
  }


  // ----------------------------------------------------------------------
  // команды в стиле CLI (`/help`, `/think`, `/bye` …)
  // ----------------------------------------------------------------------
  const HELP_TEXT = [
    '/help, /?                  — эта справка',
    '/clear                     — забыть историю диалога и очистить окно',
    '/continue                  — дописать последний ответ с места обрыва',
    '/system <текст|off>        — системный промпт (начинает новый диалог)',
    '/think <auto|off|on>       — размышления модели (think)',
    '/temp <0…2>                — temperature',
    '/top_p <0…1>               — top_p',
    '/ctx <512…131072>          — размер контекста (num_ctx)',
    '/predict <-1…8192>         — максимум токенов ответа (num_predict)',
    '/keep_alive <5m|1h|0|-1>   — сколько держать модель в памяти',
    '/model <имя>               — сменить модель',
    '/load                      — загрузить модель в память',
    '/unload                    — выгрузить модель из памяти',
    '/ps                        — что сейчас в памяти',
    '/info                      — текущие параметры',
    '/bye                       — выгрузить модель и закрыть окно',
  ];

  function showHelp() {
    HELP_TEXT.forEach((line) => appendLine(line, 'system'));
  }

  function setNumberOption(key, rawValue, low, high, label) {
    const value = Number(String(rawValue).replace(',', '.'));
    if (!String(rawValue).trim() || Number.isNaN(value) || value < low || value > high) {
      appendLine(`--- ${label}: укажите число от ${low} до ${high} ---`, 'error');
      return;
    }
    settings[key] = String(value);
    saveSettings();
    syncSettingsForm();
    appendLine(`--- ${label} = ${value} ---`, 'system');
  }

  function setIntOption(key, rawValue, low, high, label) {
    const value = Number.parseInt(String(rawValue), 10);
    if (!String(rawValue).trim() || Number.isNaN(value) || value < low || value > high) {
      appendLine(`--- ${label}: укажите целое число от ${low} до ${high} ---`, 'error');
      return;
    }
    settings[key] = String(value);
    saveSettings();
    syncSettingsForm();
    appendLine(`--- ${label} = ${value} ---`, 'system');
  }

  function setKeepAlive(rawValue) {
    const value = String(rawValue).trim();
    if (!/^-?\d+(\.\d+)?(ms|us|ns|s|m|h)?$/.test(value)) {
      appendLine('--- keep_alive: примеры значений: 5m, 1h, 300, 0, -1 ---', 'error');
      return;
    }
    settings.keepAlive = value;
    saveSettings();
    syncSettingsForm();
    appendLine(`--- keep_alive = ${value} ---`, 'system');
  }

  function setSystem(text) {
    const value = (text || '').trim();
    const off = !value || value.toLowerCase() === 'off';
    settings.system = off ? '' : value;
    saveSettings();
    syncSettingsForm();
    clearConversation();
    appendLine(off ? '--- системный промпт сброшен ---' : `--- системный промпт: ${value} ---`, 'system');
    appendLine('--- контекст очищен: новый диалог, окно очищено ---', 'system');
  }

  function setModel(name) {
    const value = (name || '').trim();
    if (!value) {
      appendLine(`--- текущая модель: ${settings.model} ---`, 'system');
      return;
    }
    settings.model = value;
    const select = $('#chat-model');
    if (!Array.from(select.options).some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = value;
    saveSettings();
    updateModelBadge();
    appendLine(`--- модель: ${value} ---`, 'system');
    refreshMemoryBadge();
  }


  async function loadModelToMemory(keepAlive) {
    if (!settings.model) {
      appendLine('--- модель не выбрана ---', 'error');
      return;
    }
    const keep = String(keepAlive || settings.keepAlive || CONFIG.preloadKeepAlive).trim();
    appendLine(`--- загружаю ${settings.model} в память (keep_alive=${keep}) ---`, 'system');
    try {
      const result = await postJson('/api/models/load', { name: settings.model, keep_alive: keep });
      appendLine(`--- ${result.message || 'модель в памяти'} ---`, 'system');
    } catch (err) {
      appendLine(`--- не удалось загрузить модель: ${err.message} ---`, 'error');
    }
    refreshMemoryBadge();
  }

  async function unloadModelFromMemory(silent) {
    if (!settings.model) return;
    try {
      await postJson('/api/models/unload', { name: settings.model });
      if (!silent) appendLine(`--- модель ${settings.model} выгружена из памяти ---`, 'system');
    } catch (err) {
      appendLine(`--- не удалось выгрузить модель: ${err.message} ---`, 'error');
    }
    refreshMemoryBadge();
  }

  async function showRunningModels() {
    try {
      const data = await api('/api/ps');
      const models = data.models || [];
      if (!models.length) {
        appendLine('--- в памяти нет моделей ---', 'system');
        return;
      }
      models.forEach((model) => {
        const expires = model.expires_at
          ? ` · до ${new Date(model.expires_at).toLocaleTimeString('ru-RU')}`
          : '';
        appendLine(
          `${model.name} · ${model.size_human} · VRAM ${model.vram_percent}%${expires}`,
          'system'
        );
      });
    } catch (err) {
      appendLine(`--- не удалось выполнить /ps: ${err.message} ---`, 'error');
    }
  }

  function showInfo() {
    appendLine(`--- модель: ${settings.model || '—'} · keep_alive: ${settings.keepAlive} ---`, 'system');
    appendLine(
      `--- temperature: ${settings.temperature || 'по умолчанию'} · ` +
      `top_p: ${settings.top_p || 'по умолчанию'} · ` +
      `num_ctx: ${settings.num_ctx || 'по умолчанию'} · ` +
      `num_predict: ${settings.num_predict || 'по умолчанию'} ---`,
      'system'
    );
    appendLine(
      `--- размышления: ${THINK_LABELS[settings.think]} · ` +
      `сообщений в контексте: ${history.length} · ` +
      `системный промпт: ${settings.system ? 'задан' : 'нет'} ---`,
      'system'
    );
  }

  async function handleCommand(text) {
    const parts = text.trim().split(/\s+/);
    const command = (parts.shift() || '').toLowerCase();
    const argument = parts.join(' ');
    switch (command) {
      case '/help':
      case '/?':
        showHelp();
        return;
      case '/clear':
      case '/reset':
        clearConversation('--- контекст очищен: история диалога и окно вывода ---');
        return;
      case '/continue':
        continueLastAnswer();
        return;
      case '/bye':
        appendLine('--- выгружаю модель и закрываю окно чата ---', 'system');
        await unloadModelFromMemory(true);
        setTimeout(close, 300);
        return;
      case '/unload':
        await unloadModelFromMemory(false);
        return;
      case '/load':
        await loadModelToMemory(argument);
        return;
      case '/ps':
        await showRunningModels();
        return;
      case '/info':
        showInfo();
        return;
      case '/think':
      case '/thinking':
        setThink(argument.trim().toLowerCase() || 'auto', true);
        return;
      case '/model':
        setModel(argument);
        return;
      case '/system':
        setSystem(argument);
        return;
      case '/temp':
        setNumberOption('temperature', argument, 0, 2, 'temperature');
        return;
      case '/top_p':
        setNumberOption('top_p', argument, 0, 1, 'top_p');
        return;
      case '/ctx':
        setIntOption('num_ctx', argument, 512, 131072, 'num_ctx');
        return;
      case '/predict':
        setIntOption('num_predict', argument, -1, 8192, 'num_predict');
        return;
      case '/keep_alive':
        setKeepAlive(argument);
        return;
      default:
        appendLine(`--- неизвестная команда «${command}», введите /help ---`, 'error');
    }
  }

  async function submitInput() {
    const input = $('#chat-input');
    const text = input.value;
    if (!text.trim() || streaming) return;
    input.value = '';
    autoGrowInput();
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);   // команда сама печатает результат
    } else {
      await sendMessage(trimmed);     // пузырь пользователя добавит sendMessage
    }
  }


  // ----------------------------------------------------------------------
  // панель настроек
  // ----------------------------------------------------------------------
  function syncSettingsForm() {
    $('#set-system').value = settings.system;
    $('#set-temperature').value = settings.temperature;
    $('#set-top-p').value = settings.top_p;
    $('#set-num-ctx').value = settings.num_ctx;
    $('#set-num-predict').value = settings.num_predict;

    const thinkSelect = $('#set-think');
    if (thinkSelect) thinkSelect.value = settings.think;

    const select = $('#set-keep-alive');
    if (!Array.from(select.options).some((option) => option.value === settings.keepAlive)) {
      const option = document.createElement('option');
      option.value = settings.keepAlive;
      option.textContent = settings.keepAlive;
      select.appendChild(option);
    }
    select.value = settings.keepAlive;
    updateModelBadge();
    updateThinkButton();
  }

  function applySettingsForm() {
    const systemChanged = $('#set-system').value.trim() !== settings.system.trim();
    settings.system = $('#set-system').value.trim();
    settings.temperature = $('#set-temperature').value;
    settings.top_p = $('#set-top-p').value;
    settings.num_ctx = $('#set-num-ctx').value;
    settings.num_predict = $('#set-num-predict').value;
    settings.keepAlive = $('#set-keep-alive').value;
    settings.think = $('#set-think').value;
    saveSettings();
    updateModelBadge();
    updateThinkButton();
    if (systemChanged) {
      clearConversation('--- системный промпт изменён: контекст и окно очищены ---');
    }
    updateContextBadge();
    appendLine(`--- параметры применены (размышления: ${THINK_LABELS[settings.think]}) ---`, 'system');
    $('#chat-settings').classList.add('hidden');
  }

  function resetSettingsForm() {
    settings.system = '';
    settings.temperature = '';
    settings.top_p = '';
    settings.num_ctx = '';
    settings.num_predict = '';
    settings.think = 'auto';
    settings.keepAlive = CONFIG.keepAlive;
    saveSettings();
    syncSettingsForm();
    clearConversation('--- параметры сброшены, контекст и окно очищены ---');
  }

  function autoGrowInput() {
    const input = $('#chat-input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }


  // ----------------------------------------------------------------------
  // события и запуск
  // ----------------------------------------------------------------------
  function bindEvents() {
    $('#chat-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submitInput();
    });
    $('#chat-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitInput();
      }
    });
    $('#chat-input').addEventListener('input', autoGrowInput);

    $('#btn-stop').addEventListener('click', () => {
      if (controller) controller.abort();
    });
    $('#btn-load').addEventListener('click', () => loadModelToMemory());
    $('#btn-unload').addEventListener('click', () => unloadModelFromMemory(false));
    $('#btn-think').addEventListener('click', cycleThink);
    $('#btn-clear').addEventListener('click', () => {
      clearConversation('--- контекст очищен: история диалога и окно вывода ---');
    });
    $('#btn-bye').addEventListener('click', () => handleCommand('/bye'));

    // клики внутри окна вывода: кнопки сообщений, предпросмотр и «копировать»
    viewEl().addEventListener('click', async (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const action = target.closest('.msg-action');
      if (action) {
        const wrap = action.closest('.msg');
        if (!wrap) return;
        if (action.dataset.action === 'edit') startEditMessage(wrap);
        else if (action.dataset.action === 'regenerate') regenerateAnswer(wrap);
        else if (action.dataset.action === 'continue') continueAnswer(wrap);
        return;
      }

      const preview = target.closest('.code-preview');
      if (preview) {
        const block = preview.closest('.md-code');
        const wrap = block ? block.closest('.msg') : null;
        if (wrap) openPreview(wrap);
        return;
      }

      // «✎ в редакторе»: панель открывается сразу на вкладке этого языка
      const edit = target.closest('.code-edit');
      if (edit) {
        const block = edit.closest('.md-code');
        const wrap = block ? block.closest('.msg') : null;
        if (wrap) openPreview(wrap, { lang: editorLangOf(block) });
        return;
      }

      const button = target.closest('.code-copy');
      if (!button) return;
      const block = button.closest('.md-code');
      const code = block ? block.querySelector('code') : null;
      if (!code) return;
      const ok = await copyText(code.textContent);
      if (!ok) {
        toast('Не удалось скопировать код: буфер обмена недоступен', 'warn');
        return;
      }
      button.textContent = 'скопировано';
      setTimeout(() => { button.textContent = 'копировать'; }, 1500);
    });

    $('#btn-settings').addEventListener('click', () => $('#chat-settings').classList.toggle('hidden'));
    $('#btn-settings-close').addEventListener('click', () => $('#chat-settings').classList.add('hidden'));
    $('#btn-settings-apply').addEventListener('click', applySettingsForm);
    $('#btn-settings-reset').addEventListener('click', resetSettingsForm);

    $('#chat-model').addEventListener('change', (event) => setModel(event.target.value));

    // закрытие модального окна: крестик, клик по фону, Esc
    const modal = $('#modal-chat');
    $('#btn-chat-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || modal.classList.contains('hidden')) return;
      // Esc сначала сворачивает предпросмотр, потом закрывает настройки и окно
      if (isPreviewFullscreen()) {
        setPreviewFullscreen(false);
        return;
      }
      // редактор внутри панели закрывается раньше самой панели
      if (editorIsOpen()) {
        setEditorOpen(false);
        return;
      }
      if (previewIsOpen()) {
        closePreview();
        return;
      }
      if (!$('#chat-settings').classList.contains('hidden')) {
        $('#chat-settings').classList.add('hidden');
        return;
      }
      close();
    });

    bindPreviewEvents();
  }

  function printBanner() {
    const target = CONFIG.serviceKind === 'служба' ? 'служба' : 'процесс';
    appendLine(
      `--- Ollama panel chat · API ${CONFIG.ollamaHost} · ${target} ${CONFIG.service}` +
      `${CONFIG.platform ? ` · ${CONFIG.platform}` : ''} ---`,
      'system'
    );
    appendLine(
      `--- модель: ${settings.model || '—'} · keep_alive: ${settings.keepAlive} · ` +
      `размышления: ${THINK_LABELS[settings.think]} ---`,
      'system'
    );
    appendLine(
      '--- /help — список команд, Esc — закрыть окно, /bye — выгрузить модель и закрыть ---',
      'system'
    );
  }


  /** Открывает модальное окно чата (при первом вызове — инициализирует его). */
  async function open(model) {
    const modal = $('#modal-chat');
    if (!modal) return;
    if (model) CONFIG.model = model;
    modal.classList.remove('hidden');
    $('#chat-settings').classList.add('hidden');

    if (!initialized) {
      initialized = true;
      loadSettings();
      syncSettingsForm();
      bindEvents();
      await loadModelList();
      printBanner();
      updateContextBadge();
      await refreshMemoryBadge();
    } else {
      if (CONFIG.model && CONFIG.model !== settings.model) setModel(CONFIG.model);
      updateModelBadge();
      updateThinkButton();
      refreshMemoryBadge();
    }
    startMemoryTimer();
    $('#chat-input').focus();
  }

  /** Закрывает окно чата, прерывая незавершённую генерацию. */
  function close() {
    if (controller) controller.abort();
    // предпросмотр не должен остаться развёрнутым поверх страницы
    setPreviewFullscreen(false);
    $('#modal-chat').classList.add('hidden');
    $('#chat-settings').classList.add('hidden');
    stopMemoryTimer();
  }

  function isOpen() {
    const modal = $('#modal-chat');
    return Boolean(modal) && !modal.classList.contains('hidden');
  }

  window.OllamaChat = { open, close, isOpen };

  // Панель может попросить открыть чат сразу после загрузки: /?chat=модель
  // (на этот адрес перенаправляет старый /chat?model=…).
  document.addEventListener('DOMContentLoaded', () => {
    if (CONFIG.model) open(CONFIG.model);
  });
})();

