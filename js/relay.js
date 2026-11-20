// 中継（リレー）通信。ブラウザ同士が直接つながらないとき（スマホのモバイル回線など）に使う。
// 公開の MQTT ブローカーに WebSocket(wss) でつなぎ、ホストと参加者のメッセージを中継してもらう。
// 中身は端末ごとの鍵（ECDH P-256 → AES-GCM）で暗号化するので、ブローカーや第三者には読めない。
// ホスト側（public-goods-host）と参加者側（public-goods-game）で同じファイルを使う。
/* global mqtt */

const TOPIC_ROOT = 'pgg7f3k/v1';
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

async function genKeys() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

async function exportPub(kp) {
  return b64(await crypto.subtle.exportKey('raw', kp.publicKey));
}

async function deriveKey(privateKey, peerPubB64, salt) {
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

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), d: b64(data) };
}

async function unseal(key, m) {
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

function connectBroker(url, opts) {
  return mqtt.connect(url, {
    protocolVersion: 4,
    clean: true,
    connectTimeout: 10000,
    keepalive: 30,
    ...opts,
  });
}

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
   * @param {(s:{connected:number,total:number})=>void} opts.onStatus
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
      this.opts.onStatus?.({ connected: 0, total: 0 });
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
    this.opts.onStatus?.({ connected: this.clients.filter((c) => c.connected).length, total: this.clients.length });
  }

  _connect(url) {
    const presence = `${this.base}/host`;
    const client = connectBroker(url, {
      clientId: `pggh${randomId(8)}`,
      reconnectPeriod: 4000,
      will: { topic: presence, payload: '', retain: true, qos: 1 },
    });
    client.pggUrl = url;
    this.clients.push(client);
    client.on('connect', () => {
      client.subscribe(`${this.base}/up`, { qos: 1 });
      client.publish(presence, JSON.stringify({ pk: this.pub, sid: this.sid, t: Date.now() }), { retain: true, qos: 1 });
      this._status();
    });
    client.on('message', (topic, payload) => {
      this.q = this.q.then(() => this._onUp(client, payload)).catch((e) => console.warn('relay recv failed', e));
    });
    client.on('close', () => this._status());
    client.on('offline', () => this._status());
    client.on('error', (e) => console.warn('relay broker error', url, e?.message));
  }

  async _onUp(client, payload) {
    const m = parse(payload);
    if (!m || typeof m.c !== 'string' || !/^[0-9a-f]{16,64}$/.test(m.c) || typeof m.iv !== 'string' || typeof m.d !== 'string') return;
    let conn = this.conns.get(m.c);
    if (typeof m.pk === 'string') {
      if (m.sid !== this.sid) {
        client.publish(`${this.base}/dn/${m.c}`, JSON.stringify({ e: 'rekey' }), { qos: 1 });
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
      client.publish(`${this.base}/dn/${m.c}`, JSON.stringify({ e: 'rekey' }), { qos: 1 });
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
        // 「ルームなし」に戻してから切る（正常終了では遺言メッセージが送られないため）
        if (this.base) c.publish(`${this.base}/host`, '', { retain: true, qos: 1 });
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

/**
 * 中継でホストにつなぐ。つながったら channel を返す。
 * channel: { kind, send(msg):boolean, close(), onmessage, onclose }
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
    // つながらなかったときの原因調査用：つながったブローカーの数と、ホストの在室情報が見えた数
    const stats = { total: brokers.length, connected: 0, presence: 0 };
    const timer = setTimeout(() => finish(null, new Error('timeout')), timeout);

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
      else reject(Object.assign(err, { relay: { ...stats } }));
    }

    function makeChannel({ client, session }) {
      let q = Promise.resolve();
      const ch = {
        kind: 'relay',
        broker: client.pggUrl,
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

    let failed = 0;
    const brokerFailed = () => {
      failed++;
      if (failed >= brokers.length) finish(null, new Error('no-broker'));
    };

    topicBase(room).then((b) => {
      base = b;
      for (const url of brokers) {
        if (settled) break;
        const client = connectBroker(url, { clientId: `pggp${randomId(8)}`, reconnectPeriod: 0 });
        client.pggUrl = url;
        clients.push(client);
        let session = null;
        let rq = Promise.resolve();
        let counted = false;
        const markFailed = () => {
          if (counted || client.pggOnLost) return;
          counted = true;
          brokerFailed();
        };
        let seenConnect = false;
        let seenPresence = false;
        client.on('connect', () => {
          if (!seenConnect) {
            seenConnect = true;
            stats.connected++;
          }
          client.subscribe([`${base}/host`, `${base}/dn/${cid}`], { qos: 1 }, (err) => {
            if (err) {
              markFailed();
              return;
            }
            // 在室情報（retained）は購読直後に届く。届かなければ、このブローカーにはホストがいない。
            setTimeout(() => {
              if (!session) markFailed();
            }, 4000);
          });
        });
        client.on('message', (topic, payload) => {
          rq = rq
            .then(async () => {
              const m = parse(payload);
              if (topic === `${base}/host`) {
                // ホストの在室情報。空ならホストがいない。sid が変わったらホストが開き直した。
                if (client.pggOnLost) {
                  if (!m || m.sid !== client.pggSessionId) client.pggOnLost();
                  return;
                }
                if (!m || typeof m.pk !== 'string' || typeof m.sid !== 'string' || session?.sid === m.sid) return;
                if (!seenPresence) {
                  seenPresence = true;
                  stats.presence++;
                }
                const kp = await genKeys();
                session = { sid: m.sid, key: await deriveKey(kp.privateKey, m.pk, `${m.sid}:${cid}`) };
                const s = await seal(session.key, { t: '_open' });
                client.publish(`${base}/up`, JSON.stringify({ c: cid, pk: await exportPub(kp), sid: m.sid, ...s }), { qos: 1 });
                return;
              }
              if (!m) return;
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
          else markFailed();
        });
        client.on('error', () => {});
      }
    }, reject);
  });
}
