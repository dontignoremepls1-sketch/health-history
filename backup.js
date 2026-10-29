import { decryptEnvelope, encryptJson, decryptAsset, fromBase64, toBase64, limits as cryptoLimits } from './crypto.js?v=2.5';
import { normalizeVault, normalizeOverlay, mergeVault, COLLECTIONS } from './model.js?v=2.5';

// Only this neutral header is public. The ordered asset manifest is encrypted.
export const BACKUP_V2_FORMAT = 'health-vault-binary-v2';
export const BACKUP_V2_LIMITS = Object.freeze({
  fileBytes:1024 * 1024 * 1024, metadataBytes:16 * 1024 * 1024,
  documents:500, assetBytes:cryptoLimits.assetBytes + 28, headerBytes:24
});
const MAGIC = new TextEncoder().encode('HEALTHVAULT2');
const utf8 = new TextEncoder(), decoder = new TextDecoder('utf-8',{fatal:true});
const safeId = id => typeof id === 'string' && /^[\w.-]{1,100}$/.test(id) && !['.','..','__proto__','prototype','constructor'].includes(id);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Резервная копия повреждена или имеет неподдерживаемый формат.');
const abortError = () => Object.assign(new Error('Работа с резервной копией отменена.'),{name:'AbortError'});
const checkAbort = signal => { if(signal?.aborted)throw abortError(); };
const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function signalCheck(signal) {
  if(signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))throw invalid();
  checkAbort(signal);
}
function blobCheck(file) {
  if(!file || !Number.isSafeInteger(file.size) || typeof file.slice !== 'function' || file.size > BACKUP_V2_LIMITS.fileBytes)throw new Error('Копия должна быть файлом не больше 1 ГиБ.');
}
function exactKeys(value,keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key=>has(value,key)); }
function kdfOnly(input) {
  if(!exactKeys(input,['name','hash','iterations','salt']) || input.name !== 'PBKDF2' || input.hash !== 'SHA-256' ||
      !Number.isSafeInteger(input.iterations) || input.iterations < cryptoLimits.iterations || input.iterations > 2000000 ||
      typeof input.salt !== 'string' || input.salt.length > 88)throw invalid();
  const salt = fromBase64(input.salt);
  if(salt.length < 16 || salt.length > 64)throw invalid();
  return {name:input.name,hash:input.hash,iterations:input.iterations,salt:input.salt};
}
function cipherMap(input,documentIds) {
  if(!object(input) || Object.keys(input).some(id=>!safeId(id) || !documentIds.has(id)))throw invalid();
}
function metadataRecords(vaultInput,overlayInput) {
  if(!object(vaultInput) || has(vaultInput,'assets') || !object(overlayInput))throw invalid();
  // Base64 assets are input references, never cloned into metadata or merge copies.
  const overlayAssets=overlayInput.assets === undefined ? {} : overlayInput.assets;
  if(!object(overlayAssets) || Object.values(overlayAssets).some(value=>typeof value!=='string'))throw invalid();
  const vault=normalizeVault(vaultInput), overlay=normalizeOverlay({...overlayInput,assets:{}});
  const people=new Set(vault.people.map(p=>p.id));
  if(vault.people.some(p=>!safeId(p.id)) || !people.size || vault.documents.length > BACKUP_V2_LIMITS.documents)throw invalid();
  const documents=new Map();
  for(const doc of vault.documents){
    if(!safeId(doc.id) || documents.has(doc.id) || !safeId(doc.personId) || !people.has(doc.personId) ||
       (doc.fileHash !== undefined && !/^[a-f0-9]{64}$/i.test(doc.fileHash)) ||
       (doc.size !== undefined && (!Number.isSafeInteger(doc.size) || doc.size < 1 || doc.size > cryptoLimits.assetBytes)))throw invalid();
    documents.set(doc.id,doc);
  }
  for(const doc of overlay.documents)if(!documents.has(doc.id) || documents.get(doc.id).personId !== doc.personId)throw invalid();
  // Reject foreign references before the snapshot can replace any application state.
  validateOwnership(vault,people,documents);
  for(const collection of COLLECTIONS)for(const record of overlay[collection]){
    const current=vault[collection].find(item=>item.id===record.id);
    if(!current || (collection!=='sources' && collection!=='people' && current.personId!==record.personId))throw invalid();
  }
  for(const change of overlay.changes)if(!vault[change.collection].some(item=>item.id===change.recordId))throw invalid();
  const merged=mergeVault(vault,overlay);
  if(merged.documents.length!==documents.size)throw invalid();
  for(const doc of merged.documents){
    const original=documents.get(doc.id);
    if(!original || original.personId!==doc.personId || original.size!==doc.size || original.fileHash!==doc.fileHash)throw invalid();
  }
  validateOwnership(merged,people,documents);
  cipherMap(overlayAssets,new Set(documents.keys()));
  return {vault,overlay,overlayAssets,documents};
}
function validateOwnership(vault,people,documents) {
  const problems=new Map(vault.problems.map(item=>[item.id,item.personId])), labs=new Map(vault.labs.map(item=>[item.id,item.personId]));
  const references=[
    [['documentId','photoDocumentId'],['documentIds','sourceDocumentIds','relatedDocumentIds'],new Map([...documents].map(([id,doc])=>[id,doc.personId]))],
    [['problemId'],['problemIds'],problems], [[],['labIds','clinicalLabIds'],labs]
  ];
  const validateReferences = item => {
    if(!object(item) || !people.has(item.personId))throw invalid();
    for(const [singles,arrays,owners] of references){
      for(const field of singles)if(item[field] && owners.get(item[field])!==item.personId)throw invalid();
      for(const field of arrays){
        if(item[field]!==undefined && (!Array.isArray(item[field]) || item[field].some(id=>owners.get(id)!==item.personId)))throw invalid();
      }
    }
    if(item.reportSource && documents.get(item.reportSource.documentId)?.personId!==item.personId)throw invalid();
  };
  // Use this snapshot's documents as well as its other records: overlay edits
  // can change relationships without changing document identity or file hashes.
  for(const collection of ['documents','problems','labs','timeline','actions','medications','symptoms','visits','genetics']){
    for(const item of vault[collection]){
      validateReferences(item);
      if(collection==='genetics' && item.variants!==undefined){
        if(!Array.isArray(item.variants))throw invalid();
        for(const variant of item.variants){
          if(!object(variant) || (variant.sourceDocumentId && documents.get(variant.sourceDocumentId)?.personId!==item.personId))throw invalid();
        }
      }
    }
  }
  if(vault.geneticImports!==undefined){
    if(!Array.isArray(vault.geneticImports))throw invalid();
    for(const imported of vault.geneticImports){
      validateReferences(imported);
      if(imported.rawData){
        if(!object(imported.rawData))throw invalid();
        validateReferences({...imported.rawData,personId:imported.personId});
      }
      if(imported.sections!==undefined){
        if(!Array.isArray(imported.sections))throw invalid();
        for(const section of imported.sections){
          if(!object(section))throw invalid();
          validateReferences({...section,personId:imported.personId});
        }
      }
    }
  }
}
async function encryptedBytes(value) {
  if(typeof value === 'string'){
    if(value.length > Math.ceil(BACKUP_V2_LIMITS.assetBytes/3)*4)throw invalid();
    value=fromBase64(value);
  }else if(value && typeof value.arrayBuffer === 'function' && Number.isSafeInteger(value.size)){
    if(value.size < 29 || value.size > BACKUP_V2_LIMITS.assetBytes)throw invalid();
    value=await value.arrayBuffer();
  }
  const bytes=value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer,value.byteOffset,value.byteLength) : null;
  if(!bytes || bytes.byteLength < 29 || bytes.byteLength > BACKUP_V2_LIMITS.assetBytes)throw invalid();
  // Detach from caller-owned buffers before asynchronous authentication and hash.
  return new Uint8Array(bytes);
}
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
async function validateCipher(bytes,doc,key,signal) {
  checkAbort(signal);
  const plain=await decryptAsset(bytes,key);checkAbort(signal);
  if(doc.size !== undefined && doc.size !== plain.byteLength)throw invalid();
  if(doc.fileHash !== undefined && await digest(plain) !== doc.fileHash.toLowerCase())throw invalid();
  checkAbort(signal);
}
function progress(callback,value,signal) { checkAbort(signal);if(callback)callback(value);checkAbort(signal); }
function envelopeLength(metadata,kdf) {
  const size=utf8.encode(JSON.stringify(metadata)).byteLength;
  const shell={format:'health-vault-v1',kdf,cipher:{name:'AES-GCM',iv:'AAAAAAAAAAAAAAAA',data:''}};
  return utf8.encode(JSON.stringify(shell)).byteLength + Math.ceil((size+16)/3)*4;
}
function finalizeLayout(metadata,kdf) {
  for(let i=0;i<8;i++){
    const size=envelopeLength(metadata,kdf);
    if(size > BACKUP_V2_LIMITS.metadataBytes)throw new Error('Описание резервной копии превышает 16 МиБ.');
    const total=BACKUP_V2_LIMITS.headerBytes+size+metadata.layout.payloadBytes;
    if(total > BACKUP_V2_LIMITS.fileBytes)throw new Error('Резервная копия превышает 1 ГиБ.');
    if(metadata.layout.metadataBytes===size && metadata.layout.totalBytes===total)return size;
    metadata.layout.metadataBytes=size;metadata.layout.totalBytes=total;
  }
  throw invalid();
}
function header(metadataLength) {
  const bytes=new Uint8Array(BACKUP_V2_LIMITS.headerBytes);bytes.set(MAGIC);
  const view=new DataView(bytes.buffer);view.setUint32(12,2,true);view.setUint32(16,metadataLength,true);
  return bytes;
}
async function readHeader(file) {
  blobCheck(file);
  if(file.size < BACKUP_V2_LIMITS.headerBytes)throw invalid();
  const bytes=new Uint8Array(await file.slice(0,BACKUP_V2_LIMITS.headerBytes).arrayBuffer());
  if(!MAGIC.every((n,i)=>bytes[i]===n))throw invalid();
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), length=view.getUint32(16,true);
  if(view.getUint32(12,true)!==2 || view.getUint32(20,true)!==0 || length < 100 ||
     length > BACKUP_V2_LIMITS.metadataBytes || BACKUP_V2_LIMITS.headerBytes+length > file.size)throw invalid();
  return length;
}

export async function isBackupV2(file) {
  if(!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < MAGIC.length)return false;
  const bytes=new Uint8Array(await file.slice(0,MAGIC.length).arrayBuffer());
  return MAGIC.every((n,i)=>bytes[i]===n);
}

export async function createBackupV2({vault:vaultInput,overlay:overlayInput={},assets={},key,kdf:getKdf,getEncryptedAsset,signal,onProgress}={}) {
  signalCheck(signal);
  const kdf=kdfOnly(getKdf), {vault,overlay,overlayAssets,documents}=metadataRecords(vaultInput,overlayInput);
  cipherMap(assets,new Set(documents.keys()));
  if(getEncryptedAsset !== undefined && typeof getEncryptedAsset !== 'function')throw invalid();
  const parts=[], entries=[];let offset=0, completed=0;
  progress(onProgress,{phase:'documents',completed,total:documents.size,bytes:0},signal);
  for(const doc of documents.values()){
    checkAbort(signal);
    const value=overlayAssets[doc.id] || assets[doc.id] || (getEncryptedAsset && await getEncryptedAsset(structuredClone(doc),{signal}));
    const bytes=await encryptedBytes(value);checkAbort(signal);
    await validateCipher(bytes,doc,key,signal);
    const sha256=await digest(bytes);checkAbort(signal);
    // Blob copies this bounded document, so a caller cannot mutate it after hashing.
    parts.push(new Blob([bytes]));
    entries.push({id:doc.id,personId:doc.personId,offset,length:bytes.byteLength,sha256});
    offset+=bytes.byteLength;
    if(!Number.isSafeInteger(offset) || offset+BACKUP_V2_LIMITS.headerBytes > BACKUP_V2_LIMITS.fileBytes)throw new Error('Резервная копия превышает 1 ГиБ.');
    progress(onProgress,{phase:'documents',completed:++completed,total:documents.size,bytes:offset},signal);
  }
  const metadata={
    format:BACKUP_V2_FORMAT,version:2,vault,overlay:{...overlay,assets:{}},
    layout:{headerBytes:BACKUP_V2_LIMITS.headerBytes,metadataBytes:0,payloadBytes:offset,totalBytes:0},
    manifest:entries
  };
  const expected=finalizeLayout(metadata,kdf);
  const envelope=await encryptJson(metadata,key,kdf);checkAbort(signal);
  const encoded=utf8.encode(JSON.stringify(envelope));
  if(encoded.byteLength!==expected)throw invalid();
  const output=new Blob([header(encoded.byteLength),encoded,...parts],{type:'application/octet-stream'});
  if(output.size!==metadata.layout.totalBytes)throw invalid();
  progress(onProgress,{phase:'complete',completed,total:documents.size,bytes:output.size},signal);
  return output;
}

function checkManifest(metadata,fileSize,metadataLength) {
  if(!exactKeys(metadata,['format','version','vault','overlay','layout','manifest']) || metadata.format!==BACKUP_V2_FORMAT || metadata.version!==2 ||
      !exactKeys(metadata.layout,['headerBytes','metadataBytes','payloadBytes','totalBytes']) ||
      !Array.isArray(metadata.manifest) || metadata.manifest.length > BACKUP_V2_LIMITS.documents)throw invalid();
  const {vault,overlay,overlayAssets,documents}=metadataRecords(metadata.vault,metadata.overlay), layout=metadata.layout;
  if(Object.keys(overlayAssets).length || metadata.manifest.length!==documents.size ||
      layout.headerBytes!==BACKUP_V2_LIMITS.headerBytes || layout.metadataBytes!==metadataLength || layout.totalBytes!==fileSize ||
      !Number.isSafeInteger(layout.payloadBytes) || layout.payloadBytes < 0 ||
      layout.headerBytes+layout.metadataBytes+layout.payloadBytes!==fileSize)throw invalid();
  const seen=new Set();let offset=0;
  for(const entry of metadata.manifest){
    if(!exactKeys(entry,['id','personId','offset','length','sha256']) || !safeId(entry.id) || seen.has(entry.id) ||
       !documents.has(entry.id) || documents.get(entry.id).personId!==entry.personId ||
       entry.offset!==offset || !Number.isSafeInteger(entry.length) || entry.length < 29 || entry.length > BACKUP_V2_LIMITS.assetBytes ||
       typeof entry.sha256!=='string' || !/^[a-f0-9]{64}$/.test(entry.sha256))throw invalid();
    seen.add(entry.id);offset+=entry.length;if(!Number.isSafeInteger(offset) || offset > layout.payloadBytes)throw invalid();
  }
  if(offset!==layout.payloadBytes)throw invalid();
  return {vault,overlay,documents};
}

export async function openBackupV2(file,password,{signal,onProgress}={}) {
  signalCheck(signal);const metadataLength=await readHeader(file);checkAbort(signal);
  let envelope;
  try{
    envelope=JSON.parse(decoder.decode(await file.slice(BACKUP_V2_LIMITS.headerBytes,BACKUP_V2_LIMITS.headerBytes+metadataLength).arrayBuffer()));
  }catch{throw invalid();}
  if(!exactKeys(envelope,['format','kdf','cipher']) || envelope.format!=='health-vault-v1' ||
     !exactKeys(envelope.cipher,['name','iv','data']) || envelope.cipher.name!=='AES-GCM')throw invalid();
  kdfOnly(envelope.kdf);checkAbort(signal);
  const {key,data:metadata}=await decryptEnvelope(envelope,password);checkAbort(signal);
  const {vault,overlay,documents}=checkManifest(metadata,file.size,metadataLength);
  const assets={};let completed=0,bytesRead=0;
  progress(onProgress,{phase:'documents',completed,total:documents.size,bytes:0},signal);
  const start=BACKUP_V2_LIMITS.headerBytes+metadataLength;
  for(const entry of metadata.manifest){
    checkAbort(signal);
    const bytes=new Uint8Array(await file.slice(start+entry.offset,start+entry.offset+entry.length).arrayBuffer());checkAbort(signal);
    if(bytes.byteLength!==entry.length || await digest(bytes)!==entry.sha256)throw invalid();
    checkAbort(signal);await validateCipher(bytes,documents.get(entry.id),key,signal);
    assets[entry.id]=toBase64(bytes);
    bytesRead+=bytes.byteLength;
    progress(onProgress,{phase:'documents',completed:++completed,total:documents.size,bytes:bytesRead},signal);
  }
  progress(onProgress,{phase:'complete',completed,total:documents.size,bytes:file.size},signal);
  return {key,data:{vault,overlay,assets},kdf:{...envelope.kdf},backupId:envelope.cipher.iv,format:BACKUP_V2_FORMAT};
}
