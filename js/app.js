import * as G from './game.js?v=1.3.0';
import { HostNet } from './net-host.js?v=1.3.0';
import { RelayHost } from './relay.js?v=1.3.0';
import { PEER_ID_PREFIX, DEFAULT_PLAYER_URL, peerOptionsFromParam, relayBrokersFromParam, makeRoomCode } from './config.js?v=1.3.0';
import { lineChart, legend } from './chart.js?v=1.3.0';
import { h, replace, yen, pct, downloadText } from './dom.js?v=1.3.0';

/* global qrcode */

const STORE_KEY = 'pgg-host-state-v1';
const URL_KEY = 'pgg-host-player-url';
const UI_KEY = 'pgg-host-ui';
const params = new URLSearchParams(location.search);
const peerParam = params.get('peer') || '';
const peerOptions = peerOptionsFromParam(peerParam);
const relayParam = params.get('relay') || '';
const relayBrokers = relayBrokersFromParam(relayParam);

const $ = (id) => document.getElementById(id);

let state = null;
let net = null; // 直接（WebRTC / PeerJS）
let relay = null; // 中継（MQTT・暗号化）
let relayStatus = { connected: 0, total: 0 };
let netStartedAt = 0;
const conns = new Map(); // pid -> conn
const connPid = new Map(); // conn -> pid
const lastSeen = new Map(); // pid -> time
const lastSent = new Map(); // pid -> 最後に送った表示データ(JSON)
const commentLog = new Map(); // pid -> 送信時刻（連投防止）
let netStatus = 'connecting';
let autoTimer = null;
let pending = false;
let renderedQrFor = '';

const ui = { showNames: false, projector: false, ...readJSON(UI_KEY) };

// ------------------------------------------------------------------ 保存

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? {};
  } catch {
    return {};
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== 1 || !s.roomCode || !s.players || !Array.isArray(s.rounds)) return null;
    s.settings = G.sanitizeSettings(s.settings);
    s.blocked ??= [];
    s.comments ??= [];
    s.nextCommentId ??= s.comments.length + 1;
    s.nextPlayerNo ??= Object.keys(s.players).length + 1;
    return s;
  } catch {
    return null;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('save failed', e);
  }
}

function saveUI() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* ignore */
  }
}

function playerUrl() {
  let saved = '';
  try {
    saved = localStorage.getItem(URL_KEY) || '';
  } catch {
    /* ignore */
  }
  return params.get('player') || saved || DEFAULT_PLAYER_URL;
}

function joinUrl() {
  let u;
  try {
    u = new URL(playerUrl(), location.href);
  } catch {
    u = new URL(DEFAULT_PLAYER_URL);
  }
  u.searchParams.set('room', state.roomCode);
  if (peerParam) u.searchParams.set('peer', peerParam);
  if (relayParam) u.searchParams.set('relay', relayParam);
  return u.toString();
}

// ------------------------------------------------------------------ 更新の反映

/** 状態が変わったら呼ぶ。同じ処理の中で何度呼んでも、保存・送信・描画は1回にまとめる。 */
function changed() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    saveState();
    broadcast();
    render();
    checkAuto();
  });
}

function viewContext() {
  return {
    series: G.classSeries(state),
    progress: G.progress(state),
    totals: state.phase === 'ended' ? G.totals(state) : undefined,
  };
}

function broadcast() {
  if (!conns.size) return;
  const ctx = viewContext();
  for (const [pid, conn] of conns) sendView(pid, conn, ctx);
}

function sendView(pid, conn, ctx, force = false) {
  const view = G.playerView(state, pid, ctx ?? viewContext());
  const json = JSON.stringify(view);
  if (!force && lastSent.get(pid) === json) return;
  lastSent.set(pid, json);
  sendTo(conn, view);
}

function checkAuto() {
  const waiting = (state.phase === 'contribute' || state.phase === 'punish') && state.settings.autoAdvance && G.allSubmitted(state);
  if (!waiting) {
    clearTimeout(autoTimer);
    autoTimer = null;
    return;
  }
  if (autoTimer) return;
  const phaseAt = `${state.phase}:${state.rounds.length}`;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (`${state.phase}:${state.rounds.length}` !== phaseAt || !G.allSubmitted(state)) return;
    closeInput();
  }, 1200);
}

// ------------------------------------------------------------------ 通信

function sendTo(conn, msg) {
  try {
    if (conn && conn.open) conn.send(msg);
  } catch (e) {
    console.warn('send failed', e);
  }
}

/** 直接（WebRTC）と中継（MQTT）の両方で参加者を待ち受ける */
function startNet() {
  net?.destroy();
  relay?.destroy();
  conns.clear();
  connPid.clear();
  lastSent.clear();
  net = new HostNet({
    peerId: PEER_ID_PREFIX + state.roomCode,
    peerOptions,
    onStatus: onNetStatus,
    onMessage,
    onClose,
  });
  net.start();
  netStartedAt = Date.now();
  relayStatus = { connected: 0, total: relayBrokers.length };
  relay = new RelayHost({
    room: state.roomCode,
    brokers: relayBrokers,
    onStatus: (st) => {
      relayStatus = st;
      renderNetStatus();
    },
    onMessage,
    onClose,
  });
  relay.start().catch((e) => console.warn('relay start failed', e));
  renderNetStatus();
}

function netReady() {
  return netStatus === 'online' || relayStatus.connected > 0;
}

function renderNetStatus() {
  const el = $('netStatus');
  const ready = netReady();
  el.dataset.s = ready ? 'online' : netStatus === 'error' || netStatus === 'id-taken' ? 'error' : 'connecting';
  const direct = netStatus === 'online' ? '○' : netStatus === 'connecting' || netStatus === 'reconnecting' ? '…' : '×';
  const rel = relayStatus.total ? `中継 ${relayStatus.connected}/${relayStatus.total}` : '中継なし';
  el.textContent = `${ready ? '接続OK' : '接続の準備中…'}（直接${direct}・${rel}）`;
  el.title = '直接＝ブラウザ同士の直接通信（WebRTC）／中継＝暗号化して中継サーバー（MQTT）経由で通信。どちらか一方がつながっていれば参加できます。';
  const brokers = relayStatus.brokers ?? [];
  $('netDetail').textContent = `通信の状態：直接 ${direct}${brokers.length ? ` ・ 中継 ${brokers.map((b) => `${b.label}${b.connected ? '○' : '×'}`).join(' ')}` : ''}`;
  renderAlerts();
}

function onNetStatus(s) {
  netStatus = s;
  if (s === 'id-taken') {
    showModal(
      'このルームコードは使用中です',
      '同じルームを別のタブや端末で開いていませんか？ そちらを閉じてから再読み込みするか、新しいルームを作ってください。',
      [
        { label: '再読み込み', fn: () => location.reload() },
        { label: '新しいルームを作る', primary: true, fn: () => newRoom(true) },
      ],
      { dismissable: false },
    );
  }
  renderNetStatus();
}

function onMessage(conn, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
  const pid = connPid.get(conn);
  if (pid) lastSeen.set(pid, Date.now());
  if (msg.t === 'hello') return onHello(conn, msg);
  if (msg.t === 'ping') return sendTo(conn, { t: 'pong' });
  if (!pid || conns.get(pid) !== conn) return;

  if (msg.t === 'contribute') {
    const r = G.submitContribution(state, pid, msg.amount);
    sendTo(conn, { t: 'ack', what: 'contribute', ok: r.ok, reason: r.reason });
    if (r.ok) changed();
  } else if (msg.t === 'punish') {
    const r = G.submitPunishment(state, pid, msg.alloc);
    sendTo(conn, { t: 'ack', what: 'punish', ok: r.ok, reason: r.reason });
    if (r.ok) changed();
  } else if (msg.t === 'comment') {
    const now = Date.now();
    const times = (commentLog.get(pid) ?? []).filter((t) => now - t < 60000);
    if (times.length >= 3) {
      sendTo(conn, { t: 'ack', what: 'comment', ok: false, reason: 'rate' });
      return;
    }
    const r = G.addComment(state, msg.text);
    if (r.ok) {
      times.push(now);
      commentLog.set(pid, times);
      changed();
    }
    sendTo(conn, { t: 'ack', what: 'comment', ok: r.ok, reason: r.reason });
  } else if (msg.t === 'sync') {
    sendView(pid, conn, null, true);
  }
}

function onHello(conn, msg) {
  if (msg.v !== G.PROTOCOL_VERSION) {
    sendTo(conn, { t: 'refused', reason: 'version' });
    setTimeout(() => conn.close(), 400);
    return;
  }
  const r = G.addPlayer(state, String(msg.pid ?? ''), msg.name);
  if (!r.ok) {
    sendTo(conn, { t: 'refused', reason: r.reason });
    setTimeout(() => conn.close(), 400);
    return;
  }
  const pid = r.player.pid;
  const old = conns.get(pid);
  if (old && old !== conn) {
    connPid.delete(old);
    sendTo(old, { t: 'replaced' });
    setTimeout(() => {
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }, 300);
  }
  const prevPid = connPid.get(conn);
  if (prevPid && prevPid !== pid && conns.get(prevPid) === conn) conns.delete(prevPid);
  conns.set(pid, conn);
  connPid.set(conn, pid);
  lastSeen.set(pid, Date.now());
  lastSent.delete(pid);
  sendTo(conn, { t: 'welcome', v: G.PROTOCOL_VERSION, pid, name: r.player.name, room: state.roomCode });
  changed();
}

function onClose(conn) {
  const pid = connPid.get(conn);
  connPid.delete(conn);
  if (pid && conns.get(pid) === conn) {
    conns.delete(pid);
    lastSent.delete(pid);
  }
  changed();
}

setInterval(() => {
  if (state && !netReady()) renderAlerts();
  const now = Date.now();
  for (const [pid, conn] of conns) {
    if (now - (lastSeen.get(pid) ?? 0) > 25000) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      onClose(conn);
    }
  }
}, 5000);

// ------------------------------------------------------------------ 進行操作

function startRound() {
  const r = G.startRound(state);
  if (!r.ok) toast('参加者がいません');
  changed();
}

function closeInput() {
  if (state.phase === 'contribute') G.closeContributions(state);
  else if (state.phase === 'punish') G.closePunishment(state);
  changed();
}

function confirmClose() {
  const p = G.progress(state);
  if (p.submitted < p.total) {
    showModal(
      '締め切りますか？',
      `まだ ${p.total - p.submitted} 人が入力していません。${state.phase === 'contribute' ? '未入力の人は 0円 を出したものとして計算します。' : '未入力の人は罰を与えなかったものとして計算します。'}`,
      [
        { label: 'キャンセル' },
        { label: '締め切る', primary: true, fn: closeInput },
      ],
    );
  } else {
    closeInput();
  }
}

function regroup() {
  if (!['lobby', 'result', 'ended'].includes(state.phase)) return;
  const doIt = () => {
    G.formGroups(state);
    changed();
    toast('グループを組み直しました');
  };
  if (state.groups.length) {
    showModal('グループを組み直しますか？', '全員をシャッフルして新しいグループを作ります。グループ内の記号（A・B・C…）も変わります。', [
      { label: 'キャンセル' },
      { label: '組み直す', primary: true, fn: doIt },
    ]);
  } else {
    doIt();
  }
}

function kick(pid) {
  const p = state.players[pid];
  if (!p) return;
  showModal('参加者を外しますか？', `「${p.name}」をゲームから外します。この端末からは同じ参加者として戻れなくなります。`, [
    { label: 'キャンセル' },
    {
      label: '外す',
      primary: true,
      fn: () => {
        const conn = conns.get(pid);
        G.removePlayer(state, pid);
        if (conn) {
          sendTo(conn, { t: 'refused', reason: 'removed' });
          conns.delete(pid);
          connPid.delete(conn);
          setTimeout(() => {
            try {
              conn.close();
            } catch {
              /* ignore */
            }
          }, 400);
        }
        lastSent.delete(pid);
        changed();
      },
    },
  ]);
}

function newRoom(skipConfirm = false) {
  const doIt = () => {
    for (const conn of conns.values()) sendTo(conn, { t: 'closed' });
    const settings = { ...state.settings, punishment: false, acceptComments: false };
    state = G.createState(makeRoomCode(), settings);
    lastSeen.clear();
    commentLog.clear();
    saveState();
    setTimeout(() => {
      startNet();
      render();
    }, 200);
    render();
  };
  if (skipConfirm) return doIt();
  showModal('新しいルームを作りますか？', 'ルームコードが変わり、今の参加者との接続は切れます。今の結果を残したい場合は、先に「結果をCSVで保存」してください。', [
    { label: 'キャンセル' },
    { label: '新しいルームを作る', primary: true, fn: doIt },
  ]);
}

function exportCsv() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  downloadText(`公共財ゲーム_${state.roomCode}_${stamp}.csv`, G.toCSV(state));
}

// ------------------------------------------------------------------ 描画

const PHASE_LABEL = {
  lobby: ['受付中', 'accent'],
  contribute: ['拠出額の入力中', 'accent'],
  punish: ['罰則の入力中', 'punish'],
  result: ['結果発表', 'ok'],
  ended: ['ゲーム終了', ''],
};

function render() {
  if (!state) return;
  document.body.classList.toggle('projector', ui.projector);
  $('btnProjector').setAttribute('aria-pressed', String(ui.projector));
  $('btnProjector').textContent = ui.projector ? '操作モードに戻る' : '投影モード';
  renderJoin();
  renderControl();
  renderAlerts();
  renderChart();
  renderHist();
  renderGroups();
  renderTable();
  renderComments();
  renderSettingsNote();
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
    }
  }
  const size = n + m * 2;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `参加用QRコード ${text}`);
  const bg = document.createElementNS(svg.namespaceURI, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

function spacedCode(code) {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function renderJoin() {
  const url = joinUrl();
  if (renderedQrFor !== url) {
    renderedQrFor = url;
    try {
      replace($('qr'), qrSvg(url));
      replace($('qrBig'), qrSvg(url));
    } catch (e) {
      replace($('qr'), h('p', { class: 'note' }, 'QRコードを作れませんでした'));
      console.error(e);
    }
    $('joinUrl').textContent = url;
    $('joinUrlBig').textContent = url;
  }
  $('roomCode').textContent = spacedCode(state.roomCode);
  $('roomCodeBig').textContent = spacedCode(state.roomCode);
  $('topCode').textContent = `ルーム ${spacedCode(state.roomCode)}`;
  const n = G.activePlayers(state).length;
  $('playerCount').textContent = String(n);
  $('playerCountBig').textContent = String(n);
  const online = G.activePlayers(state).filter((p) => conns.has(p.pid));
  const viaRelay = online.filter((p) => conns.get(p.pid)?.kind === 'relay').length;
  $('onlineCount').textContent = n
    ? `接続中 ${online.length}人${viaRelay ? `（うち中継 ${viaRelay}人）` : ''}${state.settings.acceptJoin ? '' : '・新規の参加は締め切り中'}`
    : state.settings.acceptJoin
      ? ''
      : '新規の参加は締め切り中';
}

function renderControl() {
  const s = state.settings;
  const round = G.currentRound(state);
  const [label, cls] = PHASE_LABEL[state.phase];
  const badge = $('phaseBadge');
  badge.textContent = label;
  badge.className = `badge ${cls}`;
  const nPlayers = G.activePlayers(state).length;

  let title;
  if (state.phase === 'lobby') title = nPlayers ? `ラウンド1の開始前（${nPlayers}人）` : '参加者を待っています';
  else if (state.phase === 'ended') title = 'ゲーム終了';
  else title = `ラウンド ${round.no}`;
  $('roundTitle').textContent = title;

  const stage = $('stageBadge');
  if (round && state.phase !== 'lobby' && state.phase !== 'ended') {
    stage.hidden = false;
    stage.textContent = `ステージ${round.stage}・${round.punishment ? '罰則あり' : '罰則なし'}`;
    stage.className = `badge ${round.punishment ? 'punish' : ''}`;
  } else {
    stage.hidden = true;
  }

  // 罰則スイッチ
  const toggle = $('punishToggle');
  toggle.checked = s.punishment;
  $('punishLabel').textContent = s.punishment ? 'あり' : 'なし';
  $('ruleBox').classList.toggle('on', s.punishment);
  $('ruleBox').hidden = state.phase === 'ended';
  let note = '';
  if (state.phase === 'contribute') note = '入力中のこのラウンドから反映されます';
  else if (state.phase === 'punish') note = '次のラウンドから反映されます';
  else if (state.phase === 'lobby' || state.phase === 'result') note = s.punishment
    ? `次のラウンドから：罰1回 ${s.punishCost}円 で相手を −${s.punishEffect}円`
    : '次のラウンドは罰則なし';
  $('punishNote').textContent = note;

  // 進捗・統計
  const box = $('progressBox');
  const series = G.classSeries(state);
  if (state.phase === 'contribute' || state.phase === 'punish') {
    const p = G.progress(state);
    const offline = round.groups.flatMap((g) => g.members).filter((pid) => !conns.has(pid)).length;
    replace(
      box,
      h(
        'div',
        { class: 'progress' },
        h(
          'div',
          { class: 'progress-top' },
          h('span', null, state.phase === 'contribute' ? '拠出額の入力' : '罰則の入力'),
          h('span', { class: 'progress-num' }, `${p.submitted} / ${p.total}人`),
        ),
        h('div', { class: `bar ${state.phase === 'punish' ? 'punish' : ''}` }, h('i', { style: { width: `${p.total ? (100 * p.submitted) / p.total : 0}%` } })),
        offline ? h('p', { class: 'note' }, `接続が切れている人が ${offline}人 います（再接続を待つか、締め切ってください）`) : null,
      ),
    );
  } else if ((state.phase === 'result' || state.phase === 'ended') && series.length) {
    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const diff = prev ? last.avgContribution - prev.avgContribution : null;
    const items = [
      stat('平均拠出額', yen(last.avgContribution), `保有額の ${pct(last.rate)}${diff !== null ? `（前回比 ${diff >= 0 ? '+' : '−'}${yen(Math.abs(diff))}）` : ''}`),
      stat('グループ全体の幸福度', pct(last.efficiency), '全員が全額出した場合を100%'),
      stat('平均利得', yen(last.avgPayoff), `このラウンド（${last.n}人）`),
    ];
    if (last.punishment) items.push(stat('罰の回数', `${last.punishUnits}回`, 'クラス全体'));
    if (state.phase === 'ended') {
      const t = G.totals(state);
      const vals = Object.values(t);
      const avgTotal = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      items.unshift(stat('実施ラウンド', `${series.length}回`, ''), stat('1人あたりの累計利得', yen(avgTotal), 'クラス平均'));
    }
    replace(box, h('div', { class: 'stats' }, items));
  } else if (state.phase === 'lobby') {
    replace(
      box,
      h(
        'p',
        { class: 'note' },
        nPlayers
          ? '参加者がそろったら「ラウンド1を開始」を押してください。グループは自動で作られます（先に「グループを作る」で確認することもできます）。'
          : 'QRコードかルームコードで参加してもらいましょう。',
      ),
    );
  } else {
    replace(box);
  }

  // ボタン
  const acts = [];
  const nextNo = state.rounds.length + 1;
  if (state.phase === 'lobby') {
    acts.push(h('button', { class: 'btn primary big', type: 'button', disabled: nPlayers === 0, onclick: startRound }, `ラウンド${nextNo}を開始 ▶`));
    acts.push(h('button', { class: 'btn host-only', type: 'button', disabled: nPlayers === 0, onclick: regroup }, state.groups.length ? 'グループを組み直す' : 'グループを作る'));
  } else if (state.phase === 'contribute' || state.phase === 'punish') {
    const p = G.progress(state);
    acts.push(
      h('button', { class: 'btn primary big', type: 'button', onclick: confirmClose }, state.phase === 'contribute' ? (round.punishment ? '締め切って罰則の入力へ ▶' : '締め切って結果を表示 ▶') : '締め切って結果を表示 ▶'),
    );
    if (s.autoAdvance) acts.push(h('span', { class: 'note' }, p.submitted === p.total ? 'まもなく自動で締め切ります…' : '全員が入力すると自動で締め切ります'));
    acts.push(
      h(
        'button',
        {
          class: 'btn small ghost danger host-only',
          type: 'button',
          onclick: () =>
            showModal('このラウンドを取り消しますか？', '入力された内容は消えて、ラウンドを始める前に戻ります。', [
              { label: 'キャンセル' },
              { label: '取り消す', primary: true, fn: () => { G.cancelRound(state); changed(); } },
            ]),
        },
        'ラウンドを取り消す',
      ),
    );
  } else if (state.phase === 'result') {
    acts.push(h('button', { class: 'btn primary big', type: 'button', onclick: startRound }, `ラウンド${nextNo}を開始 ▶`));
    acts.push(
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () =>
            showModal('ゲームを終了しますか？', '参加者の画面に最終結果と振り返りの問いが表示されます。あとで再開することもできます。', [
              { label: 'キャンセル' },
              { label: '終了して最終結果へ', primary: true, fn: () => { G.endGame(state); changed(); } },
            ]),
        },
        'ゲームを終了',
      ),
    );
  } else if (state.phase === 'ended') {
    acts.push(h('button', { class: 'btn', type: 'button', onclick: () => { G.resumeGame(state); changed(); } }, 'ゲームを再開する'));
    acts.push(h('button', { class: 'btn host-only', type: 'button', onclick: exportCsv }, '結果をCSVで保存'));
  }
  replace($('actions'), acts);
}

function stat(k, v, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
}

function renderAlerts() {
  const out = [];
  if (!netReady() && (netStatus === 'error' || Date.now() - netStartedAt > 10000)) {
    out.push(
      h(
        'div',
        { class: netStatus === 'error' ? 'alert danger' : 'alert' },
        '通信サーバーにつながっていません。インターネットにつながっているか確認してください（自動で再接続しています）。',
      ),
    );
  }
  if (state && state.groups.some((g) => g.members.length === 1) && G.activePlayers(state).length > 1) {
    out.push(h('div', { class: 'alert' }, '1人だけのグループがあります。「グループを組み直す」で調整できます。'));
  }
  replace($('alerts'), out);
}

function renderChart() {
  const series = G.classSeries(state);
  const box = $('chartContrib');
  if (!series.length) {
    replace(box, h('div', { class: 'chart-empty' }, 'ラウンドが終わると、ここにクラス全体の拠出額の推移が表示されます'));
    replace($('stageStats'));
    $('chartNote').textContent = '';
    return;
  }
  const rounds = G.completedRounds(state);
  const xLabels = series.map((x) => `R${x.no}`);
  const groupIds = [...new Set(rounds.flatMap((r) => Object.keys(r.groupStats)))].sort((a, b) => a - b);
  const groupSeries = groupIds.map((gid) => ({
    name: `グループ${gid}`,
    values: rounds.map((r) => (r.groupStats[gid] ? r.groupStats[gid].avg : null)),
    color: 'var(--series-muted)',
    width: 1.5,
    dots: false,
    opacity: 0.7,
  }));
  const maxE = Math.max(...rounds.map((r) => r.params.endowment));
  const anyPunish = series.some((x) => x.punishment);
  const chart = lineChart({
    xLabels,
    series: [
      ...groupSeries,
      { name: 'クラス平均', values: series.map((x) => x.avgContribution), color: 'var(--series-1)', width: 4, dotSize: 5 },
    ],
    shade: series.map((x) => x.punishment),
    shadeLabel: '罰則あり',
    yMax: maxE,
    yFormat: (v) => `${Math.round(v)}`,
    title: 'ラウンドごとの平均拠出額（円）',
    height: 280,
  });
  const effChart = lineChart({
    xLabels,
    series: [{ name: '幸福度', values: series.map((x) => x.efficiency), color: 'var(--series-3)', width: 3 }],
    shade: series.map((x) => x.punishment),
    yMax: 1,
    yMin: Math.min(0, ...series.map((x) => x.efficiency)),
    yFormat: (v) => `${Math.round(v * 100)}%`,
    title: 'グループ全体の幸福度（全員が全額出した場合を100%）',
    height: 170,
  });
  const items = [
    { name: 'クラス平均（円）', color: 'var(--series-1)' },
    { name: '各グループの平均', color: 'var(--series-muted)' },
  ];
  if (anyPunish) items.push({ name: '罰則ありのラウンド', shade: true });
  replace(
    box,
    chart,
    legend(items),
    h('h3', { style: { marginTop: '16px', fontSize: '0.95rem' } }, 'グループ全体の幸福度（全員が全額出した場合を100%）'),
    effChart,
  );
  $('chartNote').textContent = `保有額 ${yen(maxE)} に対する拠出額`;

  // ステージ別のまとめ
  const stages = [];
  for (const x of series) {
    let st = stages.find((s) => s.stage === x.stage);
    if (!st) {
      st = { stage: x.stage, punishment: x.punishment, rounds: 0, rate: 0, eff: 0 };
      stages.push(st);
    }
    st.rounds++;
    st.rate += x.rate;
    st.eff += x.efficiency;
  }
  if (stages.length > 1 || anyPunish) {
    replace(
      $('stageStats'),
      h(
        'div',
        { class: 'stats' },
        stages.map((st) =>
          stat(
            `ステージ${st.stage}（${st.punishment ? '罰則あり' : '罰則なし'}・${st.rounds}回）`,
            `拠出 ${pct(st.rate / st.rounds)}`,
            `幸福度 ${pct(st.eff / st.rounds)}`,
          ),
        ),
      ),
    );
  } else {
    replace($('stageStats'));
  }
}

function renderHist() {
  const rounds = G.completedRounds(state);
  const card = $('histCard');
  if (!rounds.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const r = rounds[rounds.length - 1];
  const E = r.params.endowment;
  const q = (f) => Math.round(E * f);
  const bins = [
    { label: '0円', test: (c) => c === 0 },
    { label: `1〜${q(0.25) - 1}円`, test: (c) => c > 0 && c < q(0.25) },
    { label: `${q(0.25)}〜${q(0.5) - 1}円`, test: (c) => c >= q(0.25) && c < q(0.5) },
    { label: `${q(0.5)}〜${q(0.75) - 1}円`, test: (c) => c >= q(0.5) && c < q(0.75) },
    { label: `${q(0.75)}〜${E - 1}円`, test: (c) => c >= q(0.75) && c < E },
    { label: `${E}円（全額）`, test: (c) => c === E },
  ];
  const values = Object.values(r.results).map((x) => x.contribution);
  const counts = bins.map((b) => values.filter(b.test).length);
  const max = Math.max(1, ...counts);
  $('histTitle').textContent = `ラウンド${r.no}の拠出額の分布（${values.length}人）`;
  replace(
    $('hist'),
    h(
      'div',
      { class: 'hist' },
      bins.map((b, i) => [
        h('span', null, b.label),
        h('div', null, h('div', { class: 'hbar', style: { width: `${(100 * counts[i]) / max}%` } })),
        h('span', { class: 'hnum' }, `${counts[i]}人`),
      ]),
    ),
  );
}

function renderGroups() {
  const round = G.currentRound(state);
  const inInput = round && (state.phase === 'contribute' || state.phase === 'punish');
  const showNames = ui.showNames && !ui.projector;
  $('hostShowNames').checked = ui.showNames;
  $('btnRegroup').disabled = !['lobby', 'result', 'ended'].includes(state.phase) || G.activePlayers(state).length === 0;
  const store = inInput ? (state.phase === 'contribute' ? round.contributions : round.punishments) : null;
  const source = inInput
    ? round.groups.map((g) => ({ id: g.id, members: g.members, labels: g.labels }))
    : state.groups.map((g) => ({ id: g.id, members: g.members, labels: Object.fromEntries(g.members.map((pid) => [pid, state.players[pid]?.label])) }));
  const lastResults = !inInput && round?.results && state.groups.length ? round : null;

  const cards = source.map((g) => {
    const done = store ? g.members.filter((pid) => store[pid] !== undefined).length : null;
    const gs = lastResults?.groupStats?.[g.id];
    return h(
      'div',
      { class: 'group' },
      h(
        'div',
        { class: 'group-head' },
        h('span', null, `グループ${g.id}`),
        h('span', { class: 'muted' }, store ? `${done}/${g.members.length} 入力済み` : gs ? `平均 ${yen(gs.avg)}` : `${g.members.length}人`),
      ),
      [...g.members]
        .sort((a, b) => String(g.labels[a]).localeCompare(String(g.labels[b])))
        .map((pid) => {
          const p = state.players[pid];
          const online = conns.has(pid);
          let st = null;
          if (store) st = store[pid] !== undefined ? h('span', { class: 'st done' }, '✓ 入力済') : online ? h('span', { class: 'st wait' }, '入力中') : h('span', { class: 'st off' }, '未接続');
          else if (!online) st = h('span', { class: 'st off' }, '未接続');
          return h(
            'div',
            { class: `member ${online ? '' : 'offline'}` },
            h('span', { class: 'lab' }, g.labels[pid] ?? '?'),
            h('span', { class: 'nm' }, showNames ? p?.name ?? '' : `メンバー${g.labels[pid] ?? ''}`),
            st,
            h('button', { class: 'kick host-only', type: 'button', title: '外す', 'aria-label': `${p?.name ?? ''}を外す`, onclick: () => kick(pid) }, '×'),
          );
        }),
    );
  });
  replace(
    $('groups'),
    cards.length
      ? cards
      : h('p', { class: 'note', style: { gridColumn: '1 / -1', margin: 0 } }, G.activePlayers(state).length ? 'ラウンドを始めるとグループが自動で作られます。' : 'まだ参加者がいません。'),
  );

  const waiting = G.unassignedPlayers(state);
  if (waiting.length && state.groups.length) {
    replace(
      $('waitingList'),
      h('span', { class: 'muted' }, `次のラウンドからグループに入る人：${waiting.length}人`),
      showNames ? h('span', null, `（${waiting.map((p) => p.name).join('、')}）`) : null,
    );
  } else if (!state.groups.length && G.activePlayers(state).length) {
    const list = G.activePlayers(state);
    replace(
      $('waitingList'),
      h('div', { class: 'muted' }, `参加者 ${list.length}人`),
      showNames
        ? h(
            'div',
            { class: 'groups', style: { marginTop: '8px' } },
            list.map((p) =>
              h(
                'div',
                { class: `member ${conns.has(p.pid) ? '' : 'offline'}` },
                h('span', { class: 'nm' }, p.name),
                h('button', { class: 'kick host-only', type: 'button', title: '外す', 'aria-label': `${p.name}を外す`, onclick: () => kick(p.pid) }, '×'),
              ),
            ),
          )
        : null,
    );
  } else {
    replace($('waitingList'));
  }
  const size = state.settings.groupSize;
  let note = state.groups.length ? `${state.groups.length}グループ` : '';
  if (state.groups.length && state.groupsFormedWithSize !== null && state.groupsFormedWithSize !== size) {
    note += '（人数の設定が変わりました。組み直すと反映されます）';
  }
  $('groupsNote').textContent = note;
}

function renderTable() {
  const series = G.classSeries(state);
  if (!series.length) {
    replace($('roundTable'), h('p', { class: 'note' }, 'まだ結果はありません。'));
    return;
  }
  const rows = series.map((x) =>
    h(
      'tr',
      { class: x.punishment ? 'punish-row' : '' },
      h('td', null, `ラウンド${x.no}`),
      h('td', null, `${x.stage}`),
      h('td', null, x.punishment ? 'あり' : 'なし'),
      h('td', null, `${x.n}人`),
      h('td', null, yen(x.avgContribution)),
      h('td', null, pct(x.rate)),
      h('td', null, yen(x.avgPayoff)),
      h('td', null, pct(x.efficiency)),
      h('td', null, x.punishment ? `${x.punishUnits}回` : '—'),
    ),
  );
  replace(
    $('roundTable'),
    h(
      'table',
      null,
      h(
        'thead',
        null,
        h('tr', null, ['ラウンド', 'ステージ', '罰則', '人数', '平均拠出額', '拠出率', '平均利得', '幸福度', '罰の回数'].map((t) => h('th', { scope: 'col' }, t))),
      ),
      h('tbody', null, rows),
    ),
  );
}

function renderComments() {
  $('commentToggle').checked = state.settings.acceptComments;
  const list = [...state.comments].reverse().filter((c) => !(ui.projector && c.hidden));
  if (!list.length) {
    replace(
      $('comments'),
      state.settings.acceptComments ? h('p', { class: 'note' }, '参加者の画面からコメントを送れます。届いたものがここに表示されます（名前は表示されません）。') : null,
    );
    return;
  }
  replace(
    $('comments'),
    list.map((c) =>
      h(
        'div',
        { class: `comment ${c.hidden ? 'hidden-c' : ''}` },
        c.text,
        h(
          'button',
          {
            class: 'btn small ghost hide host-only',
            type: 'button',
            onclick: () => {
              c.hidden = !c.hidden;
              changed();
            },
          },
          c.hidden ? '表示' : '隠す',
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ 設定フォーム

const NUM_FIELDS = ['endowment', 'multiplier', 'groupSize', 'punishCost', 'punishEffect', 'punishMax'];
const BOOL_FIELDS = ['showNames', 'autoAdvance', 'acceptJoin'];

function fillSettingsForm() {
  const f = $('settingsForm');
  for (const k of NUM_FIELDS) f.elements[k].value = String(state.settings[k]);
  for (const k of BOOL_FIELDS) f.elements[k].checked = state.settings[k];
  f.elements.playerUrl.value = playerUrl();
}

function onSettingsChange(e) {
  const f = $('settingsForm');
  const name = e.target.name;
  if (name === 'playerUrl') {
    const v = e.target.value.trim();
    try {
      if (v) new URL(v);
      if (v && v !== DEFAULT_PLAYER_URL) localStorage.setItem(URL_KEY, v);
      else localStorage.removeItem(URL_KEY);
    } catch {
      toast('URLの形式が正しくありません');
    }
    f.elements.playerUrl.value = playerUrl();
    render();
    return;
  }
  const next = { ...state.settings };
  for (const k of NUM_FIELDS) next[k] = Number(f.elements[k].value);
  for (const k of BOOL_FIELDS) next[k] = f.elements[k].checked;
  state.settings = G.sanitizeSettings(next);
  G.syncRoundSettings(state);
  fillSettingsForm();
  changed();
}

function renderSettingsNote() {
  let t = '';
  if (state.phase === 'contribute') t = '金額や罰則の設定は、入力中のこのラウンドにも反映されます。';
  else if (state.phase === 'punish') t = '金額や罰則の設定は、次のラウンドから反映されます。';
  else t = '設定は次のラウンドから反映されます。グループの人数は「グループを組み直す」と反映されます。';
  $('settingsNote').textContent = t;
}

// ------------------------------------------------------------------ モーダル・通知

let modalDismissable = true;
function showModal(title, body, buttons, { dismissable = true } = {}) {
  modalDismissable = dismissable;
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  replace(
    $('modalActions'),
    buttons.map((b) =>
      h(
        'button',
        {
          class: `btn ${b.primary ? 'primary' : ''}`,
          type: 'button',
          onclick: () => {
            $('modal').hidden = true;
            b.fn?.();
          },
        },
        b.label,
      ),
    ),
  );
  $('modal').hidden = false;
  $('modalActions').querySelector('.primary, button')?.focus();
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2200);
}

// ------------------------------------------------------------------ イベント

function bindEvents() {
  $('punishToggle').addEventListener('change', (e) => {
    state.settings.punishment = e.target.checked;
    G.syncRoundSettings(state);
    changed();
  });
  $('commentToggle').addEventListener('change', (e) => {
    state.settings.acceptComments = e.target.checked;
    changed();
  });
  $('hostShowNames').addEventListener('change', (e) => {
    ui.showNames = e.target.checked;
    saveUI();
    render();
  });
  $('btnRegroup').addEventListener('click', regroup);
  $('btnProjector').addEventListener('click', () => {
    ui.projector = !ui.projector;
    saveUI();
    render();
  });
  const openQr = () => {
    $('qrOverlay').hidden = false;
    $('btnQrClose').focus();
  };
  const closeQr = () => {
    $('qrOverlay').hidden = true;
  };
  $('btnQrBig').addEventListener('click', openQr);
  $('qr').addEventListener('click', openQr);
  $('qr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openQr();
    }
  });
  $('qrBig').addEventListener('click', closeQr);
  $('btnQrClose').addEventListener('click', closeQr);
  $('qrOverlay').addEventListener('click', (e) => {
    if (e.target === $('qrOverlay')) closeQr();
  });
  $('btnCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl());
      toast('参加用URLをコピーしました');
    } catch {
      toast('コピーできませんでした');
    }
  });
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnNewRoom').addEventListener('click', () => newRoom(false));
  $('settingsForm').addEventListener('change', onSettingsChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeQr();
      if (modalDismissable) $('modal').hidden = true;
    }
  });
  // ページを離れるときは中継サーバー上の「ルームあり」の印を消す
  window.addEventListener('pagehide', () => relay?.destroy());
  window.addEventListener('beforeunload', (e) => {
    if (conns.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // 授業中に画面が消えないようにする（対応ブラウザのみ）
  let wakeLock = null;
  const keepAwake = async () => {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch {
      /* ignore */
    }
  };
  document.addEventListener('click', keepAwake);
  document.addEventListener('visibilitychange', keepAwake);
}

// ------------------------------------------------------------------ 起動

function boot(s) {
  state = s;
  saveState();
  fillSettingsForm();
  render();
  startNet();
}

function main() {
  bindEvents();
  const saved = loadState();
  if (saved && (saved.rounds.length || Object.keys(saved.players).length)) {
    const n = Object.values(saved.players).filter((p) => !p.removed).length;
    state = saved;
    fillSettingsForm();
    render();
    showModal(
      '前回のルームがあります',
      `ルームコード ${spacedCode(saved.roomCode)}（参加者 ${n}人・${G.completedRounds(saved).length}ラウンド終了）の続きから再開しますか？`,
      [
        { label: '新しいルームを作る', fn: () => boot(G.createState(makeRoomCode(), { ...saved.settings, punishment: false, acceptComments: false })) },
        { label: '続きから再開', primary: true, fn: () => boot(saved) },
      ],
      { dismissable: false },
    );
  } else {
    boot(saved ?? G.createState(makeRoomCode()));
  }
}

main();
