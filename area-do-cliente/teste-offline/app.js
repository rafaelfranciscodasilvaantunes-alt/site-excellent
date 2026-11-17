const DATABASE_NAME = 'plataforma-obras-offline';
const DATABASE_VERSION = 1;
const STORE_NAME = 'apontamentos';
const EMPRESA_ILUSTRATIVA = 'empresa-ilustrativa';
const OBRA_ILUSTRATIVA = 'reforma-escritorio-ilustrativa';

const form = document.querySelector('#entry-form');
const textInput = document.querySelector('#entry-text');
const photoInput = document.querySelector('#entry-photo');
const connectionStatus = document.querySelector('#connection-status');
const pendingCount = document.querySelector('#pending-count');
const entryList = document.querySelector('#entry-list');
const emptyState = document.querySelector('#empty-state');
const entryTemplate = document.querySelector('#entry-template');
const storageMessage = document.querySelector('#storage-message');
const simulatedBanner = document.querySelector('#simulated-banner');
const STATIC_MODE = window.MODO_ENVIO === 'estatico';
simulatedBanner.hidden = !STATIC_MODE;

let databasePromise;
let synchronizationPromise;

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new DOMException('A gravação local foi cancelada.', 'AbortError')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new DOMException('A gravação local falhou.', 'UnknownError')),
      { once: true },
    );
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });

  return databasePromise;
}

async function putEntry(entry) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestAsPromise(transaction.objectStore(STORE_NAME).put(entry));
  await transactionAsPromise(transaction);
}

async function getEntry(id) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestAsPromise(transaction.objectStore(STORE_NAME).get(id));
}

async function getEntries() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const entries = await requestAsPromise(transaction.objectStore(STORE_NAME).getAll());
  return entries.sort((left, right) => right.criado_em.localeCompare(left.criado_em));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

function setConnectionState(state) {
  const labels = {
    online: 'Online',
    offline: 'Sem internet',
    syncing: 'Sincronizando…',
  };
  connectionStatus.dataset.state = state;
  connectionStatus.textContent = labels[state];
}

function statusLabel(status) {
  return {
    pendente: 'Aguardando envio',
    enviando: 'Enviando…',
    enviado: STATIC_MODE ? 'Enviado (simulado)' : 'Enviado',
    conflito: 'Conflito',
  }[status];
}

async function renderEntries() {
  const entries = await getEntries();
  const fragment = document.createDocumentFragment();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  for (const entry of entries) {
    const item = entryTemplate.content.firstElementChild.cloneNode(true);
    item.dataset.entryId = entry.id;
    item.querySelector('.entry-text').textContent = entry.texto;
    item.querySelector('.entry-meta').textContent = `${formatter.format(new Date(entry.criado_em))} · 1 foto`;

    const status = item.querySelector('.sync-status');
    status.dataset.state = entry.status;
    status.textContent = statusLabel(entry.status);

    const error = item.querySelector('.entry-error');
    if (entry.ultimo_erro) {
      error.hidden = false;
      error.textContent = entry.ultimo_erro;
    }

    const retryButton = item.querySelector('.retry-button');
    retryButton.hidden = !['enviado', 'conflito'].includes(entry.status);
    retryButton.addEventListener('click', () => synchronizeEntry(entry.id, true));
    fragment.append(item);
  }

  entryList.replaceChildren(fragment);
  emptyState.hidden = entries.length > 0;
  const pending = entries.filter((entry) => entry.status !== 'enviado').length;
  pendingCount.textContent = `${pending} aguardando`;
}

function metadataPayload(entry) {
  return {
    id: entry.id,
    empresa_id: entry.empresa_id,
    obra_id: entry.obra_id,
    texto: entry.texto,
    criado_em: entry.criado_em,
    origem: entry.origem,
    versao_base: entry.versao_base,
    midias: entry.midias.map(({ id, nome, tipo, tamanho, sha256: hash }) => ({
      id,
      nome,
      tipo,
      tamanho,
      sha256: hash,
      chave_objeto: `${entry.empresa_id}/${entry.obra_id}/apontamentos/${entry.id}/${hash}`,
    })),
  };
}

async function uploadStaticReceipt(entry) {
  // Sem servidor: um GET sem cache de um recibo fixo. Só dá certo com rede.
  const response = await fetch(`recibo.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Falha ao enviar (simulado) (${response.status}).`);
  const body = await response.json();
  return { recibo: `${body.recibo}-${entry.id}`, versao: body.versao };
}

async function uploadMedia(media) {
  const response = await fetch(`api/v1/midias/${media.sha256}`, {
    method: 'PUT',
    headers: {
      'Content-Type': media.tipo,
      'Idempotency-Key': media.sha256,
      'X-File-Name': media.nome,
    },
    body: media.bytes,
  });

  if (!response.ok) {
    throw new Error(`Falha ao enviar a foto (${response.status}).`);
  }
}

async function uploadMetadata(entry) {
  const response = await fetch(`api/v1/apontamentos/${entry.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': entry.id,
    },
    body: JSON.stringify(metadataPayload(entry)),
  });

  if (response.status === 409) {
    const body = await response.json();
    const error = new Error('O servidor tem outra versão. Nada foi sobrescrito.');
    error.code = 'conflito';
    error.serverVersion = body.versao_servidor;
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Falha ao enviar o apontamento (${response.status}).`);
  }

  return response.json();
}

async function synchronizeEntry(id, force = false) {
  if (!navigator.onLine) {
    setConnectionState('offline');
    return;
  }

  const entry = await getEntry(id);
  if (!entry || (entry.status === 'enviado' && !force)) return;

  entry.status = 'enviando';
  entry.ultimo_erro = null;
  entry.tentativas += 1;
  await putEntry(entry);
  setConnectionState('syncing');
  await renderEntries();

  try {
    let receipt;
    if (STATIC_MODE) {
      receipt = await uploadStaticReceipt(entry);
    } else {
      for (const media of entry.midias) await uploadMedia(media);
      receipt = await uploadMetadata(entry);
    }
    entry.status = 'enviado';
    entry.recibo = receipt.recibo;
    entry.versao_servidor = receipt.versao;
    entry.ultimo_erro = null;
  } catch (error) {
    entry.status = error.code === 'conflito' ? 'conflito' : 'pendente';
    entry.ultimo_erro = error.message;
  }

  await putEntry(entry);
  await renderEntries();
  setConnectionState(navigator.onLine ? 'online' : 'offline');
}

async function synchronizePending() {
  if (synchronizationPromise) return synchronizationPromise;

  synchronizationPromise = (async () => {
    if (!navigator.onLine) {
      setConnectionState('offline');
      return;
    }

    const entries = await getEntries();
    for (const entry of entries) {
      if (entry.status !== 'enviado') await synchronizeEntry(entry.id);
    }
  })().finally(() => {
    synchronizationPromise = null;
  });

  return synchronizationPromise;
}

async function saveEntry(event) {
  event.preventDefault();
  const photo = photoInput.files?.[0];
  if (!photo) return;

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const id = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    const photoBytes = await photo.arrayBuffer();
    const hash = await sha256(photoBytes);
    const entry = {
      id,
      empresa_id: EMPRESA_ILUSTRATIVA,
      obra_id: OBRA_ILUSTRATIVA,
      texto: textInput.value.trim(),
      criado_em: new Date().toISOString(),
      origem: navigator.onLine ? 'online' : 'offline',
      versao_base: 0,
      status: 'pendente',
      tentativas: 0,
      ultimo_erro: null,
      midias: [
        {
          id: mediaId,
          nome: photo.name,
          tipo: photo.type || 'application/octet-stream',
          tamanho: photo.size,
          sha256: hash,
          bytes: photoBytes,
        },
      ],
    };

    await putEntry(entry);
    form.reset();
    await renderEntries();
    if (navigator.onLine) await synchronizePending();
  } catch (error) {
    storageMessage.textContent =
      error?.name === 'QuotaExceededError'
        ? 'O aparelho está sem espaço. Libere armazenamento antes de continuar.'
        : `Não foi possível salvar: ${error?.message ?? 'erro de armazenamento local'}`;
  } finally {
    submitButton.disabled = false;
  }
}

async function describeStorage() {
  if (!navigator.storage) return;

  try {
    const persistentBefore = await navigator.storage.persisted?.();
    const persistent = persistentBefore || (await navigator.storage.persist?.());
    const estimate = await navigator.storage.estimate?.();
    if (!estimate?.quota) return;

    const availableMegabytes = Math.max(0, Math.floor((estimate.quota - (estimate.usage ?? 0)) / 1024 / 1024));
    storageMessage.textContent = `Espaço estimado: ${availableMegabytes} MB · ${
      persistent ? 'armazenamento persistente' : 'armazenamento sujeito a limpeza do sistema'
    }`;
  } catch {
    storageMessage.textContent = 'Não foi possível consultar o espaço do aparelho.';
  }
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
    await navigator.serviceWorker.ready;
  } catch (error) {
    console.error('Falha ao preparar o modo offline.', error);
  }
}

form.addEventListener('submit', saveEntry);
window.addEventListener('online', () => synchronizePending());
window.addEventListener('offline', () => setConnectionState('offline'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') synchronizePending();
});

setInterval(() => {
  if (document.visibilityState === 'visible') synchronizePending();
}, 5_000);

await openDatabase();
await registerServiceWorker();
await describeStorage();
await renderEntries();
setConnectionState(navigator.onLine ? 'online' : 'offline');
await synchronizePending();
document.documentElement.dataset.appReady = 'true';
