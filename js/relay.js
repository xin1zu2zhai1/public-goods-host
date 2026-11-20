// 中継（リレー）通信。ブラウザ同士が直接つながらないとき（スマホのモバイル回線など）に使う。
// 中継路は2種類：
//  - PeerJS 中継：直接通信の仲介に使う PeerJS のサーバー（443番）に、メッセージそのものを転送してもらう
//  - MQTT 中継：公開の MQTT ブローカーに WebSocket(wss) でつなぎ、メッセージを中継してもらう
// 中身は端末ごとの鍵（ECDH P-256 → AES-GCM）で暗号化するので、ブローカーや第三者には読めない。
// ホスト側（public-goods-host）と参加者側（public-goods-game）で同じファイルを使う。
/* global mqtt, Peer */

const TOPIC_ROOT = 'pgg7f3k/v2';
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ 暗号まわり

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(len = 16) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return hex(a).slice(0, len * 2);
}

export async function topicBase(room) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(`pgg7f3k-room:${room}`));
  return `${TOPIC_ROOT}/${hex(h).slice(0, 24)}`;
}

export async function genKeys() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export async function exportPub(kp) {
  return b64(await crypto.subtle.exportKey('raw', kp.publicKey));
}

export async function deriveKey(privateKey, peerPubB64, salt) {
  const pub = await crypto.subtle.importKey('raw', unb64(peerPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode('pgg-relay-v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), d: b64(data) };
}

export async function unseal(key, m) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, key, unb64(m.d));
  return JSON.parse(dec.decode(plain));
}

function parse(payload) {
  try {
    const s = typeof payload === 'string' ? payload : dec.decode(payload);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function relayAvailable() {
  return typeof mqtt !== 'undefined' && Boolean(globalThis.crypto?.subtle);
}

/** ブローカーの短い名前（表示用）。例：wss://broker.emqx.io:8084/mqtt → emqx */
export function brokerLabel(url) {
  try {
    const u = new URL(url);
    if (/^[\d.]+$|^localhost$|^\[/.test(u.hostname)) return u.host;
    const parts = u.hostname.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : u.hostname;
  } catch {
    return String(url);
  }
}

function connectBroker(url, opts) {
  // URL に「ユーザー名:パスワード@」が入っていれば、接続の設定として渡す（例：shiftr.io の public:public）
  let target = url;
  const auth = {};
  try {
    const u = new URL(url);
    if (u.username) {
      auth.username = decodeURIComponent(u.username);
      auth.password = decodeURIComponent(u.password);
      u.username = '';
      u.password = '';
      target = u.toString();
    }
  } catch {
    /* そのまま使う */
  }
  return mqtt.connect(target, {
    protocolVersion: 4,
    clean: true,
    connectTimeout: 10000,
    keepalive: 30,
    ...auth,
    ...opts,
  });
}

// ------------------------------------------------------------------ やり取りの手順
//
// 参加者 → up      {c, q:1}                    問い合わせ（このルームのホストはいますか？）
// ホスト → dn/c    {pk, sid}                   ホストの公開鍵とセッションID
// 参加者 → up      {c, pk, sid, iv, d}         参加者の公開鍵と、暗号化した {t:'_open'}
// ホスト → dn/c    {iv, d}                     暗号化した {t:'_opened'}（以後はすべて暗号化）
// ホストが知らない相手から暗号文が届いたら {e:'rekey'} を返し、参加者はつなぎ直す。
// 「ルームあり」の印をブローカーに残す方式（retained）は、ブローカーによって消えたり残ったりするので使わない。

// ------------------------------------------------------------------ ホスト側

class RelayConn {
  constructor(hub, cid, key, client) {
    this.hub = hub;
    this.cid = cid;
    this.key = key;
    this.client = client;
    this.kind = 'relay';
    this.open = true;
    this.q = Promise.resolve();
  }

  send(msg) {
    if (!this.open) return;
    this._push(msg);
  }

  _push(msg) {
    const topic = `${this.hub.base}/dn/${this.cid}`;
    this.q = this.q
      .then(async () => {
        const s = await seal(this.key, msg);
        this.client.publish(topic, JSON.stringify(s), { qos: 1 });
      })
      .catch((e) => console.warn('relay send failed', e));
  }

  close() {
    if (!this.open) return;
    this._push({ t: '_bye' });
    this._drop();
  }

  _drop() {
    if (!this.open) return;
    this.open = false;
    if (this.hub.conns.get(this.cid) === this) this.hub.conns.delete(this.cid);
    this.hub.opts.onClose?.(this);
  }
}

export class RelayHost {
  /**
   * @param {object} opts
   * @param {string} opts.room
   * @param {string[]} opts.brokers
   * @param {(s:{connected:number,total:number,brokers:{label:string,connected:boolean}[]})=>void} opts.onStatus
   * @param {(conn:RelayConn,msg:any)=>void} opts.onMessage
   * @param {(conn:RelayConn)=>void} opts.onClose
   */
  constructor(opts) {
    this.opts = opts;
    this.conns = new Map();
    this.clients = [];
    this.q = Promise.resolve();
    this.stopped = false;
  }

  async start() {
    if (!relayAvailable()) {
      this.opts.onStatus?.({ connected: 0, total: 0, brokers: [] });
      return;
    }
    this.base = await topicBase(this.opts.room);
    this.keys = await genKeys();
    this.pub = await exportPub(this.keys);
    this.sid = randomId(8);
    if (this.stopped) return;
    for (const url of this.opts.brokers) this._connect(url);
    this._status();
  }

  _status() {
    const brokers = this.clients.map((c) => ({ label: brokerLabel(c.pggUrl), connected: Boolean(c.connected && c.pggSubscribed) }));
    this.opts.onStatus?.({ connected: brokers.filter((b) => b.connected).length, total: brokers.length, brokers });
  }

  _connect(url) {
    const client = connectBroker(url, { clientId: `pggh${randomId(8)}`, reconnectPeriod: 4000 });
    client.pggUrl = url;
    client.pggSubscribed = false;
    this.clients.push(client);
    client.on('connect', () => {
      client.pggSubscribed = false;
      client.subscribe(`${this.base}/up`, { qos: 1 }, (err) => {
        client.pggSubscribed = !err;
        this._status();
      });
      this._status();
    });
    client.on('message', (topic, payload) => {
      this.q = this.q.then(() => this._onUp(client, payload)).catch((e) => console.warn('relay recv failed', e));
    });
    client.on('close', () => this._status());
    client.on('offline', () => this._status());
    client.on('error', (e) => console.warn('relay broker error', url, e?.message));
  }

  _reply(client, cid, obj) {
    client.publish(`${this.base}/dn/${cid}`, JSON.stringify(obj), { qos: 1 });
  }

  async _onUp(client, payload) {
    const m = parse(payload);
    if (!m || typeof m.c !== 'string' || !/^[0-9a-f]{16,64}$/.test(m.c)) return;
    // 問い合わせ：公開鍵を返す
    if (m.q) {
      this._reply(client, m.c, { pk: this.pub, sid: this.sid });
      return;
    }
    if (typeof m.iv !== 'string' || typeof m.d !== 'string') return;
    let conn = this.conns.get(m.c);
    if (typeof m.pk === 'string') {
      if (m.sid !== this.sid) {
        this._reply(client, m.c, { pk: this.pub, sid: this.sid });
        return;
      }
      const key = await deriveKey(this.keys.privateKey, m.pk, `${this.sid}:${m.c}`);
      let first;
      try {
        first = await unseal(key, m);
      } catch {
        return;
      }
      if (first?.t !== '_open') return;
      if (conn) conn._drop();
      conn = new RelayConn(this, m.c, key, client);
      this.conns.set(m.c, conn);
      conn.send({ t: '_opened' });
      return;
    }
    if (!conn) {
      this._reply(client, m.c, { e: 'rekey' });
      return;
    }
    conn.client = client;
    let msg;
    try {
      msg = await unseal(conn.key, m);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === '_bye') {
      conn._drop();
      return;
    }
    this.opts.onMessage?.(conn, msg);
  }

  destroy() {
    this.stopped = true;
    for (const conn of [...this.conns.values()]) conn.close();
    for (const c of this.clients) {
      try {
        c.end(false);
      } catch {
        /* ignore */
      }
    }
    this.clients = [];
    this.conns.clear();
  }
}

// ------------------------------------------------------------------ 参加者側

const PROBE_EVERY = 1500;
const PROBE_GIVE_UP = 6000;

/**
 * 中継でホストにつなぐ。すべてのブローカーに同時に問い合わせ、最初に応答したところを使う。
 * つながったら channel を返す。channel: { kind, send(msg):boolean, close(), onmessage, onclose }
 * つながらなかったときの Error には relay.brokers（ブローカーごとの状況）が付く。
 */
export function dialRelay({ room, brokers, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    if (!relayAvailable() || !brokers.length) {
      reject(new Error('relay-unavailable'));
      return;
    }
    let settled = false;
    const clients = [];
    const cid = randomId(16);
    let base;
    // ブローカーごとの状況（原因の表示用）。state: connecting | connected | failed
    const report = brokers.map((url) => ({ label: brokerLabel(url), state: 'connecting', host: false, error: '' }));
    const timer = setTimeout(() => finish(null, new Error('timeout')), timeout);

    function summary() {
      return {
        total: report.length,
        connected: report.filter((r) => r.state === 'connected' || r.wasConnected).length,
        presence: report.filter((r) => r.host).length,
        brokers: report.map(({ label, state, host, error, wasConnected }) => ({ label, connected: state === 'connected' || Boolean(wasConnected), host, error })),
      };
    }

    function finish(winner, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of clients) {
        if (c !== winner?.client) {
          try {
            c.end(true);
          } catch {
            /* ignore */
          }
        }
      }
      if (winner) resolve(makeChannel(winner));
      else reject(Object.assign(err, { relay: summary() }));
    }

    function checkAllFailed() {
      if (report.every((r) => r.state === 'failed')) finish(null, new Error('no-host'));
    }

    function makeChannel({ client, session }) {
      let q = Promise.resolve();
      const ch = {
        kind: 'relay',
        broker: brokerLabel(client.pggUrl),
        closed: false,
        onmessage: null,
        onclose: null,
        send(msg) {
          if (ch.closed || !client.connected) return false;
          q = q
            .then(async () => {
              const s = await seal(session.key, msg);
              client.publish(`${base}/up`, JSON.stringify({ c: cid, ...s }), { qos: 1 });
            })
            .catch(() => {});
          return true;
        },
        close() {
          if (ch.closed) return;
          ch.send({ t: '_bye' });
          ch.closed = true;
          q.finally(() => {
            try {
              client.end(false);
            } catch {
              /* ignore */
            }
          });
        },
      };
      const lost = () => {
        if (ch.closed) return;
        ch.closed = true;
        try {
          client.end(true);
        } catch {
          /* ignore */
        }
        ch.onclose?.();
      };
      client.pggOnLost = lost;
      client.pggOnMessage = (msg) => {
        if (msg.t === '_bye') lost();
        else if (msg.t !== '_opened') ch.onmessage?.(msg);
      };
      client.pggSessionId = session.sid;
      return ch;
    }

    topicBase(room).then((b) => {
      base = b;
      brokers.forEach((url, idx) => {
        if (settled) return;
        const r = report[idx];
        const client = connectBroker(url, { clientId: `pggp${randomId(8)}`, reconnectPeriod: 0 });
        client.pggUrl = url;
        clients.push(client);
        let session = null;
        let rq = Promise.resolve();
        let probeTimer = null;
        const fail = (why) => {
          clearInterval(probeTimer);
          if (client.pggOnLost || r.state === 'failed') return;
          if (r.state === 'connected') r.wasConnected = true;
          r.state = 'failed';
          if (why && !r.error) r.error = why;
          checkAllFailed();
        };
        client.on('connect', () => {
          r.state = 'connected';
          client.subscribe(`${base}/dn/${cid}`, { qos: 1 }, (err) => {
            if (err) {
              fail('subscribe');
              return;
            }
            // ホストに問い合わせる。返事がなければ、このブローカーにはホストがいない。
            const started = Date.now();
            const probe = () => {
              if (session || settled) {
                clearInterval(probeTimer);
                return;
              }
              if (Date.now() - started > PROBE_GIVE_UP) {
                fail('no-host');
                return;
              }
              client.publish(`${base}/up`, JSON.stringify({ c: cid, q: 1 }), { qos: 1 });
            };
            probe();
            probeTimer = setInterval(probe, PROBE_EVERY);
          });
        });
        client.on('message', (topic, payload) => {
          rq = rq
            .then(async () => {
              const m = parse(payload);
              if (!m) return;
              if (typeof m.pk === 'string' && typeof m.sid === 'string') {
                // ホストの返事（公開鍵）。つながった後に sid が変わったら、ホストが開き直した。
                if (client.pggOnLost) {
                  if (m.sid !== client.pggSessionId) client.pggOnLost();
                  return;
                }
                r.host = true;
                if (session?.sid === m.sid) return;
                clearInterval(probeTimer);
                const kp = await genKeys();
                session = { sid: m.sid, key: await deriveKey(kp.privateKey, m.pk, `${m.sid}:${cid}`) };
                const s = await seal(session.key, { t: '_open' });
                client.publish(`${base}/up`, JSON.stringify({ c: cid, pk: await exportPub(kp), sid: m.sid, ...s }), { qos: 1 });
                return;
              }
              if (m.e === 'rekey') {
                if (client.pggOnLost) client.pggOnLost();
                return;
              }
              if (!session || typeof m.iv !== 'string') return;
              let msg;
              try {
                msg = await unseal(session.key, m);
              } catch {
                return;
              }
              if (client.pggOnMessage) client.pggOnMessage(msg);
              else if (msg?.t === '_opened') finish({ client, session });
            })
            .catch(() => {});
        });
        client.on('close', () => {
          if (client.pggOnLost) client.pggOnLost();
          else fail(r.state === 'connecting' ? 'connect' : 'closed');
        });
        client.on('error', (e) => {
          if (!r.error) r.error = e?.message || 'error';
        });
      });
    }, reject);
  });
}

// ================================================================== PeerJS 中継
// PeerJS のサーバーは、接続の仲介メッセージ（type: CANDIDATE など）の payload を見ずに相手へ転送する。
// それを使って、暗号化したメッセージを運ぶ。payload に connectionId を付けないので、PeerJS 本体は無視する。
//
// 参加者 → ホスト  {pgg:'q'}                         問い合わせ
// ホスト → 参加者  {pgg:'k', pk, sid}                ホストの公開鍵
// 参加者 → ホスト  {pgg:'o', pk, sid, iv, d}         参加者の公開鍵と暗号化した {t:'_open'}
// 双方            {pgg:'m', iv, d}                  暗号化したメッセージ
// ホスト → 参加者  {pgg:'rekey'}                     知らない相手（ホストが開き直した）→ つなぎ直す

const SIG_TYPE = 'CANDIDATE';

function sigSend(peer, dst, payload) {
  try {
    peer?.socket?.send({ type: SIG_TYPE, dst, payload });
    return true;
  } catch {
    return false;
  }
}

class SignalConn {
  constructor(hub, id, key) {
    this.hub = hub;
    this.id = id;
    this.key = key;
    this.kind = 'sig';
    this.open = true;
    this.q = Promise.resolve();
  }

  send(msg) {
    if (!this.open) return;
    this._push(msg);
  }

  _push(msg) {
    this.q = this.q
      .then(async () => sigSend(this.hub.peer, this.id, { pgg: 'm', ...(await seal(this.key, msg)) }))
      .catch((e) => console.warn('sig send failed', e));
  }

  close() {
    if (!this.open) return;
    this._push({ t: '_bye' });
    this._drop();
  }

  _drop() {
    if (!this.open) return;
    this.open = false;
    if (this.hub.conns.get(this.id) === this) this.hub.conns.delete(this.id);
    this.hub.opts.onClose?.(this);
  }
}

/** ホスト側：PeerJS のサーバー経由で届く中継メッセージを受ける */
export class SignalHost {
  /**
   * @param {object} opts
   * @param {(conn:SignalConn,msg:any)=>void} opts.onMessage
   * @param {(conn:SignalConn)=>void} opts.onClose
   */
  constructor(opts) {
    this.opts = opts;
    this.conns = new Map();
    this.peer = null;
    this.q = Promise.resolve();
    this.ready = globalThis.crypto?.subtle
      ? (async () => {
          this.keys = await genKeys();
          this.pub = await exportPub(this.keys);
          this.sid = randomId(8);
        })()
      : Promise.reject(new Error('no-crypto'));
    this.ready.catch(() => {});
  }

  /** HostNet が Peer を作るたびに呼ぶ */
  attach(peer) {
    this.peer = peer;
    const sock = peer?.socket;
    if (!sock?.on) return;
    sock.on('message', (m) => {
      if (peer !== this.peer || !m || m.type !== SIG_TYPE || typeof m.src !== 'string' || m.src.length > 80) return;
      const p = m.payload;
      if (!p || typeof p.pgg !== 'string') return;
      this.q = this.q.then(() => this._on(m.src, p)).catch((e) => console.warn('sig recv failed', e));
    });
  }

  async _on(src, p) {
    await this.ready;
    if (p.pgg === 'q') {
      sigSend(this.peer, src, { pgg: 'k', pk: this.pub, sid: this.sid });
      return;
    }
    if (typeof p.iv !== 'string' || typeof p.d !== 'string') return;
    if (p.pgg === 'o') {
      if (p.sid !== this.sid || typeof p.pk !== 'string') {
        sigSend(this.peer, src, { pgg: 'k', pk: this.pub, sid: this.sid });
        return;
      }
      const key = await deriveKey(this.keys.privateKey, p.pk, `${this.sid}:${src}`);
      let first;
      try {
        first = await unseal(key, p);
      } catch {
        return;
      }
      if (first?.t !== '_open') return;
      this.conns.get(src)?._drop();
      const conn = new SignalConn(this, src, key);
      this.conns.set(src, conn);
      conn.send({ t: '_opened' });
      return;
    }
    if (p.pgg === 'm') {
      const conn = this.conns.get(src);
      if (!conn) {
        sigSend(this.peer, src, { pgg: 'rekey' });
        return;
      }
      let msg;
      try {
        msg = await unseal(conn.key, p);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === '_bye') {
        conn._drop();
        return;
      }
      this.opts.onMessage?.(conn, msg);
    }
  }

  destroy() {
    for (const conn of [...this.conns.values()]) conn.close();
    this.conns.clear();
    this.peer = null;
  }
}

const FATAL_PEER_ERRORS = ['server-error', 'socket-error', 'socket-closed', 'network', 'browser-incompatible', 'invalid-id', 'invalid-key', 'unavailable-id', 'ssl-unavailable', 'disconnected'];

/** Peer が PeerJS のサーバーにつながるのを待つ（つながっていればすぐ返る） */
export function peerReady(peer, timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!peer) {
      reject(new Error('no-peer'));
      return;
    }
    if (peer.open) {
      resolve(peer);
      return;
    }
    if (peer.destroyed || peer.disconnected) {
      reject(Object.assign(new Error('server-error'), { type: 'server-error' }));
      return;
    }
    const done = (err) => {
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', onError);
      if (err) reject(err);
      else resolve(peer);
    };
    const onOpen = () => done();
    const onError = (e) => {
      if (FATAL_PEER_ERRORS.includes(e?.type)) done(Object.assign(new Error(e.type), { type: e.type, detail: String(e?.message || '') }));
    };
    const timer = setTimeout(() => done(Object.assign(new Error('server-timeout'), { type: 'server-timeout' })), timeout);
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

/**
 * 参加者側：PeerJS のサーバー経由でホストにつなぐ。つながったら channel を返す。
 * peer は直接通信と共用する（サーバーへの接続を1本にするため）。peer の後始末は呼び出し側が行う。
 */
export function dialSignal({ hostId, peer, timeout = 14000 }) {
  return new Promise((resolve, reject) => {
    if (!peer || !globalThis.crypto?.subtle) {
      reject(new Error('sig-unavailable'));
      return;
    }
    let settled = false;
    let session = null;
    let ch = null;
    let rq = Promise.resolve();
    let probeTimer = null;
    const sock = peer.socket;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(probeTimer);
      sock?.off?.('message', onMessage);
      peer.off('error', onError);
      peer.off('disconnected', onDisconnected);
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('timeout')), timeout);
    const send = (payload) => sigSend(peer, hostId, payload);
    const lost = () => {
      if (!ch || ch.closed) return;
      ch.closed = true;
      cleanup();
      ch.onclose?.();
    };
    const onError = (e) => {
      if (!settled) {
        if (e?.type === 'peer-unavailable' || FATAL_PEER_ERRORS.includes(e?.type)) fail(Object.assign(new Error(e.type), { type: e.type, detail: String(e?.message || '') }));
      } else if (e?.type === 'peer-unavailable' || FATAL_PEER_ERRORS.includes(e?.type)) lost();
    };
    const onDisconnected = () => {
      if (settled) lost();
      else fail(Object.assign(new Error('network'), { type: 'network' }));
    };
    const onMessage = (m) => {
      if (!m || m.type !== SIG_TYPE || m.src !== hostId || !m.payload || typeof m.payload.pgg !== 'string') return;
      const p = m.payload;
      rq = rq
        .then(async () => {
          if (p.pgg === 'k' && typeof p.pk === 'string' && typeof p.sid === 'string') {
            if (ch) {
              if (p.sid !== session.sid) lost();
              return;
            }
            if (settled || session?.sid === p.sid) return;
            const kp = await genKeys();
            session = { sid: p.sid, key: await deriveKey(kp.privateKey, p.pk, `${p.sid}:${peer.id}`) };
            send({ pgg: 'o', pk: await exportPub(kp), sid: p.sid, ...(await seal(session.key, { t: '_open' })) });
            return;
          }
          if (p.pgg === 'rekey') {
            lost();
            return;
          }
          if (p.pgg !== 'm' || !session || typeof p.iv !== 'string') return;
          let msg;
          try {
            msg = await unseal(session.key, p);
          } catch {
            return;
          }
          if (!msg || typeof msg !== 'object') return;
          if (!ch) {
            if (msg.t === '_opened' && !settled) {
              settled = true;
              clearTimeout(timer);
              clearInterval(probeTimer);
              ch = makeChannel();
              resolve(ch);
            }
            return;
          }
          if (msg.t === '_bye') lost();
          else if (msg.t !== '_opened') ch.onmessage?.(msg);
        })
        .catch(() => {});
    };
    peer.on('error', onError);
    peer.on('disconnected', onDisconnected);
    sock?.on?.('message', onMessage);

    peerReady(peer, timeout).then(
      () => {
        if (settled) return;
        const started = Date.now();
        const probe = () => {
          if (session || settled) {
            clearInterval(probeTimer);
            return;
          }
          if (Date.now() - started > 8000) {
            fail(new Error('no-reply'));
            return;
          }
          send({ pgg: 'q' });
        };
        probe();
        probeTimer = setInterval(probe, 1500);
      },
      (e) => fail(e),
    );

    function makeChannel() {
      let q = Promise.resolve();
      const c = {
        kind: 'sig',
        closed: false,
        onmessage: null,
        onclose: null,
        send(msg) {
          if (c.closed || peer.disconnected || peer.destroyed) return false;
          q = q.then(async () => send({ pgg: 'm', ...(await seal(session.key, msg)) })).catch(() => {});
          return true;
        },
        close() {
          if (c.closed) return;
          c.send({ t: '_bye' });
          c.closed = true;
          cleanup();
        },
      };
      return c;
    }
  });
}
