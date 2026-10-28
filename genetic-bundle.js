// Explicit reader for saved provider reports. Never use it to discover or open raw VCF archives.
export const GENETIC_BUNDLE_FORMAT = 'health-genetic-reports-v1';
export const GENETIC_BUNDLE_LIMITS = Object.freeze({ inputBytes:25 * 1024 * 1024, inflatedBytes:16 * 1024 * 1024, reports:1000 });

const safeId = value => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value) && !['__proto__','prototype','constructor'].includes(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const nonempty = value => text(value) && value.trim().length > 0;
const invalid = () => new Error('Архив генетических отчётов имеет неверный формат.');
const cancelled = () => Object.assign(new Error('Чтение генетического отчёта отменено.'), { name:'AbortError' });
const unsupported = () => new Error('Этот браузер не поддерживает чтение gzip-отчётов. Скачайте архив и распакуйте его на своём устройстве.');

function inputBytes(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer,input.byteOffset,input.byteLength) : null;
  if (!bytes || bytes.length < 18 || bytes.length > GENETIC_BUNDLE_LIMITS.inputBytes) throw new Error('Архив отчётов должен быть непустым gzip-файлом не больше 25 МиБ.');
  if (bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8 || (bytes[3] & 224) !== 0) throw invalid();
  return bytes;
}

async function inflate(bytes, signal) {
  if (typeof globalThis.DecompressionStream !== 'function' || typeof globalThis.ReadableStream !== 'function') throw unsupported();
  let decompressor;
  try { decompressor = new globalThis.DecompressionStream('gzip'); }
  catch { throw unsupported(); }
  let offset = 0;
  const compressed = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 65536,bytes.length);
      controller.enqueue(bytes.subarray(offset,end)); offset = end;
    }
  });
  const reader = compressed.pipeThrough(decompressor).getReader(), decoder = new TextDecoder('utf-8',{fatal:true}), chunks = [];
  let total = 0, aborted = false;
  const abort = () => { aborted = true; void reader.cancel(cancelled()).catch(() => {}); };
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if (signal?.aborted) abort();
    while (true) {
      if (aborted) throw cancelled();
      const {done,value} = await reader.read();
      if (aborted) throw cancelled();
      if (done) break;
      total += value.byteLength;
      if (total > GENETIC_BUNDLE_LIMITS.inflatedBytes) throw new Error('Распакованный архив отчётов превышает предел 16 МиБ.');
      chunks.push(decoder.decode(value,{stream:true}));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort',abort);
    reader.releaseLock();
  }
}

function assertJsonData(value,depth = 0) {
  if (depth > 64 || (typeof value === 'number' && !Number.isFinite(value))) throw invalid();
  // Depth is bounded before descending; do not create a second work list for large arrays.
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item,depth+1);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) throw invalid();
      assertJsonData(value[key],depth+1);
    }
  }
}

function validateBundle(bundle, people) {
  if (!object(bundle) || bundle.format !== GENETIC_BUNDLE_FORMAT || !Array.isArray(bundle.reports) || bundle.reports.length > GENETIC_BUNDLE_LIMITS.reports) throw invalid();
  assertJsonData(bundle);
  const ids = new Set();
  for (const report of bundle.reports) {
    if (!object(report) || !safeId(report.id) || ids.has(report.id) || !safeId(report.personId) || !people.has(report.personId)) throw invalid();
    ids.add(report.id);
    if (!['title','provider','section','capturedAt'].every(key=>nonempty(report[key])) || !Array.isArray(report.tabs) || !report.tabs.length) throw invalid();
    if (report.testDate !== undefined && report.testDate !== null && !text(report.testDate)) throw invalid();
    if (report.sourceUrl !== undefined && !text(report.sourceUrl)) throw invalid();
    for (const tab of report.tabs) {
      if (!object(tab) || !nonempty(tab.label) || !text(tab.text) || typeof tab.complete !== 'boolean' || (tab.reasonIfIncomplete !== undefined && !text(tab.reasonIfIncomplete))) throw invalid();
    }
    if (report.references !== undefined && (!Array.isArray(report.references) || report.references.some(reference=>!object(reference) || !text(reference.title) || !text(reference.url)))) throw invalid();
  }
}

/**
 * Read one report on explicit request, without retaining a plaintext cache.
 * personIds is the allow-list of known profile IDs; it defaults to [personId].
 * Returned strings are data: render them as text and validate URL protocols before linking.
 */
export async function readGeneticReport(gzipBytes,{id,personId,personIds = [personId],signal} = {}) {
  if (!safeId(id) || !safeId(personId) || !Array.isArray(personIds) || !personIds.length || personIds.some(value=>!safeId(value)) || !personIds.includes(personId)) throw invalid();
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalid();
  if (signal?.aborted) throw cancelled();
  const bytes = inputBytes(gzipBytes), decoded = await inflate(bytes,signal);
  if (signal?.aborted) throw cancelled();
  let bundle;
  try { bundle = JSON.parse(decoded); }
  catch { throw invalid(); }
  validateBundle(bundle,new Set(personIds));
  const report = bundle.reports.find(item=>item.id === id && item.personId === personId);
  if (!report) throw new Error('Отчёт не найден в выбранном профиле.');
  return report;
}
