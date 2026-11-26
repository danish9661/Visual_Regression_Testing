/**
 * DOM/style profile of a rendered page, captured with Playwright.
 *
 * A screenshot diff says *that* pixels changed; this profile says *which element
 * attribute* changed (class, data-state, text, computed style, geometry). The two
 * branches are profiled with the same code, so paths are comparable.
 */

const STYLE_PROPS = [
  'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight',
  'display', 'visibility', 'opacity', 'transform', 'width', 'height',
  'marginTop', 'paddingTop', 'borderColor', 'textAlign'
];
const BOX_PROPS = ['x', 'y', 'width', 'height'];

const compact = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const shortValue = (value, max = 160) => {
  const text = compact(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Runs inside the page; returns plain data only. */
export async function captureDomProfile(page, { maxElements = 300 } = {}) {
  return page.evaluate(({ maxElements: limit, styleProps, boxProps }) => {
    const pathOf = (element) => {
      const parts = [];
      let node = element;
      while (node && node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((el) => el.tagName === node.tagName)
          : [];
        const index = siblings.length > 1 ? siblings.indexOf(node) + 1 : 0;
        parts.unshift(index ? `${tag}:nth-of-type(${index})` : tag);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };

    const elements = [];
    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length && elements.length < limit; i++) {
      const el = all[i];
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const data = {};
      const aria = {};
      for (const attr of el.attributes) {
        if (attr.name.startsWith('data-')) data[attr.name] = attr.value;
        else if (attr.name.startsWith('aria-')) aria[attr.name] = attr.value;
      }
      const styles = {};
      for (const prop of styleProps) styles[prop] = String(style[prop] ?? '');
      const box = {};
      for (const prop of boxProps) box[prop] = Math.round(rect[prop]);
      elements.push({
        path: pathOf(el),
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className : (el.className?.baseVal || ''),
        text: el.children.length === 0 ? (el.textContent || '').trim() : '',
        data,
        aria,
        styles,
        box,
        hidden: Boolean(el.hidden || el.disabled) || style.display === 'none' || style.visibility === 'hidden'
      });
    }
    return {
      title: document.title || '',
      scrollHeight: document.documentElement.scrollHeight,
      elements
    };
  }, { maxElements, styleProps: STYLE_PROPS, boxProps: BOX_PROPS });
}

/** Token list for the correlation engine, derived from a profile. */
export function domProfileTokens(profile) {
  if (!profile) return [];
  const tokens = new Set();
  const add = (token) => { if (token && tokens.size < 6000) tokens.add(token); };
  add(`text:${compact(profile.title)}`);
  add(`page:scrollHeight=${profile.scrollHeight}`);
  for (const el of profile.elements || []) {
    add(`tag:${el.tag}`);
    for (const cls of String(el.className || '').split(/\s+/)) add(`.${cls}`);
    if (el.id) add(`#${el.id}`);
    for (const [key, value] of Object.entries(el.data || {})) {
      add(`[${key}="${value}"]`);
      add(`state:${value}`);
      add(`id:${value}`);
    }
    for (const [key, value] of Object.entries(el.aria || {})) {
      add(`[${key}="${value}"]`);
      add(`state:${value}`);
      add(`id:${value}`);
    }
    if (el.text) add(`text:${compact(el.text)}`);
    for (const [prop, value] of Object.entries(el.styles || {})) {
      add(`css:${prop}=${String(value).replace(/\s+/g, '').toLowerCase()}`);
    }
  }
  return [...tokens];
}

/** Structural diff of two profiles, matched by stable element path. */
export function diffDomProfiles(base, head, { maxChanges = 150 } = {}) {
  if (!base || !head) return [];
  const headByPath = new Map((head.elements || []).map((el) => [el.path, el]));
  const baseByPath = new Map((base.elements || []).map((el) => [el.path, el]));
  const changes = [];
  const add = (path, attribute, before, after) => {
    if (String(before) === String(after)) return;
    changes.push({
      path,
      attribute,
      before: shortValue(before),
      after: shortValue(after)
    });
  };

  add('html', 'title', base.title, head.title);
  add('html', 'scrollHeight', base.scrollHeight, head.scrollHeight);

  for (const [path, before] of baseByPath) {
    const after = headByPath.get(path);
    if (!after) {
      add(path, 'element', 'present', 'removed');
      continue;
    }
    add(path, 'class', before.className, after.className);
    add(path, 'id', before.id, after.id);
    add(path, 'text', before.text, after.text);
    add(path, 'hidden', before.hidden, after.hidden);
    for (const key of new Set([...Object.keys(before.data || {}), ...Object.keys(after.data || {})])) {
      add(path, `data.${key}`, before.data?.[key] ?? '', after.data?.[key] ?? '');
    }
    for (const key of new Set([...Object.keys(before.aria || {}), ...Object.keys(after.aria || {})])) {
      add(path, `aria.${key}`, before.aria?.[key] ?? '', after.aria?.[key] ?? '');
    }
    for (const key of STYLE_PROPS) {
      add(path, `style.${key}`, before.styles?.[key] ?? '', after.styles?.[key] ?? '');
    }
    for (const key of BOX_PROPS) {
      const a = Number(before.box?.[key] ?? 0);
      const b = Number(after.box?.[key] ?? 0);
      if (Math.abs(a - b) >= 2) add(path, `box.${key}`, `${a}px`, `${b}px`);
    }
  }
  for (const path of headByPath.keys()) {
    if (!baseByPath.has(path)) add(path, 'element', 'absent', 'added');
  }

  return changes.slice(0, maxChanges);
}
