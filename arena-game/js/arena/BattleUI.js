/**
 * Боевой интерфейс арены (под дизайн-макет «чёрная панель с белыми контурами»).
 *
 * Рендерит:
 *  - шапку боя в `head`: плашки бойцов (уровень, имя, HP/MP), «Урон: N», таймер;
 *  - «штурвал» атаки/блока по центру сцены `stage` + всплывающий урон + экран
 *    конца боя;
 *  - журнал боя в `log` (вкладка «Лог боя» нижней панели);
 *  - составы команд в `teams.left / teams.right` (вкладка «Участники боя»).
 *
 * Схема боя: 3 удара × 3 блока (вверх / центр / вниз).
 * Блок — переключатель; удар наносится сразу по нажатию зоны атаки,
 * даже если блок не выбран.
 */
import { ZONES, BLOCKS } from './BattleSystem.js';

/* Пиктограммы зон: шлем / кираса / понож (inline-SVG, цвет — currentColor). */
const ZONE_ICONS = {
  high: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3.4c-4.1 0-6.6 2.9-6.6 6.9v9.5l3.3-1.9 3.3 1.9 3.3-1.9 3.3 1.9v-9.5c0-4-2.5-6.9-6.6-6.9Z"/>
    <path d="M7.9 11.2h8.2"/>
  </svg>`,
  mid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.1 3.9C8.6 5 10.2 5.6 12 5.6s3.4-.6 4.9-1.7l2.9 3.3-1.8 2.1v8.6c-1.9 1.1-3.9 1.6-6 1.6s-4.1-.5-6-1.6V9.3L4.2 7.2l2.9-3.3Z"/>
    <path d="M12 5.8v13.7"/>
  </svg>`,
  low: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8.6 3.6h5.2v8.6l4.3 5.1c.7.9.1 2.2-1 2.2H8.6c-.6 0-1.1-.5-1.1-1.1V4.7c0-.6.5-1.1 1.1-1.1Z"/>
    <path d="M8.6 12.2h5.2"/>
  </svg>`,
};

/* Иконки рядов штурвала (эмодзи в UI рендерятся нестабильно). */
const SWORD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M19 5 9.2 14.8M19 5l-.2 3.2M19 5l-3.2.2"/>
  <path d="M6.8 12.4l4.8 4.8M9.2 17.8 6.2 20.8M5.2 15.8l3 3"/>
</svg>`;
const SHIELD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3.4 19 6v5.4c0 4.5-2.9 7.7-7 9.2-4.1-1.5-7-4.7-7-9.2V6l7-2.6Z"/>
</svg>`;

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
    this.block = null;    // выбранный блок (id или null)
    this._locked = true;  // до первого turnStart кнопки неактивны
    this._build(opts);
    this.log(`<b>${opts.left.name}</b> против <b>${opts.right.name}</b> — бой начинается!`);
  }

  _build(opts) {
    // --- шапка: плашки бойцов + урон + таймер ---
    this.headEl.innerHTML = `
      <div class="bh-plates">
        <div class="bh-plate bh-left">
          <div class="bh-level">${opts.left.level ?? ''}</div>
          <div class="bh-info">
            <div class="bh-name">${opts.left.name}</div>
            <div class="bh-bar bh-hp"><div class="bh-fill"></div><span class="bh-text"></span></div>
            <div class="bh-bar bh-mp"><div class="bh-fill"></div></div>
          </div>
        </div>
        <div class="bh-plate bh-right">
          <div class="bh-level">${opts.right.level ?? ''}</div>
          <div class="bh-info">
            <div class="bh-name">${opts.right.name}</div>
            <div class="bh-bar bh-hp"><div class="bh-fill"></div><span class="bh-text"></span></div>
            <div class="bh-bar bh-mp"><div class="bh-fill"></div></div>
          </div>
        </div>
      </div>
      <div class="bh-damage">Урон: 0</div>
      <div class="bh-timer">—:——</div>`;

    // --- штурвал атаки/блока по центру сцены ---
    const wheel = document.createElement('div');
    wheel.className = 'strike-wheel';
    wheel.innerHTML = `
      <div class="sw-row sw-attack"><span class="sw-tag" title="Удар">${SWORD_ICON}</span><div class="sw-btns"></div></div>
      <div class="sw-row sw-block"><span class="sw-tag" title="Блок">${SHIELD_ICON}</span><div class="sw-btns"></div></div>
      <button class="sw-skip" type="button" title="Не бить в этот ход (выбранный блок остаётся)">Пропустить ход</button>
      <div class="sw-status"></div>`;

    // --- пилюля «ожидание противника» (штурвал на это время скрыт) ---
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

    // зоны атаки: нажатие = немедленный удар (с текущим блоком или без него)
    this._atkButtons = [];
    const atkRow = wheel.querySelector('.sw-attack .sw-btns');
    for (const z of ZONES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swb';
      b.title = `Удар: ${z.hint}`;
      b.innerHTML = ZONE_ICONS[z.id];
      b.addEventListener('click', () => this._strike(z.id, b));
      atkRow.appendChild(b);
      this._atkButtons.push(b);
    }

    // зоны блока: переключатель, можно вовсе не выбирать
    this._blkButtons = [];
    const blkRow = wheel.querySelector('.sw-block .sw-btns');
    for (const blk of BLOCKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swb';
      b.dataset.block = blk.id;
      b.title = `Блок: ${blk.hint}`;
      b.innerHTML = ZONE_ICONS[blk.zones[0]];
      b.addEventListener('click', () => this._selectBlock(blk.id));
      blkRow.appendChild(b);
      this._blkButtons.push(b);
    }

    // пропуск хода: удара нет, выбранный блок продолжает защищать
    this._skipBtn = wheel.querySelector('.sw-skip');
    this._skipBtn.addEventListener('click', () => this._skip());

    // --- вкладка «Участники боя»: составы команд ---
    this._members = {};
    for (const side of ['left', 'right']) {
      this.teamEls[side].innerHTML = '';
      const m = document.createElement('div');
      m.className = 'member';
      m.innerHTML = `${opts[side].name} <span class="m-lvl">[${opts[side].level ?? '?'}]</span>`;
      this.teamEls[side].appendChild(m);
      this._members[side] = m;
    }

    this.logEl.innerHTML = '';
    this._setLocked(true, null);
  }

  _strike(zoneId, btn) {
    if (this._locked) return;
    this._locked = true; // защита от двойного клика до hideControls()
    btn.classList.add('chosen');
    this.onStrike({ attack: zoneId, block: this.block });
  }

  _skip() {
    if (this._locked) return;
    this._locked = true;
    this.onStrike({ attack: null, block: this.block, pass: true });
  }

  _selectBlock(id) {
    if (this._locked) return;
    this.block = this.block === id ? null : id;
    for (const b of this._blkButtons) {
      b.classList.toggle('active', b.dataset.block === this.block);
    }
  }

  _setLocked(locked, statusText) {
    this._locked = locked;
    this.wheel.classList.toggle('waiting', !!statusText);
    this.refs.status.textContent = statusText || '';
    for (const b of this._atkButtons) b.disabled = locked;
    for (const b of this._blkButtons) b.disabled = locked;
    this._skipBtn.disabled = locked;
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
  }

  /**
   * Штурвал плавно исчезает на время удара; пока ждём выбор противника,
   * вместо него видна пилюля статуса.
   */
  hideControls(showWait = true) {
    this._setLocked(true, null);
    this.wheel.classList.add('off');
    this.waitEl.textContent = '⏳ Ход противника…';
    this.waitEl.classList.toggle('hidden', !showWait);
  }

  showControls() {
    this.block = null;
    for (const b of this._blkButtons) b.classList.remove('active');
    for (const b of this._atkButtons) b.classList.remove('chosen');
    this._setLocked(false, null);
    this.wheel.classList.remove('off');
    this.waitEl.classList.add('hidden');
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
    this.headEl.innerHTML = '';
    this.wheel.remove();
    this.waitEl.remove();
    this.refs.popups.remove();
    this.refs.end.remove();
    for (const side of ['left', 'right']) this.teamEls[side].innerHTML = '';
  }
}
