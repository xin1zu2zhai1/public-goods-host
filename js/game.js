// 公共財ゲームのルールと状態管理（DOM に依存しない純粋なロジック）
// ホストがこの状態を唯一の正として持ち、参加者には playerView() で個別の表示データを送る。

export const PROTOCOL_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  endowment: 1000,     // 初期保有額（円）
  multiplier: 2,       // 増殖係数
  groupSize: 4,        // 1グループの人数（0 = 全員で1グループ）
  punishment: false,   // 罰則ルールの有無
  punishCost: 100,     // 罰を1回与えるのにかかる費用
  punishEffect: 300,   // 罰1回で相手から減る金額
  punishMax: 3,        // 1人の相手に与えられる罰の最大回数
  showNames: false,    // グループ内でニックネームを見せるか（false = A, B, C… の匿名表示）
  autoAdvance: true,   // 全員が入力したら自動で締め切る
  acceptJoin: true,    // 新しい参加を受け付ける
  acceptComments: false, // 振り返りコメントを受け付ける
});

const LIMITS = {
  endowment: [100, 1000000],
  multiplier: [1, 10],
  groupSize: [0, 100],
  punishCost: [0, 1000000],
  punishEffect: [0, 1000000],
  punishMax: [1, 20],
};

const BOOL_KEYS = ['punishment', 'showNames', 'autoAdvance', 'acceptJoin', 'acceptComments'];

export function sanitizeSettings(input) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const raw = Number(input?.[key]);
    if (!Number.isFinite(raw)) continue;
    const value = key === 'multiplier' ? Math.round(raw * 100) / 100 : Math.round(raw);
    out[key] = Math.min(max, Math.max(min, value));
  }
  for (const key of BOOL_KEYS) {
    if (typeof input?.[key] === 'boolean') out[key] = input[key];
  }
  return out;
}

export function roundParams(settings) {
  return {
    endowment: settings.endowment,
    multiplier: settings.multiplier,
    punishCost: settings.punishCost,
    punishEffect: settings.punishEffect,
    punishMax: settings.punishMax,
  };
}

export function createState(roomCode, settings = {}) {
  return {
    v: 1,
    roomCode,
    createdAt: Date.now(),
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...settings }),
    players: {},
    nextPlayerNo: 1,
    groups: [],
    groupsFormedWithSize: null,
    phase: 'lobby', // lobby | contribute | punish | result | ended
    rounds: [],
    comments: [],
    nextCommentId: 1,
    blocked: [],
  };
}

// ---------------------------------------------------------------- 参加者

export function isValidPid(pid) {
  return typeof pid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(pid);
}

export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .slice(0, 16);
}

export function cleanComment(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim()
    .slice(0, 200);
}

export function addPlayer(state, pid, name) {
  if (!isValidPid(pid)) return { ok: false, reason: 'invalid' };
  if (state.blocked?.includes(pid)) return { ok: false, reason: 'removed' };
  const existing = state.players[pid];
  if (existing) {
    if (existing.removed) return { ok: false, reason: 'removed' };
    const n = cleanName(name);
    if (n) existing.name = n;
    return { ok: true, player: existing, rejoined: true };
  }
  if (!state.settings.acceptJoin) return { ok: false, reason: 'closed' };
  const no = state.nextPlayerNo++;
  const player = {
    pid,
    no,
    name: cleanName(name) || `参加者${no}`,
    joinedAt: Date.now(),
    groupId: null,
    label: null,
    removed: false,
  };
  state.players[pid] = player;
  return { ok: true, player, rejoined: false };
}

export function activePlayers(state) {
  return Object.values(state.players)
    .filter((p) => !p.removed)
    .sort((a, b) => a.no - b.no);
}

/** 参加者を外す。進行中の入力フェーズなら、そのラウンドからも外す。 */
export function removePlayer(state, pid) {
  const p = state.players[pid];
  if (!p) return false;
  for (const g of state.groups) g.members = g.members.filter((m) => m !== pid);
  state.groups = state.groups.filter((g) => g.members.length > 0);
  const round = currentRound(state);
  if (round && state.phase === 'contribute') {
    for (const g of round.groups) {
      g.members = g.members.filter((m) => m !== pid);
      delete g.labels[pid];
    }
    round.groups = round.groups.filter((g) => g.members.length > 0);
    delete round.contributions[pid];
    if (round.groups.length === 0) {
      state.rounds.pop();
      state.phase = state.rounds.length ? 'result' : 'lobby';
    }
  }
  p.groupId = null;
  p.label = null;
  const stillUsed = state.rounds.some((r) => r.groups.some((g) => g.members.includes(pid)));
  if (stillUsed) {
    // 過去のラウンドの記録に残っているので、データとしては保持する
    p.removed = true;
  } else {
    delete state.players[pid];
  }
  if (!state.blocked) state.blocked = [];
  state.blocked.push(pid);
  return true;
}

// ---------------------------------------------------------------- グループ

export function labelFor(index) {
  let s = '';
  let i = index;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/** n 人を目安 size 人のグループに分けたときの各グループの人数 */
export function groupSizes(n, size) {
  if (n <= 0) return [];
  if (!size || size <= 0 || n <= size) return [n];
  const g = Math.max(1, Math.round(n / size));
  const base = Math.floor(n / g);
  const extra = n % g;
  return Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0));
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextGroupId(state) {
  return state.groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
}

function unusedLabel(state, group) {
  const used = new Set(group.members.map((pid) => state.players[pid]?.label));
  let i = 0;
  while (used.has(labelFor(i))) i++;
  return labelFor(i);
}

/** 全員をシャッフルしてグループを組み直す */
export function formGroups(state, rng = Math.random) {
  const players = shuffle(activePlayers(state), rng);
  const sizes = groupSizes(players.length, state.settings.groupSize);
  for (const p of Object.values(state.players)) {
    p.groupId = null;
    p.label = null;
  }
  state.groups = [];
  let k = 0;
  sizes.forEach((sz, gi) => {
    const members = players.slice(k, k + sz);
    k += sz;
    const group = { id: gi + 1, members: members.map((p) => p.pid) };
    members.forEach((p, i) => {
      p.groupId = group.id;
      p.label = labelFor(i);
    });
    state.groups.push(group);
  });
  state.groupsFormedWithSize = state.settings.groupSize;
}

/** 途中参加者をグループに入れる（人数がまとまっていれば新しいグループを作る） */
export function placeUnassigned(state, rng = Math.random) {
  for (const g of state.groups) {
    g.members = g.members.filter((pid) => state.players[pid] && !state.players[pid].removed);
  }
  state.groups = state.groups.filter((g) => g.members.length > 0);
  if (state.groups.length === 0) {
    formGroups(state, rng);
    return;
  }
  const ids = new Set(state.groups.map((g) => g.id));
  let waiting = shuffle(
    activePlayers(state).filter((p) => p.groupId == null || !ids.has(p.groupId)),
    rng,
  );
  const size = state.settings.groupSize;
  if (size > 0 && waiting.length >= Math.max(2, size - 1)) {
    const sizes = groupSizes(waiting.length, size);
    for (const sz of sizes) {
      const members = waiting.slice(0, sz);
      waiting = waiting.slice(sz);
      const group = { id: nextGroupId(state), members: members.map((p) => p.pid) };
      members.forEach((p, i) => {
        p.groupId = group.id;
        p.label = labelFor(i);
      });
      state.groups.push(group);
    }
  }
  for (const p of waiting) {
    const target = [...state.groups].sort((a, b) => a.members.length - b.members.length || a.id - b.id)[0];
    p.label = unusedLabel(state, target);
    p.groupId = target.id;
    target.members.push(p.pid);
  }
}

export function unassignedPlayers(state) {
  const ids = new Set(state.groups.map((g) => g.id));
  return activePlayers(state).filter((p) => p.groupId == null || !ids.has(p.groupId));
}

// ---------------------------------------------------------------- ラウンド進行

export function currentRound(state) {
  return state.rounds.length ? state.rounds[state.rounds.length - 1] : null;
}

function stageFor(state, round) {
  const idx = state.rounds.indexOf(round);
  const prev = idx > 0 ? state.rounds[idx - 1] : null;
  if (!prev) return 1;
  return prev.punishment === round.punishment ? prev.stage : prev.stage + 1;
}

export function canStartRound(state) {
  return (state.phase === 'lobby' || state.phase === 'result') && activePlayers(state).length > 0;
}

export function startRound(state, rng = Math.random) {
  if (!canStartRound(state)) return { ok: false, reason: 'phase' };
  if (state.groups.length === 0) formGroups(state, rng);
  else placeUnassigned(state, rng);
  const s = state.settings;
  const round = {
    no: state.rounds.length + 1,
    stage: 1,
    punishment: s.punishment,
    params: roundParams(s),
    groups: state.groups.map((g) => ({
      id: g.id,
      members: [...g.members],
      labels: Object.fromEntries(g.members.map((pid) => [pid, state.players[pid].label])),
    })),
    contributions: {},
    missing: [],
    punishments: {},
    results: null,
    groupStats: null,
    startedAt: Date.now(),
    closedAt: null,
  };
  state.rounds.push(round);
  round.stage = stageFor(state, round);
  state.phase = 'contribute';
  return { ok: true, round };
}

/** 入力中のラウンドに、変更された設定（罰則の有無など）を反映する */
export function syncRoundSettings(state) {
  const round = currentRound(state);
  if (!round || state.phase !== 'contribute') return;
  round.punishment = state.settings.punishment;
  round.params = roundParams(state.settings);
  round.stage = stageFor(state, round);
  for (const pid of Object.keys(round.contributions)) {
    round.contributions[pid] = Math.min(round.contributions[pid], round.params.endowment);
  }
}

export function findMembership(round, pid) {
  if (!round) return null;
  for (const g of round.groups) {
    if (g.members.includes(pid)) return g;
  }
  return null;
}

export function submitContribution(state, pid, amount) {
  const round = currentRound(state);
  if (state.phase !== 'contribute' || !round) return { ok: false, reason: 'phase' };
  if (!findMembership(round, pid)) return { ok: false, reason: 'not-in-round' };
  const value = Number(amount);
  if (!Number.isFinite(value)) return { ok: false, reason: 'invalid' };
  round.contributions[pid] = Math.min(round.params.endowment, Math.max(0, Math.round(value)));
  return { ok: true };
}

export function submitPunishment(state, pid, alloc) {
  const round = currentRound(state);
  if (state.phase !== 'punish' || !round) return { ok: false, reason: 'phase' };
  const group = findMembership(round, pid);
  if (!group) return { ok: false, reason: 'not-in-round' };
  const byLabel = Object.fromEntries(group.members.map((m) => [group.labels[m], m]));
  const clean = {};
  if (alloc && typeof alloc === 'object') {
    for (const [label, units] of Object.entries(alloc)) {
      const target = byLabel[label];
      if (!target || target === pid) continue;
      const u = Math.round(Number(units));
      if (!Number.isFinite(u) || u <= 0) continue;
      clean[target] = Math.min(round.params.punishMax, u);
    }
  }
  round.punishments[pid] = clean;
  return { ok: true };
}

export function progress(state) {
  const round = currentRound(state);
  const res = { submitted: 0, total: 0, groups: {} };
  if (!round || (state.phase !== 'contribute' && state.phase !== 'punish')) return res;
  const store = state.phase === 'contribute' ? round.contributions : round.punishments;
  for (const g of round.groups) {
    let done = 0;
    for (const pid of g.members) if (store[pid] !== undefined) done++;
    res.groups[g.id] = { submitted: done, total: g.members.length };
    res.submitted += done;
    res.total += g.members.length;
  }
  return res;
}

export function allSubmitted(state) {
  const p = progress(state);
  return p.total > 0 && p.submitted === p.total;
}

export function computeResults(round) {
  const { endowment: E, multiplier: m, punishCost, punishEffect } = round.params;
  const results = {};
  const groupStats = {};
  const missing = new Set(round.missing);
  for (const g of round.groups) {
    const n = g.members.length;
    const sum = g.members.reduce((acc, pid) => acc + (round.contributions[pid] ?? 0), 0);
    const share = n > 0 ? (m * sum) / n : 0;
    let totalPayoff = 0;
    for (const pid of g.members) {
      const c = round.contributions[pid] ?? 0;
      const gross = E - c + share;
      let given = 0;
      let received = 0;
      if (round.punishment) {
        for (const target of g.members) {
          if (target === pid) continue;
          given += round.punishments[pid]?.[target] ?? 0;
          received += round.punishments[target]?.[pid] ?? 0;
        }
      }
      const cost = given * punishCost;
      const loss = received * punishEffect;
      const payoff = gross - cost - loss;
      totalPayoff += payoff;
      results[pid] = {
        groupId: g.id,
        label: g.labels[pid],
        contribution: c,
        missing: missing.has(pid),
        groupN: n,
        groupSum: sum,
        share,
        gross,
        punishGiven: given,
        punishReceived: received,
        cost,
        loss,
        payoff,
      };
    }
    groupStats[g.id] = {
      n,
      sum,
      avg: n > 0 ? sum / n : 0,
      rate: n > 0 ? sum / (n * E) : 0,
      totalPayoff,
      efficiency: n > 0 ? totalPayoff / (n * E * m) : 0,
    };
  }
  round.results = results;
  round.groupStats = groupStats;
  return results;
}

export function closeContributions(state) {
  const round = currentRound(state);
  if (state.phase !== 'contribute' || !round) return { ok: false };
  round.missing = [];
  for (const g of round.groups) {
    for (const pid of g.members) {
      if (round.contributions[pid] === undefined) {
        round.contributions[pid] = 0;
        round.missing.push(pid);
      }
    }
  }
  if (round.punishment) {
    state.phase = 'punish';
  } else {
    computeResults(round);
    round.closedAt = Date.now();
    state.phase = 'result';
  }
  return { ok: true };
}

export function closePunishment(state) {
  const round = currentRound(state);
  if (state.phase !== 'punish' || !round) return { ok: false };
  computeResults(round);
  round.closedAt = Date.now();
  state.phase = 'result';
  return { ok: true };
}

/** 進行中のラウンドを取り消す（操作ミス用） */
export function cancelRound(state) {
  if (state.phase !== 'contribute' && state.phase !== 'punish') return { ok: false };
  state.rounds.pop();
  state.phase = state.rounds.length ? 'result' : 'lobby';
  return { ok: true };
}

export function endGame(state) {
  if (state.phase !== 'result' && state.phase !== 'lobby') return { ok: false };
  state.phase = 'ended';
  return { ok: true };
}

export function resumeGame(state) {
  if (state.phase !== 'ended') return { ok: false };
  state.phase = state.rounds.length ? 'result' : 'lobby';
  return { ok: true };
}

export function addComment(state, text) {
  if (!state.settings.acceptComments) return { ok: false, reason: 'closed' };
  const t = cleanComment(text);
  if (!t) return { ok: false, reason: 'empty' };
  const c = { id: state.nextCommentId++, text: t, at: Date.now(), hidden: false };
  state.comments.push(c);
  return { ok: true, comment: c };
}

// ---------------------------------------------------------------- 集計

export function completedRounds(state) {
  return state.rounds.filter((r) => r.results);
}

export function classSeries(state) {
  return completedRounds(state).map((r) => {
    const pids = Object.keys(r.results);
    const n = pids.length;
    const sumC = pids.reduce((a, pid) => a + r.results[pid].contribution, 0);
    const sumPay = pids.reduce((a, pid) => a + r.results[pid].payoff, 0);
    const E = r.params.endowment;
    return {
      no: r.no,
      stage: r.stage,
      punishment: r.punishment,
      n,
      avgContribution: n ? sumC / n : 0,
      rate: n ? sumC / (n * E) : 0,
      avgPayoff: n ? sumPay / n : 0,
      efficiency: n ? sumPay / (n * E * r.params.multiplier) : 0,
      punishUnits: pids.reduce((a, pid) => a + r.results[pid].punishGiven, 0),
      groups: Object.fromEntries(Object.entries(r.groupStats).map(([gid, gs]) => [gid, gs])),
    };
  });
}

export function totals(state) {
  const t = {};
  for (const r of completedRounds(state)) {
    for (const [pid, res] of Object.entries(r.results)) t[pid] = (t[pid] ?? 0) + res.payoff;
  }
  return t;
}

function memberEntry(state, round, group, pid, viewerPid) {
  const label = group.labels[pid];
  return {
    label,
    name: state.settings.showNames ? state.players[pid]?.name ?? '' : null,
    me: pid === viewerPid,
  };
}

/** 参加者ごとの表示用データ（他の参加者の個人情報は匿名化して含める） */
export function playerView(state, pid, ctx = {}) {
  const p = state.players[pid];
  const s = state.settings;
  const series = ctx.series ?? classSeries(state);
  const round = currentRound(state);
  const phase = state.phase;
  const roundActive = round && (phase === 'contribute' || phase === 'punish' || phase === 'result' || phase === 'ended');
  const membership = roundActive ? findMembership(round, pid) : null;

  const view = {
    t: 'view',
    v: PROTOCOL_VERSION,
    room: state.roomCode,
    phase,
    roundNo: round ? round.no : 0,
    stage: round ? round.stage : 1,
    punishment: round && phase !== 'lobby' && phase !== 'ended' && phase !== 'result' ? round.punishment : s.punishment,
    nextPunishment: s.punishment,
    params: round && (phase === 'contribute' || phase === 'punish') ? round.params : roundParams(s),
    showNames: s.showNames,
    acceptComments: s.acceptComments,
    me: p
      ? { pid, no: p.no, name: p.name, groupId: p.groupId, label: p.label }
      : { pid, no: null, name: '', groupId: null, label: null },
    inRound: Boolean(membership),
    group: null,
    my: null,
    progress: null,
    reveal: null,
    result: null,
    history: [],
    classSeries: series.map((x) => ({ no: x.no, stage: x.stage, punishment: x.punishment, avg: x.avgContribution })),
    total: 0,
    summary: null,
  };

  // 現在のグループ
  const groupSrc = membership
    ? membership
    : state.groups.find((g) => g.members.includes(pid))
      ? (() => {
          const g = state.groups.find((gg) => gg.members.includes(pid));
          return { id: g.id, members: g.members, labels: Object.fromEntries(g.members.map((m) => [m, state.players[m]?.label])) };
        })()
      : null;
  if (groupSrc) {
    view.group = {
      id: groupSrc.id,
      size: groupSrc.members.length,
      members: groupSrc.members.map((m) => memberEntry(state, round, groupSrc, m, pid)),
    };
  }

  if (membership && (phase === 'contribute' || phase === 'punish')) {
    const pr = ctx.progress ?? progress(state);
    // クラス全体の進捗は含めない（誰かが入力するたびに全員へ送り直すことになるため）
    view.progress = {
      group: pr.groups[membership.id] ?? { submitted: 0, total: 0 },
    };
  }

  if (membership) {
    const myPunish = round.punishments[pid];
    view.my = {
      contribution: round.contributions[pid] ?? null,
      punishment: myPunish
        ? Object.fromEntries(Object.entries(myPunish).map(([target, u]) => [membership.labels[target], u]))
        : null,
    };
    if (phase === 'contribute' && round.missing.includes(pid)) view.my.contribution = null;
  }

  if (membership && (phase === 'punish' || ((phase === 'result' || phase === 'ended') && round.results))) {
    view.reveal = membership.members.map((m) => ({
      ...memberEntry(state, round, membership, m, pid),
      contribution: round.contributions[m] ?? 0,
      missing: round.missing.includes(m),
    }));
  }

  if (membership && round.results && (phase === 'result' || phase === 'ended')) {
    const r = round.results[pid];
    const gs = round.groupStats[membership.id];
    const classAvg = series.find((x) => x.no === round.no)?.avgContribution ?? 0;
    view.result = {
      ...r,
      punishment: round.punishment,
      params: round.params,
      groupAvg: gs.avg,
      groupEfficiency: gs.efficiency,
      classAvg,
      members: membership.members.map((m) => ({
        ...memberEntry(state, round, membership, m, pid),
        contribution: round.results[m].contribution,
        missing: round.results[m].missing,
        payoff: round.results[m].payoff,
        punishReceived: round.results[m].punishReceived,
      })),
    };
  }

  let cumulative = 0;
  for (const r of completedRounds(state)) {
    const res = r.results[pid];
    if (!res) continue;
    cumulative += res.payoff;
    const gs = r.groupStats[res.groupId];
    view.history.push({
      no: r.no,
      stage: r.stage,
      punishment: r.punishment,
      endowment: r.params.endowment,
      contribution: res.contribution,
      missing: res.missing,
      groupN: res.groupN,
      groupSum: res.groupSum,
      groupAvg: gs.avg,
      classAvg: series.find((x) => x.no === r.no)?.avgContribution ?? 0,
      share: res.share,
      gross: res.gross,
      cost: res.cost,
      loss: res.loss,
      payoff: res.payoff,
      cumulative,
    });
  }
  view.total = cumulative;

  if (phase === 'ended') {
    const t = ctx.totals ?? totals(state);
    const vals = Object.values(t);
    const played = view.history.length;
    let best = 0;
    let worst = 0;
    for (const r of completedRounds(state)) {
      if (!r.results[pid]) continue;
      best += r.params.endowment * r.params.multiplier;
      worst += r.params.endowment;
    }
    view.summary = {
      rounds: played,
      myTotal: cumulative,
      classAvgTotal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
      bestCase: best,
      worstCase: worst,
    };
  }

  return view;
}

// ---------------------------------------------------------------- 書き出し

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function round1(x) {
  return Math.round(x * 10) / 10;
}

export function toCSV(state) {
  const header = [
    'ラウンド', 'ステージ', '罰則', 'グループ', '記号', 'ニックネーム', '初期保有額', '増殖係数', 'グループ人数',
    '拠出額', '未入力', 'グループ合計拠出', '分配額', '罰則前の利得', '罰を与えた回数', '罰の費用', '罰を受けた回数', '罰による減額',
    'このラウンドの利得', '累計利得',
  ];
  const rows = [header];
  const cum = {};
  for (const r of completedRounds(state)) {
    const pids = Object.keys(r.results).sort((a, b) => {
      const ra = r.results[a];
      const rb = r.results[b];
      return ra.groupId - rb.groupId || String(ra.label).localeCompare(String(rb.label));
    });
    for (const pid of pids) {
      const res = r.results[pid];
      cum[pid] = (cum[pid] ?? 0) + res.payoff;
      rows.push([
        r.no, r.stage, r.punishment ? 'あり' : 'なし', res.groupId, res.label, state.players[pid]?.name ?? '',
        r.params.endowment, r.params.multiplier, res.groupN, res.contribution, res.missing ? '未入力' : '',
        res.groupSum, round1(res.share), round1(res.gross), res.punishGiven, res.cost, res.punishReceived, res.loss,
        round1(res.payoff), round1(cum[pid]),
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
