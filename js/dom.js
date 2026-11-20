// 小さな DOM ヘルパー。利用者の入力は必ず textContent 経由で表示する（innerHTML は使わない）。

export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
  }
  append(e, children);
  return e;
}

function append(e, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(e, c);
    else if (c instanceof Node) e.appendChild(c);
    else e.appendChild(document.createTextNode(String(c)));
  }
}

export function replace(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

export const yen = (v) => `${Math.round(v).toLocaleString('ja-JP')}円`;
export const pct = (v) => `${Math.round(v * 100)}%`;

export function downloadText(filename, text, type = 'text/csv') {
  const bom = type.startsWith('text/csv') ? '\ufeff' : '';
  const blob = new Blob([bom + text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
