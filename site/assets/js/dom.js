// Tiny DOM helpers. Everything goes in through textContent or attributes, never as HTML strings, so chat text can never become markup.

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
// An icon from the sprite in assets/icons.svg (the sprite lives next to the page's assets folder).
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', ('ico ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `/assets/icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

export const initials = (name) => (String(name).trim()[0] || '?').toUpperCase();
// A person's avatar colour is one of three flat tints, chosen from their name so it stays the same everywhere.
export const tint = (name) => 1 + ([...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % 3);
export function avatar(name, agent = false) {
  return el('span', { class: agent ? 'av av--agent' : `av ${tint(name) > 1 ? 'av--' + tint(name) : ''}`.trim(), 'aria-hidden': 'true', text: agent ? 'A' : initials(name) });
}

export const age = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
export const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
export const money = (n) => `$${Number(n).toFixed(2)}`;
export const clock = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
export const tidy = (s, max = 70) => { const one = String(s ?? '').replace(/\s+/g, ' ').trim(); return one.length > max ? one.slice(0, max - 1) + '…' : one; };

// A small, safe markdown subset for the agent's replies and the memory summary: paragraphs, "- " lists, `code`, **bold**,
// and ``` fences. It builds elements (never HTML strings), so nothing in the text can become markup.
function inline(s) {
  const out = [];
  for (const chunk of s.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!chunk) continue;
    if (chunk.startsWith('`') && chunk.length > 2) out.push(el('code', { class: 'md-code', text: chunk.slice(1, -1) }));
    else if (chunk.startsWith('**') && chunk.length > 4) out.push(el('strong', { text: chunk.slice(2, -2) }));
    else out.push(chunk);
  }
  return out;
}
export function markdown(text) {
  const out = [];
  String(text).split('```').forEach((part, i) => {
    if (i % 2) { out.push(el('pre', { class: 'sx-code' }, part.replace(/^\w*\n/, '').trimEnd())); return; }
    for (const para of part.split(/\n{2,}/)) {
      let list = null;
      const flush = () => { if (list) { out.push(list); list = null; } };
      let block = [];
      const flushBlock = () => { if (block.length) { out.push(el('p', {}, ...block.flatMap((l, k) => [k ? el('br') : null, ...inline(l)]))); block = []; } };
      for (const line of para.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())) {
        const li = /^\s*[-*] (.*)$/.exec(line);
        if (li) { flushBlock(); (list ??= el('ul', { class: 'md-list' })).append(el('li', {}, ...inline(li[1]))); }
        else { flush(); block.push(line); }
      }
      flushBlock(); flush();
    }
  });
  return out;
}

// "Read {"file_path":"~/notes-app/src/auth.js"}" becomes "Read  ~/notes-app/src/auth.js": the thing the tool touched.
export function toolLabel(name, rest) {
  const pick = (re) => re.exec(rest)?.[1];
  const what = pick(/"(?:file_path|path|notebook_path)":"((?:[^"\\]|\\.)*)"/) ?? pick(/"command":"((?:[^"\\]|\\.)*)"/) ?? pick(/"pattern":"((?:[^"\\]|\\.)*)"/) ?? rest;
  return tidy(String(what).replace(/\\\\/g, '/').replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\/{2,}/g, '/'), 90);
}
