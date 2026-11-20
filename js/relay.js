// 中継（リレー）通信。ブラウザ同士が直接つながらないとき（スマホのモバイル回線など）に使う。
// 公開の MQTT ブローカーに WebSocket(wss) でつなぎ、ホストと参加者のメッセージを中継してもらう。
// 中身は端末ごとの鍵（ECDH P-256 → AES-GCM）で暗号化するので、ブローカーや第三者には読めない。
// ホスト側（public-goods-host）と参加者側（public-goods-game）で同じファイルを使う。
/* global mqtt */

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
  return mqtt.connect(url, {
    protocolVersion: 4,
    clean: true,
    connectTimeout: 10000,
    keepalive: 30,
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
