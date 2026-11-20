// ホスト側の通信（PeerJS / WebRTC）。ホストのブラウザがサーバー役になり、参加者はここに接続する。
/* global Peer */

const RETRY_ID_TAKEN = 10; // 再読み込み直後は前の接続が残っていることがあるので、少し待ってから取り直す

export class HostNet {
  /**
   * @param {object} opts
   * @param {string} opts.peerId
   * @param {object} opts.peerOptions
   * @param {(status: string, detail?: string) => void} opts.onStatus
   * @param {(conn: any) => void} opts.onConnection
   * @param {(conn: any, msg: any) => void} opts.onMessage
   * @param {(conn: any) => void} opts.onClose
   */
  constructor(opts) {
    this.opts = opts;
    this.peer = null;
    this.conns = new Set();
    this.idTakenCount = 0;
    this.retryTimer = null;
    this.destroyed = false;
  }

  start() {
    this.destroyed = false;
    this._create();
  }

  _status(s, detail) {
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  _create() {
    clearTimeout(this.retryTimer);
    if (typeof Peer === 'undefined') {
      this._status('error', '通信ライブラリを読み込めませんでした');
      return;
    }
    this._status('connecting');
    const peer = new Peer(this.opts.peerId, { debug: 1, ...this.opts.peerOptions });
    this.peer = peer;
    this.opts.onPeer?.(peer); // PeerJS 中継（relay.js の SignalHost）がサーバーからのメッセージを受け取れるようにする

    peer.on('open', () => {
      this.idTakenCount = 0;
      this._status('online');
    });

    peer.on('connection', (conn) => {
      this.conns.add(conn);
      conn.on('open', () => this.opts.onConnection?.(conn));
      conn.on('data', (msg) => this.opts.onMessage?.(conn, msg));
      const closed = () => {
        if (!this.conns.has(conn)) return;
        this.conns.delete(conn);
        this.opts.onClose?.(conn);
      };
      conn.on('close', closed);
      conn.on('error', closed);
      conn.on('iceStateChanged', (state) => {
        if (state === 'failed' || state === 'closed') {
          closed();
        }
      });
    });

    peer.on('disconnected', () => {
      if (this.destroyed || peer !== this.peer) return;
      // シグナリングサーバーとの接続だけが切れた状態。既存の参加者との通信は続く。
      this._status('reconnecting');
      this._scheduleReconnect(3000);
    });

    peer.on('error', (err) => {
      if (this.destroyed || peer !== this.peer) return;
      const type = err?.type;
      if (type === 'unavailable-id') {
        this.idTakenCount++;
        if (this.idTakenCount > RETRY_ID_TAKEN) {
          this._status('id-taken');
          return;
        }
        this._status('connecting', 'ルームコードを確保しています…');
        peer.destroy();
        this.retryTimer = setTimeout(() => this._create(), 2500);
        return;
      }
      if (type === 'browser-incompatible') {
        this._status('error', 'このブラウザは WebRTC に対応していません');
        return;
      }
      if (type === 'peer-unavailable') return; // ホストは接続を受ける側なので通常は起きない
      // network / server-error / socket-error / socket-closed など
      this._status('reconnecting', err?.message);
      this._scheduleReconnect(4000);
    });
  }

  _scheduleReconnect(delay) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.destroyed) return;
      const peer = this.peer;
      if (!peer || peer.destroyed) {
        this._create();
      } else if (peer.disconnected) {
        try {
          peer.reconnect();
        } catch {
          this._create();
        }
        // 再接続に失敗し続けたら作り直す
        this.retryTimer = setTimeout(() => {
          if (!this.destroyed && this.peer === peer && (peer.disconnected || peer.destroyed)) {
            this._scheduleReconnect(1000);
          }
        }, 8000);
      }
    }, delay);
  }

  send(conn, msg) {
    try {
      if (conn && conn.open) conn.send(msg);
    } catch (e) {
      console.warn('send failed', e);
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    for (const c of this.conns) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.peer?.destroy();
  }
}
