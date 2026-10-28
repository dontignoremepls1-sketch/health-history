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
  let popup = null, nonce = null, connected = false, connectPromise = null, readyResolve = null, readyReject = null, handshakeTimer = null, handshakeWarning = null, handshakeTimeout = null, closedTimer = null;
  const pending = new Map();
  const status = (state,message) => onStatus({ state,message });
  const error = (message,code) => Object.assign(new Error(message), code ? { code } : {});
  const cleanupHandshake = () => { clearInterval(handshakeTimer); clearTimeout(handshakeWarning); clearTimeout(handshakeTimeout); handshakeTimer = handshakeWarning = handshakeTimeout = null; };
  function receive(event) {
    if (!validBridgeEvent(event,targetOrigin,popup,nonce)) return;
    const data = event.data;
    if (data.type === 'ready') {
      // A late reply after failure or cancellation must not revive an abandoned session.
      if (!readyResolve) return;
      connected = true; cleanupHandshake(); status('connected','Личное хранилище подключено.'); readyResolve(); readyResolve = readyReject = null; return;
    }
    if (data.type !== 'result' || !pending.has(data.id)) return;
    const operation = pending.get(data.id); pending.delete(data.id); clearTimeout(operation.timer);
    if (data.ok) operation.resolve(data.result);
    else {
      const message = data.error || 'Синхронизация не завершена. Локальная копия сохранена.';
      operation.reject(error(message, data.conflict ? 'conflict' : 'sync_failed'));
      if (!data.conflict) disconnect(message,'sync_failed','error');
    }
  }
  window.addEventListener('message',receive);
  function disconnect(message = 'Окно синхронизации закрыто. Локальные записи сохранены. Если вход уже выполнен, нажмите «Подключить» ещё раз.', code = 'closed', statusName = 'closed') {
    connected = false; cleanupHandshake(); clearInterval(closedTimer); closedTimer = null;
    readyReject?.(error(message,code)); readyResolve = readyReject = null; connectPromise = null;
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(error(message,code)); }
    pending.clear(); status(statusName,message);
  }
  function connect() {
    if (connected && popup && !popup.closed) return Promise.resolve();
    if (connectPromise && popup && !popup.closed) { try { popup.focus?.(); } catch {} return connectPromise; }
    if (popup) { const previous = popup; disconnect(); try { previous.close(); } catch {} popup = null; }
    nonce = randomToken();
    // This must remain synchronous with the user's click so mobile browsers allow it.
    popup = window.open(`${targetOrigin}/?bridge=1`, `health-sync-${nonce.slice(0,16)}`, 'popup=yes,width=520,height=680');
    if (!popup) { status('error','Браузер не открыл окно синхронизации. Локальные записи сохранены.'); return Promise.reject(error('Окно личного хранилища не открылось. Локальные записи сохранены; проверьте, разрешены ли всплывающие окна.','popup_blocked')); }
    status('connecting','Откройте личное хранилище в появившемся окне.');
    connectPromise = new Promise((resolve,reject) => { readyResolve = resolve; readyReject = reject; });
    const init = () => { try { popup?.postMessage({ channel:CHANNEL, type:'init', nonce },targetOrigin); } catch { /* Navigation to sign-in can temporarily prevent messaging. */ } };
    init(); handshakeTimer = setInterval(init,700);
    handshakeWarning = setTimeout(() => status('unconfirmed','Облако ещё не подтвердило соединение. Проверьте открытое окно: вход или доступ к сервису могли не завершиться. Локальные записи сохранены.'),12000);
    handshakeTimeout = setTimeout(() => disconnect('Облако не подтвердило соединение. Если в отдельном окне показана блокировка доступа, синхронизация недоступна. Локальные записи сохранены; используйте зашифрованную резервную копию для переноса.','handshake_timeout','error'),60000);
    closedTimer = setInterval(() => { if (!popup || popup.closed) disconnect(); },1000);
    return connectPromise;
  }
  async function request(operation, scope, envelope, etag) {
    if (!connected || !popup || popup.closed) throw error('Сначала подключите личное хранилище.','not_connected');
    if (typeof scope !== 'string' || !/^[0-9a-f]{64}$/.test(scope)) throw error('Неверный идентификатор хранилища.');
    if (operation === 'write' && (envelope?.format !== 'health-vault-v1' || envelope.cipher?.name !== 'AES-GCM' || typeof envelope.cipher.data !== 'string' || !envelope.kdf)) throw error('Отправлять можно только зашифрованную копию.');
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => disconnect('Сервис не подтвердил синхронизацию вовремя. Локальная копия сохранена. Подключитесь заново или перенесите зашифрованную резервную копию.','timeout','error'),120000);
      pending.set(id,{ resolve,reject,timer });
      try { popup.postMessage({ channel:CHANNEL,type:'request',nonce,id,operation,scope,...(operation === 'write' ? { envelope,etag:etag ?? null } : {}) },targetOrigin); }
      catch { disconnect('Не удалось связаться с личным хранилищем. Локальная копия сохранена.','connection_failed','error'); }
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
