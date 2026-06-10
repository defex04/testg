/**
 * Боевой интерфейс арены.
 *
 * Поверх сцены — только лёгкий оверлей (имена, HP, таймер, всплывающий урон,
 * экран победы). Управление и журнал боя живут в нижней панели («доке»),
 * которая стоит в потоке ПОД канвасом и не перекрывает ни бойцов, ни лог.
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

/* Иконки заголовков групп (эмодзи в заголовках рендерятся нестабильно). */
const SWORD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M19 5 9.2 14.8M19 5l-.2 3.2M19 5l-3.2.2"/>
  <path d="M6.8 12.4l4.8 4.8M9.2 17.8 6.2 20.8M5.2 15.8l3 3"/>
</svg>`;
const SHIELD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3.4 19 6v5.4c0 4.5-2.9 7.7-7 9.2-4.1-1.5-7-4.7-7-9.2V6l7-2.6Z"/>
</svg>`;

export class BattleUI {
  constructor(container, opts = {}) {
    this.container = container;
    this.onStrike = opts.onStrike || (() => {});
    this.block = null;    // выбранный блок (id или null)
    this._locked = true;  // до первого turnStart кнопки неактивны
    this._build(opts);
    if (opts.leftName && opts.rightName) {
      this.log(`<b>${opts.leftName}</b> против <b>${opts.rightName}</b> — бой начинается!`);
    }
  }

  _build(opts) {
    // --- нижний док: журнал + управление, стоит в потоке под канвасом ---
    const dock = document.createElement('div');
    dock.className = 'bui-dock';
    dock.innerHTML = `
      <div class="bui-log" aria-live="polite"></div>
      <div class="bui-controls">
        <div class="bui-group bui-attack">
          <div class="bui-group-title">${SWORD_ICON}Удар</div>
          <div class="bui-zone-row"></div>
        </div>
        <div class="bui-sep"></div>
        <div class="bui-group bui-block">
          <div class="bui-group-title">${SHIELD_ICON}Блок</div>
          <div class="bui-zone-row"></div>
        </div>
        <div class="bui-status"></div>
      </div>`;

    // --- лёгкий оверлей поверх сцены: панели HP, урон, финал ---
    const overlay = document.createElement('div');
    overlay.className = 'bui';
    overlay.innerHTML = `
      <div class="bui-top">
        <div class="bui-plate bui-left">
          <div class="bui-name">${opts.leftName || 'Игрок'}</div>
          <div class="bui-bar"><div class="bui-fill"></div><span class="bui-bar-text"></span></div>
        </div>
        <div class="bui-vs">
          <div class="bui-turn">Ход 1</div>
          <div class="bui-timer">0:30</div>
        </div>
        <div class="bui-plate bui-right">
          <div class="bui-name">${opts.rightName || 'Противник'}</div>
          <div class="bui-bar"><div class="bui-fill"></div><span class="bui-bar-text"></span></div>
        </div>
      </div>
      <div class="bui-popups"></div>
      <div class="bui-end hidden">
        <div class="bui-end-card">
          <div class="bui-end-title"></div>
          <button class="bui-restart">В бой снова</button>
        </div>
      </div>`;

    this.container.appendChild(dock);
    this.container.appendChild(overlay);
    this.dock = dock;
    this.el = overlay;

    this.refs = {
      hpFill: {
        left: overlay.querySelector('.bui-left .bui-fill'),
        right: overlay.querySelector('.bui-right .bui-fill'),
      },
      hpText: {
        left: overlay.querySelector('.bui-left .bui-bar-text'),
        right: overlay.querySelector('.bui-right .bui-bar-text'),
      },
      turn: overlay.querySelector('.bui-turn'),
      timer: overlay.querySelector('.bui-timer'),
      popups: overlay.querySelector('.bui-popups'),
      end: overlay.querySelector('.bui-end'),
      endTitle: overlay.querySelector('.bui-end-title'),
      restart: overlay.querySelector('.bui-restart'),
      log: dock.querySelector('.bui-log'),
      controls: dock.querySelector('.bui-controls'),
      status: dock.querySelector('.bui-status'),
    };

    // зоны атаки: нажатие = немедленный удар (с текущим блоком или без него)
    this._atkButtons = [];
    const atkRow = dock.querySelector('.bui-attack .bui-zone-row');
    for (const z of ZONES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bz bz-attack';
      b.title = `Удар: ${z.hint}`;
      b.innerHTML = `<span class="bz-ico">${ZONE_ICONS[z.id]}</span><span class="bz-label">${z.label}</span>`;
      b.addEventListener('click', () => this._strike(z.id, b));
      atkRow.appendChild(b);
      this._atkButtons.push(b);
    }

    // зоны блока: переключатель, можно вовсе не выбирать
    this._blkButtons = [];
    const blkRow = dock.querySelector('.bui-block .bui-zone-row');
    for (const blk of BLOCKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bz bz-block';
      b.dataset.block = blk.id;
      b.title = `Блок: ${blk.hint}`;
      b.innerHTML = `<span class="bz-ico">${ZONE_ICONS[blk.zones[0]]}</span><span class="bz-label">${blk.label}</span>`;
      b.addEventListener('click', () => this._selectBlock(blk.id));
      blkRow.appendChild(b);
      this._blkButtons.push(b);
    }

    this._setLocked(true, null);
  }

  _strike(zoneId, btn) {
    if (this._locked) return;
    this._locked = true; // защита от двойного клика до hideControls()
    btn.classList.add('chosen');
    this.onStrike({ attack: zoneId, block: this.block });
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
    this.refs.controls.classList.toggle('waiting', !!statusText);
    this.refs.status.textContent = statusText || '';
    for (const b of this._atkButtons) b.disabled = locked;
    for (const b of this._blkButtons) b.disabled = locked;
  }

  setHP(side, cur, max) {
    const pct = Math.max(0, (cur / max) * 100);
    this.refs.hpFill[side].style.width = pct + '%';
    this.refs.hpFill[side].classList.toggle('low', pct < 30);
    this.refs.hpText[side].textContent = `${Math.round(cur)} / ${max}`;
  }

  setTurn(n) {
    this.refs.turn.textContent = 'Ход ' + n;
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

  /** Кнопки блокируются на время удара (панель не исчезает — без скачков). */
  hideControls(showWait = true) {
    this._setLocked(true, showWait ? '⏳ Ход противника…' : '⚔ Обмен ударами…');
  }

  showControls() {
    this.block = null;
    for (const b of this._blkButtons) b.classList.remove('active');
    for (const b of this._atkButtons) b.classList.remove('chosen');
    this._setLocked(false, null);
  }

  /** Всплывающая цифра урона в экранной точке {x, y}. */
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
    const el = this.refs.log;
    // автопрокрутка только если пользователь и так у нижнего края,
    // иначе не сбиваем его с чтения истории
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
    el.appendChild(node);
    if (stick) el.scrollTop = el.scrollHeight;
  }

  showEnd(victory, onRestart) {
    this.log(victory ? '🏆 <b>Победа!</b>' : '☠ <b>Поражение…</b>');
    this.refs.endTitle.textContent = victory ? '⚔ Победа! ⚔' : 'Поражение…';
    this.refs.endTitle.classList.toggle('defeat', !victory);
    this.refs.end.classList.remove('hidden');
    this.refs.restart.onclick = () => {
      this.refs.end.classList.add('hidden');
      onRestart && onRestart();
    };
  }

  destroy() {
    this.el.remove();
    this.dock.remove();
  }
}
