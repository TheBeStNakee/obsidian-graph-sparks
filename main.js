// Graph Sparks: turns Obsidian's core graph view into a small piece of deep space.
// - some notes quietly emit tiny dots (their own colour) that travel along links to neighbours
// - soft glow halo behind every node, hubs breathe and flash when they emit
// - links tinted by the colours of the notes they connect
// - three-layer starfield, nebulae and rare sky events (shooting stars, flares, comets, showers)
// - softer node-size scale; notes without a colour group get a colour by their folder
// Every effect can be switched and tuned in Settings -> Graph Sparks.
const { Plugin, PluginSettingTab, Setting } = require('obsidian');

const DEFAULTS = {
  sparks: true, emitters: 0.275, sparkSpeed: 1, sparkSize: 2.8,
  glow: true, glowStrength: 0.5, breathing: true,
  coloredLinks: true, linkTint: 1,
  balancedSizes: true, folderColors: true,
  stars: true, starDensity: 1,
  nebulae: true, nebulaBrightness: 0.2,
  skyEvents: true, eventFrequency: 1, eventsBehind: 0.35,
};
let S = { ...DEFAULTS };   // live settings, shared by all graph views

// fixed tuning that is not worth a setting
const CFG = {
  every: [1.2, 3.5],  // seconds between dots from one emitter
  speed: 140,         // graph units per second
  trail: 2,           // tiny fading ghosts behind each dot
  reshuffle: 20,      // seconds; emitters slowly change
  glowSize: 4.2,      // halo radius / node radius
  hubWeight: 25,      // nodes with this many links breathe
  stars: [700, 130, 16],   // far / mid / bright stars at density 1
  events: { shoot: [35, 100], flare: [80, 180], comet: [250, 500], shower: [420, 750] },   // seconds [min, max]
  nebula: [0x3a4bd0, 0x7b3fc4, 0x1f8a9a, 0xb5652a],
};

// notes with no colour group get a colour by their top folder, so a fresh vault looks right too
const PALETTE = [0x5b8def, 0x4dd0e1, 0x5fd35f, 0xf2d024, 0x9b7cf0, 0xef7b6a, 0x58c7e8, 0xf0a35e, 0x7ee0b5, 0xe58bd8];
const folderColor = (id) => {
  const top = id.includes('/') ? id.split('/')[0] : '';
  if (!top) return 0xf2d024;   // notes in the vault root
  let h = 0; for (const ch of top) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
// recommended graph settings, applied once on first run and from the settings tab
const GRAPH_DEFAULTS = {
  showOrphans: false, showArrow: false, textFadeMultiplier: 1.9, nodeSizeMultiplier: 0.91, lineSizeMultiplier: 0.44,
  centerStrength: 0.6, repelStrength: 11, linkStrength: 0.45, linkDistance: 220,
};

function radial(PIXI, stops) {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, a] of stops) grd.addColorStop(o, 'rgba(255,255,255,' + a + ')');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  return PIXI.Texture.from(c);
}

const rnd = (a, b) => a + Math.random() * (b - a);
const fill = (n) => { try { const c = n.getFillColor(); return c && typeof c.rgb === 'number' ? c.rgb : 0xfff1c4; } catch (e) { return 0xfff1c4; } };
const mix = (a, b, t) => {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

class Sparks {
  constructor(renderer, local) {
    this.r = renderer; this.local = local; this.dots = []; this.free = []; this.emit = new Map();
    this.glows = new Map(); this.stars = []; this.last = 0; this.shuffleAt = 0; this.time = 0;
    const PIXI = window.PIXI;
    this.dotTex = radial(PIXI, [[0, 1], [0.18, 0.85], [0.3, 0.18], [0.5, 0]]);
    this.glowTex = radial(PIXI, [[0, 0.9], [0.22, 0.5], [0.5, 0.14], [1, 0]]);
    this.layer = new PIXI.Container(); this.layer.eventMode = 'none';
    this.glowLayer = new PIXI.Container(); this.glowLayer.eventMode = 'none';
    this.starLayer = new PIXI.Container(); this.starLayer.eventMode = 'none';
    this.nebula = []; this.events = []; this.nextEvt = null;
    // world layer: under the graph, moves and zooms with it (nebulae, comets, shooting stars)
    this.worldLayer = new PIXI.Container(); this.worldLayer.eventMode = 'none';
    this.win = renderer.containerEl.win || window;
    this.loop = (t) => { this.frame(t); if (!this.dead) this.raf = this.win.requestAnimationFrame(this.loop); };
    this.raf = this.win.requestAnimationFrame(this.loop);
  }
  attach() {
    const h = this.r.hanger, st = this.r.px.stage;
    if (h.children[0] !== this.glowLayer) h.addChildAt(this.glowLayer, 0);
    if (h.children[h.children.length - 1] !== this.layer) h.addChild(this.layer);
    if (st.children[0] !== this.starLayer) st.addChildAt(this.starLayer, 0);
    if (st.children[1] !== this.worldLayer) st.addChildAt(this.worldLayer, 1);
    this.worldLayer.position.set(h.x, h.y); this.worldLayer.scale.set(h.scale.x, h.scale.y);
  }
  sprite(tex, layer) {
    const s = (tex === this.dotTex && layer === this.layer && this.free.pop()) || new window.PIXI.Sprite(tex);
    s.anchor.set(0.5); s.visible = true;
    if (s.parent !== layer) layer.addChild(s);
    return s;
  }
  links(n) { return this.r.links.filter(l => l.source === n || l.target === n); }
  shuffle() {
    const nodes = (this.r.nodes || []).filter(n => this.links(n).length >= 2);
    const share = this.local ? Math.min(1, S.emitters * 2.2) : S.emitters, keep = new Map();
    for (const n of nodes) if (Math.random() < share) keep.set(n, this.emit.get(n) || { wait: rnd(0, CFG.every[1]) });
    this.emit = keep;
  }
  launch(from, link) {
    const to = link.source === from ? link.target : link.source;
    const head = this.sprite(this.dotTex, this.layer), ghosts = [];
    for (let k = 0; k < CFG.trail; k++) ghosts.push(this.sprite(this.dotTex, this.layer));
    this.dots.push({ a: from, b: to, t: 0, v: CFG.speed * rnd(0.75, 1.3), color: fill(from), head, ghosts });
    from.__sparkFlash = 1;
  }
  clearStars() {
    for (const p of this.stars) { p.s.destroy(); if (p.halo) p.halo.destroy(); }
    this.stars = [];
  }
  starsFrame(dt) {
    const r = this.r, d = window.devicePixelRatio || 1, W = r.width * d, H = r.height * d;
    if (!W || !H) return;
    this.starLayer.visible = S.stars;
    if (S.stars && !this.stars.length) {
      // far: many tiny dim, barely move; mid: visible, twinkle; bright: few with a soft halo
      const k = S.starDensity, tiers = [
        { n: Math.round(CFG.stars[0] * k), rad: [0.35, 0.8], a: [0.25, 0.6], z: [0.004, 0.012], tw: [0.3, 1.2] },
        { n: Math.round(CFG.stars[1] * k), rad: [0.8, 1.4], a: [0.5, 0.85], z: [0.015, 0.03], tw: [0.6, 1.8] },
        { n: Math.round(CFG.stars[2] * k), rad: [1.4, 2.1], a: [0.8, 1], z: [0.03, 0.05], tw: [0.4, 1], halo: true },
      ];
      const hues = [0xffffff, 0xcfe0ff, 0xa9c8ff, 0xfff1d6, 0xffd9a8];
      for (const t of tiers) for (let i = 0; i < t.n; i++) {
        const s = this.sprite(this.dotTex, this.starLayer);
        s.tint = hues[(Math.random() * hues.length) | 0];
        let halo = null;
        if (t.halo) { halo = this.sprite(this.glowTex, this.starLayer); halo.tint = s.tint; halo.blendMode = window.PIXI.BLEND_MODES.ADD; }
        this.stars.push({ s, halo, x: Math.random(), y: Math.random(), vx: rnd(-1.5, 1.5), vy: rnd(-0.8, 0.8),
          z: rnd(...t.z), rad: rnd(...t.rad) * d, a: rnd(...t.a), ph: rnd(0, 6.3), tw: rnd(...t.tw) });
      }
    }
    while (this.nebula.length < CFG.nebula.length) {
      const i = this.nebula.length, s = new window.PIXI.Sprite(this.glowTex);
      s.anchor.set(0.5); s.tint = CFG.nebula[i]; s.blendMode = window.PIXI.BLEND_MODES.ADD;
      this.worldLayer.addChildAt(s, 0);
      this.nebula.push({ s, ph: i * 1.7, sp: rnd(0.03, 0.06), rx: rnd(0.3, 0.42), ry: rnd(0.25, 0.35), k: rnd(0.9, 1.2) });
    }
    const gd = this.disc();
    for (const n of this.nebula) {
      n.s.visible = S.nebulae && !!gd;
      if (!n.s.visible) continue;
      const a = this.time * n.sp + n.ph;
      n.s.x = gd.x + gd.R * 4 * n.rx * Math.cos(a);
      n.s.y = gd.y + gd.R * 4.4 * n.ry * Math.sin(a * 1.3);
      n.s.scale.set((gd.R * 2.2 * n.k) / 64);
      n.s.alpha = S.nebulaBrightness * (1 + 0.25 * Math.sin(a * 2.1));
    }
    if (S.stars) for (const p of this.stars) {
      p.x += (p.vx * dt) / W; p.y += (p.vy * dt) / H;
      // slight parallax with panning; wrap around the view
      p.s.x = (((p.x * W + r.panX * p.z) % W) + W) % W;
      p.s.y = (((p.y * H + r.panY * p.z) % H) + H) % H;
      p.s.scale.set(p.rad / 11);
      const tw = 0.65 + 0.35 * Math.sin(this.time * p.tw + p.ph);
      p.s.alpha = p.a * tw;
      if (p.halo) { p.halo.x = p.s.x; p.halo.y = p.s.y; p.halo.scale.set((p.rad * 7) / 32); p.halo.alpha = 0.18 * tw; }
    }
    this.skyEvents(dt, W, H);
  }
  fx(tex, tint, layer) {
    const s = new window.PIXI.Sprite(tex); s.anchor.set(0.5); s.tint = tint;
    s.blendMode = window.PIXI.BLEND_MODES.ADD; (layer || this.worldLayer).addChild(s); return s;
  }
  // soft horizontal streak: transparent tail -> bright head (right edge)
  tailTex() {
    if (this._tail) return this._tail;
    const c = document.createElement('canvas'); c.width = 256; c.height = 16;
    const g = c.getContext('2d'), lg = g.createLinearGradient(0, 0, 256, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.7, 'rgba(255,255,255,0.35)'); lg.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = lg;
    for (let y = 0; y < 16; y++) { g.globalAlpha = Math.pow(Math.sin(Math.PI * (y + 0.5) / 16), 3); g.fillRect(0, y, 256, 1); }
    return (this._tail = window.PIXI.Texture.from(c));
  }
  // moving glowing head with a smooth tail; used by shooting stars and comets
  streak(x, y, ang, speed, life, opt) {
    const d = opt.u;   // size unit in graph space
    const tail = this.fx(this.tailTex(), opt.tint), head = this.fx(opt.headTex, opt.tint);
    tail.anchor.set(1, 0.5); tail.rotation = ang;
    this.events.push({ t: 0, life, sprites: [tail, head], step: (e, dt) => {
      x += Math.cos(ang) * speed * dt; y += Math.sin(ang) * speed * dt;
      const env = Math.sin(Math.PI * Math.min(1, e.t / life)), grow = Math.min(1, e.t / (life * 0.3));
      head.x = tail.x = x; head.y = tail.y = y;
      head.alpha = env * opt.a; head.scale.set((opt.head * d) / 32);
      tail.alpha = env * opt.a * 0.9; tail.width = opt.len * d * grow; tail.height = opt.w * d;
    } });
  }
  // the graph ball in graph units: events keep out of it (most of the time)
  disc() {
    const r = this.r, ns = r.nodes; if (!ns.length) return null;
    let x = 0, y = 0; for (const n of ns) { x += n.x; y += n.y; } x /= ns.length; y /= ns.length;
    let R = 0; for (const n of ns) R = Math.max(R, Math.hypot(n.x - x, n.y - y));
    return { x, y, R: R * 1.08 + 30 / (r.scale || 1), u: R / 600 };
  }
  clear(x0, y0, x1, y1) {   // segment stays outside the graph disc
    const c = this.disc(); if (!c) return true;
    const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((c.x - x0) * dx + (c.y - y0) * dy) / L));
    return Math.hypot(x0 + dx * t - c.x, y0 + dy * t - c.y) > c.R;
  }
  shootingStar(W, H, ang) {
    const c = this.disc(); if (!c) return;
    const d = c.u, dir = Math.random() < 0.5 ? 1 : -1;
    ang = ang != null ? ang : (dir > 0 ? rnd(0.35, 0.8) : Math.PI - rnd(0.35, 0.8));
    const sp = rnd(1.6, 2.4) * c.R, life = rnd(0.6, 1.0);
    const free = Math.random() < S.eventsBehind;   // world layer sits under the graph, so it simply passes behind
    let x, y, ok = false;
    for (let i = 0; i < 25 && !ok; i++) {
      x = c.x + rnd(-2.6, 2.6) * c.R; y = c.y + rnd(-2.2, 1.6) * c.R;
      ok = free || this.clear(x - Math.cos(ang) * 200 * d, y - Math.sin(ang) * 200 * d, x + Math.cos(ang) * sp * life, y + Math.sin(ang) * sp * life);
    }
    if (!ok) return;
    this.streak(x, y, ang, sp, life,
      { headTex: this.glowTex, tint: 0xf4f8ff, head: 5, len: rnd(110, 190), w: 3, a: 1, u: d });
  }
  skyEvents(dt, W, H) {
    const E = CFG.events, now = this.time, f = Math.max(0.1, S.eventFrequency);
    const next = (k) => now + rnd(...E[k]) / f;
    if (!this.nextEvt) this.nextEvt = { shoot: next('shoot') * 0.3, flare: next('flare') * 0.5, comet: next('comet') * 0.4, shower: next('shower') };
    const due = (k) => { if (now < this.nextEvt[k]) return false; this.nextEvt[k] = next(k); return S.skyEvents; };
    if (due('shoot')) this.shootingStar(W, H);
    if (due('shower')) {
      const ang = rnd(0.4, 0.7) + (Math.random() < 0.5 ? 0 : Math.PI - 1.1);
      for (let i = 0; i < 4 + ((Math.random() * 3) | 0); i++) setTimeout(() => !this.dead && this.shootingStar(W, H, ang), i * rnd(150, 450));
    }
    if (due('comet')) {
      const c = this.disc(), fromLeft = Math.random() < 0.5, sp = c ? rnd(0.3, 0.4) * c.R : 0;
      const free = Math.random() < S.eventsBehind;
      let ang, x0, y0, ok = false;
      for (let i = 0; c && i < 25 && !ok; i++) {
        ang = (fromLeft ? 0 : Math.PI) + rnd(-0.25, 0.25) * (fromLeft ? 1 : -1);
        x0 = c.x + (fromLeft ? -3 : 3) * c.R; y0 = c.y + rnd(-2, 2) * c.R;
        ok = free || this.clear(x0, y0, x0 + Math.cos(ang) * sp * 16, y0 + Math.sin(ang) * sp * 16);
      }
      if (ok) this.streak(x0, y0, ang, sp, 16,
        { headTex: this.glowTex, tint: 0xbfe8ff, head: 12, len: 260, w: 9, a: 0.85, u: c.u });
    }
    if (due('flare') && S.stars && this.stars.length) {
      const g = this.disc(), r = this.r;
      const c = g && { x: g.x * r.scale + r.panX, y: g.y * r.scale + r.panY, R: g.R * r.scale };   // screen px
      const outside = this.stars.filter(q => !c || Math.hypot(q.s.x - c.x, q.s.y - c.y) > c.R);
      if (outside.length) {
        const p = outside[(Math.random() * outside.length) | 0], halo = this.fx(this.glowTex, p.s.tint, this.starLayer), d = window.devicePixelRatio || 1;
        this.events.push({ t: 0, life: 4, sprites: [halo], step: (e) => {
          const k = e.t / e.life, env = k < 0.25 ? k / 0.25 : Math.pow(1 - (k - 0.25) / 0.75, 2);
          halo.x = p.s.x; halo.y = p.s.y; halo.alpha = 0.85 * env; halo.scale.set((d * (4 + 26 * env)) / 32);
        } });
      }
    }
    this.events = this.events.filter(e => {
      e.t += dt; if (e.t < e.life) { e.step(e, dt); return true; }
      for (const sp of e.sprites) sp.destroy(); return false;
    });
  }
  glowFrame(dt) {
    const r = this.r, seen = new Set();
    this.glowLayer.visible = S.glow;
    for (const n of r.nodes) {
      const c = n.circle; if (!c) continue;
      seen.add(n);
      const flash = n.__sparkFlash || 0; if (flash) n.__sparkFlash = Math.max(0, flash - dt * 1.8);
      if (!S.glow) continue;
      let g = this.glows.get(n);
      if (!g) { g = this.sprite(this.glowTex, this.glowLayer); g.blendMode = window.PIXI.BLEND_MODES.ADD; this.glows.set(n, g); }
      g.visible = c.visible && c.alpha > 0.02;
      if (!g.visible) continue;
      const hub = n.weight >= CFG.hubWeight;
      const breathe = hub && S.breathing ? 1 + 0.18 * Math.sin(this.time * 1.4 + (n.x % 7)) : 1;
      const rad = n.getSize() * r.nodeScale * CFG.glowSize * breathe * (1 + 0.35 * flash);
      g.x = n.x; g.y = n.y; g.tint = fill(n); g.scale.set(rad / 32);
      g.alpha = (S.glowStrength * (hub ? 1.25 : 1) + 0.35 * flash * Math.min(1, S.glowStrength * 2)) * c.alpha;
    }
    for (const [n, g] of this.glows) if (!seen.has(n)) { g.destroy(); this.glows.delete(n); }
  }
  frame(now) {
    const r = this.r;
    if (!r.px || r.destroyed || !r.hanger) return this.destroy();
    // graph tab not shown: no work (minimised windows get no animation frames anyway)
    if (r.containerEl.isShown && !r.containerEl.isShown()) { this.last = 0; return; }
    this.attach();
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016); this.last = now; this.time += dt;
    if (now > this.shuffleAt) { this.shuffle(); this.shuffleAt = now + CFG.reshuffle * 1000; }

    // hovered or dragged node joins the emitters while it is in focus
    const focus = r.highlightNode || r.dragNode;
    if (S.sparks) {
      if (focus && !this.emit.has(focus)) this.emit.set(focus, { wait: 0, temp: true });
      for (const [n, e] of this.emit) {
        if (e.temp && n !== focus) { this.emit.delete(n); continue; }
        e.wait -= dt * (n === focus ? 3 : 1);
        if (e.wait > 0) continue;
        e.wait = rnd(CFG.every[0], CFG.every[1]);
        const own = this.links(n);
        if (own.length) this.launch(n, own[(Math.random() * own.length) | 0]);
      }
    }

    const k = S.sparkSize * (r.nodeScale || 1) / 11;   // ~11px of the 64px texture is the visible dot
    this.dots = this.dots.filter(d => {
      const dx = d.b.x - d.a.x, dy = d.b.y - d.a.y, len = Math.hypot(dx, dy) || 1;
      d.t += (d.v * S.sparkSpeed * dt) / len;
      if (d.t >= 1 || !S.sparks) { for (const s of [d.head, ...d.ghosts]) { s.visible = false; this.free.push(s); } return false; }
      const fade = Math.min(1, d.t * 8, (1 - d.t) * 8);
      const put = (s, t, a) => {
        s.visible = t >= 0; if (!s.visible) return;
        s.x = d.a.x + dx * t; s.y = d.a.y + dy * t; s.tint = d.color; s.alpha = a * fade; s.scale.set(k);
      };
      put(d.head, d.t, 1);   // ghosts: same size, fading
      d.ghosts.forEach((g, i) => put(g, d.t - (i + 1) * (S.sparkSize * 1.6 * (r.nodeScale || 1) / len), 0.45 - i * 0.15));
      return true;
    });
    this.glowFrame(dt);
    this.starsFrame(dt);
    r.changed();   // keep Obsidian's render loop awake so everything moves
  }
  destroy() {
    if (this.dead) return; this.dead = true;
    this.win.cancelAnimationFrame(this.raf);
    try {
      for (const l of [this.layer, this.glowLayer, this.starLayer, this.worldLayer]) l.destroy({ children: true });
      this.dotTex.destroy(true); this.glowTex.destroy(true); if (this._tail) this._tail.destroy(true);
    } catch (e) {}
  }
}

// ---------- settings tab (Russian or English, by Obsidian's language) ----------
const RU = (document.documentElement.lang || (window.moment && window.moment.locale()) || '').startsWith('ru');
const T = RU ? {
  sparksH: 'Огоньки', sparks: 'Огоньки между заметками', sparksD: 'Крошечные точки цвета заметки бегут по её связям к соседям.',
  emitters: 'Сколько заметок пускают огоньки', speed: 'Скорость огоньков', size: 'Размер огоньков',
  glowH: 'Свечение', glow: 'Ореол вокруг шариков', glowStrength: 'Яркость ореола', breathing: 'Хабы «дышат»', breathingD: 'Заметки с 25+ связями мягко пульсируют.',
  linksH: 'Связи и шарики', coloredLinks: 'Цветные связи', coloredLinksD: 'Линия окрашена в смесь цветов двух заметок.', linkTint: 'Насыщенность цвета связей',
  balanced: 'Ровные размеры шариков', balancedD: 'Заметки с малым числом связей не превращаются в точки.',
  folder: 'Цвет по папке', folderD: 'Заметки без цветовой группы окрашиваются по своей папке.',
  spaceH: 'Космос', stars: 'Звёзды', density: 'Плотность звёзд', nebulae: 'Туманности', nebulaB: 'Яркость туманностей',
  events: 'Редкие события', eventsD: 'Падающие звёзды, вспышки, кометы, звездопад.', freq: 'Частота событий', behind: 'Доля событий, пролетающих за графом',
  graphH: 'Граф', apply: 'Рекомендуемые настройки графа', applyD: 'Силы, размеры и порог подписей, с которыми плагин смотрится лучше всего.', applyB: 'Применить',
  reset: 'Сбросить настройки плагина', resetB: 'Сбросить',
} : {
  sparksH: 'Sparks', sparks: 'Sparks between notes', sparksD: 'Tiny dots of a note\'s colour travel along its links to neighbours.',
  emitters: 'Share of notes that send sparks', speed: 'Spark speed', size: 'Spark size',
  glowH: 'Glow', glow: 'Halo around nodes', glowStrength: 'Halo brightness', breathing: 'Breathing hubs', breathingD: 'Notes with 25+ links gently pulse.',
  linksH: 'Links and nodes', coloredLinks: 'Coloured links', coloredLinksD: 'A link takes the mixed colour of the two notes it joins.', linkTint: 'Link colour strength',
  balanced: 'Balanced node sizes', balancedD: 'Notes with few links do not shrink to dots.',
  folder: 'Colour by folder', folderD: 'Notes without a colour group get a colour by their folder.',
  spaceH: 'Space', stars: 'Stars', density: 'Star density', nebulae: 'Nebulae', nebulaB: 'Nebula brightness',
  events: 'Rare sky events', eventsD: 'Shooting stars, star flares, comets, meteor showers.', freq: 'Event frequency', behind: 'Share of events passing behind the graph',
  graphH: 'Graph', apply: 'Recommended graph settings', applyD: 'Forces, sizes and label fade that make the plugin look its best.', applyB: 'Apply',
  reset: 'Reset plugin settings', resetB: 'Reset',
};

class SparksSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin; el.empty();
    const head = (t) => new Setting(el).setName(t).setHeading();
    const toggle = (key, name, desc) => new Setting(el).setName(name).setDesc(desc || '')
      .addToggle(t => t.setValue(S[key]).onChange(v => p.set(key, v)));
    const slider = (key, name, min, max, step) => new Setting(el).setName(name)
      .addSlider(s => s.setLimits(min, max, step).setValue(S[key]).setDynamicTooltip().onChange(v => p.set(key, v)));

    head(T.sparksH);
    toggle('sparks', T.sparks, T.sparksD);
    slider('emitters', T.emitters, 0.05, 0.6, 0.025);
    slider('sparkSpeed', T.speed, 0.3, 3, 0.1);
    slider('sparkSize', T.size, 1, 8, 0.2);
    head(T.glowH);
    toggle('glow', T.glow);
    slider('glowStrength', T.glowStrength, 0.05, 1, 0.05);
    toggle('breathing', T.breathing, T.breathingD);
    head(T.linksH);
    toggle('coloredLinks', T.coloredLinks, T.coloredLinksD);
    slider('linkTint', T.linkTint, 0.1, 1, 0.05);
    toggle('balancedSizes', T.balanced, T.balancedD);
    toggle('folderColors', T.folder, T.folderD);
    head(T.spaceH);
    toggle('stars', T.stars);
    slider('starDensity', T.density, 0.25, 2, 0.05);
    toggle('nebulae', T.nebulae);
    slider('nebulaBrightness', T.nebulaB, 0.05, 0.5, 0.01);
    toggle('skyEvents', T.events, T.eventsD);
    slider('eventFrequency', T.freq, 0.25, 4, 0.25);
    slider('eventsBehind', T.behind, 0, 1, 0.05);
    head(T.graphH);
    new Setting(el).setName(T.apply).setDesc(T.applyD).addButton(b => b.setButtonText(T.applyB).onClick(() => p.applyGraphDefaults()));
    new Setting(el).setName(T.reset).addButton(b => b.setButtonText(T.resetB).setWarning().onClick(async () => {
      S = { ...DEFAULTS }; await p.persist(); p.refresh(true); this.display();
    }));
  }
}

module.exports = class GraphSparks extends Plugin {
  async set(key, value) {
    S[key] = value; await this.persist();
    this.refresh(key === 'starDensity' || key === 'stars');
  }
  async persist() { this.data.settings = S; await this.saveData(this.data); }
  refresh(rebuildStars) {
    for (const s of this.map.values()) { if (rebuildStars) s.clearStars(); s.r.changed(); }
  }
  // Obsidian: size = max(8, min(3*sqrt(links+1), 30)) -> notes with few links all sit at the floor.
  // Softer scale: small notes visibly bigger, hubs a bit smaller, order by link count kept.
  patchSize(r) {
    const proto = r.nodes[0] && Object.getPrototypeOf(r.nodes[0]);
    if (!proto || proto.__sparksSize) return;
    const orig = proto.getSize;
    proto.getSize = function () {
      if (!S.balancedSizes) return orig.call(this);
      return this.renderer.fNodeSizeMult * Math.max(11, Math.min(4 + 2.6 * Math.sqrt(this.weight + 1), 26));
    };
    proto.__sparksSize = orig;
    this.register(() => { proto.getSize = orig; delete proto.__sparksSize; });
    r.changed();
  }
  patchColors(r) {
    const proto = r.nodes[0] && Object.getPrototypeOf(r.nodes[0]);
    if (!proto || proto.__sparksFill) return;
    const orig = proto.getFillColor;
    proto.getFillColor = function () {
      const c = orig.call(this), base = this.renderer.colors.fill;
      if (!S.folderColors || this.type || !c || !base || c.rgb !== base.rgb) return c;   // colour group, tag, attachment: keep
      return { a: c.a, rgb: folderColor(this.id) };
    };
    proto.__sparksFill = orig;
    this.register(() => { proto.getFillColor = orig; delete proto.__sparksFill; });
  }
  // Links take the colours of the two notes they join; the hover highlight stays Obsidian's own.
  patchLinks(r) {
    const l0 = r.links.find(l => l.line);
    const proto = l0 && Object.getPrototypeOf(l0);
    if (!proto || proto.__sparksRender) return;
    const orig = proto.render;
    proto.render = function () {
      orig.call(this);
      if (!S.coloredLinks) return;
      const e = this.line, rr = this.renderer; if (!e || !e.visible) return;
      const h = rr.getHighlightNode(); if (h && (this.source === h || this.target === h)) return;
      e.tint = mix(rr.colors.line.rgb, mix(fill(this.source), fill(this.target), 0.5), S.linkTint);
    };
    proto.__sparksRender = orig;
    this.register(() => { proto.render = orig; delete proto.__sparksRender; });
  }
  async applyGraphDefaults() {
    const gp = this.app.internalPlugins.getPluginById('graph'), inst = gp && gp.instance;
    if (!inst || !inst.options) return;
    Object.assign(inst.options, GRAPH_DEFAULTS);
    if (inst.saveOptions) await inst.saveOptions();
    for (const leaf of this.app.workspace.getLeavesOfType('graph')) leaf.view.dataEngine && leaf.view.dataEngine.setOptions(GRAPH_DEFAULTS);
  }
  async onload() {
    this.data = (await this.loadData()) || {};
    S = { ...DEFAULTS, ...(this.data.settings || {}) };
    this.addSettingTab(new SparksSettingTab(this.app, this));
    this.map = new Map();
    const scan = () => {
      for (const type of ['graph', 'localgraph']) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) {
          const r = leaf.view && leaf.view.renderer;
          if (!r || !r.px || !r.hanger || !window.PIXI) continue;
          this.patchSize(r); this.patchLinks(r); this.patchColors(r);
          const cur = this.map.get(leaf);
          if (cur && cur.r === r && !cur.dead) continue;
          if (cur) cur.destroy();
          this.map.set(leaf, new Sparks(r, type === 'localgraph'));
        }
      }
      for (const [leaf, s] of this.map) if (s.dead || !leaf.view || leaf.view.renderer !== s.r) { s.destroy(); this.map.delete(leaf); }
    };
    this.registerEvent(this.app.workspace.on('layout-change', scan));
    this.registerEvent(this.app.workspace.on('active-leaf-change', scan));
    this.registerInterval(window.setInterval(scan, 1500));
    this.app.workspace.onLayoutReady(async () => {
      if (!this.data.defaultsApplied) { await this.applyGraphDefaults(); this.data.defaultsApplied = true; await this.persist(); }
      scan();
    });
  }
  onunload() { for (const s of this.map.values()) s.destroy(); this.map.clear(); }
};
