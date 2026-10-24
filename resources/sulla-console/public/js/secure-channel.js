// ═══════════════════════════════════════════════════════════════════
// SECURE DESKTOP CHANNEL — browser client
//
// Talks to ONE of your Sulla Desktops through Sulla Cloud without the cloud
// (or anyone holding your login) being able to command it:
//
//   • This browser holds its own Ed25519 key (WebCrypto, non-extractable,
//     kept in IndexedDB). The private key never leaves this browser.
//   • The first time, the desktop shows a native "Allow?" dialog with a
//     6-digit code; this page shows the same code. You approve it at the
//     desktop. Only then will the desktop accept this browser's commands.
//   • Every command is signed ({v, deviceId, clientId, ts, nonce, body}),
//     so the relay can't forge or replay one.
//   • Sockets open with a single-use 60-second ticket; your access token
//     never goes in a WebSocket URL.
//
// Usage:
//   const ch = await SullaSecureChannel.connect(deviceId);
//   ch.on('frame', f => …);            // everything the desktop sends
//   ch.on('status', s => …);           // 'connecting' | 'online' | 'desktop_offline' | 'closed'
//   await ch.ensurePaired(onCode);     // shows onCode('123456') while waiting
//   ch.send({ type: 'chat', conversationId, userMessageId, messages });
//   const res = await ch.companion('projects.list', {});
//
// Requires SullaAuth (js/sulla-auth.js).
// ═══════════════════════════════════════════════════════════════════

window.SullaSecureChannel = (function () {
  'use strict';

  const DB_NAME = 'sulla-secure-channel';
  const STORE = 'keys';
  const KEY_ID = 'client-ed25519-v1';

  // ── Encoding helpers ───────────────────────────────────────────
  function b64(bytes) {
    let s = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }
  function hex(bytes) {
    return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function sha256(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }

  // ── Key storage (IndexedDB keeps CryptoKey objects as-is) ─────
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function dbPut(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  let identityPromise = null;

  /** Browser identity: { privateKey, publicKeyB64, clientId }. */
  function getIdentity() {
    if (identityPromise) return identityPromise;
    identityPromise = (async () => {
      if (!window.crypto?.subtle) throw new Error('This browser has no WebCrypto. Use an up-to-date Chrome, Safari, Edge or Firefox.');
      let stored = await dbGet(KEY_ID).catch(() => null);
      if (!stored) {
        let pair;
        try {
          // extractable=false: the private key can sign but can never be read out.
          pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        } catch (e) {
          throw new Error('This browser can\'t create a secure pairing key (Ed25519). Update to Chrome 113+, Safari 17+, Edge 113+ or Firefox 129+.');
        }
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        stored = { privateKey: pair.privateKey, publicKeyB64: b64(raw), createdAt: new Date().toISOString() };
        await dbPut(KEY_ID, stored);
      }
      const raw = Uint8Array.from(atob(stored.publicKeyB64), c => c.charCodeAt(0));
      const clientId = hex(await sha256(raw)).slice(0, 32);
      return { privateKey: stored.privateKey, publicKeyB64: stored.publicKeyB64, clientId };
    })();
    identityPromise.catch(() => { identityPromise = null; });
    return identityPromise;
  }

  /** Must match desktop secureChannelProtocol.pairingCode. */
  async function pairingCode(deviceId, publicKeyB64) {
    const h = await sha256(`sulla-pair-v1|${deviceId}|${publicKeyB64}`);
    const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
    return String(n % 1000000).padStart(6, '0');
  }

  function browserLabel() {
    const ua = navigator.userAgent || '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${browser}${os ? ' on ' + os : ''} (sulladesktop.com)`;
  }

  // ── Channel ────────────────────────────────────────────────────
  class Channel {
    constructor(deviceId, identity) {
      this.deviceId = deviceId;
      this.identity = identity;
      this.ws = null;
      this.handlers = {};
      this.pending = new Map(); // requestId → { resolve, reject, timer }
      this.status = 'connecting';
      this.closedByUser = false;
      this.retry = 1000;
    }

    on(event, fn) { (this.handlers[event] ||= []).push(fn); return () => this.off(event, fn); }
    off(event, fn) { this.handlers[event] = (this.handlers[event] || []).filter(f => f !== fn); }
    emit(event, arg) { for (const fn of this.handlers[event] || []) { try { fn(arg); } catch (e) { console.error(e); } } }

    setStatus(s) { this.status = s; this.emit('status', s); }

    async open() {
      this.setStatus('connecting');
      const res = await SullaAuth.request('/desktop-channel/tickets', {
        method: 'POST',
        body: JSON.stringify({ deviceId: this.deviceId, role: 'client', clientId: this.identity.clientId, surface: 'web' }),
      });
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(res.url);
        this.ws = ws;
        const t = setTimeout(() => reject(new Error('Connection timed out')), 10000);
        ws.onmessage = (ev) => {
          let f; try { f = JSON.parse(ev.data); } catch { return; }
          if (f.type === 'connected') {
            clearTimeout(t);
            this.retry = 1000;
            this.setStatus(f.desktopOnline ? 'online' : 'desktop_offline');
            resolve();
            return;
          }
          this.onFrame(f);
        };
        ws.onclose = (ev) => {
          clearTimeout(t);
          this.failPending(new Error('Connection closed'));
          if (this.ws !== ws) return;
          this.ws = null;
          if (ev.reason === 'client_revoked' || ev.reason === 'device_revoked') {
            this.setStatus(ev.reason);
            return;
          }
          this.setStatus('closed');
          if (!this.closedByUser) this.scheduleReconnect();
          reject(new Error('Connection closed'));
        };
        ws.onerror = () => { /* onclose follows */ };
      });
      this.ping = setInterval(() => { try { this.ws?.send('{"type":"ping"}'); } catch {} }, 20000);
    }

    scheduleReconnect() {
      clearInterval(this.ping);
      const delay = this.retry;
      this.retry = Math.min(this.retry * 2, 30000);
      setTimeout(() => { if (!this.closedByUser) this.open().catch(() => {}); }, delay);
    }

    onFrame(f) {
      if (f.type === 'pong') return;
      if (f.type === 'desktop_online') { this.setStatus('online'); return; }
      if (f.type === 'desktop_offline') { this.setStatus('desktop_offline'); return; }
      if (f.type === 'companion_response' && this.pending.has(f.requestId)) {
        const p = this.pending.get(f.requestId);
        this.pending.delete(f.requestId);
        clearTimeout(p.timer);
        if (f.error) p.reject(new Error(f.error)); else p.resolve(f.result);
        return;
      }
      if (f.type === 'error' && f.reason === 'client_not_approved') {
        try { localStorage.removeItem(pairedKey(this.deviceId)); } catch {}
        this.emit('needs_pairing', f);
      }
      this.emit('frame', f);
    }

    failPending(err) {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    }

    isPairedHint() {
      try { return localStorage.getItem(pairedKey(this.deviceId)) === this.identity.clientId; } catch { return false; }
    }

    /**
     * Ask the desktop owner to approve this browser. Resolves true when the
     * owner clicks Allow at the desktop. `onCode(code)` is called with the
     * 6-digit code to show while waiting.
     */
    ensurePaired(onCode) {
      if (this.isPairedHint()) return Promise.resolve(true);
      return new Promise((resolve, reject) => {
        const off = this.on('frame', (f) => {
          // Never display a code that came back through the relay: a
          // compromised relay could echo an attacker's code. The only code
          // worth comparing is the one computed here from OUR public key.
          if (f.type === 'pair_pending') return;
          if (f.type === 'pair_result') {
            off();
            if (f.approved) {
              try { localStorage.setItem(pairedKey(this.deviceId), this.identity.clientId); } catch {}
              resolve(true);
            } else {
              const why = { pairing_busy: 'Another approval is already waiting on that desktop.', remote_access_disabled: 'Remote access is turned off on that desktop.' }[f.reason];
              reject(new Error(why || 'The request was denied at the desktop.'));
            }
          }
          if (f.type === 'error' && f.reason === 'desktop_offline') { off(); reject(new Error('That desktop is offline.')); }
        });
        pairingCode(this.deviceId, this.identity.publicKeyB64).then(c => onCode?.(c));
        this.raw({ type: 'pair_request', publicKey: this.identity.publicKeyB64, label: browserLabel() });
      });
    }

    raw(obj) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected to the desktop');
      this.ws.send(JSON.stringify(obj));
    }

    /** Send a signed command (chat | inject | cancel | companion_request). */
    async send(body) {
      const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
      const signed = JSON.stringify({ v: 1, deviceId: this.deviceId, clientId: this.identity.clientId, ts: Date.now(), nonce, body });
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, this.identity.privateKey, new TextEncoder().encode(signed));
      this.raw({ type: 'signed', signed, sig: b64(sig) });
    }

    /** Read-only desktop queries (projects, conversations, heartbeat…). */
    companion(method, params = {}, timeoutMs = 20000) {
      const requestId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The desktop did not answer in time.')); }, timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
        this.send({ type: 'companion_request', requestId, method, params }).catch((e) => {
          clearTimeout(timer); this.pending.delete(requestId); reject(e);
        });
      });
    }

    close() {
      this.closedByUser = true;
      clearInterval(this.ping);
      try { this.ws?.close(); } catch {}
      this.ws = null;
    }
  }

  const WRAP_KEY_ID = 'conversation-rsa-oaep-v1';
  async function wrappingIdentity() {
    let pair = await dbGet(WRAP_KEY_ID).catch(() => null);
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, false, ['encrypt','decrypt']);
      await dbPut(WRAP_KEY_ID, pair);
    }
    return pair;
  }
  async function conversationWrapRequest() {
    const pair = await wrappingIdentity();
    return crypto.subtle.exportKey('jwk', pair.publicKey);
  }
  async function unwrapConversationKey(wrapped) {
    const pair = await wrappingIdentity();
    return crypto.subtle.decrypt({ name: 'RSA-OAEP' }, pair.privateKey, Uint8Array.from(atob(wrapped), c => c.charCodeAt(0)));
  }
  // Linked-chat AES keys are kept as non-extractable CryptoKeys so a reply can
  // still be sealed for a confirmed Cloud fallback while the Desktop is offline.
  const conversationKeyId = linkId => `conversation-key-v1:${linkId}`;
  function savedConversationKey(linkId) { return dbGet(conversationKeyId(linkId)).catch(() => null); }
  function rememberConversationKey(linkId, key) { return dbPut(conversationKeyId(linkId), key); }
  async function forgetConversationKey(linkId) {
    const db = await openDb();
    await new Promise((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(conversationKeyId(linkId)); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  function pairedKey(deviceId) { return `sulla_paired_${deviceId}`; }

  const channels = new Map();

  /** One shared channel per desktop per page. */
  async function connect(deviceId) {
    if (channels.has(deviceId)) return channels.get(deviceId);
    const p = (async () => {
      const identity = await getIdentity();
      const ch = new Channel(deviceId, identity);
      await ch.open();
      return ch;
    })();
    channels.set(deviceId, p);
    p.catch(() => channels.delete(deviceId));
    return p;
  }

  /**
   * Show the pairing modal (code + instructions) around ensurePaired().
   * Resolves true when approved; false if the user cancels.
   */
  function pairWithModal(ch, desktopName) {
    if (ch.isPairedHint()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'sc-modal-overlay';
      overlay.innerHTML = `
        <div class="sc-modal" role="dialog" aria-modal="true" aria-labelledby="sc-title">
          <h3 id="sc-title"><span class="material-symbols-outlined">lock</span> Approve this browser on your desktop</h3>
          <p>So that only you can control <strong></strong>, Sulla is asking for your OK <em>on that computer</em>.</p>
          <ol>
            <li>Go to the desktop. A dialog titled “Allow remote access to this desktop?” is open.</li>
            <li>Check that it shows this code:</li>
          </ol>
          <div class="sc-code" aria-live="polite">······</div>
          <ol start="3"><li>Click <strong>Allow</strong> there. This page continues on its own.</li></ol>
          <p class="sc-err hidden"></p>
          <div class="sc-actions"><button class="btn btn-ghost" type="button">Cancel</button></div>
        </div>`;
      overlay.querySelector('strong').textContent = desktopName || 'your desktop';
      document.body.appendChild(overlay);
      const codeEl = overlay.querySelector('.sc-code');
      const errEl = overlay.querySelector('.sc-err');
      let done = false;
      const finish = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
      overlay.querySelector('.sc-actions button').addEventListener('click', () => finish(false));
      ch.ensurePaired((code) => { codeEl.textContent = `${code.slice(0, 3)} ${code.slice(3)}`; })
        .then(() => finish(true))
        .catch((e) => {
          errEl.textContent = e.message;
          errEl.classList.remove('hidden');
          overlay.querySelector('.sc-actions button').textContent = 'Close';
        });
    });
  }

  return { connect, getIdentity, pairingCode, pairWithModal, conversationWrapRequest, unwrapConversationKey, savedConversationKey, rememberConversationKey, forgetConversationKey };
})();

// ═══════════════════════════════════════════════════════════════════
// Signed commands from Cloud dashboard screens (agents, workflows, …) to a
// paired Desktop. Same browser identity and pairing as everything above;
// the Desktop verifies the signature, its local approval and revocation.
//   const r = await CloudDesktopChannel.send(deviceId, { type: 'agent.stop', jobId });
// Resolves with the Desktop's {type:'command_result', ok, …}; rejects on
// denial, errors, ok:false or timeout.
// ═══════════════════════════════════════════════════════════════════
window.CloudDesktopChannel = (function () {
  'use strict';
  async function send(deviceId, body, { name, timeoutMs = 30000 } = {}) {
    const ch = await window.SullaSecureChannel.connect(deviceId);
    if (!(await window.SullaSecureChannel.pairWithModal(ch, name))) throw new Error('This browser was not approved on the desktop.');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(timer); off(); fn(value); };
      const timer = setTimeout(() => finish(reject, new Error('The desktop did not answer in time.')), timeoutMs);
      const off = ch.on('frame', (f) => {
        if (f.type === 'command_result' && f.requestId === requestId) {
          if (f.ok === false) finish(reject, new Error(f.error || f.message || 'The desktop rejected the request.'));
          else finish(resolve, f);
        } else if (f.type === 'error') {
          finish(reject, new Error({ desktop_offline: 'That desktop is offline.', remote_access_disabled: 'Remote access is turned off on that desktop.' }[f.reason] || f.message || 'The desktop rejected the request.'));
        }
      });
      ch.send({ ...body, requestId }).catch((e) => finish(reject, e));
    });
  }
  return { send };
})();
