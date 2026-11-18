// F1 走查辅助：注入到真机页面，供后续 device-eval 调用。
// 用法：node tools/device-eval.mjs --file tools/f1-helpers.js
window.__f1 = {
  s: (ms) => new Promise((r) => setTimeout(r, ms)),
  by: (testid) => document.querySelector(`[data-testid="${testid}"]`),
  click(testid) {
    const el = this.by(testid);
    if (!el) throw new Error(`找不到 testid=${testid}`);
    el.click();
    return true;
  },
  ids: () => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid))],
  /** 顶栏/底栏/安全区/正文排版的几何与样式快照。 */
  metrics() {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        bg: cs.backgroundColor,
        blur: cs.backdropFilter || cs.webkitBackdropFilter,
        shadow: cs.boxShadow.slice(0, 60),
        transform: cs.transform,
        opacity: cs.opacity,
        visible: r.height > 0 && cs.visibility !== 'hidden',
      };
    };
    const art = document.querySelector('article');
    const ps = [...document.querySelectorAll('article p')].slice(0, 2).map((p) => {
      const cs = getComputedStyle(p);
      return { fs: cs.fontSize, lh: cs.lineHeight, mt: cs.marginTop, ff: cs.fontFamily.split(',')[0] };
    });
    return {
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      scrollY: Math.round(scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      body: { className: document.body.className, overflow: getComputedStyle(document.body).overflow },
      topbar: pick('.reader-topbar') ?? pick('[class*="topbar"]'),
      bottombar: pick('.reader-bottom, .reader-bottombar, [class*="bottombar"]'),
      tabbar: pick('[data-testid="tabbar"]'),
      article: art
        ? { fs: getComputedStyle(art).fontSize, rect: art.getBoundingClientRect().height | 0, nodes: art.querySelectorAll('*').length }
        : null,
      paragraphs: ps,
      // env(safe-area-inset-*) 的实际取值：用一个临时探针量出来
      insets: (() => {
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:fixed;top:0;left:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);visibility:hidden';
        document.body.append(probe);
        const cs = getComputedStyle(probe);
        const v = { top: cs.paddingTop, bottom: cs.paddingBottom };
        probe.remove();
        return v;
      })(),
    };
  },
  /** 统计当前可见的 backdrop-filter 层（任务书 ≤3）。 */
  glassCount: () =>
    [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el);
      const f = cs.backdropFilter || cs.webkitBackdropFilter;
      return f && f !== 'none' && el.getBoundingClientRect().height > 0;
    }).length,
  /** 横向溢出检查。 */
  overflowX: () => {
    const bad = [...document.querySelectorAll('body *')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} sw=${el.scrollWidth} cw=${el.clientWidth}`);
    return { docOverflow: document.documentElement.scrollWidth > innerWidth, bad };
  },
};
'helper-installed';
