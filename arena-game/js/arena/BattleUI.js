/**
 * Боевой интерфейс арены.
 *
 * Рендерит:
 *  - шапку боя в `head`: плашки бойцов (уровень, имя, HP/MP), «Урон: N», таймер;
 *  - «боевое колесо» атаки/блока по центру сцены `stage` (ровно между бойцами)
 *    + всплывающий урон + экран конца боя;
 *  - журнал боя в `log` (вкладка «Лог боя» нижней панели);
 *  - составы команд в `teams.left / teams.right` (вкладка «Участники боя»).
 *
 * Боевое колесо: круг из 6 секторов. Левая половина — блок (щит, 3 зоны),
 * правая — атака (меч, 3 зоны: верх=голова, центр=корпус, низ=ноги).
 * Блок — переключатель (выбранная зона горит синим); удар наносится сразу
 * по нажатию сектора атаки (меч делает выпад), даже если блок не выбран.
 * Колесо позиционируется и масштабируется относительно бойцов (placeWheel).
 */
import { ZONES, BLOCKS } from './BattleSystem.js';

/* Имена бойцов приходят с сервера (ники Telegram) — в HTML только экранированно. */
const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const MAX_LOG_ENTRIES = 250;   // журнал боя не растёт бесконечно

const ASSET = 'assets/fight/';
const IMG = (name) => `${ASSET}${name}.webp`;
const SVGNS = 'http://www.w3.org/2000/svg';

/* Иконки в плашке бойца (инлайн-SVG — без зависимости от шрифта иконок). */
const HEART_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.4-4.6-9.9-9.1C.7 9 1.8 5.6 4.9 4.9 7.1 4.4 9 5.6 12 8.3c3-2.7 4.9-3.9 7.1-3.4 3.1.7 4.2 4.1 2.8 6.6C19.4 16.4 12 21 12 21Z"/></svg>';
const BOLT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 13.2h6l-1 8.8 9-12.4h-6.3L13 2Z"/></svg>';
/* «инфо» — крупный чёткий заполненный знак «i» (точка + ножка со скруглениями);
   рамку-медальон рисует сам .info-btn в CSS, поэтому в SVG только сама буква. */
const INFO_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="6.7" r="2"/><rect x="10.25" y="10.2" width="3.5" height="8.1" rx="1.75"/></svg>';

/* Сектора колеса заданы по РЕАЛЬНЫМ углам спиц wheel.png (адаптивно): спицы
   стоят неравномерно, поэтому границы секторов берём из замера, а не из
   «ровных» 60°. Так заливка ложится точно по спицам. a0..a1 — границы сектора
   (углы математические: 0° = вправо, против часовой; рост по сектору).
   Вертикальные спицы 90°/270° делят колесо на правую (атака) и левую (блок). */
const SECTORS = [
  { k: 'atk', zone: 'mid',  a0: 326,   a1: 392.5 }, // правый сектор (через 0°)
  { k: 'atk', zone: 'high', a0: 32.5,  a1: 90 },
  { k: 'atk', zone: 'low',  a0: 269.8, a1: 326 },
  { k: 'blk', zone: 'high', a0: 90,    a1: 147.2 },
  { k: 'blk', zone: 'mid',  a0: 147.2, a1: 214 },
  { k: 'blk', zone: 'low',  a0: 214,   a1: 269.8 },
];

/* Радиусы выверены по wheel.png (квадрат, круг по центру): ступица r≈14,
   внутр. край обода r≈37, внешний ≈44 (viewBox 0..100). */
const RO = 37;          // под внутренний край обода
const RI = 14;          // под край ступицы
const FILL_PAD = 1.4;   // лёгкий отступ заливки от спиц
const TR_R = 40;        // кольцо-таймера — в полосе обода
const SHIELD_R = 25;    // радиус центра щита (в середине сектора)
const SWORD_R = 33;     // радиус центра меча — рукоять в зоне, остриё за ободом

const polar = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.cos(a), 50 - r * Math.sin(a)];
};
/* Сектор-кольцо ломаной (без хлопот с дугами SVG — на этом масштабе незаметно). */
function wedgePath(a0, a1, ri, ro) {
  const N = 18, pts = [];
  for (let i = 0; i <= N; i++) pts.push(polar(ro, a0 + ((a1 - a0) * i) / N));
  for (let i = N; i >= 0; i--) pts.push(polar(ri, a0 + ((a1 - a0) * i) / N));
  return 'M' + pts.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L') + ' Z';
}

export class BattleUI {
  /**
   * opts: {
   *   head, stage, log: HTMLElement,
   *   teams: { left, right: HTMLElement },
   *   left, right: { name, level },
   *   onStrike(move),
   * }
   */
  constructor(opts) {
    this.headEl = opts.head;
    this.stageEl = opts.stage;
    this.logEl = opts.log;
    this.teamEls = opts.teams;
    this.onStrike = opts.onStrike || (() => {});
    this.onInfo = opts.onInfo || (() => {});         // «инфо» у ника в шапке (side)
    this.onMemberInfo = opts.onMemberInfo || (() => {}); // «инфо» у участника (id)
    this.selfId = opts.selfId ?? null;               // id игрока — не прячем при смерти (#2)
    this.block = null;    // выбранный блок (BLOCKS id или null)
    this.target = null;
    this._targetManual = false; // цель выбрана игроком вручную (не авто-фокус)
    this._locked = true;  // до первого turnStart управление неактивно
    this._blockIdByZone = {};
    for (const b of BLOCKS) this._blockIdByZone[b.zones[0]] = b.id;
    this._build(opts);
  }

  _build(opts) {
    // --- шапка: плашки бойцов (ник+уровень, полоса HP) + урон + эффекты + таймер
    // (раскладка по прототипу test.html: колонка бойца слева/справа зеркально) ---
    const fighterCol = (side, info) => `
      <div class="fighter-col ${side}">
        <div class="fighter-head">
          <span class="lvl-badge" title="Уровень">${info.level ?? '?'}</span>
          <span class="nick">${esc(info.name)}</span>
          <button class="info-btn" type="button" data-side="${side}"
                  title="Информация об игроке" aria-label="Информация об игроке">${INFO_SVG}</button>
        </div>
        <div class="bar-group bar-hp">
          <span class="bar-icon hp" aria-hidden="true">${HEART_SVG}</span>
          <div class="bar-track">
            <div class="bar-dmg"></div>
            <div class="bar-fill hp"></div>
            <span class="bar-val">—</span>
          </div>
        </div>
        <div class="bar-group bar-en">
          <span class="bar-icon en" aria-hidden="true">${BOLT_SVG}</span>
          <div class="bar-track">
            <div class="bar-fill en" style="width:0%"></div>
            <span class="bar-val">—</span>
          </div>
        </div>
      </div>`;

    this.headEl.innerHTML = `
      <div class="bh-fighters">
        ${fighterCol('left', opts.left)}
        ${fighterCol('right', opts.right)}
      </div>
      <div class="bh-damage-row">
        <span class="bh-damage">Нанесено урона: <b>0</b></span>
      </div>
      <div class="bh-lower">
        <div class="bh-effects bh-effects-left"></div>
        <div class="bh-timer">—:——</div>
        <div class="bh-effects bh-effects-right"></div>
      </div>`;

    // --- боевое колесо по центру сцены ---
    const wheel = this._buildWheel();

    // --- баннер «ожидание противника» (вверху сцены, не перекрывает бойцов) ---
    const wait = document.createElement('div');
    wait.className = 'bui-wait hidden';
    wait.innerHTML =
      `<img class="bui-wait-img" src="${IMG('wait')}" alt="Ожидание противника" draggable="false">`;

    // --- всплывающий урон + экран конца боя ---
    const popups = document.createElement('div');
    popups.className = 'bui-popups';

    // итог боя — арт-баннер win/lose с нарисованной кнопкой «Выход». Кликается
    // весь баннер (надёжно), поэтому отдельная хит-зона по кнопке не нужна.
    const end = document.createElement('div');
    end.className = 'bui-end hidden';
    end.innerHTML = `
      <div class="bui-end-card">
        <button class="bui-end-banner bui-leave" type="button" title="Выход в локацию">
          <img class="bui-end-img" alt="" draggable="false">
        </button>
      </div>`;

    this.stageEl.appendChild(wheel);
    this.stageEl.appendChild(wait);
    this.stageEl.appendChild(popups);
    // экран итога — в <body>, а НЕ в сцену: position:fixed внутри .arena-stage
    // остаётся в стек-контексте .game-mid (z-index:1) и оказывается НИЖЕ нижнего
    // меню (.castle-bottom z-index:5) — оно «просвечивало» поверх затемнения (#5).
    document.body.appendChild(end);
    this.wheel = wheel;
    this.waitEl = wait;

    const q = (sel) => ({
      left: this.headEl.querySelector('.fighter-col.left ' + sel),
      right: this.headEl.querySelector('.fighter-col.right ' + sel),
    });
    this.refs = {
      hpFill: q('.bar-hp .bar-fill'),
      hpDmg: q('.bar-hp .bar-dmg'),
      hpText: q('.bar-hp .bar-val'),
      enFill: q('.bar-en .bar-fill'),
      enText: q('.bar-en .bar-val'),
      name: q('.nick'),
      lvl: q('.lvl-badge'),
      effects: {
        left: this.headEl.querySelector('.bh-effects-left'),
        right: this.headEl.querySelector('.bh-effects-right'),
      },
      damage: this.headEl.querySelector('.bh-damage b'),
      timer: this.headEl.querySelector('.bh-timer'),
      status: wheel.querySelector('.sw-status'),
      popups,
      end,
      endImg: end.querySelector('.bui-end-img'),
      leave: end.querySelector('.bui-leave'),
    };

    // значок «инфо» у ника → информация об игроке (обрабатывает main.js)
    this.headEl.querySelectorAll('.info-btn').forEach((btn) =>
      btn.addEventListener('click', () => this.onInfo(btn.dataset.side)));

    // пропуск хода (цель выбирается в списке участников — см. setRoster)
    this._rosterEls = { all: {} };
    this._skipBtn = wheel.querySelector('.sw-skip');
    this._skipBtn.addEventListener('click', () => this._skip());

    // --- вкладка «Участники боя»: составы команд ---
    this._members = {};
    for (const side of ['left', 'right']) {
      this.teamEls[side].innerHTML = '';
      const m = document.createElement('div');
      m.className = 'member';
      m.innerHTML = `${esc(opts[side].name)} <span class="m-lvl">[${opts[side].level ?? '?'}]</span>`;
      this.teamEls[side].appendChild(m);
      this._members[side] = m;
    }

    this.logEl.innerHTML = '';
    this._setLocked(true, null);
    this._hideWheel();   // до первого turnStart колесо скрыто (ещё не наш ход)
  }

  /** Колесо: слои заливок секторов, рама-png, кольцо-таймер, спрайты, хит-зоны. */
  _buildWheel() {
    const wheel = document.createElement('div');
    wheel.className = 'strike-wheel locked';
    wheel.innerHTML = `
      <svg class="sw-fills" viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <radialGradient id="swAtk" cx="50%" cy="50%" r="62%">
            <stop offset="18%" stop-color="#7a2417"/><stop offset="100%" stop-color="#bd3e2c"/>
          </radialGradient>
          <radialGradient id="swBlk" cx="50%" cy="50%" r="62%">
            <stop offset="0%" stop-color="#1b3a5e"/><stop offset="100%" stop-color="#2f7fe0"/>
          </radialGradient>
          <radialGradient id="swBlkOn" cx="50%" cy="50%" r="62%">
            <stop offset="0%" stop-color="#2766b8"/><stop offset="100%" stop-color="#57a6ff"/>
          </radialGradient>
        </defs>
      </svg>
      <img class="sw-frame" src="${IMG('wheel')}" alt="" draggable="false">
      <svg class="sw-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="sw-timer" cx="50" cy="50" r="${TR_R}"></circle>
      </svg>
      <div class="sw-sprites"></div>
      <svg class="sw-hit" viewBox="0 0 100 100"></svg>
      <button class="sw-skip" type="button" title="Не бить в этот ход (выбранный блок остаётся)">Пропустить ход</button>
      <div class="sw-status"></div>`;

    const fills = wheel.querySelector('.sw-fills');
    const hit = wheel.querySelector('.sw-hit');
    const sprites = wheel.querySelector('.sw-sprites');
    this._fills = {};
    this._sprites = {};
    this._sectorPos = {};

    for (const s of SECTORS) {
      const id = s.k + '-' + s.zone;
      const icon = s.k === 'atk' ? 'sword' : 'shield';
      const c = (s.a0 + s.a1) / 2;           // центр сектора (угол)

      const fill = document.createElementNS(SVGNS, 'path');
      fill.setAttribute('d', wedgePath(s.a0 + FILL_PAD, s.a1 - FILL_PAD, RI, RO));
      fill.setAttribute('class', 'swedge ' + s.k + ' z-' + s.zone);
      fills.appendChild(fill);
      this._fills[id] = fill;

      // щит — по центру сектора; меч — рукоять в зоне, остриё за ободом
      const rs = s.k === 'atk' ? SWORD_R : SHIELD_R;
      const [sx, sy] = polar(rs, c);
      // клякса/burst ставим в зоне блока (на радиусе щита)
      this._sectorPos[id] = polar(SHIELD_R, c);
      const ux = Math.cos((c * Math.PI) / 180);
      const uy = -Math.sin((c * Math.PI) / 180);
      // меч: остриём наружу по своему сектору (к врагу); щит — строго вертикально
      const rot = s.k === 'atk' ? 270 - c : 0;
      const sp = document.createElement('div');
      sp.className = 'sw-sprite ' + icon + ' z-' + s.zone;
      sp.style.left = sx + '%';
      sp.style.top = sy + '%';
      sp.style.setProperty('--ux', ux.toFixed(3));
      sp.style.setProperty('--uy', uy.toFixed(3));
      sp.style.setProperty('--base', `translate(-50%,-50%) rotate(${rot.toFixed(1)}deg)`);
      sp.innerHTML = `<img src="${IMG(icon)}" alt="" draggable="false">`;
      sprites.appendChild(sp);
      this._sprites[id] = sp;

      const h = document.createElementNS(SVGNS, 'path');
      h.setAttribute('d', wedgePath(s.a0, s.a1, RI, RO + 7));
      h.setAttribute('class', 'sw-hit-area ' + s.k);
      const hint = ZONES.find((z) => z.id === s.zone)?.hint ?? '';
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = (s.k === 'atk' ? 'Удар: ' : 'Блок: ') + hint;
      h.appendChild(title);
      h.addEventListener('pointerenter', () => this._hover(id, true));
      h.addEventListener('pointerleave', () => this._hover(id, false));
      h.addEventListener('click', () => {
        if (this._locked) return;
        if (s.k === 'atk') this._strike(s.zone);
        else this._selectBlock(s.zone);
      });
      hit.appendChild(h);
    }

    this._timerRing = wheel.querySelector('.sw-timer');
    this._timerC = 2 * Math.PI * TR_R;
    this._timerRing.style.strokeDasharray = this._timerC;
    this._turnMax = 0;
    return wheel;
  }

  _hover(id, on) {
    if (on && this._locked) return;
    this._fills[id].classList.toggle('hot', on);
    this._sprites[id].classList.toggle('hot', on);
  }

  _strike(zone) {
    if (this._locked) return;
    this._locked = true; // защита от двойного клика до hideControls()
    const sp = this._sprites['atk-' + zone];
    sp.classList.remove('thrust'); void sp.offsetWidth; sp.classList.add('thrust');
    // цель удара НЕ передаём — её решает сервер (пара «кто напротив»);
    // выбор в ростере (this.target) — только для эликсиров/эффектов
    this.onStrike({ attack: zone, block: this.block });
  }

  _skip() {
    if (this._locked) return;
    this._locked = true;
    this.onStrike({ attack: null, block: this.block, pass: true });
  }

  _selectBlock(zone) {
    if (this._locked) return;
    const id = this._blockIdByZone[zone];
    this.block = this.block === id ? null : id;
    this._refreshBlocks();
    this._updateHints();
  }

  /** Подсветить выбранный блок на всех левых секторах. */
  _refreshBlocks() {
    for (const z of ['high', 'mid', 'low']) {
      const on = this.block === this._blockIdByZone[z];
      this._fills['blk-' + z].classList.toggle('on', on);
      this._sprites['blk-' + z].classList.toggle('on', on);
    }
  }

  /**
   * Подсказки на колесе (мой ход): пока БРОНЯ (блок) не выбрана — по очереди
   * подсвечиваем три синих сектора блока («выбери защиту здесь»); сектора атаки
   * (мечи) мягко пульсируют постоянно («бей сюда»). Анимации — в CSS по классам
   * hint-block / hint-attack на колесе.
   */
  _updateHints() {
    if (this._locked) { this._clearHints(); return; }
    this.wheel.classList.add('hint-attack');
    this.wheel.classList.toggle('hint-block', this.block == null);
  }
  _clearHints() { this.wheel.classList.remove('hint-attack', 'hint-block'); }

  /**
   * Цель ЭФФЕКТА/эликсира (this.target) — выбирается вручную кликом по участнику
   * (см. _pickTarget). По умолчанию её нет (null = эффект на себя). На выбор
   * соперника по удару это НЕ влияет — удар всегда по серверной паре «напротив».
   * Сохраняем ручной выбор, пока выбранный участник есть в составе боя.
   */
  setTargets() {
    const all = this._rosterEls && this._rosterEls.all;
    if (this._targetManual && this.target != null && all && all[this.target]) {
      this._refreshTargetMark();
      return;
    }
    this.target = null;
    this._targetManual = false;
    this._refreshTargetMark();
  }

  /**
   * Выбрать цель ЭФФЕКТА кликом по участнику (повторный клик — снять выделение).
   * Это цель эликсира/заклинания (союзник — лечение/бафф, и т.п.); на то, по кому
   * бьёшь в ближнем бою, выбор НЕ влияет (удар решает сервер). Допустимость цели
   * для конкретного эффекта проверяет сервер.
   */
  _pickTarget(id) {
    if (this._locked) return;
    this.target = String(this.target) === String(id) ? null : id;
    this._targetManual = this.target != null;   // запомнить ручной выбор
    this._refreshTargetMark();
  }

  /** Подсветить текущую цель в списке участников. */
  _refreshTargetMark() {
    const els = this._rosterEls && this._rosterEls.all;
    if (!els) return;
    for (const id in els) {
      els[id].classList.toggle('targeted', String(this.target) === id);
    }
  }

  /** Обновить «правую» колонку шапки под текущего сфокусированного соперника. */
  setOpponent(info) {
    if (!info) return;
    if (this.refs.name.right) this.refs.name.right.textContent = info.name ?? '';
    if (this.refs.lvl.right)
      this.refs.lvl.right.textContent = info.level != null ? info.level : '?';
  }

  /**
   * Чипы активных эффектов в шапке боя — иконка с тикающим временем внутри.
   * list = [{ icon, time, kind: 'buff'|'debuff', label }]. icon — emoji/символ
   * или путь к картинке; time — оставшиеся ходы/секунды. Пустой список очищает.
   */
  setEffects(side, list = []) {
    const host = this.refs.effects[side];
    if (!host) return;
    host.innerHTML = '';
    for (const e of list) {
      const chip = document.createElement('span');
      chip.className = 'effect-chip ' + (e.kind === 'debuff' ? 'debuff' : 'buff');
      if (e.label) chip.title = e.label;
      const ico = document.createElement('span');
      ico.className = 'effect-ico';
      if (e.icon && /[./]/.test(e.icon)) ico.innerHTML = `<img src="${e.icon}" alt="">`;
      else ico.textContent = e.icon || '✦';
      chip.appendChild(ico);
      if (e.time != null && e.time !== '') {
        const t = document.createElement('span');
        t.className = 'effect-time';
        t.textContent = e.time;
        chip.appendChild(t);
      }
      host.appendChild(chip);
    }
  }

  /**
   * Составы команд во вкладке «Участники боя» с полосками HP. Любой участник
   * кликабелен — это выбор цели: враг (удар), союзник (лечение) или мёртвый
   * (воскрешение). Допустимость цели для действия проверяет сервер.
   */
  setRoster(roster) {
    if (!roster) return;
    this._roster = roster;
    this._renderRoster();
  }

  /** Поиск/сортировка списка участников (тулбар окна «Участники»). */
  setRosterFilter(opts = {}) {
    this._rosterFilter = { ...(this._rosterFilter || {}), ...opts };
    if (this._roster) this._renderRoster();
  }

  _renderRoster() {
    const roster = this._roster;
    if (!roster) return;
    const f0 = this._rosterFilter || {};
    const q = String(f0.search || '').trim().toLowerCase();
    const sortKey = f0.sortKey || null;       // 'hp' | 'en' | null
    const sortDir = f0.sortDir ?? 1;          // 1 — по возрастанию доли
    const frac = (f) => sortKey === 'en'
      ? (f.maxEn ? f.en / f.maxEn : 0)
      : (f.maxHp ? f.hp / f.maxHp : 0);

    this._rosterEls = { all: {} };
    for (const side of ['left', 'right']) {
      const host = this.teamEls[side];
      host.innerHTML = '';
      let list = (roster[side] || []).slice();
      if (q) list = list.filter((f) => String(f.name || '').toLowerCase().includes(q));
      if (sortKey) list.sort((a, b) => (frac(a) - frac(b)) * sortDir);
      for (const f of list) {
        const pct = f.maxHp ? Math.max(0, (f.hp / f.maxHp) * 100) : 0;
        const enPct = f.maxEn ? Math.max(0, (f.en / f.maxEn) * 100) : 0;
        const dead = f.alive === false || f.hp <= 0;
        const isSelf = this.selfId != null && String(f.id) === String(this.selfId);
        const m = document.createElement('div');
        m.className = 'member' + (dead ? ' dead' : '') + (isSelf ? ' is-self' : '');
        const infoBtn = f.id != null
          ? `<button class="info-btn m-info" type="button" title="Информация об игроке">${INFO_SVG}</button>`
          : '';
        // две полосы вплотную: жизнь (красная) + энергия (синяя), БЕЗ значков (#6.2);
        // «инфо» сидит рядом с ником (#6.3 — раскладка в CSS)
        m.innerHTML = `<div class="m-line"><span class="m-name">${esc(f.name)} <span class="m-lvl">[${f.level ?? '?'}]</span></span>${infoBtn}</div>
          <div class="m-bars">
            <div class="m-bar m-hp"><div class="m-fill" style="width:${pct}%"></div></div>
            <div class="m-bar m-en"><div class="m-fill" style="width:${enPct}%"></div></div>
          </div>`;
        if (f.id != null) {
          m.dataset.id = f.id;
          m.dataset.side = side;
          m.classList.add('targetable');
          this._rosterEls.all[f.id] = m;
          m.addEventListener('click', () => this._pickTarget(f.id));
          // «инфо» открывает карточку игрока, НЕ выбирая его целью
          m.querySelector('.m-info')?.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.onMemberInfo(f.id);
          });
        }
        host.appendChild(m);
      }
    }
    this._refreshTargetMark();
  }

  _setLocked(locked, statusText) {
    this._locked = locked;
    this.wheel.classList.toggle('waiting', !!statusText);
    if (this.refs?.status) this.refs.status.textContent = statusText || '';
  }

  /** Колесо ударов полностью скрыто (чужой ход / ожидание / розыгрыш). */
  _hideWheel() { this.wheel.classList.add('gone', 'locked'); this._clearHints(); }
  /** Колесо снова видно и активно (мой ход). */
  _showWheel() { this.wheel.classList.remove('gone', 'locked'); }
  /** Баннер «ожидание противника» (вверху сцены). */
  _toggleWait(on) { this.waitEl.classList.toggle('hidden', !on); }

  setHP(side, cur, max) {
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    const fill = this.refs.hpFill[side];
    const dmg = this.refs.hpDmg[side];
    // «след урона»: при потере HP белая полоса остаётся на прежней ширине
    // и плавно догоняет новую — видно, сколько только что сняли (как в прототипе)
    if (dmg) {
      const prev = parseFloat(fill.style.width) || pct;
      if (pct < prev) {
        dmg.style.width = prev + '%';
        requestAnimationFrame(() => setTimeout(() => { dmg.style.width = pct + '%'; }, 60));
      } else {
        dmg.style.width = pct + '%';
      }
    }
    fill.style.width = pct + '%';
    fill.classList.toggle('low', pct < 25);
    this.refs.hpText[side].textContent = `${Math.round(cur)}/${max}`;
    if (this._members[side]) this._members[side].classList.toggle('dead', cur <= 0);
  }

  /**
   * Полоса энергии (синяя) в плашке бойца. Показываем всегда, даже если данных
   * нет (тогда пустая) — энергетическая механика появится позже.
   */
  setEnergy(side, cur, max) {
    const fill = this.refs.enFill[side];
    const text = this.refs.enText[side];
    if (!fill) return;
    if (max == null || max <= 0) {
      fill.style.width = '0%';
      if (text) text.textContent = '—';
      return;
    }
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    fill.style.width = pct + '%';
    if (text) text.textContent = `${Math.round(cur)}/${max}`;
  }

  /** Счётчик «Нанесено урона» в шапке боя. */
  setDamage(value) {
    this.refs.damage.textContent = value;
  }

  setTurn(n) {
    const sep = document.createElement('div');
    sep.className = 'bui-log-turn';
    sep.textContent = `ход ${n}`;
    this._appendLog(sep);
  }

  setTimer(sec) {
    const s = Math.max(0, sec);
    this.refs.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.refs.timer.classList.toggle('urgent', s <= 5);
    // кольцо-таймер на колесе: за «полный» ход берём наибольшее виденное время
    if (s > this._turnMax) this._turnMax = s;
    if (this._timerRing && this._turnMax) {
      const frac = Math.max(0, Math.min(1, s / this._turnMax));
      this._timerRing.style.strokeDashoffset = (this._timerC * (1 - frac)).toFixed(1);
      this._timerRing.classList.toggle('low', s <= 5);
    }
  }

  /** Поставить колесо ровно между бойцами и задать его диаметр (px). */
  placeWheel(layout) {
    if (!layout || !this.wheel) return;
    // На время (пере)раскладки гасим transition спрайтов: смена --d на WebKit
    // переразрешает translate(-50%) щита/меча, и спрайт «уезжает» на новую
    // позицию с overshoot-кривой — верхний щит особенно заметно (#1). Снимаем
    // 'placing' спустя кадр после оседания раскладки — hover-анимации вернутся.
    this.wheel.classList.add('placing');
    this.wheel.style.left = layout.x + 'px';
    this.wheel.style.top = layout.y + 'px';
    this.wheel.style.setProperty('--d', Math.round(layout.diameter) + 'px');
    clearTimeout(this._placeT);
    this._placeT = setTimeout(() => {
      if (this.wheel) this.wheel.classList.remove('placing');
    }, 120);
  }

  /**
   * Свой ход завершён (удар отправлен) — колесо скрывается, ждём розыгрыша.
   * Баннер ожидания тут не нужен (мы не «без соперника», просто идёт ход).
   */
  hideControls() {
    this._setLocked(true, null);
    this._hideWheel();
    this._toggleWait(false);
  }

  /** Сброс блокировки после отклонённого удара (не ваш ход / неверная цель). */
  releasePendingStrike() {
    this._setLocked(false, null);
    this._showWheel();
    this._toggleWait(false);
    for (const id in this._sprites) this._sprites[id].classList.remove('thrust');
    this._updateHints();
  }

  /** Свой ход: колесо снова видно и активно; блок держится между ходами. */
  showControls() {
    this._refreshBlocks();
    for (const id in this._sprites) this._sprites[id].classList.remove('thrust', 'hot', 'clang');
    for (const id in this._fills) this._fills[id].classList.remove('hot');
    this._setLocked(false, null);
    this._showWheel();
    this._toggleWait(false);
    this._updateHints();   // привлечь внимание к выбору брони/атаки (ТЗ #2)
  }

  /** Чужой ход (#7): колесо пропадает, БЕЗ баннера — просто ждём удара врага. */
  showWaitTimer() {
    this._setLocked(true, null);
    this._hideWheel();
    this._toggleWait(false);
  }

  /** Напротив нет соперника (ход союзника в мультибое) — колесо скрыто + баннер. */
  showWait() {
    this._setLocked(true, null);
    this._hideWheel();
    this._toggleWait(true);
  }

  /** Розыгрыш ударов: колесо скрыто, но баннер убран — видна анимация боя. */
  showResolving() {
    this._setLocked(true, null);
    this._hideWheel();
    this._toggleWait(false);
  }

  /**
   * Входящий удар противника по зоне `zone`: запоминаем сектор на колесе
   * (стойкая метка видна в следующий свой ход).
   */
  showIncoming(zone) {
    const id = 'blk-' + zone;
    if (!this._sectorPos[id]) return;
    const [sx, sy] = this._sectorPos[id];
    this._markLastHit(sx, sy);
  }

  /** Стойкая отметка последнего удара противника — только на колесе в свой ход. */
  _markLastHit(sx, sy) {
    if (!this._lastHitEl) {
      this._lastHitEl = document.createElement('div');
      this._lastHitEl.className = 'sw-lasthit';
      this.wheel.appendChild(this._lastHitEl);
    }
    this._lastHitEl.style.left = sx + '%';
    this._lastHitEl.style.top = sy + '%';
    this._lastHitEl.classList.remove('show'); void this._lastHitEl.offsetWidth;
    this._lastHitEl.classList.add('show');
  }

  /** Всплывающая цифра урона в экранной точке {x, y} (координаты сцены). */
  popup(pos, text, type = 'dmg') {
    const p = document.createElement('div');
    p.className = 'bui-popup ' + type;
    p.textContent = text;
    p.style.left = pos.x + 'px';
    p.style.top = pos.y + 'px';
    this.refs.popups.appendChild(p);
    setTimeout(() => p.remove(), 1400);
  }

  /** Запись в журнал. История не затирается — журнал прокручивается. */
  log(html) {
    const e = document.createElement('div');
    e.className = 'bui-log-entry';
    e.innerHTML = html;
    this._appendLog(e);
  }

  _appendLog(node) {
    const el = this.logEl;
    // автопрокрутка только если пользователь и так у нижнего края,
    // иначе не сбиваем его с чтения истории
    const pane = el.parentElement; // скроллится панель вкладки
    const scroller = pane && pane.classList.contains('dock-pane') ? pane : el;
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
    el.appendChild(node);
    while (el.children.length > MAX_LOG_ENTRIES) el.firstChild.remove();
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  showEnd(victory, handlers = {}) {
    this.refs.endImg.src = IMG(victory ? 'win' : 'lose');
    this.refs.endImg.alt = victory ? 'Победа' : 'Поражение';
    this.refs.end.classList.remove('hidden');
    this.refs.leave.onclick = () => {
      this.refs.end.classList.add('hidden');
      handlers.onLeave && handlers.onLeave();
    };
  }

  destroy() {
    this.block = null;
    this.headEl.innerHTML = '';
    this.wheel.remove();
    this.waitEl.remove();
    this.refs.popups.remove();
    this.refs.end.remove();
    for (const side of ['left', 'right']) this.teamEls[side].innerHTML = '';
  }
}
