const CHANNEL = 'health-sync-v1';
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((value) => value.toString(16).padStart(2,'0')).join('');
export function validBridgeEvent(event, origin, popup, nonce) {
  return !!event && !!popup && typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce) && event.origin === origin && event.source === popup && event.data?.channel === CHANNEL && event.data.nonce === nonce;
}
export async function syncScope(kdf) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`health-vault-v1:${kdf.name}:${kdf.hash}:${kdf.iterations}:${kdf.salt}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2,'0')).join('');
}
export function createSyncClient({ origin, onStatus = () => {} }) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:') throw new Error('Синхронизация требует HTTPS.');
  const targetOrigin = parsed.origin;
  let popup = null, nonce = null, connected = false, connectPromise = null, readyResolve = null, readyReject = null, handshakeTimer = null, handshakeTimeout = null, closedTimer = null;
  const pending = new Map();
  const status = (state,message) => onStatus({ state,message });
  const error = (message,code) => Object.assign(new Error(message), code ? { code } : {});
  const cleanupHandshake = () => { clearInterval(handshakeTimer); clearTimeout(handshakeTimeout); handshakeTimer = handshakeTimeout = null; };
  function receive(event) {
    if (!validBridgeEvent(event,targetOrigin,popup,nonce)) return;
    const data = event.data;
    if (data.type === 'ready') { connected = true; cleanupHandshake(); status('connected','Личное хранилище подключено.'); readyResolve?.(); readyResolve = readyReject = null; return; }
    if (data.type !== 'result' || !pending.has(data.id)) return;
    const operation = pending.get(data.id); pending.delete(data.id); clearTimeout(operation.timer);
    if (data.ok) operation.resolve(data.result);
    else operation.reject(error(data.error || 'Синхронизация не завершена.', data.conflict ? 'conflict' : 'sync_failed'));
  }
  window.addEventListener('message',receive);
  function disconnect(message = 'Окно синхронизации закрыто. Если вход уже выполнен, нажмите «Подключить» ещё раз.') {
    connected = false; cleanupHandshake(); clearInterval(closedTimer); closedTimer = null;
    readyReject?.(error(message,'closed')); readyResolve = readyReject = null; connectPromise = null;
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(error(message,'closed')); }
    pending.clear(); status('closed',message);
  }
  function connect() {
    if (connected && popup && !popup.closed) return Promise.resolve();
    if (connectPromise && popup && !popup.closed) { popup.focus?.(); return connectPromise; }
    if (popup) { const previous = popup; disconnect(); try { previous.close(); } catch {} popup = null; }
    nonce = randomToken();
    // This must remain synchronous with the user's click so mobile browsers allow it.
    popup = window.open(`${targetOrigin}/?bridge=1`, `health-sync-${nonce.slice(0,16)}`, 'popup=yes,width=520,height=680');
    if (!popup) { status('error','Браузер заблокировал окно синхронизации.'); return Promise.reject(error('Разрешите открыть окно личного хранилища для синхронизации.','popup_blocked')); }
    status('connecting','Откройте личное хранилище в появившемся окне.');
    connectPromise = new Promise((resolve,reject) => { readyResolve = resolve; readyReject = reject; });
    const init = () => { try { popup?.postMessage({ channel:CHANNEL, type:'init', nonce },targetOrigin); } catch { /* Navigation to sign-in can temporarily prevent messaging. */ } };
    init(); handshakeTimer = setInterval(init,700);
    handshakeTimeout = setTimeout(() => disconnect('Вход в хранилище не завершён. Повторите подключение.'), 5*60*1000);
    closedTimer = setInterval(() => { if (!popup || popup.closed) disconnect(); },1000);
    return connectPromise;
  }
  async function request(operation, scope, envelope, etag) {
    if (!connected || !popup || popup.closed) throw error('Сначала подключите личное хранилище.','not_connected');
    if (typeof scope !== 'string' || !/^[0-9a-f]{64}$/.test(scope)) throw error('Неверный идентификатор хранилища.');
    if (operation === 'write' && (envelope?.format !== 'health-vault-v1' || envelope.cipher?.name !== 'AES-GCM' || typeof envelope.cipher.data !== 'string' || !envelope.kdf)) throw error('Отправлять можно только зашифрованную копию.');
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(error('Синхронизация заняла слишком много времени. Локальная копия сохранена.','timeout')); },120000);
      pending.set(id,{ resolve,reject,timer });
      try { popup.postMessage({ channel:CHANNEL,type:'request',nonce,id,operation,scope,...(operation === 'write' ? { envelope,etag:etag ?? null } : {}) },targetOrigin); }
      catch { clearTimeout(timer); pending.delete(id); reject(error('Не удалось связаться с личным хранилищем.','connection_failed')); }
    });
  }
  return {
    connect,
    read:(scope) => request('read',scope),
    write:(scope,envelope,etag = null) => request('write',scope,envelope,etag),
    close() { const opened = popup; disconnect(); popup = null; try { opened?.close(); } catch {} window.removeEventListener('message',receive); },
    get connected() { return connected && !!popup && !popup.closed; },
  };
}
