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
const SVGNS = 'http://www.w3.org/2000/svg';

/* Сектора колеса: k — вид (атака/блок), zone — зона тела, deg — угол центра
   сектора (математический, 0° = вправо, против часовой). Вертикальные спицы
   рамы (90°/270°) делят колесо на правую (атака) и левую (блок) половины. */
const SECTORS = [
  { k: 'atk', zone: 'high', deg: 60 },
  { k: 'atk', zone: 'mid',  deg: 0 },
  { k: 'atk', zone: 'low',  deg: -60 },
  { k: 'blk', zone: 'high', deg: 120 },
  { k: 'blk', zone: 'mid',  deg: 180 },
  { k: 'blk', zone: 'low',  deg: 240 },
];

/* Радиусы выверены по wheel.png (ступица ~r74, внутр. край обода ~r198 из 265):
   заливка идёт от-под-ступицы до-под-обод, без зазоров — обод/спицы рамы
   (рисуются поверх) дают чистые границы секторов. */
const RO = 39;        // под внутренний край обода (viewBox 0..100)
const RI = 12;        // под край ступицы
const FILL_PAD = 0;   // без зазора у спиц — рама перекрывает швы
const TR_R = 40;      // радиус кольца-таймера (по ободу)

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
    this._locked = true;  // до первого turnStart управление неактивно
    this._blockIdByZone = {};
    for (const b of BLOCKS) this._blockIdByZone[b.zones[0]] = b.id;
    this._build(opts);
    this.log(`<b>${esc(opts.left.name)}</b> против <b>${esc(opts.right.name)}</b> — бой начинается!`);
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

    // --- пилюля «ожидание противника» (внизу сцены) ---
    const wait = document.createElement('div');
    wait.className = 'bui-wait hidden';

    // --- всплывающий урон + экран конца боя ---
    const popups = document.createElement('div');
    popups.className = 'bui-popups';

    const end = document.createElement('div');
    end.className = 'bui-end hidden';
    end.innerHTML = `
      <div class="bui-end-card">
        <div class="bui-end-title"></div>
        <div class="bui-end-actions">
          <button class="bui-end-btn bui-restart">В бой снова</button>
          <button class="bui-end-btn secondary bui-leave">В локацию</button>
        </div>
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
      endTitle: end.querySelector('.bui-end-title'),
      restart: end.querySelector('.bui-restart'),
      leave: end.querySelector('.bui-leave'),
    };

    // пропуск хода (цель в NvN выбирается в списке участников — см. setRoster)
    this._validTargets = null;
    this._rosterEls = { left: {}, right: {} };
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
    this.wheel.classList.add('locked');
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
      <img class="sw-frame" src="${ASSET}wheel.png" alt="" draggable="false">
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

      const fill = document.createElementNS(SVGNS, 'path');
      fill.setAttribute('d', wedgePath(s.deg - 30 + FILL_PAD, s.deg + 30 - FILL_PAD, RI, RO));
      fill.setAttribute('class', 'swedge ' + s.k);
      fills.appendChild(fill);
      this._fills[id] = fill;

      const rs = s.k === 'atk' ? 25 : 26;
      const [sx, sy] = polar(rs, s.deg);
      this._sectorPos[id] = [sx, sy];
      const ux = Math.cos((s.deg * Math.PI) / 180);
      const uy = -Math.sin((s.deg * Math.PI) / 180);
      // меч: остриём наружу по сектору (к врагу); щит — строго вертикально
      const rot = s.k === 'atk' ? 270 - s.deg : 0;
      const sp = document.createElement('div');
      sp.className = 'sw-sprite ' + icon;
      sp.style.left = sx + '%';
      sp.style.top = sy + '%';
      sp.style.setProperty('--ux', ux.toFixed(3));
      sp.style.setProperty('--uy', uy.toFixed(3));
      sp.style.setProperty('--base', `translate(-50%,-50%) rotate(${rot}deg)`);
      sp.innerHTML = `<img src="${ASSET}${icon}.png" alt="" draggable="false">`;
      sprites.appendChild(sp);
      this._sprites[id] = sp;

      const h = document.createElementNS(SVGNS, 'path');
      h.setAttribute('d', wedgePath(s.deg - 30, s.deg + 30, RI, RO + 6));
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
   * Живые враги, по которым можно бить (NvN). Сам выбор цели — кликом по врагу
   * во вкладке «Участники боя» (см. setRoster); здесь только список допустимых
   * целей и цель по умолчанию.
   */
  setTargets(list = [], focusId = null) {
    const targets = list.filter((t) => t && t.alive !== false);
    this._validTargets = new Set(targets.map((t) => t.id));
    this.target = (focusId != null && this._validTargets.has(focusId))
      ? focusId : (targets[0] ? targets[0].id : null);
    this._refreshTargetMark();
  }

  /** Выбрать цель кликом по врагу в списке участников. */
  _pickTarget(id) {
    if (this._locked) return;
    if (this._validTargets && !this._validTargets.has(id)) return;
    this.target = id;
    this._refreshTargetMark();
  }

  /** Подсветить текущую цель в списке участников. */
  _refreshTargetMark() {
    const right = this._rosterEls && this._rosterEls.right;
    if (!right) return;
    for (const id in right) {
      right[id].classList.toggle('targeted', String(this.target) === id);
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
   * Составы команд во вкладке «Участники боя» с полосками HP. Живые враги
   * (правая команда) кликабельны — это и есть выбор цели в NvN.
   */
  setRoster(roster) {
    if (!roster) return;
    this._rosterEls = { left: {}, right: {} };
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
        // правая команда = враги: живых можно выбирать целью
        if (side === 'right' && f.id != null) {
          m.dataset.id = f.id;
          this._rosterEls.right[f.id] = m;
          if (!dead) {
            m.classList.add('targetable');
            m.addEventListener('click', () => this._pickTarget(f.id));
          }
        }
        host.appendChild(m);
      }
    }
    this._refreshTargetMark();
  }

  _setLocked(locked, statusText) {
    this._locked = locked;
    this.wheel.classList.toggle('waiting', !!statusText);
    this.refs.status.textContent = statusText || '';
  }

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
   * Колесо во время удара/ожидания не прячется (оно — центр сцены между
   * бойцами), а только гаснет и блокируется, чтобы на нём были видны эффекты
   * входящих ударов.
   */
  hideControls(showWait = true) {
    this._setLocked(true, null);
    this.wheel.classList.add('locked');
    this.waitEl.textContent = '⏳ Ход противника…';
    this.waitEl.classList.toggle('hidden', !showWait);
  }

  /** Свой ход: колесо активно; блок держится между ходами. */
  showControls() {
    this._refreshBlocks();
    for (const id in this._sprites) this._sprites[id].classList.remove('thrust', 'hot', 'clang');
    for (const id in this._fills) this._fills[id].classList.remove('hot');
    this._setLocked(false, null);
    this.wheel.classList.remove('locked');
    this.waitEl.classList.add('hidden');
  }

  /** Чужой ход (PvP): колесо погашено, таймер в шапке тикает. */
  showWaitTimer() {
    this._setLocked(true, null);
    this.wheel.classList.add('locked');
    this.waitEl.classList.add('hidden');
  }

  /** Ожидание соперника (NvN): погашенное колесо + плашка с текстом. */
  showWait(text = '⏳ Ожидание соперника…') {
    this._setLocked(true, null);
    this.wheel.classList.add('locked');
    this.waitEl.textContent = text;
    this.waitEl.classList.remove('hidden');
  }

  /**
   * Эффект входящего удара противника по зоне `zone`: отметка зоны на колесе
   * (левый сектор блока) + вспышка-burst. Синий «звон» при удачном блоке,
   * красный пробой — иначе.
   */
  showIncoming(zone, blocked) {
    const id = 'blk-' + zone;
    const fill = this._fills[id];
    if (!fill) return;
    // отметка зоны на (погашенном) колесе — куда целил противник
    fill.style.setProperty('--rest', fill.classList.contains('on') ? '1' : '0.32');
    fill.classList.remove('aim'); void fill.getBoundingClientRect(); fill.classList.add('aim');
    if (blocked) {
      const sp = this._sprites[id];
      sp.classList.remove('clang'); void sp.offsetWidth; sp.classList.add('clang');
    }
    // запоминаем последнее место удара противника — стойкая красная клякса
    const [sx, sy] = this._sectorPos[id];
    this._markLastHit(sx, sy);
    // burst — в незатемняемом слое попапов поверх сцены, координаты сектора → px
    const d = parseFloat(getComputedStyle(this.wheel).getPropertyValue('--d')) || this.wheel.clientWidth || 300;
    const cx = parseFloat(this.wheel.style.left) || this.wheel.offsetLeft + d / 2;
    const cy = parseFloat(this.wheel.style.top) || this.wheel.offsetTop + d / 2;
    const x = cx - d / 2 + (sx / 100) * d;
    const y = cy - d / 2 + (sy / 100) * d;
    this._burst(x, y, d, blocked ? '#6aa6ff' : '#ff4733');
  }

  /** Стойкая отметка последнего удара противника (красная клякса на секторе). */
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

  _burst(x, y, d, color) {
    const b = document.createElement('div');
    b.className = 'sw-burst';
    b.style.left = x + 'px';
    b.style.top = y + 'px';
    b.style.setProperty('--d', d + 'px');
    b.style.setProperty('--bc', color);
    let html = '<i class="flash"></i><i class="ring"></i>';
    for (let i = 0; i < 6; i++) {
      const a = i * 60 + (Math.random() * 20 - 10);
      html += `<i class="spark" style="transform:translate(-50%,-100%) rotate(${a}deg)"></i>`;
    }
    b.innerHTML = html;
    this.refs.popups.appendChild(b);
    setTimeout(() => b.remove(), 700);
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
    this.log(victory ? '🏆 <b>Победа!</b>' : '☠ <b>Поражение…</b>');
    this.refs.endTitle.textContent = victory ? '⚔ Победа! ⚔' : 'Поражение…';
    this.refs.endTitle.classList.toggle('defeat', !victory);
    // без обработчика рестарта (PvP) кнопка «В бой снова» не показывается
    this.refs.restart.classList.toggle('hidden', !handlers.onRestart);
    this.refs.end.classList.remove('hidden');
    this.refs.restart.onclick = () => {
      this.refs.end.classList.add('hidden');
      handlers.onRestart && handlers.onRestart();
    };
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
