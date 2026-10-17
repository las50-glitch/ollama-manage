/* Панель управления Ollama — клиентская логика (без внешних зависимостей). */
'use strict';

// ----------------------------------------------------------------------
// конфигурация со страницы (data-атрибуты <body>)
// ----------------------------------------------------------------------
const PAGE = document.body.dataset;

/**
 * Описание активного окружения панели: ОС и источник данных об Ollama.
 * На Linux с systemd это служба и journalctl, на Windows и macOS — процесс
 * Ollama и файл журнала, поэтому подписи в интерфейсе берутся отсюда.
 */
const CONFIG = {
  platform: PAGE.platform || 'linux',
  platformLabel: PAGE.platformLabel || '',
  backend: PAGE.backend || 'systemd',
  serviceKind: PAGE.serviceKind || 'служба',
  serviceName: PAGE.service || '',
  logsAvailable: PAGE.logsAvailable !== 'false',
  logsSource: PAGE.logsSource || '',
  ollamaHost: PAGE.ollamaHost || '',
};

/** Заголовок элемента интерфейса с учётом ОС: «Служба» или «Процесс». */
function serviceLabel() {
  return CONFIG.serviceKind.charAt(0).toUpperCase() + CONFIG.serviceKind.slice(1);
}

// ----------------------------------------------------------------------
// утилиты
// ----------------------------------------------------------------------
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/** Экранирует HTML-спецсимволы. */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Показывает всплывающее уведомление. */
function toast(message, kind = 'info', timeout = 6000) {
  const container = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  container.appendChild(node);
  setTimeout(() => node.remove(), timeout);
}

/** Форматирует ISO-дату в локальное время. */
function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('ru-RU', { hour12: false });
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
    error.authRequired = Boolean(data && data.auth_required);
    throw error;
  }
  return data;
}

/** POST с JSON-телом. */
function postJson(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// ----------------------------------------------------------------------
// тема панели: тёмная (по умолчанию) и светлая
// ----------------------------------------------------------------------
const THEME_KEY = 'ollama-theme';
const THEME_LABELS = { dark: '🌙 Тёмная', light: '☀ Светлая' };
const THEME_ICONS = { dark: '🌙', light: '☀' };

/** Текущая тема: атрибут data-theme выставляет инлайн-скрипт в index.html. */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Применяет тему, обновляет кнопки и (при persist) запоминает выбор. */
function applyTheme(theme, persist) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', value);

  const button = $('#btn-theme');
  if (button) {
    button.textContent = THEME_LABELS[value];
    button.title = value === 'light' ? 'Переключить на тёмную тему' : 'Переключить на светлую тему';
    button.setAttribute('aria-pressed', String(value === 'light'));
  }
  const chatButton = $('#btn-chat-theme');
  if (chatButton) {
    chatButton.textContent = THEME_ICONS[value];
    chatButton.title = value === 'light'
      ? 'Сейчас светлая тема — включить тёмную'
      : 'Сейчас тёмная тема — включить светлую';
  }

  if (persist) {
    try {
      window.localStorage.setItem(THEME_KEY, value);
    } catch (err) {
      /* localStorage недоступен — тема просто не запомнится */
    }
  }
}

/** Кнопки темы в шапке панели и в шапке окна чата. */
function initTheme() {
  applyTheme(currentTheme(), false);
  const toggle = () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
  ['#btn-theme', '#btn-chat-theme'].forEach((selector) => {
    const button = $(selector);
    if (button) button.addEventListener('click', toggle);
  });

  // пока тема не выбрана вручную — следуем за системной настройкой
  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', (event) => {
        try {
          if (window.localStorage.getItem(THEME_KEY)) return;
        } catch (err) {
          return;
        }
        applyTheme(event.matches ? 'light' : 'dark', false);
      });
    }
  }
}

// ----------------------------------------------------------------------
// вкладки
// ----------------------------------------------------------------------
const tabLoaders = {};
const tabLeavers = {};
let activeTab = 'models';

function activateTab(name) {
  if (activeTab !== name && tabLeavers[activeTab]) tabLeavers[activeTab]();
  activeTab = name;
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === name));
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === `tab-${name}`));
  if (tabLoaders[name]) tabLoaders[name]();
}

// ----------------------------------------------------------------------
// сводка в шапке
// ----------------------------------------------------------------------
async function loadOverview() {
  try {
    const data = await api('/api/overview');
    $('#badge-version').textContent = `Ollama: ${data.version || 'недоступна'}`;
    $('#badge-models').textContent = `Моделей: ${data.models_count ?? '—'}`;
    $('#badge-running').textContent = `В памяти: ${data.running_count ?? '—'}`;

    const service = data.service;
    const badge = $('#badge-service');
    if (service) {
      badge.textContent = `${serviceLabel()}: ${service.active_state} (${service.sub_state})`;
      badge.classList.toggle('ok', service.running);
      badge.classList.toggle('bad', !service.running);
    } else {
      badge.textContent = `${serviceLabel()}: нет данных`;
      badge.classList.add('bad');
    }
    (data.errors || []).forEach((message) => toast(message, 'err', 9000));
  } catch (err) {
    toast(`Не удалось получить сводку: ${err.message}`, 'err');
  }
}

// ----------------------------------------------------------------------
// модели
// ----------------------------------------------------------------------
let modelsCache = [];
let totalSizeHuman = '—';

function modelRow(model) {
  const search = ($('#models-filter').value || '').trim().toLowerCase();
  if (search && !model.name.toLowerCase().includes(search)) return null;

  const row = document.createElement('tr');
  row.innerHTML = `
    <td class="model-name">${escapeHtml(model.name)}</td>
    <td class="nowrap">${escapeHtml(model.size_human)}</td>
    <td class="nowrap">${escapeHtml(model.parameter_size || '—')}</td>
    <td class="nowrap">${escapeHtml(model.quantization_level || '—')}</td>
    <td class="nowrap">${escapeHtml(fmtDate(model.modified_at))}</td>
    <td class="actions"></td>`;

  const details = document.createElement('button');
  details.className = 'btn btn-sm';
  details.type = 'button';
  details.textContent = 'Детали';
  details.addEventListener('click', () => showModelDetails(model.name));

  const preload = document.createElement('button');
  preload.className = 'btn btn-sm btn-ok';
  preload.type = 'button';
  preload.textContent = 'В память';
  preload.title = 'Загрузить модель в память, не выполняя генерацию (как ollama run)';
  preload.addEventListener('click', () => preloadModel(model.name, preload));

  const chat = document.createElement('button');
  chat.className = 'btn btn-sm btn-primary';
  chat.type = 'button';
  chat.textContent = 'Чат';
  chat.title = 'Открыть чат с моделью в модальном окне панели (стиль ollama run)';
  chat.addEventListener('click', () => openChat(model.name));

  const remove = document.createElement('button');
  remove.className = 'btn btn-sm btn-danger';
  remove.type = 'button';
  remove.textContent = 'Удалить';
  remove.addEventListener('click', () => deleteModel(model.name));

  row.querySelector('.actions').append(preload, chat, details, remove);
  return row;
}

function renderModels() {
  const body = $('#models-body');
  body.innerHTML = '';
  let shown = 0;
  modelsCache.forEach((model) => {
    const row = modelRow(model);
    if (row) {
      body.appendChild(row);
      shown += 1;
    }
  });
  $('#models-counter').textContent =
    `(${shown} из ${modelsCache.length}, всего на диске: ${totalSizeHuman})`;
  $('#models-empty').classList.toggle('hidden', shown > 0);
}

async function loadModels() {
  try {
    const data = await api('/api/models');
    modelsCache = data.models || [];
    totalSizeHuman = data.total_size_human || '—';
    renderModels();
  } catch (err) {
    toast(`Не удалось получить список моделей: ${err.message}`, 'err');
  }
}

async function deleteModel(name) {
  const confirmed = window.confirm(
    `Удалить модель «${name}»?\nФайлы модели будут удалены с диска без возможности восстановления.`
  );
  if (!confirmed) return;
  try {
    const result = await postJson('/api/models/delete', { name });
    toast(result.message || 'Модель удалена', 'ok');
    await Promise.all([loadModels(), loadOverview()]);
  } catch (err) {
    toast(`Не удалось удалить модель: ${err.message}`, 'err');
  }
}

async function showModelDetails(name) {
  const modal = $('#modal-details');
  $('#details-title').textContent = `Модель: ${name}`;
  $('#details-body').innerHTML = '<p class="hint">Загрузка…</p>';
  modal.classList.remove('hidden');
  try {
    const data = await api(`/api/models/details?name=${encodeURIComponent(name)}`);
    const info = data.model_info || {};
    const summary = {
      'Формат': data.details && data.details.format,
      'Семейство': data.details && data.details.family,
      'Параметры': data.details && data.details.parameter_size,
      'Квантование': data.details && data.details.quantization_level,
      'Шаблон': data.template ? `${data.template.length} символов` : '—',
      'Лицензия': (data.license || '').slice(0, 120) || '—',
      'Параметров в model_info': Object.keys(info).length,
    };
    const rows = Object.entries(summary)
      .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value || '—')}</dd></div>`)
      .join('');
    const parameters = data.parameters ? escapeHtml(data.parameters) : '—';
    const system = data.system ? escapeHtml(data.system) : '—';
    $('#details-body').innerHTML = `
      <dl class="status-grid">${rows}</dl>
      <h4>Параметры запуска</h4>
      <pre class="details-pre">${parameters}</pre>
      <h4>Системный промпт (system)</h4>
      <pre class="details-pre">${system}</pre>`;
  } catch (err) {
    $('#details-body').innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

// ----------------------------------------------------------------------
// скачивание моделей (поток прогресса через SSE поверх POST)
// ----------------------------------------------------------------------
function humanBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return index === 0 ? `${Math.round(size)} ${units[index]}` : `${size.toFixed(2)} ${units[index]}`;
}

function createPullJob(name) {
  const job = document.createElement('div');
  job.className = 'pull-job';
  job.innerHTML = `
    <div class="pull-job-head">
      <span class="pull-job-name">${escapeHtml(name)}</span>
      <span class="pull-job-status">подключение…</span>
    </div>
    <div class="progress"><div class="progress-fill"></div></div>
    <div class="pull-job-log"></div>`;
  $('#pull-jobs').prepend(job);
  return {
    node: job,
    layers: new Map(),
    statusNode: job.querySelector('.pull-job-status'),
    fillNode: job.querySelector('.progress-fill'),
    logNode: job.querySelector('.pull-job-log'),
    finished: false,
  };
}

function pullJobLog(job, text) {
  const line = document.createElement('div');
  line.textContent = text;
  job.logNode.appendChild(line);
  job.logNode.scrollTop = job.logNode.scrollHeight;
}

function updatePullProgress(job) {
  let completed = 0;
  let total = 0;
  job.layers.forEach((layer) => {
    completed += layer.completed || 0;
    total += layer.total || 0;
  });
  if (!total) return;
  const percent = Math.min(100, (completed / total) * 100);
  job.fillNode.style.width = `${percent.toFixed(1)}%`;
  job.statusNode.textContent =
    `${percent.toFixed(1)}% · ${humanBytes(completed)} из ${humanBytes(total)}`;
}

function handlePullEvent(job, event) {
  if (event.type === 'start') {
    job.statusNode.textContent = 'запрос принят…';
    return;
  }
  if (event.type === 'error') {
    job.finished = true;
    job.node.classList.add('is-error');
    job.statusNode.textContent = `ошибка: ${event.message}`;
    pullJobLog(job, `ОШИБКА: ${event.message}`);
    toast(`Ошибка скачивания «${job.node.querySelector('.pull-job-name').textContent}»: ${event.message}`, 'err', 12000);
    return;
  }
  if (event.type === 'done') {
    job.finished = true;
    job.node.classList.add('is-done');
    job.fillNode.style.width = '100%';
    job.statusNode.textContent = 'готово (success)';
    pullJobLog(job, 'Модель успешно скачана.');
    toast(`Модель «${event.model || ''}» скачана`, 'ok');
    loadModels();
    loadOverview();
    return;
  }

  // событие прогресса
  if (event.digest && (event.total || event.completed)) {
    const layer = job.layers.get(event.digest) || { completed: 0, total: 0 };
    layer.completed = event.completed || layer.completed;
    layer.total = event.total || layer.total;
    job.layers.set(event.digest, layer);
    updatePullProgress(job);
  }
  if (event.status) {
    const percent = event.total ? ` (${((event.completed / event.total) * 100).toFixed(1)}%)` : '';
    const digest = event.digest ? ` ${String(event.digest).slice(0, 12)}` : '';
    job.statusNode.textContent = `${event.status}${digest}${percent}`;
    pullJobLog(job, `${event.status}${digest}${percent}`);
  }
}

async function startPull(name, insecure) {
  const job = createPullJob(name);
  try {
    const response = await fetch('/api/models/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, insecure }),
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
        const line = chunk.split('\n').find((part) => part.startsWith('data:'));
        if (!line) return;
        try {
          handlePullEvent(job, JSON.parse(line.slice(5).trim()));
        } catch (err) { /* игнорируем некорректные чанки */ }
      });
    }
    if (!job.finished) {
      job.finished = true;
      job.statusNode.textContent = 'поток завершён';
      loadModels();
    }
  } catch (err) {
    job.finished = true;
    job.node.classList.add('is-error');
    job.statusNode.textContent = `ошибка: ${err.message}`;
    pullJobLog(job, `ОШИБКА: ${err.message}`);
    toast(`Не удалось скачать модель: ${err.message}`, 'err', 12000);
  }
}

// ----------------------------------------------------------------------
// загруженные в память (ollama ps)
// ----------------------------------------------------------------------
let psTimer = null;

function renderPs(models) {
  const body = $('#ps-body');
  body.innerHTML = '';
  models.forEach((model) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="model-name">${escapeHtml(model.name)}</td>
      <td class="nowrap">${escapeHtml(model.size_human)}</td>
      <td class="nowrap">${escapeHtml(model.size_vram_human)} (${model.vram_percent}%)</td>
      <td class="nowrap">${escapeHtml(model.parameter_size || '—')}</td>
      <td class="nowrap">${escapeHtml(fmtDate(model.expires_at))}</td>
      <td class="actions"></td>`;

    const chat = document.createElement('button');
    chat.className = 'btn btn-sm btn-primary';
    chat.type = 'button';
    chat.textContent = 'Чат';
    chat.addEventListener('click', () => openChat(model.name));

    const unload = document.createElement('button');
    unload.className = 'btn btn-sm';
    unload.type = 'button';
    unload.textContent = 'Выгрузить';
    unload.addEventListener('click', () => unloadModel(model.name));
    row.querySelector('.actions').append(chat, unload);

    body.appendChild(row);
  });
  $('#ps-counter').textContent = `(${models.length})`;
  $('#ps-empty').classList.toggle('hidden', models.length > 0);
}

async function loadPs() {
  try {
    const data = await api('/api/ps');
    renderPs(data.models || []);
  } catch (err) {
    $('#ps-empty').textContent = `Не удалось получить список: ${err.message}`;
    $('#ps-empty').classList.remove('hidden');
  }
}

async function unloadModel(name) {
  try {
    const result = await postJson('/api/models/unload', { name });
    toast(result.message || 'Модель выгружена', 'ok');
    await loadPs();
  } catch (err) {
    toast(`Не удалось выгрузить модель: ${err.message}`, 'err');
  }
}

function schedulePs() {
  if (psTimer) {
    clearInterval(psTimer);
    psTimer = null;
  }
  if (!$('#ps-autorefresh').checked) return;
  const interval = Number($('#ps-interval').value) || 5000;
  psTimer = setInterval(loadPs, interval);
}

// ----------------------------------------------------------------------
// журнал службы в реальном времени
// ----------------------------------------------------------------------
const LOG_LIMIT = 4000;
let logSource = null;
let logEntries = [];
let logSnapshotLoaded = false;

function logFilter() {
  return ($('#log-filter').value || '').trim().toLowerCase();
}

function logEntryNode(entry, filter) {
  const span = document.createElement('span');
  span.className = 'log-line';
  if (entry.system) span.classList.add('log-system');
  if (/\b(error|err!|failed|failure|panic|fatal)\b/i.test(entry.text)) span.classList.add('err');
  if (filter && entry.text.toLowerCase().includes(filter)) span.classList.add('match');
  span.textContent = entry.text;
  return span;
}

function renderLog() {
  const view = $('#log-view');
  const filter = logFilter();
  view.innerHTML = '';
  const fragment = document.createDocumentFragment();
  logEntries.forEach((entry) => fragment.appendChild(logEntryNode(entry, filter)));
  view.appendChild(fragment);
  if ($('#log-autoscroll').checked) view.scrollTop = view.scrollHeight;
}

function appendLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > LOG_LIMIT) logEntries = logEntries.slice(-LOG_LIMIT);

  const view = $('#log-view');
  view.appendChild(logEntryNode(entry, logFilter()));
  while (view.childElementCount > LOG_LIMIT) view.removeChild(view.firstChild);
  if ($('#log-autoscroll').checked) view.scrollTop = view.scrollHeight;
}

function setLogState(text, kind) {
  const badge = $('#log-state');
  badge.textContent = text;
  badge.classList.remove('ok', 'bad', 'warn');
  if (kind) badge.classList.add(kind);
}

/** Сообщение о том, что журнал читать не из чего (файла нет и journalctl недоступен). */
function showLogNotice(message) {
  const node = $('#log-unavailable');
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.classList.remove('hidden');
  } else {
    node.textContent = '';
    node.classList.add('hidden');
  }
}

/** Блокирует кнопки потока, если журнал недоступен (например, нет файла). */
function applyLogAvailability() {
  const buttons = ['#btn-log-start', '#btn-log-snapshot'].map($);
  buttons.forEach((button) => {
    if (button) button.disabled = !CONFIG.logsAvailable;
  });
  if (!CONFIG.logsAvailable) {
    setLogState('журнал недоступен', 'bad');
    showLogNotice(
      `Журнал Ollama не найден (${CONFIG.logsSource}). Запустите Ollama или задайте ` +
      'путь к журналу переменной OLLAMA_LOG_FILE и перезапустите панель, ' +
      'затем обновите страницу (F5).'
    );
  }
}

async function loadLogSnapshot() {
  const lines = Number($('#log-lines').value) || 200;
  try {
    const data = await api(`/api/logs?lines=${lines}`);
    logEntries = (data.lines || []).map((text) => ({ text, system: false }));
    logSnapshotLoaded = true;
    renderLog();
    showLogNotice('');
    if (!logSource) setLogState(`снимок: ${logEntries.length} строк`);
  } catch (err) {
    toast(`Не удалось прочитать журнал: ${err.message}`, 'err', 10000);
    setLogState('ошибка чтения', 'bad');
    showLogNotice(err.message);
  }
}

function stopLogStream() {
  if (logSource) {
    logSource.close();
    logSource = null;
  }
  $('#btn-log-start').disabled = !CONFIG.logsAvailable;
  $('#btn-log-stop').disabled = true;
  if (CONFIG.logsAvailable) setLogState('поток остановлен');
}

function startLogStream() {
  if (!CONFIG.logsAvailable) {
    applyLogAvailability();
    return;
  }
  stopLogStream();
  const lines = Number($('#log-lines').value) || 200;
  logSource = new EventSource(`/api/logs/stream?lines=${lines}`);
  $('#btn-log-start').disabled = true;
  $('#btn-log-stop').disabled = false;
  setLogState('подключение…', 'warn');

  logSource.onmessage = (event) => {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (data.type === 'started') {
      setLogState('поток активен', 'ok');
      showLogNotice('');
      appendLog({ text: `--- ${data.message} ---`, system: true });
    } else if (data.type === 'line') {
      appendLog({ text: data.line, system: false });
    } else if (data.type === 'closed') {
      appendLog({ text: `--- поток журнала завершён (код ${data.returncode}) ---`, system: true });
      stopLogStream();
    }
  };

  logSource.onerror = () => {
    if (!logSource) return;
    setLogState('соединение потеряно, переподключение…', 'warn');
  };
}

// ----------------------------------------------------------------------
// состояние Ollama: юнит systemd или процесс (Windows/macOS)
// ----------------------------------------------------------------------
function renderServiceStatus(status) {
  const state = status.running ? 'работает' : 'не запущен';
  $('#st-active').textContent = `${status.active_state} (${state})`;
  $('#st-sub').textContent = status.sub_state || '—';
  $('#st-enabled').textContent = autostartText(status.unit_file_state);
  $('#st-pid').textContent = status.main_pid || '—';
  $('#st-memory').textContent = status.memory_human || '—';
  $('#st-restarts').textContent = valueOrDash(status.n_restarts);
  $('#st-since').textContent = valueOrDash(status.active_since);
  $('#st-started').textContent = valueOrDash(status.started_at);

  const badge = $('#badge-service');
  badge.textContent = `${serviceLabel()}: ${status.active_state} (${status.sub_state})`;
  badge.classList.toggle('ok', status.running);
  badge.classList.toggle('bad', !status.running);
}

/** Значение поля или прочерк, если бэкенд его не предоставляет (например, процесс). */
function valueOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
}

/** Расшифровывает состояние автозапуска для разных бэкендов. */
function autostartText(state) {
  if (state === 'enabled') return 'включён';
  if (state === 'disabled') return 'выключен';
  if (!state || state === 'unknown') return 'неизвестно';
  return state;
}

async function loadServiceStatus() {
  try {
    renderServiceStatus(await api('/api/service/status'));
  } catch (err) {
    toast(`Не удалось получить состояние ${CONFIG.serviceKind}: ${err.message}`, 'err');
  }
}

// ----------------------------------------------------------------------
// загрузка модели в память и окно чата
// ----------------------------------------------------------------------
function keepAliveValue() {
  const select = $('#preload-keep-alive');
  return select && select.value ? select.value : '30m';
}

/** Предзагружает модель в память (аналог старта `ollama run`). */
async function preloadModel(name, button) {
  const keepAlive = keepAliveValue();
  if (button) button.disabled = true;
  toast(`Загружаю «${name}» в память (keep_alive=${keepAlive})…`, 'info', 4000);
  try {
    const result = await postJson('/api/models/load', { name, keep_alive: keepAlive });
    toast(result.message || `Модель «${name}» загружена в память`, 'ok', 9000);
    loadOverview();
    if (activeTab === 'ps') await loadPs();
  } catch (err) {
    toast(`Не удалось загрузить модель в память: ${err.message}`, 'err', 12000);
  } finally {
    if (button) button.disabled = false;
  }
}

/** Открывает чат с моделью в модальном окне панели (см. static/js/chat.js). */
function openChat(name) {
  if (!window.OllamaChat) {
    toast('Модуль чата не загрузился — обновите страницу', 'err', 9000);
    return;
  }
  window.OllamaChat.open(name);
  toast(`Чат с «${name}» открыт — Esc или ✕ закрывает окно`, 'ok', 5000);
}

/** Подставляет keep_alive из config.py в список «Держать». */
function applyKeepAliveDefault() {
  const select = $('#preload-keep-alive');
  if (!select) return;
  const wanted = select.dataset.default;
  if (!wanted) return;
  if (!Array.from(select.options).some((option) => option.value === wanted)) {
    const option = document.createElement('option');
    option.value = wanted;
    option.textContent = wanted;
    select.appendChild(option);
  }
  select.value = wanted;
}

// ----------------------------------------------------------------------
// поиск моделей на Hugging Face
// ----------------------------------------------------------------------
let hfResults = [];

function fmtNumber(value) {
  return Number(value || 0).toLocaleString('ru-RU');
}

function showHfEmpty(text) {
  const empty = $('#hf-empty');
  empty.textContent = text;
  empty.classList.remove('hidden');
}

function hfRow(item) {
  const row = document.createElement('tr');
  const tags = (item.tags || [])
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join('');
  row.innerHTML = `
    <td class="model-name">
      <a href="${escapeHtml(item.page_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(item.repo)}</a>
      ${item.gated ? '<span class="badge warn">gated</span>' : ''}
      ${item.installed ? '<span class="badge ok">скачана</span>' : ''}
      <div class="tags">${tags}</div>
    </td>
    <td class="nowrap">${escapeHtml(fmtNumber(item.downloads))}</td>
    <td class="nowrap">${escapeHtml(fmtNumber(item.likes))}</td>
    <td class="nowrap">${escapeHtml(fmtDate(item.modified_at))}</td>
    <td class="actions"></td>`;

  const quants = document.createElement('button');
  quants.className = 'btn btn-sm btn-primary';
  quants.type = 'button';
  quants.textContent = 'Кванты';
  quants.addEventListener('click', () => showQuants(item));

  const pull = document.createElement('button');
  pull.className = 'btn btn-sm';
  pull.type = 'button';
  pull.textContent = 'Скачать';
  pull.title = 'ollama pull без тега — Ollama сама выберет подходящий квант (обычно Q4_K_M)';
  pull.addEventListener('click', () => {
    activateTab('models');
    startPull(item.pull_name, false);
    toast('Прогресс скачивания — на вкладке «Модели»', 'info', 6000);
  });

  row.querySelector('.actions').append(quants, pull);
  return row;
}

function renderHfResults() {
  const body = $('#hf-body');
  body.innerHTML = '';
  hfResults.forEach((item) => body.appendChild(hfRow(item)));
  $('#hf-empty').classList.toggle('hidden', hfResults.length > 0);
}

async function hfSearch() {
  const query = ($('#hf-query').value || '').trim();
  if (!query) {
    toast('Введите запрос для поиска на Hugging Face', 'warn');
    $('#hf-query').focus();
    return;
  }
  const limit = Number($('#hf-limit').value) || 20;
  const sort = $('#hf-sort').value;
  const button = $('#btn-hf-search');
  button.disabled = true;
  showHfEmpty('Поиск на Hugging Face…');
  try {
    const data = await api(
      `/api/hf/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}&limit=${limit}`
    );
    hfResults = data.results || [];
    renderHfResults();
    if (!hfResults.length) showHfEmpty(`Ничего не найдено по запросу «${query}» (ищутся только GGUF).`);
  } catch (err) {
    hfResults = [];
    renderHfResults();
    showHfEmpty(`Ошибка поиска: ${err.message}`);
    toast(`Поиск не удался: ${err.message}`, 'err', 10000);
  } finally {
    button.disabled = false;
  }
}

// ----------------------------------------------------------------------
// токен Hugging Face (хранится на сервере, в браузер не передаётся)
// ----------------------------------------------------------------------
function renderHfTokenState(state) {
  const badge = $('#hf-token-state');
  if (!state.set) {
    badge.textContent = 'токен не задан';
    badge.className = 'badge warn';
  } else if (state.source === 'panel') {
    badge.textContent = `задан в панели: ${state.hint}`;
    badge.className = 'badge ok';
  } else {
    badge.textContent = `из окружения HF_TOKEN: ${state.hint}`;
    badge.className = 'badge ok';
  }
  badge.title = state.file ? `Файл настроек панели: ${state.file}` : '';
}

async function loadHfTokenState() {
  try {
    const data = await api('/api/settings');
    renderHfTokenState(data.hf_token);
  } catch (err) {
    toast(`Не удалось получить настройки панели: ${err.message}`, 'err', 9000);
  }
}

async function saveHfToken() {
  const input = $('#hf-token-input');
  const token = (input.value || '').trim();
  if (!token) {
    toast('Вставьте токен Hugging Face в поле', 'warn');
    input.focus();
    return;
  }
  const button = $('#btn-hf-token-save');
  button.disabled = true;
  try {
    const data = await postJson('/api/settings/hf-token', { token });
    input.value = '';
    renderHfTokenState(data.hf_token);
    $('#hf-token-result').textContent = data.message;
    toast(data.message, data.verified ? 'ok' : 'warn', 12000);
    // с токеном выдача поиска шире — обновим её, если запрос уже был
    if (($('#hf-query').value || '').trim()) hfSearch();
  } catch (err) {
    toast(`Токен не сохранён: ${err.message}`, 'err', 12000);
  } finally {
    button.disabled = false;
  }
}

async function clearHfToken() {
  const button = $('#btn-hf-token-clear');
  button.disabled = true;
  try {
    const data = await postJson('/api/settings/hf-token', { token: '' });
    $('#hf-token-input').value = '';
    renderHfTokenState(data.hf_token);
    $('#hf-token-result').textContent = data.message;
    toast(data.message, 'ok');
  } catch (err) {
    toast(`Не удалось удалить токен: ${err.message}`, 'err', 12000);
  } finally {
    button.disabled = false;
  }
}

// ----------------------------------------------------------------------
// окно выбора кванта
// ----------------------------------------------------------------------
async function showQuants(item) {
  const modal = $('#modal-quants');
  $('#quants-title').textContent = `Кванты: ${item.repo}`;
  $('#quants-sub').textContent = 'Загрузка списка GGUF-файлов…';
  $('#quants-page').href = item.page_url;
  $('#quants-body').innerHTML = '';
  $('#quants-error').classList.add('hidden');
  modal.classList.remove('hidden');
  try {
    const data = await api(`/api/hf/quants?repo=${encodeURIComponent(item.repo)}`);
    renderQuants(data);
  } catch (err) {
    $('#quants-sub').textContent = '';
    $('#quants-error').textContent = err.message;
    $('#quants-error').classList.remove('hidden');
  }
}

function renderQuants(data) {
  const body = $('#quants-body');
  body.innerHTML = '';
  const files = data.files || [];
  $('#quants-sub').textContent = files.length
    ? `Найдено файлов: ${data.count}. Ollama скачивает конкретный GGUF по тегу после двоеточия.`
    : 'В репозитории нет одиночных GGUF-файлов с распознанным квантом.';
  if (!files.length) return;

  files.forEach((file) => {
    const row = document.createElement('tr');
    const parts = file.parts > 1 ? ` · ${file.parts} частей` : '';
    row.innerHTML = `
      <td class="nowrap"><code>${escapeHtml(file.quant)}</code></td>
      <td class="nowrap">${escapeHtml(file.size_human)}${escapeHtml(parts)}</td>
      <td class="model-name">${escapeHtml(file.file)}</td>
      <td class="actions"></td>`;

    const pull = document.createElement('button');
    pull.className = 'btn btn-sm btn-primary';
    pull.type = 'button';
    pull.textContent = file.installed ? 'Уже скачана' : 'Скачать';
    pull.disabled = Boolean(file.installed);
    pull.title = `ollama pull ${file.pull_name}`;
    pull.addEventListener('click', () => {
      $('#modal-quants').classList.add('hidden');
      activateTab('models');
      startPull(file.pull_name, false);
      toast(`Скачиваю ${file.pull_name} — прогресс на вкладке «Модели»`, 'info', 7000);
    });

    row.querySelector('.actions').appendChild(pull);
    body.appendChild(row);
  });
}

// ----------------------------------------------------------------------
// привязка событий и запуск
// ----------------------------------------------------------------------
function bindEvents() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  // скачивание модели
  $('#btn-pull').addEventListener('click', () => {
    const name = ($('#pull-name').value || '').trim();
    if (!name) {
      toast('Введите имя модели, например llama3.2:3b', 'warn');
      return;
    }
    startPull(name, $('#pull-insecure').checked);
    $('#pull-name').value = '';
  });
  $('#pull-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#btn-pull').click();
  });

  // список моделей
  $('#btn-models-refresh').addEventListener('click', () => {
    loadModels();
    loadOverview();
  });
  $('#models-filter').addEventListener('input', renderModels);
  $('#models-filter').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.target.value = '';
      renderModels();
    }
  });

  // поиск на Hugging Face
  $('#btn-hf-search').addEventListener('click', hfSearch);
  $('#hf-query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') hfSearch();
  });
  $('#hf-sort').addEventListener('change', () => {
    if (($('#hf-query').value || '').trim()) hfSearch();
  });

  // токен Hugging Face
  $('#btn-hf-token-save').addEventListener('click', saveHfToken);
  $('#btn-hf-token-clear').addEventListener('click', clearHfToken);
  $('#hf-token-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveHfToken();
  });

  // модальное окно выбора кванта
  const quantsModal = $('#modal-quants');
  $('#quants-close').addEventListener('click', () => quantsModal.classList.add('hidden'));
  quantsModal.addEventListener('click', (event) => {
    if (event.target === quantsModal) quantsModal.classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !quantsModal.classList.contains('hidden')) {
      quantsModal.classList.add('hidden');
    }
  });

  // загруженные в память
  $('#btn-ps-refresh').addEventListener('click', loadPs);
  $('#ps-autorefresh').addEventListener('change', schedulePs);
  $('#ps-interval').addEventListener('change', schedulePs);

  // журнал
  $('#btn-log-start').addEventListener('click', startLogStream);
  $('#btn-log-stop').addEventListener('click', stopLogStream);
  $('#btn-log-snapshot').addEventListener('click', loadLogSnapshot);
  $('#btn-log-clear').addEventListener('click', () => {
    logEntries = [];
    renderLog();
  });
  $('#log-filter').addEventListener('input', renderLog);

  // состояние Ollama (юнит systemd или процесс)
  $('#btn-service-refresh').addEventListener('click', loadServiceStatus);

  // модальное окно деталей
  const detailsModal = $('#modal-details');
  $('#details-close').addEventListener('click', () => detailsModal.classList.add('hidden'));
  detailsModal.addEventListener('click', (event) => {
    if (event.target === detailsModal) detailsModal.classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !detailsModal.classList.contains('hidden')) {
      detailsModal.classList.add('hidden');
    }
  });

  // шапка
  $('#btn-refresh-all').addEventListener('click', refreshAll);

  // ленивая загрузка вкладок
  tabLoaders.ps = () => {
    loadPs();
    schedulePs();
  };
  tabLeavers.ps = () => {
    if (psTimer) {
      clearInterval(psTimer);
      psTimer = null;
    }
  };
  tabLoaders.logs = () => {
    applyLogAvailability();
    if (CONFIG.logsAvailable && !logSnapshotLoaded) loadLogSnapshot();
  };
  tabLoaders.service = () => loadServiceStatus();
  tabLoaders.hf = () => {
    $('#hf-query').focus();
    loadHfTokenState();
  };
}

/** Прячет строки состояния, которые бэкенд не заполняет (процесс вместо службы). */
function applyPlatformDetails() {
  // body тоже помечен data-backend — это конфигурация, а не строка таблицы.
  $$('[data-backend]:not(body)').forEach((node) => {
    if (node.dataset.backend !== CONFIG.backend) node.classList.add('hidden');
  });
  const badge = $('#badge-service');
  if (badge) badge.textContent = `${serviceLabel()}: —`;
}

function refreshAll() {
  loadOverview();
  loadModels();
  if (activeTab === 'ps') loadPs();
  if (activeTab === 'service') loadServiceStatus();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindEvents();
  applyKeepAliveDefault();
  applyPlatformDetails();
  applyLogAvailability();
  loadHfTokenState();
  refreshAll();
  loadServiceStatus();
});
