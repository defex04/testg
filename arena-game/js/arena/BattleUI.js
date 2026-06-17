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
    this.block = null;    // выбранный блок (BLOCKS id или null)
    this.target = null;
    this._targetManual = false; // цель выбрана игроком вручную (не авто-фокус)
    this._locked = true;  // до первого turnStart управление неактивно
    this._blockIdByZone = {};
    for (const b of BLOCKS) this._blockIdByZone[b.zones[0]] = b.id;
    this._build(opts);
  }

  _build(opts) {
    // --- шапка: плашки бойцов + урон + таймер ---
    this.headEl.innerHTML = `
      <div class="bh-plates">
        <div class="bh-plate bh-left">
          <div class="bh-level">${opts.left.level ?? ''}</div>
          <div class="bh-info">
            <div class="bh-name">${esc(opts.left.name)}</div>
            <div class="bh-bar bh-hp"><div class="bh-fill"></div><span class="bh-text"></span></div>
            <div class="bh-bar bh-mp"><div class="bh-fill"></div></div>
          </div>
        </div>
        <div class="bh-plate bh-right">
          <div class="bh-level">${opts.right.level ?? ''}</div>
          <div class="bh-info">
            <div class="bh-name">${esc(opts.right.name)}</div>
            <div class="bh-bar bh-hp"><div class="bh-fill"></div><span class="bh-text"></span></div>
            <div class="bh-bar bh-mp"><div class="bh-fill"></div></div>
          </div>
        </div>
      </div>
      <div class="bh-damage">Урон: 0</div>
      <div class="bh-timer">—:——</div>`;

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
    this.stageEl.appendChild(end);
    this.wheel = wheel;
    this.waitEl = wait;

    this.refs = {
      hpFill: {
        left: this.headEl.querySelector('.bh-left .bh-hp .bh-fill'),
        right: this.headEl.querySelector('.bh-right .bh-hp .bh-fill'),
      },
      hpText: {
        left: this.headEl.querySelector('.bh-left .bh-text'),
        right: this.headEl.querySelector('.bh-right .bh-text'),
      },
      damage: this.headEl.querySelector('.bh-damage'),
      timer: this.headEl.querySelector('.bh-timer'),
      status: wheel.querySelector('.sw-status'),
      popups,
      end,
      endImg: end.querySelector('.bui-end-img'),
      leave: end.querySelector('.bui-leave'),
    };

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
      fill.setAttribute('class', 'swedge ' + s.k);
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
      sp.className = 'sw-sprite ' + icon;
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
    this.onStrike({ attack: zone, block: this.block, target: this.target });
  }

  _skip() {
    if (this._locked) return;
    this._locked = true;
    this.onStrike({ attack: null, block: this.block, pass: true, target: this.target });
  }

  _selectBlock(zone) {
    if (this._locked) return;
    const id = this._blockIdByZone[zone];
    this.block = this.block === id ? null : id;
    this._refreshBlocks();
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
   * Цель по умолчанию (сфокусированный враг). Сам выбор — кликом по участнику
   * во вкладке «Участники боя» (см. setRoster).
   */
  setTargets(list = [], focusId = null) {
    // ручной выбор игрока сохраняется, пока выбранный участник есть в составе
    const all = this._rosterEls && this._rosterEls.all;
    if (this._targetManual && this.target != null && all && all[this.target]) {
      this._refreshTargetMark();
      return;
    }
    const targets = list.filter((t) => t && t.alive !== false);
    const ids = new Set(targets.map((t) => t.id));
    this.target = (focusId != null && ids.has(focusId))
      ? focusId : (targets[0] ? targets[0].id : null);
    this._targetManual = false;
    this._refreshTargetMark();
  }

  /**
   * Выбрать цель кликом по участнику (повторный клик по выбранному — снять
   * выделение). Можно выбирать кого угодно — врага (удар), союзника (лечение),
   * мёртвого (свиток воскрешения); что допустимо для действия, решает сервер.
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

  /** Обновить «правую» плашку шапки под текущего сфокусированного соперника. */
  setOpponent(info) {
    if (!info) return;
    const plate = this.headEl.querySelector('.bh-right');
    if (!plate) return;
    plate.querySelector('.bh-name').textContent = info.name ?? '';
    plate.querySelector('.bh-level').textContent = info.level ?? '';
  }

  /**
   * Составы команд во вкладке «Участники боя» с полосками HP. Любой участник
   * кликабелен — это выбор цели: враг (удар), союзник (лечение) или мёртвый
   * (воскрешение). Допустимость цели для действия проверяет сервер.
   */
  setRoster(roster) {
    if (!roster) return;
    this._rosterEls = { all: {} };
    for (const side of ['left', 'right']) {
      const host = this.teamEls[side];
      host.innerHTML = '';
      for (const f of roster[side] || []) {
        const pct = f.maxHp ? Math.max(0, (f.hp / f.maxHp) * 100) : 0;
        const dead = f.alive === false || f.hp <= 0;
        const m = document.createElement('div');
        m.className = 'member' + (dead ? ' dead' : '');
        m.innerHTML = `<div class="m-line">${esc(f.name)} <span class="m-lvl">[${f.level ?? '?'}]</span></div>
          <div class="m-bar"><div class="m-fill" style="width:${pct}%"></div></div>`;
        if (f.id != null) {
          m.dataset.id = f.id;
          m.dataset.side = side;
          m.classList.add('targetable');
          this._rosterEls.all[f.id] = m;
          m.addEventListener('click', () => this._pickTarget(f.id));
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
  _hideWheel() { this.wheel.classList.add('gone', 'locked'); }
  /** Колесо снова видно и активно (мой ход). */
  _showWheel() { this.wheel.classList.remove('gone', 'locked'); }
  /** Баннер «ожидание противника» (вверху сцены). */
  _toggleWait(on) { this.waitEl.classList.toggle('hidden', !on); }

  setHP(side, cur, max) {
    const pct = Math.max(0, (cur / max) * 100);
    this.refs.hpFill[side].style.width = pct + '%';
    this.refs.hpFill[side].classList.toggle('low', pct < 30);
    this.refs.hpText[side].textContent = `${Math.round(cur)} / ${max}`;
    this._members[side].classList.toggle('dead', cur <= 0);
  }

  /** Строка «Урон: N» в шапке боя. */
  setDamage(value) {
    this.refs.damage.textContent = `Урон: ${value}`;
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
    this.wheel.style.left = layout.x + 'px';
    this.wheel.style.top = layout.y + 'px';
    this.wheel.style.setProperty('--d', Math.round(layout.diameter) + 'px');
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
  }

  /** Свой ход: колесо снова видно и активно; блок держится между ходами. */
  showControls() {
    this._refreshBlocks();
    for (const id in this._sprites) this._sprites[id].classList.remove('thrust', 'hot', 'clang');
    for (const id in this._fills) this._fills[id].classList.remove('hot');
    this._setLocked(false, null);
    this._showWheel();
    this._toggleWait(false);
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
