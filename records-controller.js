import * as model from './model.js?v=2.2';
import { recordForm, readRecordForm, TYPES, TYPE_FOR } from './forms.js?v=2.2';
import { encryptAsset, toBase64 } from './crypto.js?v=2.2';

export async function prepareAttachment(file,{key,personId,documents=[],id=crypto.randomUUID(),metadata={},maxMB=20}) {
  if(!file||typeof file.arrayBuffer!=='function'||!file.size||file.size>maxMB*1024*1024) throw Error(`Выберите непустой файл до ${maxMB} МБ.`);
  const extension=file.name.split('.').pop().toLowerCase();
  const types={pdf:'application/pdf',md:'text/markdown',txt:'text/plain',csv:'text/plain',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
  const mime=types[extension]; if(!mime)throw Error('Поддерживаются PDF, текст, CSV, PNG, JPEG и WebP.');
  const bytes=await file.arrayBuffer(), header=new Uint8Array(bytes.slice(0,12));
  if(extension==='pdf'&&new TextDecoder().decode(header.slice(0,5))!=='%PDF-')throw Error('Файл не похож на PDF.');
  if(mime==='image/png'&&!(header[0]===137&&header[1]===80&&header[2]===78&&header[3]===71))throw Error('Некорректный PNG.');
  if(mime==='image/jpeg'&&!(header[0]===255&&header[1]===216))throw Error('Некорректный JPEG.');
  if(mime==='image/webp'&&!(new TextDecoder().decode(header.slice(0,4))==='RIFF'&&new TextDecoder().decode(header.slice(8,12))==='WEBP'))throw Error('Некорректный WebP.');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(documents.some(d=>d.fileHash===hash))throw Error('Этот файл уже есть в профиле. Откройте существующий документ, чтобы изменить его описание или связи.');
  return {record:{id,personId,local:true,createdAt:new Date().toISOString(),title:file.name,date:new Date().toLocaleDateString('sv-SE'),kind:mime.startsWith('image/')?'photo':'analysis',problemIds:[],description:'',...metadata,fileName:file.name,mime,size:file.size,fileHash:hash},encrypted:toBase64(await encryptAsset(bytes,key))};
}

export function installRecordController(api) {
  const {state,$,records,toast,render,populateProfiles,persistOverlay}=api;
  function showForm(type,id=null) {
    const collection=TYPES[type]; if(!collection)return;
    const record=id?state.vault[collection].find(r=>r.id===id&&(collection==='people'||r.personId===state.personId)):null;
    if(id&&!record){toast('Запись не найдена в выбранном профиле.');return;}
    state.formRequest=(state.formRequest||0)+1;state.formType=type;state.editing=record?{collection,id,record}:null;
    const form=recordForm(type,{record:record||{},problems:records('problems'),documents:records('documents'),editing:!!record});
    $('record-title').textContent=form.title;$('record-fields').innerHTML=form.fields;$('record-error').textContent='';$('record-dialog').showModal();
  }
  $('record-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!state.key||state.busy)return;
    const generation=state.generation,request=state.formRequest,button=event.currentTarget.querySelector('[type="submit"]'),type=state.formType,editing=state.editing,now=new Date().toISOString();
    state.busy=true;button.disabled=true;
    try{
      const parsed=readRecordForm(type,new FormData(event.currentTarget),{record:editing?.record||{},personId:state.personId,id:editing?.id||crypto.randomUUID(),now});
      if(editing&&!parsed.reason)throw Error('Укажите причину изменения для истории.');
      let candidate=model.normalizeOverlay(state.overlay);
      if(type==='person')delete parsed.record.personId;
      if(type==='document'&&!editing){
        const attachment=await prepareAttachment(parsed.file,{key:state.key,personId:state.personId,documents:records('documents'),id:parsed.record.id,metadata:parsed.fields});
        if(generation!==state.generation)return;parsed.record=attachment.record;candidate.assets[parsed.record.id]=attachment.encrypted;
      }
      if(type==='symptom'&&parsed.file?.size){
        const attachment=await prepareAttachment(parsed.file,{key:state.key,personId:state.personId,documents:records('documents'),maxMB:10,metadata:{title:`Фото: ${parsed.fields.title}`,date:parsed.fields.date,kind:'photo',problemIds:parsed.fields.problemId?[parsed.fields.problemId]:[]}});
        if(generation!==state.generation)return;candidate=model.addRecord(candidate,'documents',attachment.record);candidate.assets[attachment.record.id]=attachment.encrypted;parsed.fields.photoDocumentId=attachment.record.id;parsed.record.photoDocumentId=attachment.record.id;
      }
      if(type==='lab'&&!editing){const duplicates=model.identifyDuplicates(records('labs'),parsed.record);if(duplicates.length)throw Error('Такой результат уже есть в профиле. Проверьте дату, показатель и исходный бланк.');}
      candidate=editing?model.editOverlay(candidate,state.vault,parsed.collection,editing.id,parsed.fields,parsed.reason):model.addRecord(candidate,parsed.collection,parsed.record);
      if(!editing&&type==='document')candidate=model.addRecord(candidate,'timeline',{id:crypto.randomUUID(),personId:state.personId,date:parsed.record.date,title:parsed.record.title,description:'Добавлен документ.',type:parsed.record.kind,documentId:parsed.record.id,local:true});
      await persistOverlay(candidate);if(generation!==state.generation)return;
      if(type==='person'){if(!editing){state.personId=parsed.record.id;state.filters={};state.visitDraft=null;}populateProfiles();if(!editing)location.hash='#/home';}
      if(request===state.formRequest){$('record-dialog').close();state.editing=null;}render();toast(editing?'Изменение сохранено. Прежние значения доступны в истории.':'Запись сохранена зашифрованной.');
    }catch(error){if(generation===state.generation){if(request===state.formRequest)$('record-error').textContent=error.message||'Не удалось сохранить запись.';else toast(error.message||'Не удалось сохранить прежнюю запись.');}}
    finally{button.disabled=false;if(generation===state.generation)state.busy=false;}
  });
  return {showForm,showEdit(value){const split=value.indexOf(':');const collection=value.slice(0,split),id=value.slice(split+1);showForm(TYPE_FOR[collection],id);}};
}
