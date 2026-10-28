import { decryptEnvelope, encryptJson, decryptJson, decryptAsset, encryptAsset, toBase64, fromBase64, limits } from './crypto.js?v=2.3';
import * as model from './model.js?v=2.3';
import * as views from './views.js?v=2.3';
import { createSyncClient, syncScope } from './sync.js?v=2.1';
import { SYNC_ORIGIN } from './config.js';
import { installRecordController, prepareAttachment } from './records-controller.js?v=2.3';
import { extractDocument, parseLabText } from './import.js';

const $ = (id) => document.getElementById(id);
const esc = (v = '') => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const arrays = model.COLLECTIONS;
const emptyOverlay = () => model.normalizeOverlay({});
const state = { key:null, kdf:null, base:null, vault:null, overlay:emptyOverlay(), assets:{}, personId:null, imported:null, database:null, scope:null, legacyScopes:[], urls:new Set(), downloadUrls:new Set(), timer:null, toastTimer:null, formType:null, editing:null, busy:false, generation:0, documentRequest:0, filters:{}, sync:null, syncEtag:undefined, syncStatus:'Локальная копия', syncTimer:null, conflict:null, importDraft:null, visitDraft:null };
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
const kindLabel = model.DOCUMENT_KIND_LABELS;
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
  state.vault = model.mergeVault(state.base, state.overlay);
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
function compareAndStore(envelope,expectedIV){
  const database=state.database,scope=state.scope;
  return new Promise((resolve,reject)=>{
    const tx=database.transaction('vaults','readwrite'),store=tx.objectStore('vaults'),read=store.get(scope);let written=false;
    read.onsuccess=()=>{if((read.result?.cipher?.iv||null)!==expectedIV)return;store.put(envelope,scope);written=true;};
    tx.oncomplete=()=>resolve(written);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить запись.'));
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
    let candidate = structuredClone(state.overlay); candidate.migratedScopes ||= [];
    let matched = 0;
    for (const legacy of state.legacyScopes) {
      let decrypted;
      try { decrypted = await decryptEnvelope(legacy.envelope, password); } catch { continue; }
      if (generation !== state.generation) return;
      const overlay = model.normalizeOverlay(decrypted.data);
      if (!overlay || arrays.some((key) => !Array.isArray(overlay[key])) || !overlay.assets || typeof overlay.assets !== 'object') throw new Error('Прежние данные имеют неподдерживаемый формат. Они сохранены без изменений.');
      const convertedAssets={};
      for (const [assetId,encrypted] of Object.entries(overlay.assets)) {
        const plain = await decryptAsset(fromBase64(encrypted), decrypted.key);
        if (generation !== state.generation) return;
        if(candidate.assets[assetId]){
          const existing=await decryptAsset(fromBase64(candidate.assets[assetId]),state.key),hash=async b=>toBase64(await crypto.subtle.digest('SHA-256',b));
          if(await hash(existing)!==await hash(plain))throw Error('Найдены разные версии вложения. Прежняя зашифрованная копия сохранена.');
          convertedAssets[assetId]=candidate.assets[assetId];
        }else convertedAssets[assetId]=toBase64(await encryptAsset(plain,state.key));
        if (generation !== state.generation) return;
      }
      const merged=model.mergeOverlays(candidate,{...overlay,assets:convertedAssets});
      if(merged.conflicts.length)throw Error('В прежних дополнениях есть пересекающиеся изменения. Исходная копия сохранена; сначала откройте её резервную копию отдельно.');
      candidate=merged.overlay;
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
document.addEventListener('submit',event=>{if(event.target.id==='visit-plan-form'){event.preventDefault();void saveVisit(event.target).catch(error=>toast(error.message));}});
async function persistOverlay(candidate,{sync=true,replace=false}={}) {
  if (!state.database) throw new Error('Браузер не разрешил локальное хранение. Откройте сайт в обычном режиме браузера.');
  const generation = state.generation;
  const operation=async()=>{
    if(generation!==state.generation)throw Error('База заблокирована.');
    for(let attempt=0;attempt<4;attempt++){
      const stored=await storedOverlay('read');if(generation!==state.generation)throw Error('База заблокирована.');
      const disk=stored?model.normalizeOverlay(await decryptJson(stored,state.key)):emptyOverlay();if(generation!==state.generation)throw Error('База заблокирована.');
      const local=replace?{overlay:model.normalizeOverlay(candidate),conflicts:[]}:model.mergeOverlays(state.overlay,candidate);
      const merged=replace?local:model.mergeOverlays(local.overlay,disk);
      if(local.conflicts.length||merged.conflicts.length){
        const draft=await encryptJson(candidate,state.key,state.kdf);if(generation!==state.generation)throw Error('База заблокирована.');
        await putRecovery(`recovery:${new Date().toISOString()}:tab-draft`,draft);
        throw Error('Запись изменена в другой вкладке. Её версия не перезаписана; ваша версия сохранена в «Хранение и копии». Откройте базу заново перед изменением.');
      }
      if(replace&&stored)await putRecovery(`recovery:${new Date().toISOString()}:before-choice`,stored);
      const envelope=await encryptJson(merged.overlay,state.key,state.kdf);if(generation!==state.generation)throw Error('База заблокирована.');
      if(!await compareAndStore(envelope,stored?.cipher?.iv||null))continue;
      if(generation!==state.generation)return;state.overlay=merged.overlay;state.localRevision=(state.localRevision||0)+1;mergeVault();setSyncStatus('Сохранено в этом браузере');
      if(sync&&state.sync?.connected&&state.syncEtag!==undefined){clearTimeout(state.syncTimer);state.syncTimer=setTimeout(()=>{void synchronize(false);},1200);}return;
    }
    throw Error('Другая вкладка продолжает менять базу. Ничего не перезаписано; повторите сохранение.');
  };
  const task=(state.persistChain||Promise.resolve()).catch(()=>{}).then(operation);state.persistChain=task;return task;
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
  state.importAbort?.abort();
  state.importRequest=(state.importRequest||0)+1;$('extract-document').disabled=false;$('import-document-file').disabled=false;
  for (const id of ['record-dialog','document-dialog','import-dialog','sync-conflict-dialog']) if ($(id)?.open) $(id).close();
  revokeDocuments();
  for(const url of state.downloadUrls)URL.revokeObjectURL(url);state.downloadUrls.clear();
  clearTimeout(state.syncTimer); state.sync?.close();
  Object.assign(state, { key:null, kdf:null, base:null, vault:null, overlay:emptyOverlay(), assets:{}, personId:null, scope:null, legacyScopes:[], busy:false, editing:null, importDraft:null, visitDraft:null, sync:null, syncEtag:undefined, conflict:null, importInputFile:null,backupSession:false,filters:{} });
  state.database?.close(); state.database = null;
  $('main').replaceChildren(); $('profile-select').replaceChildren(); $('search-results').replaceChildren(); $('search-results').hidden = true;
  $('record-fields').replaceChildren(); $('record-title').textContent = 'Добавить запись'; $('document-title').textContent = 'Документ';
  $('import-review-fields').replaceChildren();$('import-document-file').value='';$('import-review-form').hidden=true;$('import-progress').textContent='';$('import-error').textContent='';$('sync-conflict-list').replaceChildren();state.persistChain=null;state.localRevision=0;state.syncBusy=false;
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
    const data = model.normalizeVault(decrypted.data.vault || decrypted.data);
    validateVault(data);
    state.key = decrypted.key; state.kdf = envelope.kdf; state.base = data; state.assets = decrypted.data.assets || {};state.backupSession=!!decrypted.data.vault;state.scope=state.backupSession?`backup:${envelope.kdf.salt}:${envelope.cipher.iv}`:`v1:${envelope.kdf.salt}`;
    state.overlay = model.normalizeOverlay(decrypted.data.overlay||{});
    let warning = '';
    try {
      state.database = await openDatabase();
      const stored = await storedOverlay('read');
      if (stored) {
        const local = model.normalizeOverlay(await decryptJson(stored, state.key));
        if (!local || arrays.some((key) => !Array.isArray(local[key])) || typeof local.assets !== 'object') throw new Error('Неверный формат локальных записей');
        const merged=model.mergeOverlays(state.overlay,local);
        if(merged.conflicts.length)throw Error('Копии содержат разные изменения. Откройте резервную копию в отдельном браузере.');
        state.overlay = merged.overlay;
      }
      state.legacyScopes = state.backupSession?[]:await otherStoredOverlays();
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
    if (file.size > limits.fileBytes) throw new Error('Файл превышает допустимый размер зашифрованной резервной копии.');
    const envelope = JSON.parse(await file.text());
    if (envelope.format !== 'health-vault-v1') throw new Error('Выберите зашифрованную резервную копию этой базы.');
    state.imported = envelope; $('backup-selection').textContent = 'Выбрана резервная копия. Введите её пароль. Чтобы открыть опубликованную базу, обновите страницу.';
    $('unlock-error').textContent = ''; $('password').focus();
  } catch (error) { $('unlock-error').textContent = error.message; }
  $('import-file').value = '';
});

function populateProfiles() {
  if(!state.vault.people.some(p=>p.id===state.personId))state.personId=state.vault.people[0]?.id;
  $('profile-select').innerHTML = state.vault.people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('profile-select').value = state.personId;
}
$('profile-select').addEventListener('change', () => { state.personId = $('profile-select').value; state.filters={};state.visitDraft=null;$('global-search').value = ''; hideSearch(); location.hash = '#/home'; render(); });
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
  const sorted=[...events].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  return sorted.length?'<div class="timeline">'+sorted.map(item=>`<article class="timeline-item"><time class="timeline-date">${dateText(item.date)}</time><div><p class="eyebrow">${esc(eventLabel[item.type]||item.type||'Событие')}</p><h3 class="timeline-title">${esc(item.title)}</h3><p class="timeline-copy">${esc(item.description)}</p>${localBadge(item)}<div class="record-tools"><button class="button button-secondary button-small" data-edit="timeline:${esc(item.id)}" type="button">Изменить</button>${routeLink('history/timeline/'+encodeURIComponent(item.id),'История изменений','button button-secondary button-small')}${item.documentId&&getDocument(item.documentId)?`<button class="button button-secondary button-small" data-document="${esc(item.documentId)}" type="button">Документ ↗</button>`:''}</div></div></article>`).join('')+'</div>':empty('Консультации, симптомы и результаты будут появляться здесь.');
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
  return heading('ХРАНЕНИЕ','Данные под вашим контролем','Локальная копия, зашифрованное облако и резервные версии.')+`
  <div class="detail-grid"><section class="panel prose"><p class="eyebrow accent-cyan">РЕЗЕРВНАЯ КОПИЯ</p><h2>Сохранить всю базу</h2>
  <p>Копия включает профили, записи, историю исправлений и все документы. Она зашифрована текущим паролем.</p>
  <button class="button button-primary" id="export-backup" type="button">Скачать зашифрованную копию ↗</button>
  <h3>Перенести на другое устройство</h3><ol><li>Скачайте зашифрованную копию этой базы и передайте файл на своё устройство.</li><li>На другом устройстве откройте сайт. На экране входа нажмите «Открыть резервную копию», выберите файл и введите пароль копии.</li><li>Продолжайте работу в открытой копии. После изменений скачайте её заново для следующего переноса.</li></ol>
  <p class="section-note">Копия открывается отдельно и автоматически не объединяется с основной базой. Для ручного переноса ведите одну рабочую версию. Скачанные до смены пароля копии сохраняют прежний пароль.</p></section>
  <section class="panel prose"><p class="eyebrow accent-violet">СОХРАНЕНИЕ</p><h2>Браузер и другие устройства</h2><p>Изменения сначала сохраняются зашифрованными в этом браузере. После успешного подключения личного хранилища они синхронизируются, пока окно хранилища открыто. Статус сохранения виден внизу страницы.</p><p>При конфликте устройств обе копии сохраняются перед выбором. Их можно скачать ниже. Очистка браузера удаляет его локальные версии; сохраняйте резервную копию отдельно.</p><button class="button button-secondary" id="show-recovery" type="button">Показать сохранённые версии</button><div id="recovery-list"></div></section></div>
  <section class="callout prose"><h2>Пароль и блокировка</h2><p>Пароль не сохраняется приложением и не передаётся облачному сервису. Через 15 минут бездействия база блокируется.</p><p>В отдельной сводке для врача и скачанном исходном документе данные уже расшифрованы. Блокировка сайта очищает текущую страницу; скачанные файлы остаются на устройстве.</p><button class="button button-secondary" data-lock type="button">Заблокировать сейчас</button></section>`;
}
function render() {
  if (!state.vault) return;
  const previousVisit=$('visit-plan-form');
  if(!state.skipVisitCapture&&previousVisit?.dataset.personId===state.personId)state.visitDraft=currentVisit(previousVisit);
  state.skipVisitCapture=false;
  const parts = (location.hash.replace(/^#\/?/,'') || 'home').split('/');
  const page = parts[0]; let id = ''; try { id = decodeURIComponent(parts[1] || ''); } catch { /* malformed URL has no matching record */ }
  let html;
  if (page === 'home') html = views.renderDashboard(viewContext());
  else if (page === 'problems') html = views.renderProblems(viewContext());
  else if (page === 'problem') html = problemControls(id) + problemDetail(id) + problemNotes(id) + relatedCare(id);
  else if (page === 'labs') html = views.renderLabOverview(viewContext());
  else if (page === 'lab') html = views.renderLabHistory(viewContext(),id);
  else if (page === 'genetics') html = views.renderGenetics(viewContext());
  else if (page === 'genetic') html = views.renderGeneticDetail(viewContext(),id);
  else if (page === 'care') html = views.renderCare(viewContext());
  else if (page === 'visit') html = views.renderVisit(viewContext());
  else if (page === 'visit-report') { const report=records('visits').find(v=>v.id===id)||state.visitDraft; html=report?views.renderVisitReport(viewContext(),report)+`<button class="button button-secondary v2-no-print" type="button" data-download-visit="${esc(report.id)}">Скачать сводку HTML</button>`:empty('Сводка не найдена.'); }
  else if (page === 'history') {let recordId='';try{recordId=decodeURIComponent(parts[2]||'');}catch{}html=arrays.includes(id)?views.renderHistory(viewContext(),id,recordId):empty('Неизвестный раздел истории.');}
  else if (page === 'documents') html = `${heading('03 / АРХИВ','Документы','Исходные бланки, консультации и подробные исследовательские обзоры.',button('document','Добавить документ'))}<div class="filter-row"><label class="field"><span class="field-label">Тип документа</span><select id="document-kind" class="select"><option value="">Все документы</option>${Object.entries(kindLabel).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label></div><div id="document-results" class="card-grid">${records('documents').filter(d=>!state.filters.documentKind||d.kind===state.filters.documentKind).map(documentCard).join('') || empty('Добавьте документ, чтобы сохранить его вместе с историей.')}</div>`;
  else if (page === 'timeline') html = `${heading('04 / ХРОНОЛОГИЯ','История событий','Симптомы, консультации, анализы и обновления в одной ленте.',button('timeline','Добавить событие'))}<section class="panel">${timeline(records('timeline'))}</section>`;
  else if (page === 'actions') html = `${heading('05 / ДАЛЬНЕЙШИЕ ШАГИ','План действий','Выполненные действия сохраняются в истории. Статус проблемы меняется отдельно.',button('action','Добавить шаг'))}<section class="panel">${views.renderTasks(viewContext(),records('actions'))}</section>`;
  else if (page === 'profiles') html = profilesPage();
  else if (page === 'sources') html = `${heading('06 / ДОКАЗАТЕЛЬНАЯ БАЗА','Источники','Исследования, обзоры и профессиональные рекомендации, использованные в разборах.')}${sourceList(state.vault.sources.filter((s) => records('problems').some((p) => (p.sourceIds || []).includes(s.id)) || records('genetics').some(g=>(g.assessmentSourceIds||[]).includes(s.id))))}`;
  else if (page === 'settings') html = settingsPage() + syncPanel();
  else html = `${heading('СТРАНИЦА НЕ НАЙДЕНА','Такого раздела нет','Выберите раздел в меню.')}${routeLink('home','На главную →','button button-primary')}`;
  if (state.legacyScopes.length) html = (page === 'settings' ? '' : `<div class="local-notice">Найдены дополнения с прежним паролем. ${routeLink('settings','Перенести записи →')}</div>`) + html + (page === 'settings' ? migrationPanel() : '');
  if(state.backupSession)html=`<div class="local-notice">Открыта резервная копия. Её изменения сохраняются отдельно; основная база и облако остаются прежними. <button class="button button-secondary button-small" type="button" data-return-published>Открыть основную базу</button></div>`+html;
  $('main').innerHTML = html;
  if($('visit-plan-form'))$('visit-plan-form').dataset.personId=state.personId;
  if($('document-kind'))$('document-kind').value=state.filters.documentKind||'';
  if(page==='documents') $('main').querySelector('.section-head')?.insertAdjacentHTML('beforeend','<button class="button button-secondary" type="button" data-import>Извлечь из файла</button>');
  for (const card of $('main').querySelectorAll('.document-card')) { const id=card.querySelector('[data-document]')?.dataset.document; if(id)card.insertAdjacentHTML('beforeend',`<div class="record-tools"><button class="button button-secondary button-small" data-edit="documents:${esc(id)}" type="button">Изменить</button>${routeLink(`history/documents/${encodeURIComponent(id)}`,'История изменений','button button-secondary button-small')}</div>`); }
  for(const card of $('main').querySelectorAll('.document-card')){const id=card.querySelector('[data-document]')?.dataset.document,doc=id&&getDocument(id);if(doc&&doc.mime!=='application/gzip'&&doc.kind!=='genetic_report')card.insertAdjacentHTML('beforeend',`<button class="button button-secondary button-small" type="button" data-import-document="${esc(id)}">Извлечь результаты из документа</button>`);}
  for (const card of $('main').querySelectorAll('.profile-card')) { const id=card.querySelector('[data-profile]')?.dataset.profile; if(id)card.insertAdjacentHTML('beforeend',`<button class="button button-secondary button-small" type="button" data-edit="people:${esc(id)}">Изменить профиль</button>`); }
  for (const link of $('header-nav').querySelectorAll('a')) { const active = link.hash === `#/${page === 'problem' ? 'problems' : page === 'lab' ? 'labs' : page === 'genetic' ? 'genetics' : page}`; if (active) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
  $('header-nav').classList.remove('is-open'); $('menu-toggle').ariaExpanded = 'false'; hideSearch();
}

function hideSearch() { $('search-results').hidden = true; $('global-search').ariaExpanded = 'false'; }
$('global-search').addEventListener('input', () => {
  const query = $('global-search').value.trim().toLocaleLowerCase('ru');
  if (!query) { hideSearch(); return; }
  const candidates = [...records('problems').map((p) => ({ title:p.title, copy:p.summary, path:`problem/${encodeURIComponent(p.id)}`, type:'Разбор' })), ...records('labs').map((l) => ({ title:l.name, copy:`${l.value} ${l.unit} · ${l.interpretation}`, path:`lab/${encodeURIComponent(l.id)}`, type:'Анализ' })), ...records('documents').map((d) => ({ title:d.title, copy:d.description, documentId:d.id, type:'Документ' })),...records('medications').map(m=>({title:m.name,copy:[m.reason,m.notes,m.dose].join(' '),path:'care',type:'Препарат'})),...records('symptoms').map(s=>({title:s.title,copy:s.description,path:'care',type:'Наблюдение'})),...records('visits').map(v=>({title:v.title,copy:[v.complaints,v.questions].join(' '),path:`visit-report/${encodeURIComponent(v.id)}`,type:'Для приёма'}))];
  candidates.push(...records('genetics').map(g=>({title:g.title,copy:[g.provider,g.rawCardText,g.assessment,...(g.variants||[]).map(v=>[v.gene,v.rsid,v.rsId].filter(Boolean).join(' '))].filter(Boolean).join(' '),path:`genetic/${encodeURIComponent(g.id)}`,type:'Генетика'})));
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
  if(target.dataset.edit)showEdit(target.dataset.edit);
  if(target.dataset.lifecycle)showForm('problem',target.dataset.lifecycle);
  if(target.hasAttribute('data-import'))openImport();
  if(target.dataset.importDocument){const doc=getDocument(target.dataset.importDocument),generation=state.generation;if(doc){try{const plain=await decryptAsset(await encryptedDocument(doc),state.key);if(generation!==state.generation)return;openImport();await runExtraction(new File([plain],doc.fileName||'document.pdf',{type:doc.mime}),doc);}catch(error){if(generation===state.generation)toast(error.message);}}}
  if(target.dataset.reviewlab)await patchRecord('labs',target.dataset.reviewlab,{reviewed:true},'Результат отмечен разобранным пользователем');
  if(target.dataset.favorite){const series=model.labSeries(records('labs'),target.dataset.favorite),favorite=!series.some(l=>l.favorite);let candidate=state.overlay;for(const lab of series)candidate=model.editOverlay(candidate,state.vault,'labs',lab.id,{favorite},'Избранный показатель');try{await persistOverlay(candidate);render();}catch(error){toast(error.message);}}
  if(target.dataset.actiontoggle){const action=records('actions').find(a=>a.id===target.dataset.actiontoggle);if(action){const done=action.done===true||action.completed===true||!!action.completedAt||action.status==='completed';await patchRecord('actions',action.id,{done:!done,completed:!done,completedAt:done?null:new Date().toISOString(),...(action.status==='completed'?{status:done?'planned':'completed'}:{})},done?'Действие открыто повторно':'Действие выполнено');}}
  if(target.id==='connect-sync')await synchronize(true);
  if(target.id==='sync-now')await synchronize(!state.sync?.connected);
  if(target.id==='disconnect-sync'){state.sync?.close();state.sync=null;state.syncEtag=undefined;setSyncStatus('Облако отключено; локальная копия сохранена');}
  if(target.dataset.syncChoice)await chooseSyncVersion(target.dataset.syncChoice);
  if(target.id==='show-recovery')await showRecoveryVersions();
  if(target.dataset.recovery)await downloadRecovery(target.dataset.recovery);
  if(target.dataset.visitExport){state.visitDraft=null;location.hash=`#/visit-report/${encodeURIComponent(target.dataset.visitExport)}`;render();}
  if(target.hasAttribute('data-download-visit'))exportVisit(target.dataset.downloadVisit);
  if(target.hasAttribute('data-visit-preview')){const form=$('visit-plan-form');if(form){state.visitDraft=currentVisit(form);location.hash='#/visit-report/draft';render();}}
  if(target.hasAttribute('data-print-report'))window.print();
  if (target.hasAttribute('data-lock')) lock();
  if(target.hasAttribute('data-return-published')){state.imported=null;$('backup-selection').textContent='';lock();}
  if (target.dataset.scroll) { event.preventDefault(); $(target.dataset.scroll)?.scrollIntoView({ behavior:'smooth', block:'start' }); }
  if (target.dataset.document) await openDocument(target.dataset.document);
  if (target.dataset.profile) { state.personId = target.dataset.profile;state.filters={};state.visitDraft=null;populateProfiles(); location.hash = '#/home'; render(); }
  if (target.id === 'export-backup') await exportBackup(target);
});
document.addEventListener('input',event=>{
  if(!state.key||event.target.id!=='genetic-query')return;
  const start=event.target.selectionStart,end=event.target.selectionEnd;
  state.filters.geneticQuery=event.target.value;render();
  const field=$('genetic-query');if(field){field.focus();if(start!==null&&end!==null)field.setSelectionRange(start,end);}
});
document.addEventListener('change', (event) => {
  if (!state.key) return;
  const filterKeys={'problem-lifecycle':'problemLifecycle','lab-view':'labView','lab-group-v2':'labGroup','lab-problem':'labProblem','lab-status-v2':'labStatus','lab-favorites':'labFavorites','genetic-level':'geneticLevel','genetic-category':'geneticCategory'};
  if(filterKeys[event.target.id]){state.filters[filterKeys[event.target.id]]=event.target.type==='checkbox'?event.target.checked:event.target.value;render();}
  if (['lab-group','lab-status'].includes(event.target.id)) { const labs = records('labs').filter((l) => (!$('lab-group').value || l.group === $('lab-group').value) && (!$('lab-status').value || l.status === $('lab-status').value)); $('lab-results').innerHTML = labTable(labs); $('lab-count').textContent = `Показателей: ${labs.length}`; }
  if (event.target.id === 'document-kind') { state.filters.documentKind=event.target.value;render(); }
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
    else if(doc.mime.startsWith('image/')) { const img=document.createElement('img');img.src=url;img.alt=doc.title;img.className='journal-photo';$('document-viewer').append(img); }
    else if(doc.mime==='application/gzip') { const note=document.createElement('p');note.className='section-note';note.textContent='Это сжатый архив исходных данных. Скачайте файл и распакуйте его на своём устройстве. Генетические данные внутри архива не преобразуются автоматически в диагнозы или обычные анализы.';$('document-viewer').append(note); }
    else { const pre = document.createElement('pre'); pre.className = 'document-text'; pre.textContent = new TextDecoder(doc.encoding||'utf-8').decode(plain); $('document-viewer').append(pre); }
  } catch (error) { if (generation === state.generation && request === state.documentRequest) $('document-viewer').textContent = error.name === 'OperationError' ? 'Не удалось проверить целостность документа.' : error.message; }
}
$('document-dialog').addEventListener('close', revokeDocuments);
async function exportBackup(target) {
  const generation = state.generation, snapshot = structuredClone(state.vault),overlaySnapshot=structuredClone(state.overlay),sourceAssets=structuredClone(state.assets); target.disabled = true; target.textContent = 'Подготовка документов…';
  try {
    const assets = {};
    for (const doc of snapshot.documents) { assets[doc.id] = overlaySnapshot.assets[doc.id]||sourceAssets[doc.id]||toBase64(new Uint8Array(await encryptedDocument(doc))); if (generation !== state.generation) return; }
    const envelope = await encryptJson({ vault:snapshot, overlay:overlaySnapshot, assets }, state.key, state.kdf);
    if (generation !== state.generation) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type:'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `health-archive-${today()}.healthvault`; anchor.click();
    state.downloadUrls.add(url);setTimeout(() => {URL.revokeObjectURL(url);state.downloadUrls.delete(url);}, 30000); toast('Зашифрованная копия подготовлена. Сохраните пароль отдельно.');
  } catch (error) { toast(`Копия не создана: ${error.message}`); }
  finally { target.disabled = false; target.textContent = 'Скачать зашифрованную копию ↗'; }
}

const { showForm, showEdit } = installRecordController({state,$,records,toast,render,populateProfiles,persistOverlay});

function viewContext(){return {vault:state.vault,overlay:state.overlay,personId:state.personId,esc,dateText,records,getProblem,documentCard,problemCard,actionList,model,filters:state.filters,visitDraft:state.visitDraft};}
function problemControls(id){
  const p=getProblem(id);if(!p)return '';
  return `<div class="record-tools"><span class="badge">${esc(model.LIFECYCLE_LABELS[p.lifecycle]||'Активна')}</span><span class="badge">${esc(model.CLINICAL_KIND_LABELS[p.clinicalKind]||'Тип не указан')}</span><button class="button button-primary button-small" type="button" data-lifecycle="${esc(id)}">Статус / закрытие</button><button class="button button-secondary button-small" type="button" data-edit="problems:${esc(id)}">Изменить запись</button>${routeLink(`history/problems/${encodeURIComponent(id)}`,'История изменений','button button-secondary button-small')}</div>`;
}
function relatedCare(id){
  const labs=records('labs').filter(l=>(l.problemIds||[]).includes(id)&&l.reviewed===false),meds=records('medications').filter(m=>(m.problemIds||[]).includes(id)),symptoms=records('symptoms').filter(s=>s.problemId===id);
  return `${labs.length?`<section class="callout"><h2>Новые результаты: ${labs.length}</h2><p>Появились ещё не разобранные результаты. Проверьте, меняют ли они прежние выводы.</p>${labs.map(l=>routeLink(`lab/${encodeURIComponent(l.id)}`,esc(l.name),'button button-secondary button-small')).join('')}</section>`:''}<section class="panel"><h2>Лечение и наблюдения</h2><p>Записей о препаратах: ${meds.length}. Записей симптомов: ${symptoms.length}.</p>${routeLink('care','Открыть журнал →','button button-secondary')}<button class="button button-secondary" data-add="symptom" type="button">Добавить наблюдение</button></section>`;
}
function problemNotes(id){const notes=getProblem(id)?.notesEntries||[];return notes.length?`<section class="panel prose"><h2>Записи пользователя</h2>${notes.map(n=>`<article><p class="eyebrow">${dateText(n.at)}</p><p>${esc(n.text)}</p></article>`).join('')}</section>`:'';}
function setSyncStatus(message){state.syncStatus=message;const footer=$('save-status');if(footer)footer.textContent=`${message} · Хранение и копии ↗`;const detail=$('sync-state');if(detail)detail.textContent=message;}
function syncPanel(){return `<section class="panel prose"><p class="eyebrow accent-cyan">СОХРАНЕНИЕ МЕЖДУ УСТРОЙСТВАМИ</p><h2>Личное зашифрованное облако</h2>
  <div class="local-notice"><strong>Известная проблема доступа.</strong> Cloudflare блокирует подключение к облачному сервису; автоматическая синхронизация сейчас недоступна. Если вы видите «Sorry, you have been blocked», закройте это окно и используйте зашифрованную копию по инструкции выше. Это сообщение относится к доступу к облачному сервису.</div>
  <p id="sync-state" role="status">${esc(state.syncStatus)}</p><p>Подключите личное хранилище в отдельном окне через вход в свой аккаунт. Сервис получает только зашифрованные дополнения; пароль базы и открытые данные остаются на устройстве.</p><div class="record-tools"><button class="button button-primary" id="connect-sync" type="button">Проверить подключение и синхронизировать</button><button class="button button-secondary" id="sync-now" type="button">Синхронизировать сейчас</button><button class="button button-secondary" id="disconnect-sync" type="button">Отключить облако</button></div><p class="section-note">После успешного подключения новые изменения сохраняются в облаке, пока окно хранилища открыто. После закрытия окна записи продолжают сохраняться в этом браузере. На другом устройстве откройте базу и подключите то же личное хранилище.</p><p class="section-note">Исходные опубликованные документы доступны на сайте. Новые вложения синхронизируются вместе с зашифрованными дополнениями. Лимит одной облачной копии — 60 МБ шифротекста.</p></section>`;}
async function decryptCloud(envelope){
  if(envelope?.kdf?.salt!==state.kdf.salt||envelope?.kdf?.iterations!==state.kdf.iterations)throw Error('Облачная копия использует другой ключ. Локальные данные сохранены.');
  return model.normalizeOverlay(await decryptJson(envelope,state.key));
}
function showSyncConflict(local,remote,etag,scope,conflicts){
  state.conflict={local,remote,etag,scope};
  const localVault=model.mergeVault(state.base,local),remoteVault=model.mergeVault(state.base,remote),labels={title:'Название',name:'Название',summary:'Описание',lifecycle:'Актуальность',clinicalKind:'Тип записи',value:'Результат',reference:'Референс',date:'Дата',done:'Выполнено',notes:'Примечание',description:'Описание',dose:'Доза',frequency:'Режим'};
  const shown=value=>{if(value===null||value===undefined||value==='')return 'Не указано';if(typeof value==='boolean')return value?'Да':'Нет';return typeof value==='object'?JSON.stringify(value).slice(0,600):String(value).slice(0,600);};
  $('sync-conflict-list').innerHTML=`<p>Пересечений: ${conflicts.length}. Выбор ниже относится ко всей копии. Обе версии можно будет скачать в разделе хранения.</p>${conflicts.slice(0,12).map(c=>{const collection=c.collection||'documents',id=c.recordId||c.id,l=localVault[collection]?.find(x=>x.id===id),r=remoteVault[collection]?.find(x=>x.id===id),title=l?.title||l?.name||r?.title||r?.name||'Запись';return `<article class="panel"><h3>${esc(title)}${c.field?' · '+esc(labels[c.field]||c.field):''}</h3><dl><dt>На устройстве</dt><dd>${esc(c.type==='asset'?'Зашифрованное вложение этой версии':shown(c.field?l?.[c.field]:l?.summary||l?.title||l?.name||c.local))}</dd><dt>В облаке</dt><dd>${esc(c.type==='asset'?'Другая версия зашифрованного вложения':shown(c.field?r?.[c.field]:r?.summary||r?.title||r?.name||c.remote))}</dd></dl></article>`;}).join('')}`;
  if(!$('sync-conflict-dialog').open)$('sync-conflict-dialog').showModal();setSyncStatus('Конфликт версий — выберите копию');
}
async function synchronize(connect=false){
  if(!state.key||state.syncBusy)return;
  if(state.backupSession){toast('Открыта отдельная резервная копия. Вернитесь в основную базу для синхронизации.');return;}
  let ready=Promise.resolve();
  if(connect){if(!state.sync)state.sync=createSyncClient({origin:SYNC_ORIGIN,onStatus:s=>{setSyncStatus(s.message);}});ready=state.sync.connect();}
  else if(!state.sync?.connected){setSyncStatus('Сохранено в браузере — подключите личное хранилище');return;}
  const generation=state.generation;state.syncBusy=true;
  try{
    await ready;if(generation!==state.generation)return;const scope=await syncScope(state.kdf);
    for(let attempt=0;attempt<2;attempt++){
      const remote=await state.sync.read(scope);if(generation!==state.generation)return;
      const remoteOverlay=remote.envelope?await decryptCloud(remote.envelope):emptyOverlay();if(generation!==state.generation)return;
      const merged=model.mergeOverlays(state.overlay,remoteOverlay);state.syncEtag=remote.etag;
      if(merged.conflicts.length){showSyncConflict(state.overlay,remoteOverlay,remote.etag,scope,merged.conflicts);return;}
      await persistOverlay(merged.overlay,{sync:false});if(generation!==state.generation)return;
      const revision=state.localRevision,envelope=await encryptJson(state.overlay,state.key,state.kdf);if(generation!==state.generation)return;
      try{
        const saved=await state.sync.write(scope,envelope,remote.etag);if(generation!==state.generation)return;state.syncEtag=saved.etag;
        setSyncStatus(revision===state.localRevision?'Синхронизировано с личным облаком':'Есть новые изменения в браузере');
        if(revision!==state.localRevision){clearTimeout(state.syncTimer);state.syncTimer=setTimeout(()=>void synchronize(false),1400);}
        populateProfiles();render();return;
      }catch(error){if(error.code!=='conflict'||attempt===1)throw error;}
    }
  }catch(error){if(generation===state.generation){setSyncStatus(error.code==='conflict'?'Облачная версия изменилась — повторите синхронизацию':'Сохранено в браузере — облако недоступно');toast(error.message||'Не удалось синхронизировать. Локальная копия сохранена.');}}
  finally{if(generation===state.generation)state.syncBusy=false;}
}
function putRecovery(key,envelope){return new Promise((resolve,reject)=>{const tx=state.database.transaction('vaults','readwrite');tx.objectStore('vaults').put(envelope,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function chooseSyncVersion(choice){
  if(!state.conflict||state.busy)return;const conflict=state.conflict,generation=state.generation;state.busy=true;
  try{
    await state.persistChain?.catch(()=>{});conflict.local=state.overlay;
    for(const side of ['local','remote']){const encrypted=await encryptJson(conflict[side],state.key,state.kdf);if(generation!==state.generation)return;await putRecovery(`recovery:${new Date().toISOString()}:${side}`,encrypted);}
    const selected=choice==='remote'?conflict.remote:conflict.local;
    await persistOverlay(selected,{sync:false,replace:true});if(generation!==state.generation)return;
    if(choice==='local'){const envelope=await encryptJson(selected,state.key,state.kdf);const saved=await state.sync.write(conflict.scope,envelope,conflict.etag);if(generation!==state.generation)return;state.syncEtag=saved.etag;}
    state.conflict=null;$('sync-conflict-dialog').close();populateProfiles();render();setSyncStatus('Версия выбрана; обе предыдущие копии сохранены');toast('Обе прежние зашифрованные копии сохранены в этом браузере.');
  }catch(error){if(generation===state.generation)toast(error.message||'Не удалось сохранить выбранную версию. Обе копии сохранены.');}
  finally{if(generation===state.generation)state.busy=false;}
}
async function patchRecord(collection,id,fields,reason){
  if(state.busy)return;const generation=state.generation;
  try{await persistOverlay(model.editOverlay(state.overlay,state.vault,collection,id,fields,reason));if(generation===state.generation)render();}catch(error){toast(error.message);}
}
function currentVisit(form){const fd=new FormData(form);return {id:newId(),personId:state.personId,title:String(fd.get('title')||'Подготовка к приёму').trim(),date:String(fd.get('date')||today()),problemIds:fd.getAll('problemIds').map(String),complaints:String(fd.get('complaints')||'').trim(),questions:String(fd.get('questions')||'').trim(),local:true,createdAt:new Date().toISOString()};}
async function saveVisit(form){if(state.busy)return;const generation=state.generation,button=form.querySelector('[type="submit"]'),visit=currentVisit(form);state.busy=true;button.disabled=true;try{await persistOverlay(model.addRecord(state.overlay,'visits',visit));if(generation!==state.generation)return;state.visitDraft=null;state.skipVisitCapture=true;render();toast('Подготовка к приёму сохранена.');}finally{button.disabled=false;if(generation===state.generation)state.busy=false;}}
function exportVisit(id){
  const visit=records('visits').find(v=>v.id===id)||state.visitDraft;if(!visit)return;
  const article=views.renderVisitReport(viewContext(),visit),html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(visit.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:960px;margin:30px auto;padding:20px;color:#182234}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #ccc;text-align:left}button,.record-tools,.section-note.print-note{display:none}a{color:inherit}section{margin:20px 0}h1,h2,h3{line-height:1.25}</style>${article}</html>`;
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`visit-summary-${visit.date||today()}.html`;a.click();state.downloadUrls.add(url);setTimeout(()=>{URL.revokeObjectURL(url);state.downloadUrls.delete(url);},30000);toast('Скачана обычная незашифрованная сводка для приёма.');
}
function readRecoveryStore(){return new Promise((resolve,reject)=>{const tx=state.database.transaction('vaults','readonly'),store=tx.objectStore('vaults'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>resolve(keys.result.map((key,i)=>({key,envelope:values.result[i]})).filter(v=>typeof v.key==='string'&&v.key.startsWith('recovery:')));tx.onerror=()=>reject(tx.error);});}
async function showRecoveryVersions(){
  const generation=state.generation;
  try{const entries=await readRecoveryStore();if(generation!==state.generation)return;const list=$('recovery-list');if(list)list.innerHTML=entries.length?`<ul>${entries.slice().reverse().map(entry=>`<li><button class="button button-secondary button-small" data-recovery="${esc(entry.key)}" type="button">Скачать версию ${esc(entry.key.slice(9,28))} · ${entry.key.endsWith(':remote')?'облако':'устройство'}</button></li>`).join('')}</ul>`:'<p class="section-note">Сохранённых конфликтующих версий нет.</p>';}catch(error){toast(error.message||'Не удалось прочитать версии.');}
}
async function downloadRecovery(key){
  const generation=state.generation;
  try{
    const entry=(await readRecoveryStore()).find(v=>v.key===key);if(!entry)throw Error('Сохранённая версия не найдена.');
    const overlay=model.normalizeOverlay(await decryptJson(entry.envelope,state.key)),vault=model.mergeVault(state.base,overlay),assets={};
    for(const doc of vault.documents){
      const local=overlay.assets[doc.id]||state.assets[doc.id];
      if(local)assets[doc.id]=local;
      else{if(!/^assets\/[a-zA-Z0-9_-]+\.bin$/.test(doc.asset||''))throw Error('Нет вложения для сохранённой версии.');const response=await fetch(doc.asset);if(!response.ok)throw Error('Не удалось загрузить исходный документ для копии.');assets[doc.id]=toBase64(await response.arrayBuffer());}
      if(generation!==state.generation)return;
    }
    const envelope=await encryptJson({vault,overlay,assets},state.key,state.kdf);if(generation!==state.generation)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(envelope)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`health-recovery-${today()}.healthvault`;a.click();state.downloadUrls.add(url);setTimeout(()=>{URL.revokeObjectURL(url);state.downloadUrls.delete(url);},30000);toast('Зашифрованная сохранённая версия скачана вместе с документами.');
  }catch(error){if(generation===state.generation)toast(error.message||'Не удалось скачать сохранённую версию.');}
}

function openImport(){state.importAbort?.abort();state.importRequest=(state.importRequest||0)+1;state.importDraft=null;state.importInputFile=null;$('import-document-file').disabled=false;$('extract-document').disabled=false;$('import-document-file').value='';$('import-progress').textContent='';$('import-review-form').hidden=true;$('import-review-fields').replaceChildren();$('import-error').textContent='';$('import-dialog').showModal();}
function importReviewMarkup(result,file,existing=null){
  const fields=(name,label,value='',type='text',required=false)=>`<label class="field"><span class="field-label">${esc(label)}</span><input class="input" type="${type}" name="${name}" value="${esc(value)}" ${required?'required':''}></label>`;
  return `<div class="form-grid">${fields('documentTitle','Название документа',file.name,'text',true)}${fields('documentDate','Дата документа — проверьте','', 'date')}<label class="field"><span class="field-label">Группа показателей</span><input name="group" class="input" value="Другие анализы"></label><label class="field"><span class="field-label">Связанные проблемы</span><select class="select" name="problemId"><option value="">Без привязки</option>${records('problems').map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select></label></div><div class="callout"><p>${result.issues.map(esc).join(' ')}</p><p>Строки не выбраны автоматически. Проверьте каждую перед сохранением; можно сохранить только документ.</p></div><label class="field"><span class="field-label">Извлечённый текст — можно исправить и разобрать заново</span><textarea class="input" id="import-source-text" rows="6" maxlength="2097152">${esc(result.text)}</textarea></label><button class="button button-secondary" id="reparse-import" type="button">Разобрать исправленный текст</button><div class="import-rows">${result.rows.slice(0,200).map((row,index)=>`<fieldset class="panel import-row"><legend><label class="check-field"><input type="checkbox" name="include" value="${index}"> Проверил строку ${index+1}${row.duplicateOf!==undefined?' · возможный повтор':''}</label></legend><div class="form-grid">${fields(`name_${index}`,'Показатель',row.name)}${fields(`value_${index}`,'Результат',row.value)}${fields(`unit_${index}`,'Единицы',row.unit)}${fields(`reference_${index}`,'Референс из бланка',row.reference)}${fields(`date_${index}`,'Дата забора / записи — проверьте',row.date||'','date')}${fields(`dateContext_${index}`,'Основание даты',row.dateContext||'Дата не распознана; уточнить по бланку')}</div><details><summary>Исходная строка</summary><p>${esc(row.sourceLine)}</p></details></fieldset>`).join('')}</div>${result.rows.length>200?'<p class="callout">Показаны первые 200 строк. Разделите большой документ на части.</p>':''}`;
}
async function runExtraction(file,existingDocument=null){
  if(!state.key||state.busy)return;if(!file){$('import-progress').textContent='Выберите файл.';return;}state.importInputFile=file;
  const generation=state.generation,request=(state.importRequest||0)+1,abort=new AbortController();state.importRequest=request;state.importAbort=abort;$('extract-document').disabled=true;$('import-document-file').disabled=true;$('import-progress').textContent='Извлечение на устройстве…';
  try{const result=await extractDocument(file,{signal:abort.signal,onProgress:p=>{if(generation===state.generation&&request===state.importRequest)$('import-progress').textContent=p.message||'Распознавание…';}});if(generation!==state.generation||abort.signal.aborted)return;const hash=existingDocument?.fileHash||[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');if(generation!==state.generation||abort.signal.aborted)return;const existing=existingDocument||records('documents').find(d=>d.fileHash===hash);state.importDraft={file,result,personId:state.personId,hash,existingDocumentId:existing?.id};$('import-review-fields').innerHTML=importReviewMarkup(result,file,existing);if(existing)$('import-review-fields').insertAdjacentHTML('afterbegin',`<p class="callout">Файл уже сохранён: ${esc(existing.title)}. Будут добавлены только выбранные новые показатели; копия файла не создаётся.</p>`);$('import-review-form').hidden=false;$('import-progress').textContent=`Найдено предложений: ${result.rows.length}. Проверьте их перед сохранением.`;}
  catch(error){if(generation===state.generation)$('import-progress').textContent=error.name==='AbortError'?'Распознавание отменено.':error.message;}
  finally{if(request===state.importRequest){$('extract-document').disabled=false;$('import-document-file').disabled=false;}}
}
$('extract-document').addEventListener('click',()=>void runExtraction($('import-document-file').files[0]||state.importInputFile));
$('import-dialog').addEventListener('close',()=>state.importAbort?.abort());
document.addEventListener('click',event=>{if(event.target.id==='reparse-import'&&state.importDraft){try{const text=$('import-source-text').value,result=parseLabText(text);state.importDraft.result=result;$('import-review-fields').innerHTML=importReviewMarkup(result,state.importDraft.file);}catch(error){$('import-error').textContent=error.message;}}});
$('import-review-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!state.key||!state.importDraft||state.busy)return;
  const generation=state.generation,draft=state.importDraft,fd=new FormData(event.currentTarget),get=name=>String(fd.get(name)||'').trim(),submit=event.currentTarget.querySelector('[type="submit"]');
  state.busy=true;submit.disabled=true;$('import-error').textContent='';
  try{
    if(draft.personId!==state.personId)throw Error('Выбран другой профиль. Откройте импорт заново.');
    const existing=records('documents').find(d=>d.fileHash===draft.hash||d.id===draft.existingDocumentId),attachment=existing?{record:existing}:await prepareAttachment(draft.file,{key:state.key,personId:state.personId,documents:records('documents'),metadata:{title:get('documentTitle')||draft.file.name,date:get('documentDate')||null,encoding:draft.result.encoding||'utf-8',description:'Загружено с проверкой извлечённых значений.',kind:'analysis',problemIds:get('problemId')?[get('problemId')]:[]}});
    if(generation!==state.generation)return;let candidate=model.normalizeOverlay(state.overlay);
    if(!existing){candidate=model.addRecord(candidate,'documents',attachment.record);candidate.assets[attachment.record.id]=attachment.encrypted;}
    const newLink=existing&&get('problemId')&&!(existing.problemIds||[]).includes(get('problemId'));
    if(newLink)candidate=model.editOverlay(candidate,state.vault,'documents',existing.id,{problemIds:[...(existing.problemIds||[]),get('problemId')]},'Документ связан с ещё одной проблемой при разборе');
    if(existing&&!newLink&&!fd.getAll('include').length){$('import-dialog').close();state.importDraft=null;toast('Документ уже сохранён; новые показатели не выбраны.');return;}
    for(const rawIndex of fd.getAll('include')){
      const index=Number(rawIndex);if(!Number.isInteger(index)||!draft.result.rows[index])throw Error('Неверная строка импорта.');
      const date=get(`date_${index}`),name=get(`name_${index}`),value=get(`value_${index}`);if(!date||!name||!value)throw Error(`У выбранной строки ${index+1} заполните показатель, значение и дату.`);
      const lab={id:newId(),personId:state.personId,name,value,date,unit:get(`unit_${index}`),reference:get(`reference_${index}`)||'Не указан',dateContext:get(`dateContext_${index}`),group:get('group')||'Другие анализы',status:'unreviewed',reviewed:false,interpretation:'Значение проверено при переносе из бланка. Медицинская интерпретация ещё не добавлена.',documentId:attachment.record.id,problemIds:get('problemId')?[get('problemId')]:[],local:true,createdAt:new Date().toISOString()};
      Object.assign(lab,{low:null,high:null,...model.referenceBounds(lab.reference)});
      if(model.identifyDuplicates([...records('labs'),...candidate.labs],lab).length)throw Error(`Строка ${index+1} повторяет уже сохранённый результат. Снимите её выбор.`);
      candidate=model.addRecord(candidate,'labs',lab);
    }
    candidate=model.addRecord(candidate,'timeline',{id:newId(),personId:state.personId,title:attachment.record.title,date:attachment.record.date||today(),description:'Загружен документ; сохранены только выбранные и проверенные показатели.',type:'analysis',documentId:attachment.record.id,local:true});
    await persistOverlay(candidate);if(generation!==state.generation)return;$('import-dialog').close();state.importDraft=null;render();toast('Документ и выбранные показатели сохранены.');
  }catch(error){if(generation===state.generation)$('import-error').textContent=error.message||'Не удалось сохранить импорт.';}
  finally{submit.disabled=false;if(generation===state.generation)state.busy=false;}
});
