// 依存なしの小さな SVG 折れ線グラフ（ホスト・参加者で共通）

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  }
  if (text !== undefined) e.textContent = text;
  return e;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * p >= v) return m * p;
  }
  return 10 * p;
}

/**
 * @param {object} o
 * @param {string[]} o.xLabels    x 軸のラベル（ラウンド番号など）
 * @param {{name:string,values:(number|null)[],color:string,width?:number,dash?:string,dots?:boolean}[]} o.series
 * @param {boolean[]} [o.shade]   true のラウンドに背景色（罰則ありの期間）
 * @param {string} [o.shadeLabel]
 * @param {number} [o.yMax]
 * @param {number} [o.yMin]
 * @param {(v:number)=>string} [o.yFormat]
 * @param {string} [o.title]
 */
export function lineChart(o) {
  const W = o.width ?? 640;
  const H = o.height ?? 260;
  const pad = { l: 58, r: 14, t: 22, b: 34 };
  const n = o.xLabels.length;
  const all = o.series.flatMap((s) => s.values.filter((v) => v !== null && Number.isFinite(v)));
  const yMin = o.yMin ?? Math.min(0, ...all);
  const yMax = o.yMax ?? niceMax(Math.max(1, ...all));
  const fmt = o.yFormat ?? ((v) => String(Math.round(v)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const step = n > 1 ? iw / (n - 1) : 0;
  const xAt = (i) => (n > 1 ? pad.l + i * step : pad.l + iw / 2);
  const yAt = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart',
    role: 'img',
    'aria-label': o.title ?? 'グラフ',
    preserveAspectRatio: 'xMidYMid meet',
  });
  if (o.title) svg.appendChild(el('title', {}, o.title));

  // 罰則ありの期間の背景
  if (o.shade && n > 0) {
    const half = n > 1 ? step / 2 : iw / 2;
    let i = 0;
    while (i < n) {
      if (!o.shade[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && o.shade[j + 1]) j++;
      const x0 = Math.max(pad.l, xAt(i) - half);
      const x1 = Math.min(pad.l + iw, xAt(j) + half);
      svg.appendChild(el('rect', { x: x0, y: pad.t, width: Math.max(2, x1 - x0), height: ih, class: 'chart-shade' }));
      if (o.shadeLabel) {
        svg.appendChild(el('text', { x: x0 + 4, y: pad.t - 6, class: 'chart-shade-label' }, o.shadeLabel));
      }
      i = j + 1;
    }
  }

  // 目盛り
  const ticks = 4;
  for (let k = 0; k <= ticks; k++) {
    const v = yMin + ((yMax - yMin) * k) / ticks;
    const y = yAt(v);
    svg.appendChild(el('line', { x1: pad.l, x2: pad.l + iw, y1: y, y2: y, class: k === 0 && yMin === 0 ? 'chart-axis' : 'chart-grid' }));
    svg.appendChild(el('text', { x: pad.l - 8, y: y + 4, class: 'chart-tick', 'text-anchor': 'end' }, fmt(v)));
  }
  if (yMin < 0) {
    const y0 = yAt(0);
    svg.appendChild(el('line', { x1: pad.l, x2: pad.l + iw, y1: y0, y2: y0, class: 'chart-axis' }));
  }
  const every = Math.max(1, Math.ceil(n / 12));
  o.xLabels.forEach((lab, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    svg.appendChild(el('text', { x: xAt(i), y: H - 12, class: 'chart-tick', 'text-anchor': 'middle' }, lab));
  });

  // 系列
  for (const s of o.series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    if (d) {
      svg.appendChild(
        el('path', {
          d,
          fill: 'none',
          stroke: s.color,
          'stroke-width': s.width ?? 2.5,
          'stroke-dasharray': s.dash,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          opacity: s.opacity,
        }),
      );
    }
    if (s.dots !== false && n <= 40) {
      s.values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) return;
        const c = el('circle', { cx: xAt(i), cy: yAt(v), r: s.dotSize ?? 4, fill: s.color, class: 'chart-dot' });
        c.appendChild(el('title', {}, `${s.name} ${o.xLabels[i]}: ${fmt(v)}`));
        svg.appendChild(c);
      });
    }
  }
  return svg;
}

/** 凡例（HTML） */
export function legend(items) {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  for (const it of items) {
    const span = document.createElement('span');
    span.className = 'legend-item';
    const sw = document.createElement('i');
    sw.className = it.shade ? 'legend-swatch shade' : it.dash ? 'legend-swatch dash' : 'legend-swatch';
    if (!it.shade) sw.style.setProperty('--c', it.color);
    span.append(sw, document.createTextNode(it.name));
    wrap.appendChild(span);
  }
  return wrap;
}
