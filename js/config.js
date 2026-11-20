// 設定値。参加者側リポジトリ（public-goods-game）の js/config.js と PEER_ID_PREFIX を必ず揃えること。

/** PeerJS のサーバー上でルームを識別する接頭辞（ルームコードの前に付く） */
export const PEER_ID_PREFIX = 'pgg7f3k-';

/** 参加者用ページの URL（QRコードに埋め込まれる） */
export const DEFAULT_PLAYER_URL = 'https://xin1zu2zhai1.github.io/public-goods-game/';

/**
 * 中継（リレー）に使う公開 MQTT ブローカー（WebSocket / wss）。
 * ブラウザ同士が直接つながらないとき（スマホのモバイル回線など）に、ここを経由して通信する。
 * 中身は暗号化されるので、ブローカーには読めない。ホスト側と参加者側で同じ一覧にすること。
 * URL に ?relay=wss://…,wss://… を付けると差し替えられる（QRコードにも引き継がれる）。
 */
export const RELAY_BROKERS = [
  // 443番（普通のWebサイトと同じポート）。学校や職場のネットワークでも通りやすい
  'wss://public:public@public.cloud.shiftr.io:443',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
  // 443番以外。スマホ回線などでは通ることが多い
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

export function relayBrokersFromParam(value) {
  if (value === null || value === undefined || value === '') return RELAY_BROKERS;
  if (value === 'off') return [];
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\/[^\s]+$/i.test(s));
  return list.length ? list : RELAY_BROKERS;
}

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
