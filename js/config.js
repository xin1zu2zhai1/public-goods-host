// 設定値。参加者側リポジトリ（public-goods-game）の js/config.js と PEER_ID_PREFIX を必ず揃えること。

/** PeerJS のサーバー上でルームを識別する接頭辞（ルームコードの前に付く） */
export const PEER_ID_PREFIX = 'pgg7f3k-';

/** 参加者用ページの URL（QRコードに埋め込まれる） */
export const DEFAULT_PLAYER_URL = 'https://xin1zu2zhai1.github.io/public-goods-game/';

/**
 * 接続サーバーの指定。通常は空（PeerJS の公開サーバーを使う）。
 * 自前の PeerJS サーバーを使う場合は URL に ?peer=host:port/path を付ける。
 * 例: ?peer=localhost:9000  /  ?peer=https://peer.example.com/myapp
 */
export function peerOptionsFromParam(value) {
  if (!value) return {};
  try {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(value);
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `${local ? 'http' : 'https'}://${value}`);
    const secure = url.protocol === 'https:';
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      path: url.pathname || '/',
      secure,
    };
  } catch {
    return {};
  }
}

export function makeRoomCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}
