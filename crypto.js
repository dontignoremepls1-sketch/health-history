const FORMAT = 'health-vault-v1';
const ITERATIONS = 600000;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error('Для открытия нужен современный браузер и защищённое соединение HTTPS.');
  return globalThis.crypto.subtle;
}

function bytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('Ожидались двоичные данные.');
}

export function toBase64(input) {
  const data = bytes(input);
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
}

export function fromBase64(input) {
  if (typeof input !== 'string' || input.length > Math.ceil(MAX_JSON_BYTES * 4 / 3) + 32 || input.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    throw new Error('Некорректный формат зашифрованных данных.');
  }
  let decoded;
  try { decoded = atob(input); } catch { throw new Error('Некорректный формат зашифрованных данных.'); }
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

function validateKdf(kdf) {
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isSafeInteger(kdf.iterations) || kdf.iterations < ITERATIONS || kdf.iterations > 2000000) {
    throw new Error('Параметры защиты файла не поддерживаются.');
  }
  const salt = fromBase64(kdf.salt);
  if (salt.length < 16 || salt.length > 64) throw new Error('Некорректные параметры защиты файла.');
  return salt;
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.format !== FORMAT || envelope.cipher?.name !== 'AES-GCM') throw new Error('Это не поддерживаемый файл медицинской базы.');
  validateKdf(envelope.kdf);
  const iv = fromBase64(envelope.cipher.iv);
  const data = fromBase64(envelope.cipher.data);
  if (iv.length !== 12 || data.length < 16 || data.length > MAX_JSON_BYTES) throw new Error('Зашифрованный файл повреждён.');
  return { iv, data };
}

export async function deriveKey(password, kdf) {
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('Введите пароль.');
  const salt = validateKdf(kdf);
  const material = await subtle().importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function decryptEnvelope(envelope, password) {
  validateEnvelope(envelope);
  const key = await deriveKey(password, envelope.kdf);
  const data = await decryptJson(envelope, key);
  return { key, data };
}

export async function decryptJson(envelope, key) {
  const { iv, data } = validateEnvelope(envelope);
  let plaintext;
  try {
    plaintext = await subtle().decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data);
  } catch {
    throw new Error('Не удалось открыть базу. Проверьте пароль и целостность файла.');
  }
  try { return JSON.parse(decoder.decode(plaintext)); }
  catch { throw new Error('Расшифрованный файл имеет неверный формат.'); }
}

export async function encryptJson(data, key, kdf) {
  validateKdf(kdf);
  const plaintext = utf8.encode(JSON.stringify(data));
  if (plaintext.length > MAX_JSON_BYTES - 16) throw new Error('Размер резервной копии превышает допустимый предел.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintext);
  return { format: FORMAT, kdf: { ...kdf }, cipher: { name: 'AES-GCM', iv: toBase64(iv), data: toBase64(encrypted) } };
}

export async function encryptAsset(input, key) {
  const data = bytes(input);
  if (!data.length || data.length > MAX_ASSET_BYTES) throw new Error('Документ должен быть не больше 25 МБ.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data));
  const out = new Uint8Array(12 + encrypted.length);
  out.set(iv); out.set(encrypted, 12);
  return out.buffer;
}

export async function decryptAsset(input, key) {
  const data = bytes(input);
  if (data.length < 29 || data.length > MAX_ASSET_BYTES + 28) throw new Error('Недопустимый размер документа.');
  try {
    return await subtle().decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), tagLength: 128 }, key, data.subarray(12));
  } catch { throw new Error('Документ повреждён или зашифрован другим паролем.'); }
}

export const limits = Object.freeze({ jsonBytes: MAX_JSON_BYTES, assetBytes: MAX_ASSET_BYTES, iterations: ITERATIONS });
