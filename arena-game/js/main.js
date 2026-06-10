/**
 * Точка входа демо-игры: собирает модуль арены, боевую систему и UI,
 * плюс MMORPG-обвязку вокруг (аукцион, рюкзак и т.п. — заглушки).
 *
 * Всё, что нужно менять при добавлении контента, находится в
 * FIGHTERS и BACKGROUNDS — см. README.md.
 */
import { Arena } from './arena/Arena.js';
import { BattleSystem } from './arena/BattleSystem.js';
import { BattleUI } from './arena/BattleUI.js';
import { DressingRoom } from './arena/DressingRoom.js';

// ---------------------------------------------------------------------------
// БИБЛИОТЕКА КОНТЕНТА — сюда добавляются новые модели и фоны
// ---------------------------------------------------------------------------

const FIGHTERS = {
  brawler: {
    name: 'Сила_Воли',
    model: 'assets/models/fighter.fbx',
    height: 1.85,
    stats: { hp: 2330, damage: [160, 240], crit: 0.14, dodge: 0.07 },
    animations: {
      idle:   { file: 'assets/models/fighter.fbx' },
      // анимация из другого файла "надевается" на скелет модели
      attack: { file: 'assets/models/martelo2.fbx', hitTime: 0.58, reach: 1.25, inPlace: true },
      // боевой клич для примерочной; lazy — не грузится при старте боя
      taunt:  { file: 'assets/models/taunt.fbx', inPlace: true, lazy: true },
    },
  },
  // тот же меш, другие статы — пример того, что боец = конфиг
  brawlerElite: {
    name: 'Сумасшедший',
    model: 'assets/models/fighter.fbx',
    height: 1.92,
    stats: { hp: 2600, damage: [140, 220], crit: 0.1, dodge: 0.05 },
    animations: {
      idle:   { file: 'assets/models/fighter.fbx' },
      attack: { file: 'assets/models/martelo2.fbx', hitTime: 0.58, reach: 1.25, inPlace: true },
      // боевой клич для примерочной; lazy — не грузится при старте боя
      taunt:  { file: 'assets/models/taunt.fbx', inPlace: true, lazy: true },
    },
  },
};

const BACKGROUNDS = {
  village:  { label: 'Деревня',  image: 'assets/backgrounds/village.svg' },
  canyon:   { label: 'Каньон',   image: 'assets/backgrounds/canyon.svg' },
  night:    { label: 'Ночь',     css: 'linear-gradient(180deg,#0b1026 0%,#1b2a52 55%,#2c3e6b 78%,#15315c 100%)' },
};

// Экипировка: предмет = модель + слот + настройки крепления к кости.
// Новый предмет — новая запись здесь, код трогать не нужно.
const ITEMS = {
  bronzeArmor: {
    name: 'Бронзовый доспех',
    icon: '🛡️',
    slot: 'torso',
    model: 'assets/models/bronze_armor.fbx',
    // у модели Meshy "перёд" вдоль локальной -X, поэтому доворот на 90°;
    // cover/offset подобраны в примерочной. Материал — родной из FBX:
    // с PBR-картами из архива металл пересвечивается (см. README).
    attach: { bone: /Spine1$/i, cover: 1.5, scale: 1, offset: [0.02, -0.02, 0], rotation: [0, 90, 0] },
  },
};

// ---------------------------------------------------------------------------
// Telegram WebApp (безопасно: в обычном браузере просто ничего не делает)
// ---------------------------------------------------------------------------

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

const arenaRoot = document.getElementById('arena-root');
const arenaStage = document.getElementById('arena-stage');
const loadingEl = document.getElementById('arena-loading');

// канвас живёт в stage; боевой UI добавляет в arenaRoot док ПОД канвасом,
// поэтому панель управления и журнал не перекрывают сцену
const arena = new Arena(arenaStage);
window.__arena = arena; // отладочный доступ из консоли
window.__debug = () => ({ arena, dressing, ITEMS, equipState, fighters });
arena.setBackground(BACKGROUNDS.village);

let battle = null;
let ui = null;
let fighters = { left: null, right: null };

async function startBattle() {
  loadingEl.classList.remove('hidden');
  if (ui) ui.destroy();
  if (battle) battle.destroy();

  const leftDef = FIGHTERS.brawler;
  const rightDef = FIGHTERS.brawlerElite;

  [fighters.left, fighters.right] = await Promise.all([
    arena.addFighter('left', leftDef),
    arena.addFighter('right', rightDef),
  ]);
  // надетое переживает перезапуск боя
  await Promise.all([syncEquipment('left'), syncEquipment('right')]);
  loadingEl.classList.add('hidden');

  battle = new BattleSystem({
    left:  { name: leftDef.name,  isAI: false, ...leftDef.stats },
    right: { name: rightDef.name, isAI: true,  ...rightDef.stats },
  }, { turnTime: 30 });

  ui = new BattleUI(arenaRoot, {
    leftName: leftDef.name,
    rightName: rightDef.name,
    onStrike: (move) => {
      ui.hideControls();
      battle.submitMove('left', move);
    },
  });
  ui.setHP('left', battle.sides.left.hp, battle.sides.left.maxHp);
  ui.setHP('right', battle.sides.right.hp, battle.sides.right.maxHp);

  battle.addEventListener('turnStart', (e) => {
    ui.setTurn(e.detail.turn);
    ui.setTimer(e.detail.timeLeft);
    ui.showControls();
  });

  battle.addEventListener('timer', (e) => ui.setTimer(e.detail.timeLeft));

  battle.addEventListener('resolve', async (e) => {
    ui.hideControls(false);
    for (const s of e.detail.strikes) {
      await playStrike(s, e.detail.sides);
    }
    battle.finishTurn();
  });

  battle.addEventListener('battleEnd', (e) => {
    ui.hideControls(false);
    ui.showEnd(e.detail.winner === 'left', () => startBattle());
  });

  battle.start();
}

const ZONE_LABELS = { high: 'голову', mid: 'корпус', low: 'ноги' };

async function playStrike(s, sides) {
  const attacker = fighters[s.attacker];
  const defender = fighters[s.defender];

  await attacker.strike(defender, () => {
    const pos = arena.worldToScreen(defender.headPoint());
    if (s.dodged) {
      ui.popup(pos, 'Уворот!', 'dodge');
    } else if (s.blocked && !s.crit) {
      defender.hitReact();
      ui.popup(pos, `Блок −${s.damage}`, 'block');
    } else {
      defender.hitReact();
      ui.popup(pos, `−${s.damage}`, s.crit ? 'crit' : 'dmg');
    }
    ui.setHP(s.defender, s.defenderHp, sides[s.defender].maxHp);

    const who = sides[s.attacker].name;
    const whom = sides[s.defender].name;
    const zone = ZONE_LABELS[s.zone] || s.zone;
    let text;
    if (s.dodged) text = `<b>${whom}</b> уклонился от удара`;
    else if (s.crit) text = `<b>${who}</b> наносит <span class="crit">критический удар</span> в ${zone}: −${s.damage}`;
    else if (s.blocked) text = `<b>${whom}</b> блокирует удар в ${zone}: −${s.damage}`;
    else text = `<b>${who}</b> бьёт в ${zone}: −${s.damage}`;
    ui.log(text);
  });

  if (s.killed) {
    await defender.die();
    ui.log(`<b>${sides[s.defender].name}</b> повержен!`);
  }
}

// ---------------------------------------------------------------------------
// Инвентарь: надеть/снять предметы на любого из бойцов
// ---------------------------------------------------------------------------

// Желаемое состояние экипировки. Единственный источник правды:
// UI меняет его, а syncEquipment приводит бойцов в соответствие.
// Так нет гонок между кликами и пересозданием бойцов при рестарте боя.
const equipState = { left: {}, right: {} };   // side -> slot -> itemKey | null
const syncLocks = { left: Promise.resolve(), right: Promise.resolve() };
const busySides = new Set();

function syncEquipment(side) {
  // очередь на бойца: одновременные вызовы выполняются по одному
  syncLocks[side] = syncLocks[side].then(async () => {
    busySides.add(side);
    renderInventory();
    try {
      // всегда берём АКТУАЛЬНОГО бойца — он мог быть пересоздан
      const fighter = fighters[side];
      if (!fighter) return;
      for (const [slot, key] of Object.entries(equipState[side])) {
        try {
          if (key && !fighter.hasEquipped(slot)) await fighter.equip(ITEMS[key]);
          else if (!key && fighter.hasEquipped(slot)) fighter.unequip(slot);
        } catch (e) {
          // предмет не загрузился — откатываем желаемое состояние,
          // иначе каждый рестарт боя будет повторять ошибку
          console.error(`Не удалось надеть «${ITEMS[key]?.name || key}»:`, e);
          equipState[side][slot] = null;
        }
      }
    } finally {
      busySides.delete(side);
      renderInventory();
    }
  }).catch((e) => console.error('Ошибка экипировки:', e));
  return syncLocks[side];
}

function toggleEquip(side, itemKey) {
  const item = ITEMS[itemKey];
  equipState[side][item.slot] = equipState[side][item.slot] === itemKey ? null : itemKey;
  return syncEquipment(side);
}

// --- примерочная: персонаж лицом к камере, вещи меряются на нём ---

const dressingEl = document.getElementById('dressing');
const dressingItemsEl = document.getElementById('dressing-items');
const dressing = new DressingRoom(document.getElementById('dressing-view'));
let dressingSide = 'left';
let dressingBusy = false;

async function openDressing(side) {
  dressingSide = side;
  document.querySelectorAll('.dressing-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.side === side));
  dressingEl.classList.remove('hidden');
  dressing.start();
  dressingBusy = true;
  renderInventory();
  try {
    await dressing.show(side === 'left' ? FIGHTERS.brawler : FIGHTERS.brawlerElite);
    await syncDressing(false);
  } finally {
    dressingBusy = false;
    renderInventory();
  }
}

/** Привести персонажа в примерочной к equipState (желаемому состоянию). */
async function syncDressing(withTaunt = true) {
  const f = dressing.fighter;
  if (!f) return;
  for (const [slot, key] of Object.entries(equipState[dressingSide])) {
    try {
      if (key && !f.hasEquipped(slot)) {
        if (withTaunt) await dressing.equip(ITEMS[key]);
        else await f.equip(ITEMS[key]);
      } else if (!key && f.hasEquipped(slot)) {
        dressing.unequip(slot);
      }
    } catch (e) {
      console.error(`Примерочная: не удалось надеть «${ITEMS[key]?.name || key}»:`, e);
      equipState[dressingSide][slot] = null;
    }
  }
}

async function toggleDressingEquip(itemKey) {
  if (dressingBusy) return;
  dressingBusy = true;
  renderInventory();
  try {
    toggleEquip(dressingSide, itemKey);   // состояние + бойцы на арене (очередь)
    await syncDressing();                 // персонаж в примерочной
  } finally {
    dressingBusy = false;
    renderInventory();
  }
}

function renderInventory() {
  dressingItemsEl.innerHTML = '';
  for (const [key, item] of Object.entries(ITEMS)) {
    const equipped = equipState[dressingSide][item.slot] === key;
    const row = document.createElement('div');
    row.className = 'inv-item';
    row.innerHTML = `
      <div class="inv-item-head">
        <span class="inv-icon">${item.icon || '📦'}</span>
        <span class="inv-name">${item.name}</span>
      </div>
      <div class="inv-actions"></div>`;
    const b = document.createElement('button');
    b.className = 'inv-btn' + (equipped ? ' equipped' : '');
    b.disabled = dressingBusy;
    b.textContent = dressingBusy ? 'Загрузка…' : (equipped ? 'Снять' : 'Надеть');
    b.addEventListener('click', () => toggleDressingEquip(key));
    row.querySelector('.inv-actions').appendChild(b);
    dressingItemsEl.appendChild(row);
  }
}

document.getElementById('inventory-btn').addEventListener('click', () => {
  openDressing(dressingSide);
});
document.querySelectorAll('.dressing-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (!dressingBusy && tab.dataset.side !== dressingSide) openDressing(tab.dataset.side);
  });
});
document.getElementById('dressing-close').addEventListener('click', () => {
  dressingEl.classList.add('hidden');
  dressing.stop(); // рендер-цикл примерочной не жрёт GPU, пока она закрыта
});

// ---------------------------------------------------------------------------
// MMORPG-обвязка: переключатель фона + кнопки-заглушки боковых модулей
// ---------------------------------------------------------------------------

const bgSelect = document.getElementById('bg-select');
for (const [key, bg] of Object.entries(BACKGROUNDS)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = bg.label;
  bgSelect.appendChild(opt);
}
bgSelect.addEventListener('change', () => arena.setBackground(BACKGROUNDS[bgSelect.value]));

const toast = document.getElementById('toast');
let toastTimer = null;
document.querySelectorAll('[data-module]').forEach((btn) => {
  btn.addEventListener('click', () => {
    toast.textContent = `Модуль «${btn.dataset.module}» подключается отдельно — арена о нём ничего не знает`;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  });
});

startBattle();
