import { decryptEnvelope, encryptJson, decryptJson, decryptAsset, encryptAsset, toBase64, fromBase64 } from './crypto.js';

const $ = (id) => document.getElementById(id);
const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const arrays = ['people', 'problems', 'labs', 'documents', 'timeline', 'actions', 'sources'];
const emptyOverlay = () => Object.fromEntries([...arrays.map((key) => [key, []]), ['assets', {}], ['migratedScopes', []]]);
const state = { key:null, kdf:null, base:null, vault:null, overlay:emptyOverlay(), assets:{}, personId:null, imported:null, database:null, scope:null, legacyScopes:[], urls:new Set(), timer:null, toastTimer:null, formType:null, busy:false, generation:0, documentRequest:0 };
const dateText = (date) => {
  if (!date) return 'Дата не указана';
  const text = String(date), monthOnly = /^\d{4}-\d{2}$/.test(text);
  const parsed = new Date(`${monthOnly ? text + '-01' : text.slice(0,10)}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return text;
  return new Intl.DateTimeFormat('ru', { ...(monthOnly ? {} : { day:'numeric' }), month:monthOnly ? 'long' : 'short', year:'numeric', timeZone:'UTC' }).format(parsed);
};
const today = () => new Date().toLocaleDateString('sv-SE');
const newId = () => crypto.randomUUID();
const person = () => state.vault.people.find((p) => p.id === state.personId);
const records = (key) => state.vault[key].filter((record) => record.personId === state.personId);
const getProblem = (id) => state.vault.problems.find((p) => p.id === id && p.personId === state.personId);
const getDocument = (id) => state.vault.documents.find((d) => d.id === id && d.personId === state.personId);
const localBadge = (record) => record.local ? '<span class="badge badge-calculated">В этом браузере</span>' : '';
const statusLabel = { normal:'В референсе', high:'Выше референса', low:'Ниже референса', calculated:'Расчёт', unreviewed:'Без оценки' };
const kindLabel = { analysis:'Анализ', consultation:'Консультация', report:'Обзор', note:'Заметка' };
const eventLabel = { ...kindLabel, history:'Анамнез', review:'Обновление обзора', planned:'Запланировано', symptom:'Симптомы', lab:'Анализ', update:'Обновление' };
const routeLink = (path, label, cls = '') => `<a class="${esc(cls)}" href="#/${esc(path)}">${label}</a>`;
const safeUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
const button = (type, label) => `<button class="button button-primary button-small" data-add="${type}" type="button">+ ${label}</button>`;
const empty = (text) => `<div class="empty-state"><span class="eyebrow">ПОКА НЕТ ЗАПИСЕЙ</span><p>${esc(text)}</p></div>`;
const heading = (eyebrow, title, copy, action = '') => `<div class="section-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h1 class="section-title">${esc(title)}</h1>${copy ? `<p class="section-note">${esc(copy)}</p>` : ''}</div>${action}</div>`;

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { $('toast').hidden = true; $('toast').textContent = ''; }, 5500);
}
function validateVault(data) {
  if (!data || data.schemaVersion !== 1 || arrays.some((key) => !Array.isArray(data[key])) || !data.people.length) throw new Error('Неподдерживаемый формат базы.');
  for (const key of arrays) {
    if (data[key].some((record) => !record || typeof record.id !== 'string') || new Set(data[key].map((record) => record.id)).size !== data[key].length) throw new Error('Повреждена структура записей.');
  }
  return data;
}
function mergeVault() {
  const vault = { ...state.base };
  for (const key of arrays) vault[key] = [...state.base[key], ...state.overlay[key].filter((record) => !state.base[key].some((original) => original.id === record.id))];
  state.vault = vault;
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('health-archive-encrypted', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vaults');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function storedOverlay(mode, value) {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction('vaults', mode === 'read' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('vaults');
    const request = mode === 'read' ? store.get(state.scope) : store.put(value, state.scope);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Хранилище недоступно'));
  });
}
function otherStoredOverlays() {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction('vaults', 'readonly');
    const store = transaction.objectStore('vaults'), keys = store.getAllKeys(), values = store.getAll();
    transaction.oncomplete = () => {
      const migrated = state.overlay.migratedScopes || [];
      resolve(keys.result.map((scope,index) => ({ scope, envelope:values.result[index] })).filter((item) => typeof item.scope === 'string' && item.scope.startsWith('v1:') && item.scope !== state.scope && item.envelope?.format === 'health-vault-v1' && !migrated.includes(`${item.scope}:${item.envelope.cipher?.iv}`)));
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Хранилище недоступно'));
  });
}
function migrationPanel() {
  if (!state.legacyScopes.length) return '';
  return `<section class="panel prose"><p class="eyebrow accent-orange">ДОПОЛНЕНИЯ С ПРЕЖНИМ ПАРОЛЕМ</p><h2>Перенести записи после смены пароля</h2><p>В этом браузере найдены зашифрованные дополнения с другим ключом. Введите их прежний пароль: сайт перенесёт записи и вложения под текущий ключ. Исходная зашифрованная копия останется в браузере.</p><form id="migrate-local-form"><label class="field"><span class="field-label">Прежний пароль дополнений</span><input id="previous-password" class="input" type="password" required autocomplete="off" spellcheck="false" maxlength="1024"></label><p id="migration-error" class="form-error" role="alert"></p><button class="button button-primary" type="submit">Перенести дополнения</button></form><p class="section-note">Прежние скачанные резервные копии открываются со своим прежним паролем через экран блокировки.</p></section>`;
}
async function migrateLocalRecords(form) {
  if (state.busy || !state.key) return;
  const generation = state.generation, passwordField = $('previous-password'), password = passwordField.value;
  const submit = form.querySelector('[type="submit"]'); state.busy = true; submit.disabled = true; $('migration-error').textContent = '';
  try {
    const candidate = structuredClone(state.overlay); candidate.migratedScopes ||= [];
    let matched = 0;
    for (const legacy of state.legacyScopes) {
      let decrypted;
      try { decrypted = await decryptEnvelope(legacy.envelope, password); } catch { continue; }
      if (generation !== state.generation) return;
      const overlay = decrypted.data;
      if (!overlay || arrays.some((key) => !Array.isArray(overlay[key])) || !overlay.assets || typeof overlay.assets !== 'object') throw new Error('Прежние данные имеют неподдерживаемый формат. Они сохранены без изменений.');
      for (const doc of overlay.documents) {
        if (state.base.documents.some((existing) => existing.id === doc.id) || candidate.documents.some((existing) => existing.id === doc.id)) continue;
        if (!overlay.assets[doc.id]) throw new Error('В прежних данных отсутствует вложение. Исходная копия сохранена.');
        const plain = await decryptAsset(fromBase64(overlay.assets[doc.id]), decrypted.key);
        if (generation !== state.generation) return;
        candidate.assets[doc.id] = toBase64(await encryptAsset(plain, state.key));
        if (generation !== state.generation) return;
      }
      for (const key of arrays) {
        const known = new Set([...state.base[key], ...candidate[key]].map((item) => item.id));
        for (const item of overlay[key]) if (typeof item.id === 'string' && !known.has(item.id)) { candidate[key].push(item); known.add(item.id); }
      }
      candidate.migratedScopes.push(`${legacy.scope}:${legacy.envelope.cipher.iv}`); matched++;
    }
    if (!matched) throw new Error('Этот пароль не открывает найденные дополнения. Проверьте прежний пароль. Данные не изменены.');
    await persistOverlay(candidate); if (generation !== state.generation) return;
    passwordField.value = ''; state.legacyScopes = await otherStoredOverlays(); if (generation !== state.generation) return;
    populateProfiles(); render(); toast('Дополнения перенесены под текущий пароль. Скачайте новую резервную копию.');
  } catch (error) {
    if (generation === state.generation) {
      const message = error.message || 'Не удалось перенести дополнения. Исходные данные сохранены.', errorNode = $('migration-error');
      if (errorNode) errorNode.textContent = message; else toast(message);
    }
  }
  finally { passwordField.value = ''; if (generation === state.generation) { state.busy = false; submit.disabled = false; } }
}
document.addEventListener('submit', (event) => { if (event.target.id === 'migrate-local-form') { event.preventDefault(); void migrateLocalRecords(event.target); } });
async function persistOverlay(candidate) {
  if (!state.database) throw new Error('Браузер не разрешил локальное хранение. Откройте сайт в обычном режиме браузера.');
  const generation = state.generation;
  const envelope = await encryptJson(candidate, state.key, state.kdf);
  if (generation !== state.generation) throw new Error('База заблокирована. Откройте её ещё раз.');
  await storedOverlay('write', envelope);
  if (generation !== state.generation) return;
  state.overlay = candidate; mergeVault();
}
function armLock() {
  if (!state.key) return;
  clearTimeout(state.timer); state.timer = setTimeout(() => lock('База заблокирована после 15 минут бездействия.'), 15 * 60 * 1000);
}
function revokeDocuments() {
  state.documentRequest++;
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls.clear(); $('document-viewer').replaceChildren();
}
function lock(message = '') {
  state.generation++; clearTimeout(state.timer); clearTimeout(state.toastTimer);
  for (const id of ['record-dialog','document-dialog']) if ($(id).open) $(id).close();
  revokeDocuments();
  Object.assign(state, { key:null, kdf:null, base:null, vault:null, overlay:emptyOverlay(), assets:{}, personId:null, scope:null, legacyScopes:[], busy:false });
  state.database?.close(); state.database = null;
  $('main').replaceChildren(); $('profile-select').replaceChildren(); $('search-results').replaceChildren(); $('search-results').hidden = true;
  $('record-fields').replaceChildren(); $('record-title').textContent = 'Добавить запись'; $('document-title').textContent = 'Документ';
  $('global-search').value = ''; $('password').value = ''; $('password').type = 'password'; $('password-toggle').ariaPressed = 'false';
  $('app-shell').hidden = true; $('lock-screen').hidden = false; $('unlock-error').textContent = message;
  $('toast').hidden = true; $('toast').textContent = ''; $('unlock-submit').disabled = false; $('unlock-submit').textContent = 'Открыть базу ↗';
  $('password').focus();
}

$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.busy) return;
  state.busy = true; $('unlock-submit').disabled = true; $('unlock-submit').textContent = 'Расшифровка…'; $('unlock-error').textContent = '';
  try {
    if (!crypto.subtle) throw new Error('Нужен современный браузер и защищённое HTTPS-соединение.');
    let envelope = state.imported;
    if (!envelope) { const response = await fetch('vault.json', { cache:'no-store' }); if (!response.ok) throw new Error('Не удалось загрузить хранилище. Проверьте соединение.'); envelope = await response.json(); }
    const decrypted = await decryptEnvelope(envelope, $('password').value);
    $('password').value = '';
    const data = decrypted.data.vault || decrypted.data;
    validateVault(data);
    state.key = decrypted.key; state.kdf = envelope.kdf; state.base = data; state.assets = decrypted.data.assets || {}; state.scope = `v1:${envelope.kdf.salt}`;
    state.overlay = emptyOverlay();
    let warning = '';
    try {
      state.database = await openDatabase();
      const stored = await storedOverlay('read');
      if (stored) {
        const local = await decryptJson(stored, state.key);
        if (!local || arrays.some((key) => !Array.isArray(local[key])) || typeof local.assets !== 'object') throw new Error('Неверный формат локальных записей');
        state.overlay = local;
      }
      state.legacyScopes = await otherStoredOverlays();
    } catch { warning = 'Локальные записи недоступны. Исходная база открыта; импортируйте резервную копию, если добавляли данные.'; }
    mergeVault(); state.personId = state.vault.people[0].id;
    populateProfiles(); $('lock-screen').hidden = true; $('app-shell').hidden = false;
    render(); armLock(); if (warning) toast(warning);
  } catch (error) {
    if (state.key) lock();
    $('unlock-error').textContent = error.name === 'OperationError' || error.name === 'DataError' ? 'Не удалось расшифровать. Проверьте пароль и целостность файла.' : (error.message || 'Не удалось открыть базу.');
  } finally { state.busy = false; $('unlock-submit').disabled = false; $('unlock-submit').textContent = 'Открыть базу ↗'; }
});
$('password-toggle').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('password-toggle').ariaPressed = String(show); $('password-toggle').ariaLabel = show ? 'Скрыть пароль' : 'Показать пароль'; });
$('lock-button').addEventListener('click', () => lock());
for (const event of ['pointerdown','keydown','scroll']) document.addEventListener(event, armLock, { passive:true });
window.addEventListener('pagehide', () => { if (state.key) lock(); });
$('import-backup').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; if (!file) return;
  try {
    if (file.size > 150 * 1024 * 1024) throw new Error('Файл больше 150 МБ.');
    const envelope = JSON.parse(await file.text());
    if (envelope.format !== 'health-vault-v1') throw new Error('Выберите зашифрованную резервную копию этой базы.');
    state.imported = envelope; $('backup-selection').textContent = 'Выбрана резервная копия. Введите её пароль. Чтобы открыть опубликованную базу, обновите страницу.';
    $('unlock-error').textContent = ''; $('password').focus();
  } catch (error) { $('unlock-error').textContent = error.message; }
  $('import-file').value = '';
});

function populateProfiles() {
  $('profile-select').innerHTML = state.vault.people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('profile-select').value = state.personId;
}
$('profile-select').addEventListener('change', () => { state.personId = $('profile-select').value; $('global-search').value = ''; hideSearch(); location.hash = '#/home'; render(); });
$('menu-toggle').addEventListener('click', () => { const open = $('menu-toggle').ariaExpanded !== 'true'; $('header-nav').classList.toggle('is-open', open); $('menu-toggle').ariaExpanded = String(open); });
window.addEventListener('hashchange', () => { if (state.key) { render(); $('main').focus({ preventScroll:true }); window.scrollTo({ top:0, behavior:'instant' }); } });

function problemCard(p) {
  const tone = ['cyan','orange','green','violet'].includes(p.tone) ? p.tone : 'cyan';
  return `<article class="problem-card accent-${tone}"><div class="card-top"><span class="card-icon" aria-hidden="true">↗</span><span class="badge">${esc(p.category)}</span>${localBadge(p)}</div><h3 class="card-title">${routeLink(`problem/${encodeURIComponent(p.id)}`, esc(p.title))}</h3><p class="card-copy">${esc(p.summary)}</p><div class="card-footer"><span>${esc(p.status)}</span>${routeLink(`problem/${encodeURIComponent(p.id)}`, 'Открыть разбор →')}</div></article>`;
}
function documentCard(d) {
  return `<article class="document-card"><div class="card-top"><span class="badge">${esc(kindLabel[d.kind] || 'Документ')}</span><span class="section-note">${dateText(d.date)}</span>${localBadge(d)}</div><h3 class="card-title">${esc(d.title)}</h3><p class="card-copy">${esc(d.description)}</p><div class="card-footer"><span>${esc(d.mime === 'application/pdf' ? 'PDF' : 'Текст')} ${d.size ? ` / ${(d.size/1024).toFixed(0)} КБ` : ''}</span><button class="button button-secondary button-small" type="button" data-document="${esc(d.id)}">Открыть ↗</button></div></article>`;
}
function labTable(labs) {
  if (!labs.length) return empty('Анализы можно добавить вручную и связать с разбором проблемы.');
  return `<div class="lab-table-wrap"><table class="lab-table"><caption class="sr-only">Результаты анализов и их лабораторные референсы</caption><thead><tr><th scope="col">Показатель / дата</th><th scope="col">Результат</th><th scope="col">Референс лаборатории</th><th scope="col">Значение для разбора</th></tr></thead><tbody>${labs.map((lab) => `<tr><th scope="row" class="lab-name"><a href="#/lab/${encodeURIComponent(lab.id)}">${esc(lab.name)}</a><span class="section-note">${dateText(lab.date)} · ${esc(lab.group)}</span>${localBadge(lab)}</th><td class="lab-value"><span class="${lab.status === 'high' || lab.status === 'low' ? 'accent-orange' : ''}">${esc(lab.value)} <small>${esc(lab.unit)}</small></span><span class="badge badge-${esc(['normal','high','calculated'].includes(lab.status) ? lab.status : 'calculated')}">${esc(statusLabel[lab.status] || lab.status)}</span></td><td class="lab-range">${esc(lab.reference)}</td><td>${esc(lab.interpretation)}</td></tr>`).join('')}</tbody></table></div>`;
}
function actionList(actions) {
  if (!actions.length) return empty('Добавьте следующие шаги после консультации или получения новых данных.');
  return `<div class="action-list">${actions.map((action, index) => `<article class="action-item"><span class="result-number">${String(index + 1).padStart(2,'0')}</span><div><div class="card-top"><span class="eyebrow ${action.priority === 'next' ? 'accent-cyan' : ''}">${esc(action.timing || ({ next:'Ближайший шаг', planned:'Планово', conditional:'По показаниям' }[action.priority]))}</span>${localBadge(action)}</div><h3>${esc(action.title)}</h3><p>${esc(action.description)}</p>${action.problemId && getProblem(action.problemId) ? routeLink(`problem/${encodeURIComponent(action.problemId)}`, esc(getProblem(action.problemId).title), 'section-note') : ''}</div></article>`).join('')}</div>`;
}
function timeline(events) {
  return events.length ? `<div class="timeline">${[...events].sort((a,b) => b.date.localeCompare(a.date)).map((item) => `<article class="timeline-item"><time class="timeline-date" datetime="${esc(item.date)}">${dateText(item.date)}</time><div><p class="eyebrow">${esc(eventLabel[item.type] || item.type || 'Событие')}</p><h3 class="timeline-title">${esc(item.title)}</h3><p class="timeline-copy">${esc(item.description)}</p>${localBadge(item)}${item.documentId && getDocument(item.documentId) ? `<button class="button button-secondary button-small" data-document="${esc(item.documentId)}" type="button">Документ ↗</button>` : ''}</div></article>`).join('')}</div>` : empty('Консультации, симптомы и новые результаты будут появляться здесь.');
}
function sourceList(sources) {
  return `<ol class="source-list">${sources.map((source) => { const url = safeUrl(source.url), number = Number.isSafeInteger(source.number) ? source.number : null; return `<li class="source-item"${number ? ` value="${number}"` : ''}><span class="badge">${number ? `[${number}] · ` : ''}${esc(source.kind || 'Источник')}${source.year ? ` / ${esc(source.year)}` : ''}</span><h3>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)} ↗</a>` : esc(source.title)}</h3>${source.note ? `<p>${esc(source.note)}</p>` : ''}</li>`; }).join('')}</ol>`;
}
function localNotice() {
  const count = arrays.reduce((sum,key) => sum + state.overlay[key].length, 0);
  return count ? `<div class="local-notice">Локальных записей: ${count}. Они зашифрованы в этом браузере. ${routeLink('settings','Скачать резервную копию →')}</div>` : '';
}
function home() {
  const p = person(), problems = records('problems'), labs = records('labs'), docs = records('documents');
  return `<section class="hero"><div><p class="eyebrow">ЛИЧНЫЙ ПРОФИЛЬ / ${esc(p.age ? `${p.age} ЛЕТ` : 'МЕДИЦИНСКАЯ ИСТОРИЯ')}</p><h1 class="hero-title">${esc(p.name)}<br><span class="accent-cyan">Карта здоровья.</span></h1><p class="hero-copy">${esc(p.summary)}</p><div class="hero-meta"><span>ОБНОВЛЕНО / ${dateText(state.vault.updatedAt)}</span>${routeLink('profiles','Все профили ↗')}</div></div><div class="hero-side"><div class="hero-orbit" aria-hidden="true"></div><p class="eyebrow accent-cyan">ИСТОРИЯ → ДАННЫЕ → ДЕЙСТВИЯ</p><p class="section-note">Каждый вывод связан с результатами, документами и источниками.</p></div></section>${localNotice()}<div class="stat-grid">${[['problems',problems.length,'Разборы проблем','cyan'],['labs',labs.length,'Показатели','green'],['documents',docs.length,'Документы','violet'],['actions',records('actions').length,'Следующие шаги','orange']].map(([path,value,label,tone]) => routeLink(path, `<span class="stat-value accent-${tone}">${String(value).padStart(2,'0')}</span><span class="stat-label">${label} ↗</span>`, 'stat-card')).join('')}</div><section><div class="section-head"><div><p class="eyebrow">01 / РАЗБОРЫ</p><h2 class="section-title">Проблемы и исследования</h2></div>${button('problem','Добавить проблему')}</div><div class="card-grid">${problems.map(problemCard).join('') || empty('Добавьте первую проблему в профиль.')}</div></section><div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><p class="eyebrow">02 / ПЛАН</p><h2>Ближайшие действия</h2></div>${routeLink('actions','Все шаги →')}</div>${actionList(records('actions').slice(0,3))}</section><section class="panel"><div class="panel-head"><div><p class="eyebrow">03 / ИСТОРИЯ</p><h2>Последние события</h2></div>${routeLink('timeline','Вся история →')}</div>${timeline([...records('timeline')].sort((a,b) => b.date.localeCompare(a.date)).slice(0,3))}</section></div><section class="callout"><h2>Как читать базу</h2><p>Записанные диагнозы, рабочие гипотезы и результаты обследований имеют разный вес. В разборах указано, что подтверждено документами и что требует проверки на приёме. Лабораторный референс сам по себе не устанавливает диагноз.</p>${routeLink('sources','Исследования и рекомендации ↗')}</section>`;
}
function problemDetail(id) {
  const p = getProblem(id); if (!p) return empty('Такой разбор не найден в выбранном профиле.');
  const labs = records('labs').filter((l) => (p.labIds || []).includes(l.id) || (l.problemIds || []).includes(id));
  const docs = records('documents').filter((d) => (p.documentIds || []).includes(d.id) || (d.problemIds || []).includes(id));
  const sources = state.vault.sources.filter((s) => (p.sourceIds || []).includes(s.id));
  return `<div class="breadcrumbs">${routeLink('problems','Разборы проблем')} / ${esc(p.category)}</div>${heading(p.category,p.title,p.summary)}<div class="hero-meta"><span class="badge">${esc(p.status)}</span><span>ОБНОВЛЕНО / ${dateText(p.updatedAt)}</span>${localBadge(p)}</div><nav class="section-tabs" aria-label="Навигация по разбору"><a href="#problem-conclusions" data-scroll="problem-conclusions">Выводы</a><a href="#problem-labs" data-scroll="problem-labs">Анализы</a><a href="#problem-actions" data-scroll="problem-actions">Действия</a><a href="#problem-documents" data-scroll="problem-documents">Документы</a><a href="#problem-sources" data-scroll="problem-sources">Источники</a></nav><div id="problem-conclusions" class="prose">${(p.sections || []).map((section) => `<section class="panel"><h2>${esc(section.title)}</h2>${(section.paragraphs || []).map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}${section.bullets?.length ? `<ul>${section.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}</section>`).join('')}</div><section id="problem-labs"><div class="section-head"><h2 class="section-title">Связанные анализы</h2>${button('lab','Добавить результат')}</div>${labTable(labs)}</section><section id="problem-actions"><div class="section-head"><h2 class="section-title">Дальнейшие действия</h2></div>${actionList(records('actions').filter((a) => a.problemId === id))}</section><section id="problem-documents"><div class="section-head"><h2 class="section-title">Документы</h2></div><div class="card-grid">${docs.map(documentCard).join('') || empty('Связанные документы пока не добавлены.')}</div></section><section id="problem-sources"><div class="section-head"><h2 class="section-title">Источники</h2><span class="section-note">${sources.length} материалов</span></div>${sourceList(sources)}</section>`;
}
function labDetail(id) {
  const lab = records('labs').find((l) => l.id === id); if (!lab) return empty('Результат не найден.');
  return `<div class="breadcrumbs">${routeLink('labs','Анализы')} / ${esc(lab.group)}</div>${heading(lab.group,lab.name,`Дата ${dateText(lab.date)}${lab.reportedAt ? ` · Результат ${dateText(lab.reportedAt)}` : ''}`)}<div class="detail-grid"><section class="detail-card"><p class="eyebrow">РЕЗУЛЬТАТ</p><p class="stat-value ${lab.status === 'high' ? 'accent-orange' : 'accent-cyan'}">${esc(lab.value)} <small>${esc(lab.unit)}</small></p><span class="badge badge-${esc(lab.status === 'normal' ? 'normal' : lab.status === 'high' ? 'high' : 'calculated')}">${esc(statusLabel[lab.status] || lab.status)}</span>${localBadge(lab)}</section><section class="detail-card"><p class="eyebrow">РЕФЕРЕНС ИЗ БЛАНКА</p><p class="result-number">${esc(lab.reference)}</p><p class="section-note">Референс относится к этой лаборатории и методу. Учитывайте условия сдачи и клиническую картину.</p></section></div><section class="panel prose"><h2>Что это означает</h2><p>${esc(lab.interpretation)}</p>${lab.context ? `<div class="callout">${esc(lab.context)}</div>` : ''}${lab.documentId && getDocument(lab.documentId) ? `<button class="button button-primary" type="button" data-document="${esc(lab.documentId)}">Открыть исходный бланк ↗</button>` : ''}</section><div class="section-head"><h2 class="section-title">Связанные разборы</h2></div><div class="card-grid">${records('problems').filter((p) => (lab.problemIds || []).includes(p.id)).map(problemCard).join('') || empty('Результат пока не привязан к проблеме.')}</div>`;
}
function labsPage() {
  const labs = records('labs'), groups = [...new Set(labs.map((l) => l.group))];
  return `${heading('02 / РЕЗУЛЬТАТЫ','Анализы','Все показатели с единицами, датами, референсами и объяснением.',button('lab','Добавить результат'))}<div class="filter-row"><label class="field"><span class="field-label">Группа</span><select id="lab-group" class="select"><option value="">Все группы</option>${groups.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label><label class="field"><span class="field-label">Оценка</span><select id="lab-status" class="select"><option value="">Все результаты</option><option value="high">Выше референса</option><option value="normal">В референсе</option><option value="calculated">Расчётные</option><option value="unreviewed">Без оценки</option></select></label><span class="section-note" id="lab-count">Показателей: ${labs.length}</span></div><div id="lab-results">${labTable(labs)}</div>`;
}
function profilesPage() {
  return `${heading('ПРОФИЛИ','Истории людей','Отдельные проблемы, результаты и документы для каждого человека.',button('person','Добавить профиль'))}<div class="card-grid">${state.vault.people.map((p) => `<article class="profile-card panel"><span class="profile-avatar">${esc(p.initials || p.name.slice(0,1))}</span><h2>${esc(p.name)}</h2><p>${esc(p.summary)}</p>${localBadge(p)}<div class="card-footer"><span>${state.vault.problems.filter((problem) => problem.personId === p.id).length} разборов</span><button class="button button-secondary button-small" data-profile="${esc(p.id)}" type="button">${p.id === state.personId ? 'Текущий профиль' : 'Открыть профиль →'}</button></div></article>`).join('')}</div>`;
}
function settingsPage() {
  return `${heading('ХРАНЕНИЕ','Данные под вашим контролем','Опубликованные материалы и локальные дополнения хранятся зашифрованными.')}<div class="detail-grid"><section class="panel prose"><p class="eyebrow accent-cyan">РЕЗЕРВНАЯ КОПИЯ</p><h2>Сохранить всю базу</h2><p>Копия включает текущие профили, записи и все документы. Она зашифрована тем же паролем. Сохраните её перед очисткой браузера и переносом на другое устройство.</p><button class="button button-primary" id="export-backup" type="button">Скачать зашифрованную копию ↗</button><p class="section-note">Для открытия: заблокируйте базу → «Открыть резервную копию» → введите пароль.</p></section><section class="panel prose"><p class="eyebrow accent-violet">ДОПОЛНЕНИЯ</p><h2>Что сохраняет сайт</h2><p>Новые профили, проблемы, анализы, документы, события и действия сохраняются только в этом браузере. Они не загружаются в GitHub и не появляются автоматически на другом устройстве.</p><p>Чтобы обновить общую опубликованную версию, нужно включить новые материалы в исходную базу и опубликовать заново. Резервная копия переносит текущую версию без публикации.</p>${button('person','Новый профиль')}</section></div><section class="callout prose"><h2>Пароль и блокировка</h2><p>Сайт не хранит пароль. Расшифрованные записи находятся в памяти до блокировки или закрытия страницы. Через 15 минут бездействия база блокируется автоматически.</p><p>Кто знает пароль, сможет прочитать всю базу и документы. Восстановить забытый пароль на сервере невозможно. Сохраните пароль отдельно от копии.</p><p>При скачивании отдельного документа создаётся обычный расшифрованный файл на вашем устройстве. Блокировка сайта не удаляет такие файлы и уже сделанные копии.</p><button class="button button-secondary" data-lock type="button">Заблокировать сейчас</button></section>`;
}
function render() {
  if (!state.vault) return;
  const parts = (location.hash.replace(/^#\/?/,'') || 'home').split('/');
  const page = parts[0]; let id = ''; try { id = decodeURIComponent(parts[1] || ''); } catch { /* malformed URL has no matching record */ }
  let html;
  if (page === 'home') html = home();
  else if (page === 'problems') html = `${heading('01 / ИССЛЕДОВАНИЯ','Разборы проблем','По каждой теме: выводы, подтверждения, неопределённость и план.',button('problem','Добавить проблему'))}<div class="card-grid">${records('problems').map(problemCard).join('') || empty('В этом профиле пока нет разборов.')}</div>`;
  else if (page === 'problem') html = problemDetail(id);
  else if (page === 'labs') html = labsPage();
  else if (page === 'lab') html = labDetail(id);
  else if (page === 'documents') html = `${heading('03 / АРХИВ','Документы','Исходные бланки, консультации и подробные исследовательские обзоры.',button('document','Добавить документ'))}<div class="filter-row"><label class="field"><span class="field-label">Тип документа</span><select id="document-kind" class="select"><option value="">Все документы</option>${Object.entries(kindLabel).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label></div><div id="document-results" class="card-grid">${records('documents').map(documentCard).join('') || empty('Добавьте документ, чтобы сохранить его вместе с историей.')}</div>`;
  else if (page === 'timeline') html = `${heading('04 / ХРОНОЛОГИЯ','История событий','Симптомы, консультации, анализы и обновления в одной ленте.',button('timeline','Добавить событие'))}<section class="panel">${timeline(records('timeline'))}</section>`;
  else if (page === 'actions') html = `${heading('05 / ДАЛЬНЕЙШИЕ ШАГИ','План действий','Основа для обсуждения с врачом. Шаги по показаниям нужны при выполнении описанных условий.',button('action','Добавить шаг'))}<section class="panel">${actionList(records('actions'))}</section>`;
  else if (page === 'profiles') html = profilesPage();
  else if (page === 'sources') html = `${heading('06 / ДОКАЗАТЕЛЬНАЯ БАЗА','Источники','Исследования, обзоры и профессиональные рекомендации, использованные в разборах.')}${sourceList(state.vault.sources.filter((s) => records('problems').some((p) => (p.sourceIds || []).includes(s.id))))}`;
  else if (page === 'settings') html = settingsPage();
  else html = `${heading('СТРАНИЦА НЕ НАЙДЕНА','Такого раздела нет','Выберите раздел в меню.')}${routeLink('home','На главную →','button button-primary')}`;
  if (state.legacyScopes.length) html = (page === 'settings' ? '' : `<div class="local-notice">Найдены дополнения с прежним паролем. ${routeLink('settings','Перенести записи →')}</div>`) + html + (page === 'settings' ? migrationPanel() : '');
  $('main').innerHTML = html;
  for (const link of $('header-nav').querySelectorAll('a')) { const active = link.hash === `#/${page === 'problem' ? 'problems' : page === 'lab' ? 'labs' : page}`; if (active) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
  $('header-nav').classList.remove('is-open'); $('menu-toggle').ariaExpanded = 'false'; hideSearch();
}

function hideSearch() { $('search-results').hidden = true; $('global-search').ariaExpanded = 'false'; }
$('global-search').addEventListener('input', () => {
  const query = $('global-search').value.trim().toLocaleLowerCase('ru');
  if (!query) { hideSearch(); return; }
  const candidates = [...records('problems').map((p) => ({ title:p.title, copy:p.summary, path:`problem/${encodeURIComponent(p.id)}`, type:'Разбор' })), ...records('labs').map((l) => ({ title:l.name, copy:`${l.value} ${l.unit} · ${l.interpretation}`, path:`lab/${encodeURIComponent(l.id)}`, type:'Анализ' })), ...records('documents').map((d) => ({ title:d.title, copy:d.description, documentId:d.id, type:'Документ' }))];
  const results = candidates.filter((r) => `${r.title} ${r.copy}`.toLocaleLowerCase('ru').includes(query)).slice(0,10);
  $('search-results').innerHTML = results.length ? results.map((r) => r.documentId ? `<button type="button" class="search-result" data-document="${esc(r.documentId)}"><span class="eyebrow">${r.type}</span><strong>${esc(r.title)}</strong></button>` : routeLink(r.path, `<span class="eyebrow">${r.type}</span><strong>${esc(r.title)}</strong>`, 'search-result')).join('') : '<p class="search-result">Ничего не найдено.</p>';
  $('search-results').hidden = false; $('global-search').ariaExpanded = 'true';
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideSearch(); });
document.addEventListener('click', async (event) => {
  if (event.target.closest('.skip-link')) { event.preventDefault(); const target = state.key ? $('main') : $('password'); target.focus(); target.scrollIntoView({ block:'start' }); return; }
  if (!event.target.closest('.search-wrap')) hideSearch();
  const target = event.target.closest('button,a'); if (!target) return;
  if (target.dataset.close) $(target.dataset.close)?.close();
  if (!state.key) return;
  if (target.dataset.add) showForm(target.dataset.add);
  if (target.hasAttribute('data-lock')) lock();
  if (target.dataset.scroll) { event.preventDefault(); $(target.dataset.scroll)?.scrollIntoView({ behavior:'smooth', block:'start' }); }
  if (target.dataset.document) await openDocument(target.dataset.document);
  if (target.dataset.profile) { state.personId = target.dataset.profile; populateProfiles(); location.hash = '#/home'; render(); }
  if (target.id === 'export-backup') await exportBackup(target);
});
document.addEventListener('change', (event) => {
  if (!state.key) return;
  if (['lab-group','lab-status'].includes(event.target.id)) { const labs = records('labs').filter((l) => (!$('lab-group').value || l.group === $('lab-group').value) && (!$('lab-status').value || l.status === $('lab-status').value)); $('lab-results').innerHTML = labTable(labs); $('lab-count').textContent = `Показателей: ${labs.length}`; }
  if (event.target.id === 'document-kind') { const docs = records('documents').filter((d) => !event.target.value || d.kind === event.target.value); $('document-results').innerHTML = docs.map(documentCard).join('') || empty('Документов этого типа пока нет.'); }
});

async function encryptedDocument(doc) {
  const local = state.overlay.assets[doc.id] || state.assets[doc.id];
  if (local) return fromBase64(local).buffer;
  if (typeof doc.asset !== 'string' || !/^assets\/[a-zA-Z0-9_-]+\.bin$/.test(doc.asset)) throw new Error('Нет зашифрованного файла документа.');
  const response = await fetch(doc.asset); if (!response.ok) throw new Error('Не удалось загрузить документ. Проверьте соединение.');
  return response.arrayBuffer();
}
async function openDocument(id) {
  const doc = getDocument(id); if (!doc) return;
  hideSearch(); revokeDocuments(); $('document-title').textContent = doc.title;
  $('document-viewer').textContent = 'Загрузка и расшифровка…'; $('document-dialog').showModal();
  const generation = state.generation, request = state.documentRequest;
  try {
    const bytes = await encryptedDocument(doc); if (generation !== state.generation || request !== state.documentRequest) return;
    const plain = await decryptAsset(bytes, state.key); if (generation !== state.generation || request !== state.documentRequest || !$('document-dialog').open) return;
    $('document-viewer').replaceChildren();
    const url = URL.createObjectURL(new Blob([plain], { type:doc.mime })); state.urls.add(url);
    const hint = document.createElement('p'); hint.className = 'section-note'; hint.textContent = 'После скачивания на устройстве останется обычный расшифрованный файл.';
    const download = document.createElement('a'); download.className = 'button button-primary button-small'; download.href = url; download.download = doc.fileName || 'document'; download.textContent = 'Скачать документ ↓';
    $('document-viewer').append(hint, download);
    if (doc.mime === 'application/pdf') {
      const open = document.createElement('a'); open.className = 'button button-secondary button-small'; open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'Открыть PDF отдельно ↗';
      const note = document.createElement('p'); note.className = 'section-note'; note.textContent = 'Если предпросмотр на телефоне пустой, откройте PDF отдельно или скачайте его для просмотра в приложении.';
      $('document-viewer').append(open, note);
    }
    if (doc.mime === 'application/pdf') { const frame = document.createElement('iframe'); frame.src = url; frame.title = doc.title; frame.className = 'pdf-frame'; $('document-viewer').append(frame); }
    else { const pre = document.createElement('pre'); pre.className = 'document-text'; pre.textContent = new TextDecoder().decode(plain); $('document-viewer').append(pre); }
  } catch (error) { if (generation === state.generation && request === state.documentRequest) $('document-viewer').textContent = error.name === 'OperationError' ? 'Не удалось проверить целостность документа.' : error.message; }
}
$('document-dialog').addEventListener('close', revokeDocuments);
async function exportBackup(target) {
  const generation = state.generation, snapshot = structuredClone(state.vault); target.disabled = true; target.textContent = 'Подготовка документов…';
  try {
    const assets = {};
    for (const doc of snapshot.documents) { assets[doc.id] = toBase64(new Uint8Array(await encryptedDocument(doc))); if (generation !== state.generation) return; }
    const envelope = await encryptJson({ vault:snapshot, assets }, state.key, state.kdf);
    if (generation !== state.generation) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type:'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `health-archive-${today()}.healthvault`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000); toast('Зашифрованная копия подготовлена. Сохраните пароль отдельно.');
  } catch (error) { toast(`Копия не создана: ${error.message}`); }
  finally { target.disabled = false; target.textContent = 'Скачать зашифрованную копию ↗'; }
}

const input = (name,label,options = {}) => `<label class="field ${options.full ? 'full-width' : ''}"><span class="field-label">${esc(label)}</span>${options.area ? `<textarea class="input" name="${name}" rows="${options.rows || 4}" ${options.required ? 'required' : ''} maxlength="${options.max || 12000}"></textarea>` : `<input class="input" name="${name}" type="${options.type || 'text'}" ${options.required ? 'required' : ''} ${options.value ? `value="${esc(options.value)}"` : ''} ${options.accept ? `accept="${options.accept}"` : ''} ${options.type === 'number' ? 'min="0" max="130"' : ''} ${options.type === 'file' ? '' : 'maxlength="500"'}>`}</label>`;
const select = (name,label,values) => `<label class="field"><span class="field-label">${esc(label)}</span><select class="select" name="${name}">${values.map(([value,text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join('')}</select></label>`;
function showForm(type) {
  const titles = { person:'Добавить профиль', problem:'Добавить проблему', lab:'Добавить результат анализа', document:'Добавить документ', timeline:'Добавить событие', action:'Добавить следующий шаг' };
  if (!titles[type]) return;
  state.formType = type;
  const problemSelect = () => select('problemId','Связанный разбор', [['','Без привязки'], ...records('problems').map((p) => [p.id,p.title])]);
  let fields = '';
  if (type === 'person') fields = input('name','Имя', { required:true }) + input('age','Возраст (необязательно)', { type:'number' }) + input('summary','Краткое описание', { area:true, full:true });
  if (type === 'problem') fields = input('title','Название проблемы', { required:true, full:true }) + input('category','Раздел', { value:'Наблюдение' }) + input('status','Статус', { value:'Требует разбора' }) + input('summary','Кратко: симптомы и контекст', { required:true, area:true, full:true }) + input('notes','Известные факты и вопросы к врачу', { area:true, full:true });
  if (type === 'lab') fields = input('name','Показатель', { required:true }) + input('group','Группа', { required:true, value:'Другие анализы' }) + input('date','Дата сдачи', { type:'date', required:true, value:today() }) + input('value','Результат из бланка', { required:true }) + input('unit','Единицы измерения') + input('reference','Референс из бланка') + select('status','Оценка по бланку',[['unreviewed','Не оценено'],['normal','В референсе'],['high','Выше референса'],['low','Ниже референса'],['calculated','Расчётный показатель']]) + problemSelect() + input('interpretation','Комментарий (без автоматической диагностики)', { area:true, full:true });
  if (type === 'document') fields = input('title','Название документа', { required:true, full:true }) + input('date','Дата документа', { type:'date', required:true, value:today() }) + select('kind','Тип',Object.entries(kindLabel)) + problemSelect() + input('file','Файл PDF или текст (до 20 МБ)', { required:true, type:'file', accept:'.pdf,.md,.txt,application/pdf,text/plain,text/markdown', full:true }) + input('description','Краткое описание', { area:true, full:true });
  if (type === 'timeline') fields = input('title','Событие', { required:true, full:true }) + input('date','Дата', { type:'date', required:true, value:today() }) + problemSelect() + input('description','Что произошло', { required:true, area:true, full:true });
  if (type === 'action') fields = input('title','Следующий шаг', { required:true, full:true }) + input('timing','Срок или условие выполнения', { required:true }) + select('priority','Приоритет',[['next','Ближайший шаг'],['planned','Планово'],['conditional','По показаниям']]) + problemSelect() + input('description','Что сделать и зачем', { required:true, area:true, full:true });
  $('record-title').textContent = titles[type]; $('record-fields').innerHTML = fields; $('record-error').textContent = ''; $('record-dialog').showModal();
}
$('record-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!state.key || state.busy) return;
  const form = event.currentTarget, fd = new FormData(form), get = (name) => String(fd.get(name) || '').trim();
  const type = state.formType, id = newId(), record = { id, local:true, personId:state.personId }, candidate = structuredClone(state.overlay);
  const generation = state.generation; state.busy = true; const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    let collection;
    if (type === 'person') { collection = 'people'; Object.assign(record, { name:get('name'), initials:get('name').split(/\s+/).slice(0,2).map((s) => s[0]).join(''), age:get('age') ? Number(get('age')) : null, summary:get('summary'), updatedAt:today() }); delete record.personId; }
    else if (type === 'problem') { collection = 'problems'; Object.assign(record, { title:get('title'), category:get('category') || 'Наблюдение', status:get('status') || 'Требует разбора', tone:'violet', summary:get('summary'), updatedAt:today(), sections:[{ title:'Записано пользователем', paragraphs:[get('notes') || get('summary')], bullets:[] }], labIds:[], documentIds:[], sourceIds:[] }); }
    else if (type === 'lab') { collection = 'labs'; Object.assign(record, { name:get('name'), group:get('group'), date:get('date'), value:get('value'), unit:get('unit'), reference:get('reference') || 'Не указан', status:get('status'), interpretation:get('interpretation') || 'Комментарий не добавлен. Требует оценки в клиническом контексте.', problemIds:get('problemId') ? [get('problemId')] : [] }); }
    else if (type === 'document') {
      collection = 'documents'; const file = fd.get('file'); if (!(file instanceof File) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('Выберите непустой PDF или текстовый файл до 20 МБ.');
      const extension = file.name.split('.').pop().toLowerCase(); if (!['pdf','md','txt'].includes(extension)) throw new Error('Поддерживаются PDF, MD и TXT.');
      const data = await file.arrayBuffer(); if (generation !== state.generation) return;
      if (extension === 'pdf' && !new TextDecoder().decode(data.slice(0,5)).startsWith('%PDF-')) throw new Error('Файл не похож на PDF.');
      candidate.assets[id] = toBase64(new Uint8Array(await encryptAsset(data, state.key)));
      Object.assign(record, { title:get('title'), date:get('date'), kind:get('kind'), fileName:file.name, mime:extension === 'pdf' ? 'application/pdf' : 'text/plain', description:get('description'), size:file.size, problemIds:get('problemId') ? [get('problemId')] : [] });
    }
    else if (type === 'timeline') { collection = 'timeline'; Object.assign(record, { title:get('title'), date:get('date'), description:get('description'), type:'Запись', problemId:get('problemId') || undefined }); }
    else if (type === 'action') { collection = 'actions'; Object.assign(record, { title:get('title'), timing:get('timing'), priority:get('priority'), description:get('description'), problemId:get('problemId') || undefined }); }
    if (!collection) throw new Error('Неизвестный тип записи.');
    candidate[collection].push(record);
    if (type === 'document') candidate.timeline.push({ id:newId(), personId:state.personId, date:get('date'), title:get('title'), description:'Добавлен документ в локальную базу.', type:get('kind'), documentId:id, local:true });
    await persistOverlay(candidate); if (generation !== state.generation) return;
    if (type === 'person') { state.personId = id; populateProfiles(); location.hash = '#/home'; }
    $('record-dialog').close(); render(); toast('Запись сохранена зашифрованной в этом браузере. Сделайте резервную копию.');
  } catch (error) { if (generation === state.generation) $('record-error').textContent = error.message || 'Не удалось сохранить запись.'; }
  finally { state.busy = false; submit.disabled = false; }
});
