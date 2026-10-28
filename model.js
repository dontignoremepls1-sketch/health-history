// All clinical content belongs in the encrypted vault, never in this module.
export const COLLECTIONS = Object.freeze(['people', 'problems', 'labs', 'documents', 'timeline', 'actions', 'sources', 'medications', 'symptoms', 'visits']);
export const LIFECYCLE_LABELS = Object.freeze({ active:'Активна', monitoring:'Наблюдаю', paused:'Отложена', closed:'Закрыта мной' });
export const CLINICAL_KIND_LABELS = Object.freeze({ unspecified:'Не указано', symptom:'Жалоба', hypothesis:'Предположение', confirmed:'Подтверждённый диагноз', refuted:'Исключённый диагноз' });
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const uuid = () => globalThis.crypto.randomUUID();
const has = (object,key) => Object.prototype.hasOwnProperty.call(object,key);

function assertJson(value, depth = 0) {
  if (depth > 64) throw new Error('Запись слишком сложная.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Число в записи должно быть конечным.');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Неподдерживаемый формат записи.');
    for (const key of Object.keys(value)) { if (forbidden.has(key)) throw new Error('Недопустимое поле записи.'); assertJson(value[key], depth + 1); }
  } else if (['function','symbol','bigint'].includes(typeof value)) throw new Error('Запись должна содержать данные JSON.');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const same = (a,b) => canonical(a) === canonical(b);
function assertCollection(collection) { if (!COLLECTIONS.includes(collection)) throw new Error('Неизвестный тип записи.'); }
function records(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50000) throw new Error(`Неверная коллекция ${name}.`);
  const ids = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error(`Пустой или повторный идентификатор в ${name}.`);
    ids.add(item.id); return clone(item);
  });
}
function normalizeProblem(record) {
  return { ...record, lifecycle:has(LIFECYCLE_LABELS,record.lifecycle) ? record.lifecycle : has(LIFECYCLE_LABELS,record.status) ? record.status : 'active', clinicalKind:has(CLINICAL_KIND_LABELS,record.clinicalKind) ? record.clinicalKind : 'unspecified' };
}
export function normalizeVault(input = {}) {
  assertJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || (input.schemaVersion !== undefined && input.schemaVersion !== 1)) throw new Error('Неподдерживаемый формат базы.');
  const vault = { ...clone(input), schemaVersion:1 };
  for (const key of COLLECTIONS) vault[key] = records(input[key],key);
  vault.problems = vault.problems.map(normalizeProblem);
  return vault;
}
export function normalizeOverlay(input = {}) {
  assertJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Неподдерживаемые дополнения.');
  const overlay = { ...clone(input) };
  for (const key of COLLECTIONS) overlay[key] = records(input[key],key);
  overlay.changes = records(input.changes,'changes');
  for (const change of overlay.changes) {
    assertCollection(change.collection);
    if (typeof change.recordId !== 'string' || !change.after || typeof change.after !== 'object' || Array.isArray(change.after)) throw new Error('Неверная запись истории изменений.');
    if (Object.keys(change.after).some((key) => ['id','personId','_revision','_heads'].includes(key))) throw new Error('История изменяет неизменяемое поле.');
  }
  overlay.assets = input.assets === undefined ? {} : clone(input.assets);
  if (!overlay.assets || typeof overlay.assets !== 'object' || Array.isArray(overlay.assets) || Object.values(overlay.assets).some((value) => typeof value !== 'string')) throw new Error('Неверные зашифрованные вложения.');
  overlay.migratedScopes = input.migratedScopes === undefined ? [] : clone(input.migratedScopes);
  if (!Array.isArray(overlay.migratedScopes) || overlay.migratedScopes.some((scope) => typeof scope !== 'string')) throw new Error('Неверная история переноса ключей.');
  return overlay;
}
const parents = (change) => Array.isArray(change.parentRevisions) ? change.parentRevisions : change.parentRevision && change.parentRevision !== 'base' ? [change.parentRevision] : [];
const changeOrder = (a,b) => String(a.at || a.date || '').localeCompare(String(b.at || b.date || '')) || a.id.localeCompare(b.id);
function orderedChanges(changes) {
  const remaining = [...changes].sort(changeOrder), output = [], known = new Set(changes.map((item) => item.id)), done = new Set();
  while (remaining.length) {
    const index = remaining.findIndex((item) => parents(item).every((id) => !known.has(id) || done.has(id)));
    if (index < 0) throw new Error('Циклическая история изменений.');
    const [item] = remaining.splice(index,1); output.push(item); done.add(item.id);
  }
  return output;
}
export function mergeVault(baseInput, overlayInput = {}) {
  const vault = normalizeVault(baseInput), overlay = normalizeOverlay(overlayInput);
  for (const collection of COLLECTIONS) {
    const map = new Map(vault[collection].map((record) => [record.id,record]));
    for (const record of overlay[collection]) if (!map.has(record.id)) map.set(record.id,clone(record));
    const changes = orderedChanges(overlay.changes.filter((change) => change.collection === collection));
    const histories = new Map();
    for (const change of changes) {
      if (!map.has(change.recordId)) continue;
      map.set(change.recordId,{ ...map.get(change.recordId), ...clone(change.after), _revision:change.id });
      const history = histories.get(change.recordId) || []; history.push(change); histories.set(change.recordId,history);
    }
    for (const [id,history] of histories) {
      const ancestors = new Set(history.flatMap(parents));
      map.get(id)._heads = history.filter((change) => !ancestors.has(change.id)).map((change) => change.id);
    }
    vault[collection] = [...map.values()];
  }
  vault.problems = vault.problems.map(normalizeProblem);
  return vault;
}
export function addRecord(overlayInput, collection, record) {
  assertCollection(collection); assertJson(record);
  const overlay = normalizeOverlay(overlayInput);
  if (!record || typeof record.id !== 'string' || !record.id) throw new Error('У новой записи нет идентификатора.');
  if (overlay[collection].some((item) => item.id === record.id)) throw new Error('Запись с таким идентификатором уже есть.');
  overlay[collection].push(collection === 'problems' ? normalizeProblem(clone(record)) : clone(record));
  return overlay;
}
export function editOverlay(overlayInput, vaultInput, collection, id, fields, reason = '') {
  assertCollection(collection); assertJson(fields);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some((key) => ['id','personId','_revision','_heads'].includes(key) || fields[key] === undefined)) throw new Error('Недопустимые поля изменения.');
  const overlay = normalizeOverlay(overlayInput), vault = normalizeVault(vaultInput), record = vault[collection].find((item) => item.id === id);
  if (!record) throw new Error('Запись для изменения не найдена.');
  const at = now(), after = clone(fields);
  if (collection === 'problems' && has(after,'lifecycle')) {
    if (!has(LIFECYCLE_LABELS,after.lifecycle)) throw new Error('Неизвестный статус проблемы.');
    if (after.lifecycle === 'closed' && record.lifecycle !== 'closed') { after.closedAt ||= at; after.closeReason = after.closeReason ?? String(reason || ''); }
    if (record.lifecycle === 'closed' && after.lifecycle !== 'closed') { after.reopenedAt = at; after.closedAt = null; after.closeReason = null; }
  }
  if (collection === 'problems' && has(after,'clinicalKind') && !has(CLINICAL_KIND_LABELS,after.clinicalKind)) throw new Error('Неизвестный тип медицинской записи.');
  for (const key of Object.keys(after)) if (same(record[key],after[key])) delete after[key];
  if (!Object.keys(after).length) return overlay;
  const before = Object.fromEntries(Object.keys(after).map((key) => [key,has(record,key) ? clone(record[key]) : null]));
  const parentRevisions = record._heads?.length ? [...record._heads] : record._revision ? [record._revision] : [];
  overlay.changes.push({ id:uuid(), collection, recordId:id, at, date:at.slice(0,10), reason:String(reason || ''), before, after, parentRevision:record._revision || 'base', parentRevisions });
  return overlay;
}
export function historyFor(overlayInput, collection, id) {
  assertCollection(collection);
  return orderedChanges(normalizeOverlay(overlayInput).changes.filter((change) => change.collection === collection && change.recordId === id));
}

const cleanText = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[\s\u00a0]+/g,' ').trim();
const aliases = new Map([
  ['ттг','tsh'], ['tsh','tsh'], ['тиреотропный гормон','tsh'], ['thyroid stimulating hormone','tsh'], ['thyroid-stimulating hormone','tsh'],
  ['ферритин','ferritin'], ['ferritin','ferritin'], ['фсг','fsh'], ['fsh','fsh'], ['фолликулостимулирующий гормон','fsh'],
  ['амг','amh'], ['amh','amh'], ['антимюллеров гормон','amh'], ['anti-mullerian hormone','amh'], ['anti-müllerian hormone','amh'],
  ['цинк','zinc'], ['zinc','zinc'], ['железо','iron'], ['iron','iron'],
  ['гемоглобин','hemoglobin'], ['hemoglobin','hemoglobin'], ['haemoglobin','hemoglobin'],
  ['глюкоза','glucose'], ['glucose','glucose'], ['тромбоциты','platelets'], ['platelets','platelets'],
  ['лейкоциты','wbc'], ['wbc','wbc'], ['эритроциты','rbc'], ['rbc','rbc']
]);
export function analyteKey(lab) {
  if (typeof lab?.analyteId === 'string' && lab.analyteId.trim()) {
    const explicit = lab.analyteId.trim();
    if (/^(?:id|name):/.test(explicit)) return explicit;
    return aliases.get(cleanText(explicit)) || `id:${explicit}`;
  }
  const name = cleanText(lab?.name).replace(/[()]/g,' ').replace(/\s+/g,' ').trim();
  return aliases.get(name) || `name:${name}`;
}
const unitAliases = new Map([
  ['нг/мл','ng/mL'], ['ng/ml','ng/mL'], ['ng/mL','ng/mL'], ['мкг/л','ug/L'], ['µg/L','ug/L'], ['μg/L','ug/L'], ['ug/L','ug/L'],
  ['мг/л','mg/L'], ['mg/L','mg/L'], ['мг/дл','mg/dL'], ['mg/dL','mg/dL'], ['г/л','g/L'], ['g/L','g/L'],
  ['мкМЕ/мл','uIU/mL'], ['µIU/mL','uIU/mL'], ['μIU/mL','uIU/mL'], ['uIU/mL','uIU/mL'],
  ['мМЕ/л','mIU/L'], ['mIU/L','mIU/L'], ['мМЕ/мл','mIU/mL'], ['mIU/mL','mIU/mL'],
  ['мкмоль/л','umol/L'], ['µmol/L','umol/L'], ['μmol/L','umol/L'], ['umol/L','umol/L'],
  ['ммоль/л','mmol/L'], ['mmol/L','mmol/L'], ['нмоль/л','nmol/L'], ['nmol/L','nmol/L'], ['%','%']
]);
export function unitKey(value) {
  const text = String(value ?? '').trim().replace(/[\s\u00a0]+/g,'');
  return unitAliases.get(text) || text;
}
const specimenAliases = new Map([['сыворотка','serum'],['сыворотка крови','serum'],['serum','serum'],['плазма','plasma'],['plasma','plasma'],['цельная кровь','whole blood'],['whole blood','whole blood']]);
export function seriesKey(lab) {
  const specimen = cleanText(lab?.specimen || lab?.sample || lab?.material);
  return JSON.stringify([String(lab?.personId || ''), analyteKey(lab), unitKey(lab?.unit), cleanText(lab?.method || lab?.assay || lab?.testMethod), specimenAliases.get(specimen) || specimen, cleanText(lab?.laboratory || lab?.labName || lab?.lab), lab?.status === 'calculated' || lab?.calculated ? 'calculated' : 'measured']);
}
export function parseNumeric(input) {
  let raw;
  if (input && typeof input === 'object') raw = input.value !== undefined && input.value !== null && String(input.value).trim() !== '' ? input.value : input.numericValue;
  else raw = input;
  if (raw === undefined || raw === null) return { raw:'', value:null, exact:false, operator:null };
  const text = String(raw).trim().replace(/\u2212/g,'-'), compact = text.replace(/[\s\u00a0\u202f]+/g,'');
  const match = compact.match(/^(<=|>=|<|>|≤|≥)?([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)$/i);
  if (!match) return { raw:text, value:null, exact:false, operator:null };
  const value = Number(match[2].replace(',','.'));
  if (!Number.isFinite(value)) return { raw:text, value:null, exact:false, operator:null };
  const operator = match[1] === '<=' ? '≤' : match[1] === '>=' ? '≥' : match[1] || null;
  return { raw:text, value, exact:!operator, operator };
}
export function referenceBounds(reference) {
  if (typeof reference !== 'string') return {};
  const text = reference.trim().replace(/\u2212/g,'-');
  const number = '[+-]?(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)';
  const match = text.match(new RegExp(`^(${number})\\s*[-–—]\\s*(${number})$`));
  if (!match) return {};
  const low = Number(match[1].replace(',','.')), high = Number(match[2].replace(',','.'));
  return Number.isFinite(low) && Number.isFinite(high) && low <= high ? {low,high} : {};
}
const measurementDate = (lab) => String(lab?.collectedAt || lab?.collectedDate || lab?.date || '');
const dateNumber = (value) => {
  const match = String(value).match(/^(\d{4})-(\d{2})(?:-(\d{2})(?:T.*)?)?$/);
  if (!match) return NaN;
  const year = Number(match[1]), month = Number(match[2]), day = match[3] ? Number(match[3]) : 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (month < 1 || month > 12 || day < 1 || day > days[month-1]) return NaN;
  return Date.parse(value);
};
const observationOrder = (a,b) => {
  const aDate = dateNumber(measurementDate(a)), bDate = dateNumber(measurementDate(b));
  const dateOrder = Number.isFinite(aDate) && Number.isFinite(bDate) ? aDate - bDate : Number.isFinite(aDate) ? 1 : Number.isFinite(bDate) ? -1 : 0;
  return dateOrder || String(a.reportedAt || '').localeCompare(String(b.reportedAt || '')) || String(a.id).localeCompare(String(b.id));
};
const validObservation = (lab) => !lab.enteredInError && !lab.invalidatedAt && !lab.deletedAt && lab.status !== 'entered-in-error';
export function labSeries(labs, idOrKey) {
  const source = Array.isArray(labs) ? labs : [];
  const target = typeof idOrKey === 'object' ? idOrKey : source.find((lab) => lab.id === idOrKey);
  const key = target ? seriesKey(target) : String(idOrKey || '');
  return source.filter((lab) => validObservation(lab) && seriesKey(lab) === key).map(clone).sort(observationOrder);
}
export function labComparison(latestOrSeries, previousInput) {
  const sorted = Array.isArray(latestOrSeries) ? [...latestOrSeries].filter(validObservation).sort(observationOrder) : null;
  const latest = sorted ? sorted.at(-1) || null : latestOrSeries || null, previous = sorted ? sorted.at(-2) || null : previousInput || null;
  const result = { latest, previous, comparable:false, delta:null, percent:null, reason:null, direction:null };
  if (!latest || !previous) return { ...result, reason:'Нет предыдущего измерения.' };
  if (seriesKey(latest) !== seriesKey(previous)) return { ...result, reason:'Различаются показатель, единицы, лаборатория, метод или материал.' };
  const current = parseNumeric(latest), past = parseNumeric(previous);
  if (!current.exact || !past.exact) return { ...result, reason:'Для границ и качественных результатов числовое изменение не рассчитывается.' };
  if (!Number.isFinite(dateNumber(measurementDate(latest))) || !Number.isFinite(dateNumber(measurementDate(previous)))) return { ...result, reason:'Неизвестна дата одного из измерений.' };
  if (dateNumber(measurementDate(latest)) === dateNumber(measurementDate(previous))) return { ...result, reason:'Порядок измерений в одну дату не указан.' };
  if (observationOrder(latest,previous) < 0) return { ...result, reason:'Предыдущее измерение должно быть раньше последнего.' };
  const delta = current.value - past.value;
  return { ...result, comparable:true, delta, percent:past.value === 0 ? null : delta / Math.abs(past.value) * 100, direction:delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', reason:past.value === 0 ? 'Предыдущее значение равно нулю; процент не рассчитывается.' : null };
}
export function latestLabs(labs = []) {
  const groups = new Map();
  for (const lab of labs) if (validObservation(lab)) { const key = seriesKey(lab); if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(clone(lab)); }
  return [...groups].map(([key,observations]) => {
    observations.sort(observationOrder);
    return { key, latest:observations.at(-1), previous:observations.at(-2) || null, observations, count:observations.length, comparison:labComparison(observations) };
  }).sort((a,b) => observationOrder(b.latest,a.latest));
}
function duplicateDescriptor(record) {
  const hash = record.sha256 || record.fileHash || record.contentHash || record.hash;
  if (typeof hash === 'string' && hash) return { key:`file:${record.personId || ''}:${hash.toLowerCase()}`, reason:'Совпадает хеш файла.', kind:'exact-file' };
  if (record.name && has(record,'value')) {
    const number = parseNumeric(record), value = number.value === null ? cleanText(record.value) : `${number.operator || '='}${number.value}`;
    return { key:`observation:${seriesKey(record)}:${measurementDate(record)}:${value}`, reason:'Совпадают показатель, условия, дата и результат; проверьте, не повторная ли это запись.', kind:'similar-result' };
  }
  return null;
}
export function identifyDuplicates(recordsInput = [], candidate) {
  if (candidate) {
    const descriptor = duplicateDescriptor(candidate); if (!descriptor) return [];
    return recordsInput.filter((record) => record.id !== candidate.id && duplicateDescriptor(record)?.key === descriptor.key).map((record) => ({ record:clone(record), ...descriptor }));
  }
  const groups = new Map();
  for (const record of recordsInput) { const descriptor = duplicateDescriptor(record); if (descriptor) { if (!groups.has(descriptor.key)) groups.set(descriptor.key,{ ...descriptor, records:[] }); groups.get(descriptor.key).records.push(clone(record)); } }
  return [...groups.values()].filter((group) => group.records.length > 1);
}

export function mergeOverlays(leftInput = {}, rightInput = {}) {
  const left = normalizeOverlay(leftInput), right = normalizeOverlay(rightInput), overlay = normalizeOverlay(left), conflicts = [];
  for (const collection of [...COLLECTIONS,'changes']) {
    const map = new Map(overlay[collection].map((item) => [item.id,item]));
    for (const item of right[collection]) {
      if (!map.has(item.id)) { const copy = clone(item); overlay[collection].push(copy); map.set(copy.id,copy); }
      else if (!same(map.get(item.id),item)) conflicts.push({ type:collection === 'changes' ? 'change' : 'record', collection, id:item.id, local:clone(map.get(item.id)), remote:clone(item) });
    }
  }
  for (const [id,asset] of Object.entries(right.assets)) {
    if (!has(overlay.assets,id)) overlay.assets[id] = asset;
    else if (overlay.assets[id] !== asset) conflicts.push({ type:'asset', id, local:overlay.assets[id], remote:asset });
  }
  overlay.migratedScopes = [...new Set([...left.migratedScopes,...right.migratedScopes])];
  const knownMetadata = new Set([...COLLECTIONS,'changes','assets','migratedScopes']);
  for (const [key,value] of Object.entries(right)) if (!knownMetadata.has(key)) {
    if (!has(overlay,key)) overlay[key] = clone(value);
    else if (!same(overlay[key],value)) conflicts.push({ type:'metadata', key, local:clone(overlay[key]), remote:clone(value) });
  }
  const changes = new Map(overlay.changes.map((change) => [change.id,change]));
  // Validate the graph and compare only the latest writers of each field.
  orderedChanges(overlay.changes);
  const ancestry = new Map();
  const ancestorsOf = (id) => {
    if (ancestry.has(id)) return ancestry.get(id);
    const found = new Set();
    for (const parent of parents(changes.get(id) || {})) { found.add(parent); for (const ancestor of ancestorsOf(parent)) found.add(ancestor); }
    ancestry.set(id,found); return found;
  };
  const writers = new Map();
  for (const change of overlay.changes) for (const field of Object.keys(change.after)) {
    const key = JSON.stringify([change.collection,change.recordId,field]);
    if (!writers.has(key)) writers.set(key,[]); writers.get(key).push(change);
  }
  for (const [key,items] of writers) {
    const heads = items.filter((item) => !items.some((other) => other.id !== item.id && ancestorsOf(other.id).has(item.id)));
    if (heads.length < 2 || heads.every((item) => same(item.after[JSON.parse(key)[2]],heads[0].after[JSON.parse(key)[2]]))) continue;
    const [collection,recordId,field] = JSON.parse(key);
    conflicts.push({ type:'field', collection, recordId, field, variants:heads.map((change) => ({ changeId:change.id, value:clone(change.after[field]), at:change.at })) });
  }
  return { overlay, conflicts };
}
