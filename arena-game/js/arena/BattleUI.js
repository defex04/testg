/**
 * Боевой интерфейс поверх арены: панели HP, таймер, выбор зоны атаки и блока,
 * всплывающие цифры урона, журнал боя, экран победы/поражения.
 *
 * Во время разыгрывания удара панель управления скрывается
 * (hideControls/showControls), как в классических браузерных файтингах.
 */
import { ZONES, BLOCKS } from './BattleSystem.js';

export class BattleUI {
  constructor(container, opts = {}) {
    this.container = container;
    this.onStrike = opts.onStrike || (() => {});
    this.selection = { attack: null, block: null };
    this._build(opts);
  }

  _build(opts) {
    const el = document.createElement('div');
    el.className = 'bui';
    el.innerHTML = `
      <div class="bui-top">
        <div class="bui-plate bui-left">
          <div class="bui-name">${opts.leftName || 'Игрок'}</div>
          <div class="bui-bar hp"><div class="bui-fill"></div><span class="bui-bar-text"></span></div>
        </div>
        <div class="bui-vs">
          <div class="bui-turn">Ход 1</div>
          <div class="bui-timer">0:30</div>
        </div>
        <div class="bui-plate bui-right">
          <div class="bui-name">${opts.rightName || 'Противник'}</div>
          <div class="bui-bar hp"><div class="bui-fill"></div><span class="bui-bar-text"></span></div>
        </div>
      </div>

      <div class="bui-log"></div>

      <div class="bui-controls">
        <div class="bui-col bui-attack">
          <div class="bui-col-title">Атака</div>
          <div class="bui-zone-list"></div>
        </div>
        <div class="bui-strike-wrap">
          <button class="bui-strike" disabled>
            <span class="bui-strike-icon">⚔</span>
            <span class="bui-strike-text">Удар!</span>
          </button>
        </div>
        <div class="bui-col bui-block">
          <div class="bui-col-title">Блок</div>
          <div class="bui-zone-list"></div>
        </div>
      </div>

      <div class="bui-wait hidden">Ход противника…</div>
      <div class="bui-popups"></div>
      <div class="bui-end hidden">
        <div class="bui-end-card">
          <div class="bui-end-title"></div>
          <button class="bui-restart">В бой снова</button>
        </div>
      </div>`;
    this.container.appendChild(el);
    this.el = el;

    this.refs = {
      hpFill: {
        left: el.querySelector('.bui-left .bui-fill'),
        right: el.querySelector('.bui-right .bui-fill'),
      },
      hpText: {
        left: el.querySelector('.bui-left .bui-bar-text'),
        right: el.querySelector('.bui-right .bui-bar-text'),
      },
      turn: el.querySelector('.bui-turn'),
      timer: el.querySelector('.bui-timer'),
      log: el.querySelector('.bui-log'),
      controls: el.querySelector('.bui-controls'),
      wait: el.querySelector('.bui-wait'),
      strike: el.querySelector('.bui-strike'),
      popups: el.querySelector('.bui-popups'),
      end: el.querySelector('.bui-end'),
      endTitle: el.querySelector('.bui-end-title'),
      restart: el.querySelector('.bui-restart'),
    };

    const attackList = el.querySelector('.bui-attack .bui-zone-list');
    for (const z of ZONES) {
      const b = document.createElement('button');
      b.className = 'bui-zone';
      b.dataset.zone = z.id;
      b.innerHTML = `<i>➤</i>${z.label}`;
      b.addEventListener('click', () => this._select('attack', z.id, attackList, b));
      attackList.appendChild(b);
    }
    const blockList = el.querySelector('.bui-block .bui-zone-list');
    for (const blk of BLOCKS) {
      const b = document.createElement('button');
      b.className = 'bui-zone';
      b.dataset.block = blk.id;
      b.innerHTML = `<i>🛡</i>${blk.label}`;
      b.addEventListener('click', () => this._select('block', blk.id, blockList, b));
      blockList.appendChild(b);
    }

    this.refs.strike.addEventListener('click', () => {
      if (this.selection.attack && this.selection.block) {
        this.onStrike({ ...this.selection });
      }
    });
  }

  _select(kind, id, list, btn) {
    this.selection[kind] = id;
    list.querySelectorAll('.bui-zone').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    this.refs.strike.disabled = !(this.selection.attack && this.selection.block);
  }

  setHP(side, cur, max) {
    const pct = Math.max(0, (cur / max) * 100);
    this.refs.hpFill[side].style.width = pct + '%';
    this.refs.hpFill[side].classList.toggle('low', pct < 30);
    this.refs.hpText[side].textContent = `${Math.round(cur)} / ${max}`;
  }

  setTurn(n) {
    this.refs.turn.textContent = 'Ход ' + n;
  }

  setTimer(sec) {
    const s = Math.max(0, sec);
    this.refs.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.refs.timer.classList.toggle('urgent', s <= 5);
  }

  /** Кнопки исчезают на время удара. */
  hideControls(showWait = true) {
    this.refs.controls.classList.add('hidden');
    this.refs.wait.classList.toggle('hidden', !showWait);
  }

  showControls() {
    this.selection = { attack: null, block: null };
    this.el.querySelectorAll('.bui-zone').forEach((b) => b.classList.remove('active'));
    this.refs.strike.disabled = true;
    this.refs.controls.classList.remove('hidden');
    this.refs.wait.classList.add('hidden');
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

  log(html) {
    this.refs.log.innerHTML = html;
    this.refs.log.classList.remove('flash');
    void this.refs.log.offsetWidth; // перезапуск css-анимации
    this.refs.log.classList.add('flash');
  }

  showEnd(victory, onRestart) {
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
  }
}
