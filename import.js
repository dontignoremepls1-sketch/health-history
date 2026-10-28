const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_PAGES = 25;
const MAX_OCR_PAGES = 8;
const MAX_PIXELS = 12_000_000;
const VENDOR = new URL('./vendor/', import.meta.url);
let pdfLibrary;
let ocrLibrary;
const checkAbort = (signal) => { if (signal?.aborted) throw new DOMException('Распознавание отменено.', 'AbortError'); };
const clean = (text) => String(text ?? '').replace(/\u0000/g,'').replace(/\u00a0/g,' ').replace(/\r\n?/g,'\n').normalize('NFC');
const normalized = (text) => clean(text).toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
const validName = (name) => /[a-zа-яё]/i.test(name) && name.length >= 2 && name.length <= 150 && !/^(?:дата|телефон|тел\.?\b|факс|адрес|пациент|фио|номер|заказ|код|полис|снилс|инн|врач|доктор|страниц|итого|всего|диагноз|результат|значение|единицы|референс|референтные|date|phone|patient|order|invoice|birth)/i.test(name);
const numeric = '(?:(?:<=|>=|<|>|≤|≥)\\s*)?[+−-]?\\d+(?:[.,]\\d+)?(?:[eE][+−-]?\\d+)?';
const units = '(?:%|(?:10\\s*(?:\\^|[xх×*])?\\s*\\d+|тыс\\.?|млн\\.?)\\s*[/]\\s*(?:л|мкл|ul|l)|(?:[мкнюпсдгкМГедЕnmupcgdikUIMmolµμ/\\^·×0-9.-]{1,20}(?:моль|мол|mol|г|g|МЕ|ме|Ед|ед|IU|U|мм|mm|сек|sec|ч|h|л|l|pg|ng|ug|mcg|mg|nmol|pmol|mmol|мкг|нг|мг|мкМЕ|мМЕ|нмоль|пмоль|ммоль))?\\s*[/]\\s*(?:мкл|мл|дл|л|kg|ml|dl|ul|l|min|мин|сут|h)|(?:ммоль|нмоль|пмоль|мкмоль|мкг|нг|мг|г|мкМЕ|мМЕ|МЕ|Ед|ед|mmol|nmol|pmol|umol|µmol|μmol|mg|ng|pg|ug|mcg|g|IU|U)\\s*[/]\\s*(?:мкл|мл|дл|л|ml|dl|ul|l)|(?:мм\\s*[/]\\s*ч|mm\\s*[/]\\s*h|сек\\.?|seconds?|мОсм\\s*[/]\\s*кг))';
const lineWithUnit = new RegExp(`^(.+?)\\s*[:|;\\t]?\\s+(${numeric})\\s*(${units})(?:\\s*[:|;\\t]?\\s*(.*))?$`,'iu');
const numericOnly = new RegExp(`^${numeric}$`,'u');
const rangeOnly = /^[<>≤≥]?\s*[+−-]?\d+(?:[.,]\d+)?\s*(?:[-–—]|до|to)\s*[+−-]?\d+(?:[.,]\d+)?/iu;
const qualitative = /^(?:не\s+обнаружен[оыа]?|обнаружен[оыа]?|не\s+выявлен[оыа]?|выявлен[оыа]?|положительн[оаый]+|отрицательн[оаый]+|negative|positive|not\s+detected|detected)$/iu;

function isoDate(text) {
  const value = String(text ?? '').trim();
  let year,month,day;
  let match = value.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/);
  if (match) [,year,month,day]=match;
  else { match=value.match(/\b(\d{2})[./](\d{2})[./](20\d{2}|19\d{2})\b/); if(!match)return null; [,day,month,year]=match; }
  const result=`${year}-${month}-${day}`, parsed=new Date(`${result}T12:00:00Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===result?result:null;
}
function documentDate(lines) {
  for (const line of lines) {
    if (/(?:рожд|birth)/iu.test(line)) continue;
    if (!/(?:дата\s*(?:забора|взятия|сдачи|исследования)|(?:забор|взятие)\s*(?:крови|материала)|sample\s*(?:date|collected)|collection\s*date)/iu.test(line)) continue;
    const date=isoDate(line); if(date)return {date,dateContext:'Дата забора / исследования распознана из текста; проверьте бланк.'};
  }
  return {};
}
function csvSplit(line, delimiter) {
  const result=[];let field='',quoted=false;
  for(let i=0;i<line.length;i++) { const c=line[i]; if(c==='"'){if(quoted&&line[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){result.push(field.trim());field='';}else field+=c; }
  if(quoted)return null; result.push(field.trim());return result;
}
const column = (headers, names) => headers.findIndex((header)=>names.some((name)=>normalized(header).replace(/[().:]/g,'').trim()===name));
function csvRows(lines, dates) {
  for(let start=0;start<Math.min(lines.length,20);start++)for(const delimiter of [';','\t',',','|']) {
    const headers=csvSplit(lines[start],delimiter);if(!headers||headers.length<2)continue;
    const name=column(headers,['показатель','анализ','название','наименование','наименование исследования','исследование','name','test','analyte','parameter']);
    const value=column(headers,['результат','значение','result','value']);if(name<0||value<0)continue;
    const unit=column(headers,['единицы','ед измерения','ед изм','ед','unit','units']);
    const reference=column(headers,['референс','референсные значения','референтные значения','норма','reference','range','reference range']);
    const date=column(headers,['дата','дата забора','дата исследования','date','collection date']);
    const rows=[];
    for(const line of lines.slice(start+1)) {
      const cells=csvSplit(line,delimiter);if(!cells||cells.length!==headers.length)continue;
      if(!validName(cells[name])||(!numericOnly.test(cells[value])&&!qualitative.test(cells[value])))continue;
      const observedDate=date>=0?isoDate(cells[date]):dates.date;
      rows.push({name:cells[name],value:cells[value].replace(/\s+/g,' ').trim(),unit:unit>=0?cells[unit]:'',reference:reference>=0?cells[reference]:'',...(observedDate?{date:observedDate,dateContext:date>=0?'Дата из строки таблицы; проверьте её назначение.':dates.dateContext}:{}),sourceLine:line,confidence:'medium'});
    }
    return rows;
  }
  return null;
}
function lineRow(line, dates) {
  const trimmed=line.trim(); if(!trimmed||trimmed.length>550||/^https?:/i.test(trimmed))return null;
  // Delimited rows without headers remain review proposals, never accepted measurements.
  const cells=trimmed.includes('|')?csvSplit(trimmed,'|'):trimmed.includes('\t')?csvSplit(trimmed,'\t'):null;
  if(cells?.length>=2) {
    const [name,value,unit='',reference='']=cells;
    if(validName(name)&&(numericOnly.test(value)||qualitative.test(value)))return {name,value,unit,reference,...dates,sourceLine:trimmed,confidence:'low'};
  }
  const match=trimmed.match(lineWithUnit);
  if(match) {
    const name=match[1].replace(/[|;:]\s*$/,'').trim(),value=match[2].replace(/\s+/g,'').replace(/−/g,'-'),unit=match[3].replace(/\s+/g,'').trim(),reference=(match[4]||'').trim();
    if(validName(name)&&!/[/:]\s*$/.test(name)&&!/(?:\d[.\/-]\d{2}|\+\d\s*\()/u.test(name))return {name,value,unit,reference,...dates,sourceLine:trimmed,confidence:reference&&rangeOnly.test(reference)?'medium':'low'};
  }
  const dimensionless=trimmed.match(new RegExp(`^(.{2,150}?)\\s+(${numeric})\\s+((?:[<>≤≥]?\\s*\\d+(?:[.,]\\d+)?\\s*[-–—]\\s*\\d+(?:[.,]\\d+)?)(?:\\s.*)?)$`,'iu'));
  if(dimensionless&&validName(dimensionless[1]))return {name:dimensionless[1].trim(),value:dimensionless[2].replace(/\s+/g,''),unit:'',reference:dimensionless[3],...dates,sourceLine:trimmed,confidence:'low'};
  const qualitativeMatch=trimmed.match(/^(.{2,150}?)\s*(?::|\||\t|\s{2,})\s*((?:не\s+)?(?:обнаружен[оыа]?|выявлен[оыа]?)|положительн[оаый]+|отрицательн[оаый]+|negative|positive|not\s+detected|detected)\s*$/iu);
  if(qualitativeMatch&&validName(qualitativeMatch[1]))return {name:qualitativeMatch[1].trim(),value:qualitativeMatch[2],unit:'',reference:'',...dates,sourceLine:trimmed,confidence:'low'};
  return null;
}

export function parseLabText(input) {
  const text=clean(input);
  if(text.length>MAX_TEXT)throw new Error('Текст больше 2 МБ. Разделите документ на части.');
  const lines=text.split('\n').map(line=>line.replace(/[ \t]+$/,'')).filter(line=>line.trim());
  const dates=documentDate(lines), issues=[];
  const rows=csvRows(lines,dates)??lines.map(line=>lineRow(line,dates)).filter(Boolean);
  const seen=new Map();
  for(let i=0;i<rows.length;i++){
    const row=rows[i],signature=[row.name,row.value,row.unit,row.reference,row.date||''].map(normalized).join('|');
    if(seen.has(signature)){row.duplicateOf=seen.get(signature);row.confidence='low';}else seen.set(signature,i);
  }
  if(!dates.date)issues.push('Дата забора не определена. Укажите её по бланку; дата рождения и дата печати не используются как дата анализа.');
  if(!rows.length)issues.push('Не удалось надёжно выделить показатели. Можно исправить текст или внести значения вручную.');
  if(rows.some(row=>row.duplicateOf!==undefined))issues.push('Есть повторяющиеся строки. Проверьте, не является ли это повтором одного результата.');
  issues.push('Все найденные строки — предложения для проверки. Сверьте название, значение, единицы, референс и дату с оригиналом.');
  return {text,rows,...dates,issues};
}

async function pdfjs() {
  if(!pdfLibrary)pdfLibrary=import(new URL('pdfjs/pdf.mjs',VENDOR).href).then(lib=>{lib.GlobalWorkerOptions.workerSrc=new URL('pdfjs/pdf.worker.mjs',VENDOR).href;return lib;});
  return pdfLibrary;
}
async function createOcr(onProgress,signal) {
  checkAbort(signal);
  if(!ocrLibrary)ocrLibrary=import(new URL('ocr/tesseract.mjs',VENDOR).href);
  const lib=await ocrLibrary;
  checkAbort(signal);
  const creating=lib.createWorker('rus+eng',1,{workerPath:new URL('ocr/worker.min.js',VENDOR).href,corePath:new URL('ocr/core',VENDOR).href,langPath:new URL('ocr/lang',VENDOR).href,workerBlobURL:false,cacheMethod:'none',gzip:true,logger:message=>{if(!signal?.aborted)onProgress?.({stage:'ocr',progress:Number(message.progress)||0,message:message.status==='recognizing text'?'Распознавание текста на устройстве…':'Подготовка локального распознавания…'});}});
  let cancel;
  const canceled=new Promise((_,reject)=>{cancel=()=>{creating.then(worker=>worker.terminate()).catch(()=>{});reject(new DOMException('Распознавание отменено.','AbortError'));};});
  signal?.addEventListener('abort',cancel,{once:true});
  let worker;
  try{worker=await Promise.race([creating,canceled]);}finally{signal?.removeEventListener('abort',cancel);}
  if(signal?.aborted){await worker.terminate();checkAbort(signal);}
  return worker;
}
async function recognizeImage(image,{onProgress,signal,worker}={}) {
  const own=!worker, active=worker||await createOcr(onProgress,signal);
  let rejectAbort;const canceled=new Promise((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{void active.terminate().catch(()=>{});rejectAbort(new DOMException('Распознавание отменено.','AbortError'));};signal?.addEventListener('abort',abort,{once:true});
  try {checkAbort(signal);const result=await Promise.race([active.recognize(image),canceled]);checkAbort(signal);return result.data.text||'';}
  finally {signal?.removeEventListener('abort',abort);if(own)await active.terminate().catch(()=>{});}
}
function textFromPage(items) {
  const rows=[];let order=0;
  for(const item of items){
    if(typeof item.str!=='string'||!item.str.trim())continue;
    const x=item.transform?.[4],y=item.transform?.[5];
    if(!Number.isFinite(y)){rows.push({y:-1e9-order++,items:[{x:0,text:item.str}]});continue;}
    let row=rows.find(candidate=>Math.abs(candidate.y-y)<=3);
    if(!row){row={y,items:[]};rows.push(row);}row.items.push({x:Number.isFinite(x)?x:order++,text:item.str});
  }
  return rows.sort((a,b)=>b.y-a.y).map(row=>row.items.sort((a,b)=>a.x-b.x).map(item=>item.text).join(' ')).join('\n');
}
async function extractPdf(bytes,{onProgress,signal}={}) {
  const lib=await pdfjs();checkAbort(signal);
  const task=lib.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:true,enableXfa:false,wasmUrl:new URL('pdfjs/wasm/',VENDOR).href,verbosity:0});
  const abort=()=>{void task.destroy().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  let document,worker,ocrPages=0;
  try {
    document=await task.promise;checkAbort(signal);const pages=Math.min(document.numPages,MAX_PAGES),texts=[],issues=[];
    if(document.numPages>pages)issues.push(`Для извлечения обработаны первые ${pages} из ${document.numPages} страниц. Остальные можно добавить отдельно.`);
    for(let i=1;i<=pages;i++){
      checkAbort(signal);onProgress?.({stage:'pdf',progress:(i-1)/pages,message:`Чтение страницы ${i} из ${pages}…`});
      const page=await document.getPage(i);const content=await page.getTextContent();let text=textFromPage(content.items);
      if((text.match(/[\p{L}\p{N}]/gu)||[]).length<12){
        if(ocrPages>=MAX_OCR_PAGES){issues.push(`Страница ${i}: достигнут предел распознавания сканов (${MAX_OCR_PAGES} страниц за один импорт).`);continue;}
        if(typeof globalThis.document?.createElement!=='function') {issues.push(`Страница ${i}: для скана нужен браузерный режим распознавания.`);continue;}
        worker ||= await createOcr(onProgress,signal);ocrPages++;
        const base=page.getViewport({scale:1}),scale=Math.min(2.5,Math.sqrt(MAX_PIXELS/(base.width*base.height))),viewport=page.getViewport({scale});
        const canvas=globalThis.document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        try {const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('Браузер не поддерживает Canvas.');await page.render({canvasContext:context,viewport,background:'white'}).promise;checkAbort(signal);text=await recognizeImage(canvas,{onProgress,signal,worker});}
        finally{canvas.width=canvas.height=0;}
      }
      texts.push(text);page.cleanup();
    }
    return {text:texts.join('\n\n'),issues,pages:document.numPages,ocrPages};
  } catch(error){checkAbort(signal);if(error?.name==='PasswordException')throw Error('PDF защищён паролем. Выберите доступную копию или внесите показатели вручную.');throw error;}
  finally{signal?.removeEventListener('abort',abort);if(worker)await worker.terminate().catch(()=>{});await task.destroy().catch(()=>{});}
}
async function decodeText(file) {
  const bytes=await file.arrayBuffer();
  try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),encoding:'utf-8'};}catch{return {text:new TextDecoder('windows-1251').decode(bytes),encoding:'windows-1251'};}
}

export async function extractDocument(file,{onProgress,signal}={}) {
  checkAbort(signal);
  if(!file||typeof file.arrayBuffer!=='function'||!Number.isFinite(file.size)||!file.size||file.size>MAX_BYTES)throw Error('Выберите непустой документ до 20 МБ.');
  const extension=String(file.name||'').split('.').pop().toLowerCase();let text='',extra={},kind='text';
  if(extension==='pdf'||file.type==='application/pdf'){
    const bytes=await file.arrayBuffer();if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('Файл не похож на PDF.');kind='pdf';extra=await extractPdf(bytes,{onProgress,signal});text=extra.text;
  }else if(['png','jpg','jpeg','webp'].includes(extension)||/^image\/(?:png|jpeg|webp)$/.test(file.type)){
    kind='image';let canvas;
    if(typeof createImageBitmap==='function'&&typeof globalThis.document?.createElement==='function'){
      const bitmap=await createImageBitmap(file);
      try{checkAbort(signal);const scale=Math.min(1,Math.sqrt(MAX_PIXELS/(bitmap.width*bitmap.height)),4000/bitmap.width,4000/bitmap.height);canvas=globalThis.document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));const context=canvas.getContext('2d');if(!context)throw Error('Браузер не поддерживает Canvas.');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);if(scale<1)extra.issues=['Большое изображение уменьшено для распознавания на устройстве. Если мелкий текст потерялся, загрузите отдельный фрагмент.'];}finally{bitmap.close();}
    }
    try{text=await recognizeImage(canvas||file,{onProgress,signal});}finally{if(canvas)canvas.width=canvas.height=0;}
    extra.ocrPages=1;
  }else if(['csv','tsv','txt','md'].includes(extension)||/^text\//.test(file.type)){extra=await decodeText(file);text=extra.text;}
  else throw Error('Для извлечения поддерживаются PDF, PNG, JPEG, WebP, CSV, TSV и текст.');
  checkAbort(signal);const parsed=parseLabText(text);onProgress?.({stage:'done',progress:1,message:'Извлечение завершено. Проверьте предложенные строки.'});
  return {...parsed,...extra,text:parsed.text,kind,issues:[...(extra.issues||[]),...parsed.issues]};
}
