/**
 * Движок экипировки: надевает FBX/GLB-предметы на скелетного персонажа так,
 * чтобы они корректно двигались в любых его анимациях.
 *
 * Три режима посадки (mode):
 *  - 'skin'     — предмет уже отскинен на совместимый скелет (имена костей
 *                 совпадают с точностью до префикса mixamorig). Меш предмета
 *                 перепривязывается к скелету персонажа — высшее качество,
 *                 нулевая цена в рантайме.
 *  - 'autoskin' — статичный меш (латы, штаны, перчатки, сапоги). Движок сам
 *                 рассчитывает скиннинг: переносит веса с меша тела персонажа
 *                 на вершины предмета (k ближайших вершин тела, сварка швов,
 *                 сглаживание по топологии) — предмет деформируется вместе
 *                 с телом, а не болтается на одной кости.
 *  - 'bone'     — жёсткое крепление к одной кости (оружие, шлем, амулет).
 *
 * Режим выбирается автоматически: скелет в файле → 'skin', иначе по слоту
 * (см. SLOT_FIT); явно — через itemDef.attach.mode. Тяжёлый расчёт
 * автоскиннинга выполняется один раз и кэшируется по паре
 * (модель предмета, модель персонажа) — повторное надевание мгновенно.
 *
 * Контракт результата: { itemDef, nodes, dispose() } — снять предмет можно
 * вызовом dispose(), он убирает узлы из сцены и освобождает клоны материалов
 * (геометрия остаётся в кэше, скелет принадлежит персонажу).
 */
import * as THREE from 'three';
import { loadGLTF, buildItemMaterial } from './loaders.js';

// ---------------------------------------------------------------------------
// Посадка по умолчанию для каждого слота. Поля:
//   mode   — способ крепления (см. выше);
//   bone   — кость крепления ('bone') и якорь по умолчанию;
//   at     — [кость1, кость2, t] точка между двумя костями (lerp);
//   ref    — [кость1, кость2] эталонная длина (по умолч. шея..бёдра);
//   cover  — размер предмета = ref * cover (по оси axis);
//   axis   — по какой оси мерить габарит предмета: 'y' | 'x' | 'max';
//   align  — 'top'/'bottom': прижать верх/низ предмета к якорю, не центр;
//   scale, offset [вперёд, вверх, влево] (м), rotation [x,y,z]° — ручные
//   поправки. Любое поле переопределяется в itemDef.attach.
// ---------------------------------------------------------------------------
const SLOT_FIT = {
  torso:     { mode: 'autoskin', bone: /Spine1$/i, at: [/Neck$/i, /Hips$/i, 0.45], cover: 1.35 },
  shoulders: { mode: 'autoskin', bone: /(Spine2|Spine1)$/i, at: [/Neck$/i, /Hips$/i, 0.12],
               ref: [/LeftArm$/i, /RightArm$/i], cover: 1.18, axis: 'x' },
  hands:     { mode: 'autoskin', bone: /Spine1$/i, at: [/LeftHand$/i, /RightHand$/i, 0.5],
               ref: [/LeftHand$/i, /RightHand$/i], cover: 1.02, axis: 'x' },
  legs:      { mode: 'autoskin', bone: /Hips$/i, at: [/Hips$/i, /Hips$/i, 0],
               ref: [/Hips$/i, /LeftFoot$/i], cover: 0.95, align: 'top' },
  feet:      { mode: 'autoskin', bone: /Hips$/i, at: [/LeftFoot$/i, /RightFoot$/i, 0.5],
               ref: [/Hips$/i, /LeftFoot$/i], cover: 0.32, offset: [0, 0.04, 0] },
  head:      { mode: 'bone', bone: /Head$/i, at: [/Head$/i, /HeadTop_?End$/i, 0.55],
               ref: [/Head$/i, /HeadTop_?End$/i], cover: 1.35 },
  belt:      { mode: 'bone', bone: /Hips$/i, at: [/Hips$/i, /Hips$/i, 0], cover: 0.45 },
  amulet:    { mode: 'bone', bone: /Neck$/i, at: [/Neck$/i, /Spine2$/i, 0.6], cover: 0.3 },
  mainhand:  { mode: 'bone', bone: /RightHand$/i, cover: 1.4, axis: 'max' },
  offhand:   { mode: 'bone', bone: /LeftHand$/i, cover: 1.1, axis: 'max' },
  misc:      { mode: 'bone', bone: /Spine1$/i, cover: 0.5 },
};

// кэш результатов автоскиннинга/перепривязки: key -> [{ geometry, srcMaterial, name }]
const partsCache = new Map();

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/** Надеть предмет на бойца. Возвращает { itemDef, nodes, dispose }. */
export async function equipItem(fighter, itemDef) {
  const slot = itemDef.slot || 'misc';
  const cfg = { ...(SLOT_FIT[slot] || SLOT_FIT.misc), ...(itemDef.attach || {}) };
  const { scene } = await loadGLTF(itemDef.model);

  let hasSkin = false;
  scene.traverse((o) => { hasSkin = hasSkin || !!o.isSkinnedMesh; });
  // cfg.mode (дефолт слота или attach.mode) важнее авто-детекта: Meshy-одежда
  // без скелета — autoskin; FBX с чужим ригом не должен перебивать это в 'skin'.
  let mode = cfg.mode || (hasSkin ? 'skin' : 'bone');
  if (mode === 'skin' && !isRigCompatible(scene, fighter)) {
    console.warn(`Экипировка «${itemDef.name}»: скелет несовместим с «${fighter.def.name}» — autoskin`);
    mode = 'autoskin';
  }

  const override = itemDef.material ? buildItemMaterial(itemDef.material) : null;

  if (mode === 'skin') return equipSkinned(fighter, itemDef, scene, override);
  if (mode === 'autoskin') return equipAutoSkin(fighter, itemDef, cfg, scene, override);
  return equipRigid(fighter, itemDef, cfg, scene, override);
}

/** Прогреть кэш: загрузка FBX + веса автоскиннинга (без надевания на сцену). */
export async function prefetchEquip(fighter, itemDef) {
  try {
    const slot = itemDef.slot || 'misc';
    const cfg = { ...(SLOT_FIT[slot] || SLOT_FIT.misc), ...(itemDef.attach || {}) };
    const { scene } = await loadGLTF(itemDef.model);
    let hasSkin = false;
    scene.traverse((o) => { hasSkin = hasSkin || !!o.isSkinnedMesh; });
    let mode = cfg.mode || (hasSkin ? 'skin' : 'bone');
    if (mode === 'skin' && !isRigCompatible(scene, fighter)) mode = 'autoskin';
    if (mode !== 'autoskin') return true;
    const main = mainSkinnedMesh(fighter);
    const key = cacheKey(fighter, itemDef, cfg, 'autoskin');
    if (!partsCache.has(key) && !pendingAuto.has(key)) {
      pendingAuto.set(key,
        computeAutoSkinTemplates(fighter, itemDef, cfg, scene, main, key)
          .then((t) => { partsCache.set(key, t); return t; })
          .finally(() => pendingAuto.delete(key)));
    }
    await pendingAuto.get(key);
    return true;
  } catch (e) {
    console.warn(`Прогрев «${itemDef.name}»:`, e);
    return false;
  }
}

/**
 * Выполнить fn в bind-позе скелета. Пока меряем посадку:
 *  — анимация (боксёрская idle) на паузе, иначе mixer перезапишет кости;
 *  — root.rotation.y = 0 (посадка в пространстве модели, не разворота арены);
 *  — skeleton.pose() на всех мешах.
 */
export function withBindPose(fighter, fn) {
  const savedBones = [];
  fighter.model.traverse((o) => {
    if (o.isBone) savedBones.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
  });

  const savedRootY = fighter.root.rotation.y;
  fighter.root.rotation.y = 0;

  const animSnap = pauseAnimation(fighter);

  fighter.model.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  fighter.model.updateMatrixWorld(true);

  try {
    return fn();
  } finally {
    for (const [b, p, q, s] of savedBones) {
      b.position.copy(p);
      b.quaternion.copy(q);
      b.scale.copy(s);
    }
    fighter.root.rotation.y = savedRootY;
    fighter.model.updateMatrixWorld(true);
    resumeAnimation(fighter, animSnap);
  }
}

function pauseAnimation(fighter) {
  if (!fighter.current) return null;
  const action = fighter.current;
  const wasPaused = action.paused;
  action.paused = true;
  return { action, time: action.time, wasPaused };
}

function resumeAnimation(fighter, snap) {
  if (!snap) return;
  const { action, time, wasPaused } = snap;
  action.time = time;
  action.paused = wasPaused;
  if (!action.isRunning()) action.play();
  fighter.current = action;
}

// ---------------------------------------------------------------------------
// Общая геометрия посадки
// ---------------------------------------------------------------------------

const matsOf = (o) =>
  Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
const cloneMats = (m) => (Array.isArray(m) ? m.map((x) => x.clone()) : m.clone());

function disposeNodeMats(node) {
  node.traverse((o) => { if (o.isMesh) matsOf(o).forEach((m) => m.dispose()); });
}

/** Самый большой скелетный меш персонажа — его скелет считаем главным. */
function mainSkinnedMesh(fighter) {
  let main = null;
  fighter.model.traverse((o) => {
    if (o.isSkinnedMesh &&
        (!main || o.geometry.attributes.position.count > main.geometry.attributes.position.count)) {
      main = o;
    }
  });
  if (!main) throw new Error(`У «${fighter.def.name}» нет скелетного меша`);
  return main;
}

function boneWorldPos(fighter, matcher) {
  const b = fighter.findBone(matcher);
  if (!b) throw new Error(`Кость ${matcher} не найдена у «${fighter.def.name}»`);
  return b.getWorldPosition(new THREE.Vector3());
}

function boneRefDistance(fighter, cfg) {
  const refPair = cfg.ref || [/Neck$/i, /Hips$/i];
  return boneWorldPos(fighter, refPair[0]).distanceTo(boneWorldPos(fighter, refPair[1])) || 0.5;
}

function measureDim(size, cfg) {
  return cfg.axis === 'max' ? Math.max(size.x, size.y, size.z)
    : cfg.axis === 'x' ? (size.x || size.y || size.z || 1)
    : (size.y || size.x || size.z || 1);
}

/** offset [вперёд, вверх, влево] в осях модели (+Z / +Y / -X) → позиция holder в local кости. */
function offsetInBoneLocal(bone, off) {
  const p = bone.getWorldPosition(new THREE.Vector3());
  p.addScaledVector(new THREE.Vector3(0, 0, 1), off[0] ?? 0);
  p.addScaledVector(new THREE.Vector3(0, 1, 0), off[1] ?? 0);
  p.addScaledVector(new THREE.Vector3(-1, 0, 0), off[2] ?? 0);
  return bone.worldToLocal(p);
}

/**
 * Жёсткое крепление: holder — ребёнок кости. offset — в осях модели (не кости!):
 * в боксёрской стойке локальная Z кости смотрит вбок, и смещение уводило латы в сторону.
 */
function fitToBone(fighter, itemRoot, bone, cfg) {
  const holder = new THREE.Group();
  bone.add(holder);

  const rot = (cfg.rotation || [0, 0, 0]).map(THREE.MathUtils.degToRad);
  holder.rotation.set(rot[0], rot[1], rot[2]);
  holder.add(itemRoot);
  holder.updateMatrixWorld(true);

  const ref = boneRefDistance(fighter, cfg);
  let box = new THREE.Box3().setFromObject(itemRoot);
  let size = box.getSize(new THREE.Vector3());
  holder.scale.setScalar((ref * (cfg.cover ?? 1.35)) / (measureDim(size, cfg) || 1) * (cfg.scale ?? 1));
  holder.updateMatrixWorld(true);

  box = new THREE.Box3().setFromObject(itemRoot);
  if (cfg.align === 'bottom' || cfg.align === 'top') {
    const pivot = (cfg.align === 'top' ? box.max : box.min).clone();
    holder.worldToLocal(pivot);
    itemRoot.position.copy(pivot).negate();
  } else {
    const center = box.getCenter(new THREE.Vector3());
    holder.worldToLocal(center);
    itemRoot.position.copy(center).negate();
  }

  holder.position.copy(offsetInBoneLocal(bone, cfg.offset || [0, 0, 0]));
  holder.updateMatrixWorld(true);
  return holder;
}

/**
 * Подогнать предмет к персонажу (автоскиннинг): масштаб от эталонной длины,
 * позиция на якорной точке в мире. Возвращает holder вне иерархии бойца.
 *
 * Габариты меряются ПОСЛЕ поворота: у Meshy/Tripo «рост» часто вдоль X.
 */
function fitTransform(fighter, itemRoot, cfg) {
  const ref = boneRefDistance(fighter, cfg);

  const at = cfg.at || [cfg.bone, cfg.bone, 0];
  const anchor = boneWorldPos(fighter, at[0]).lerp(boneWorldPos(fighter, at[1]), at[2] ?? 0);

  const rot = (cfg.rotation || [0, 0, 0]).map(THREE.MathUtils.degToRad);
  const holder = new THREE.Group();
  // только доворот из attach — не смешиваем с root.rotation (арена/примерочная)
  holder.rotation.set(rot[0], rot[1], rot[2]);
  holder.add(itemRoot);
  holder.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(itemRoot);
  let size = box.getSize(new THREE.Vector3());
  const scale = (ref * (cfg.cover ?? 1.35)) / (measureDim(size, cfg) || 1) * (cfg.scale ?? 1);
  holder.scale.setScalar(scale);
  holder.updateMatrixWorld(true);

  box = new THREE.Box3().setFromObject(itemRoot);
  size = box.getSize(new THREE.Vector3());
  if (cfg.align === 'top') anchor.y -= size.y / 2;
  else if (cfg.align === 'bottom') anchor.y += size.y / 2;

  // Mixamo: персонаж в модели смотрит в +Z (независимо от разворота на арене)
  const fwd = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const left = new THREE.Vector3(-1, 0, 0);
  const off = cfg.offset || [0, 0, 0];
  anchor.addScaledVector(fwd, off[0]).addScaledVector(up, off[1]).addScaledVector(left, off[2]);

  // центрируем в holder пока он в начале координат — иначе worldToLocal даст сдвиг
  const center = box.getCenter(new THREE.Vector3());
  holder.worldToLocal(center);
  itemRoot.position.copy(center).negate();
  holder.position.copy(anchor);
  holder.updateMatrixWorld(true);
  return holder;
}

/**
 * Мировая матрица узла-родителя корневой кости в bind-позе. В этой системе
 * координат живут boneInverses скелета: запекая геометрию через её инверсию
 * и привязывая SkinnedMesh с единичной bindMatrix, получаем предмет, который
 * скелет деформирует наравне с родным мешом тела.
 */
function skeletonSpaceInverse(skeleton) {
  const rootBone = skeleton.bones.find((b) => !(b.parent && b.parent.isBone));
  const m = new THREE.Matrix4();
  if (rootBone && rootBone.parent) m.copy(rootBone.parent.matrixWorld);
  return m.invert();
}

/** Ключ кэша: предмет + персонаж + вся конфигурация посадки. Рост в ключ
 *  не входит: в системе скелета посадка от него не зависит (бойцы разных
 *  ростов с одной моделью делят один расчёт). */
function cacheKey(fighter, itemDef, cfg, mode) {
  const cfgStr = Object.entries(cfg)
    .map(([k, v]) => k + '=' + String(v))
    .sort()
    .join(';');
  return [mode, 'v5', itemDef.model, fighter.def.model, cfgStr].join('|');
}

// ---------------------------------------------------------------------------
// Режим 'bone' — жёсткое крепление к кости
// ---------------------------------------------------------------------------

function equipRigid(fighter, itemDef, cfg, scene, override) {
  const item = scene.clone(true);
  item.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.material = override || cloneMats(o.material);
    }
  });

  // Жёсткие латы меряем в ТЕКУЩЕЙ позе (idle/стойка), не в bind-pose:
  // иначе якорь на груди в Т-позе, а на экране боксёрская стойка — доспех уезжает назад.
  const savedRootY = fighter.root.rotation.y;
  fighter.root.rotation.y = 0;
  fighter.model.updateMatrixWorld(true);

  try {
    const bone = fighter.findBone(cfg.bone || /Spine2$/i);
    if (!bone) throw new Error(`Кость для предмета не найдена у «${fighter.def.name}»`);
    const holder = fitToBone(fighter, item, bone, cfg);
    return equipResult(itemDef, [holder]);
  } finally {
    fighter.root.rotation.y = savedRootY;
    fighter.model.updateMatrixWorld(true);
  }
}

// ---------------------------------------------------------------------------
// Режим 'skin' — предмет отскинен на совместимый скелет
// ---------------------------------------------------------------------------

const normBoneName = (s) =>
  String(s).toLowerCase().replace(/^mixamorig[:_]?/, '').replace(/[^a-z0-9]/g, '');

/** Достаточно ли костей предмета совпадает с ригом персонажа для режима skin. */
function isRigCompatible(scene, fighter) {
  const main = mainSkinnedMesh(fighter);
  const charIdx = new Map(main.skeleton.bones.map((b, i) => [normBoneName(b.name), i]));
  let bones = 0;
  let matched = 0;
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    for (const b of o.skeleton.bones) {
      bones++;
      if (charIdx.has(normBoneName(b.name))) matched++;
    }
  });
  return bones > 0 && matched / bones >= 0.75;
}

function equipSkinned(fighter, itemDef, scene, override) {
  const main = mainSkinnedMesh(fighter);
  const key = cacheKey(fighter, itemDef, {}, 'skin');

  let parts = partsCache.get(key);
  if (!parts) {
    const charIdx = new Map(main.skeleton.bones.map((b, i) => [normBoneName(b.name), i]));
    const fallback = charIdx.get('hips') ?? 0;
    scene.updateMatrixWorld(true);
    parts = [];
    let missing = 0;
    scene.traverse((src) => {
      if (!src.isSkinnedMesh) return;
      const lut = src.skeleton.bones.map((b) => {
        const i = charIdx.get(normBoneName(b.name));
        if (i === undefined) missing++;
        return i ?? -1;
      });
      const geo = src.geometry.clone();
      remapSkinIndices(geo, lut, fallback);
      // вершины -> систему скелета персонажа; bindMatrix предмета учитывает
      // положение меша в его собственном FBX на момент привязки
      geo.applyMatrix4(src.bindMatrix);
      parts.push({ geometry: geo, srcMaterial: src.material, name: src.name });
    });
    if (!parts.length) throw new Error(`В «${itemDef.name}» нет скелетных мешей`);
    if (missing) {
      console.warn(`Экипировка «${itemDef.name}»: ${missing} костей нет у персонажа — ` +
        'их веса переданы соседним (совпадение ригов неполное)');
    }
    partsCache.set(key, parts);
  }

  return attachSkinnedParts(fighter, itemDef, parts, override, main.skeleton);
}

/** Перенумеровать skinIndex по lut; потерянные кости -> fallback c весом 0. */
function remapSkinIndices(geo, lut, fallback) {
  const idx = geo.attributes.skinIndex;
  const wts = geo.attributes.skinWeight;
  const n = idx.count;
  const outI = new Uint16Array(n * 4);
  const outW = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    let sum = 0;
    for (let j = 0; j < 4; j++) {
      const ci = lut[idx.getComponent(v, j)];
      const w = ci >= 0 ? wts.getComponent(v, j) : 0;
      outI[v * 4 + j] = ci >= 0 ? ci : fallback;
      outW[v * 4 + j] = w;
      sum += w;
    }
    if (sum > 1e-6) {
      for (let j = 0; j < 4; j++) outW[v * 4 + j] /= sum;
    } else {
      outI[v * 4] = fallback;   // вершина без единой знакомой кости
      outW[v * 4] = 1;
    }
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(outI, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(outW, 4));
}

/** Собрать SkinnedMesh-узлы из готовых частей (режим skin: геометрия уже в bind-пространстве). */
function attachSkinnedParts(fighter, itemDef, parts, override, skeleton) {
  const nodes = parts.map(({ geometry, srcMaterial, name }) => {
    const mesh = new THREE.SkinnedMesh(geometry, override || cloneMats(srcMaterial));
    mesh.name = `equip:${itemDef.slot || 'misc'}:${name}`;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    fighter.model.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  });
  return equipResult(itemDef, nodes);
}

function equipResult(itemDef, nodes) {
  return {
    itemDef,
    nodes,
    dispose() {
      for (const n of nodes) {
        n.removeFromParent();
        matsOf(n).forEach((m) => m.dispose());
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Режим 'autoskin' — перенос весов скиннинга с тела на статичный предмет.
// Сам расчёт (сварка вершин, k ближайших, сглаживание) живёт в воркере
// autoskin.worker.js: модели из генераторов бывают на миллионы вершин,
// и расчёт идёт фоном, не замораживая интерфейс. Результат кэшируется
// в памяти и в IndexedDB — после перезагрузки страницы пересчёта нет.
// ---------------------------------------------------------------------------

const pendingAuto = new Map();   // key -> Promise (дедупликация параллельных)
const MAX_AUTOSKIN_VERTS = 18000; // Meshy-модели 300k+ — упрощаем до разумного для GPU

async function equipAutoSkin(fighter, itemDef, cfg, scene, override) {
  const main = mainSkinnedMesh(fighter);
  const key = cacheKey(fighter, itemDef, cfg, 'autoskin');

  let templates = partsCache.get(key);
  if (!templates) {
    if (!pendingAuto.has(key)) {
      pendingAuto.set(key,
        computeAutoSkinTemplates(fighter, itemDef, cfg, scene, main, key)
          .then((t) => { partsCache.set(key, t); return t; })
          .finally(() => pendingAuto.delete(key)));
    }
    templates = await pendingAuto.get(key);
  }

  const tplByName = new Map(templates.map((t) => [t.name, t]));

  return withBindPose(fighter, () => {
    const holder = fitTransform(fighter, scene.clone(true), cfg);
    const nodes = [];

    holder.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      const tpl = tplByName.get(o.name) || templates[0];
      if (!tpl) return;

      const sm = new THREE.SkinnedMesh(tpl.geometry.clone(), override || cloneMats(o.material));
      sm.name = `equip:${itemDef.slot || 'misc'}:${o.name}`;
      sm.castShadow = true;
      sm.frustumCulled = false;
      sm.position.copy(o.position);
      sm.rotation.copy(o.rotation);
      sm.scale.copy(o.scale);
      o.parent.add(sm);
      o.parent.remove(o);
      sm.updateMatrixWorld(true);
      sm.bindMode = THREE.DetachedBindMode;
      sm.bind(main.skeleton, sm.matrixWorld.clone());
      nodes.push(sm);
    });

    if (!nodes.length) throw new Error(`В «${itemDef.name}» не удалось привязать меши`);
    holder.name = `equip-holder:${itemDef.slot || 'misc'}`;
    fighter.model.add(holder);
    return equipResult(itemDef, [holder, ...nodes]);
  });
}

async function computeAutoSkinTemplates(fighter, itemDef, cfg, scene, main, key) {
  const t0 = performance.now();

  // Снимок данных в bind-позе (синхронно): посадка предмета, образцы тела,
  // матрицы. Дальше можно считать асинхронно — всё уже скопировано.
  const jobs = [];
  let bodyData = null;
  withBindPose(fighter, () => {
    const holder = fitTransform(fighter, scene.clone(true), cfg);
    fighter.model.add(holder);
    fighter.model.updateMatrixWorld(true);
    bodyData = collectBodySamples(fighter, main);
    holder.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      const raw = o.geometry.clone();
      const geometry = simplifyForAutoskin(raw, MAX_AUTOSKIN_VERTS);
      jobs.push({
        geometry,
        srcMaterial: o.material,
        name: o.name,
        worldMatrix: o.matrixWorld.clone(),
      });
    });
    fighter.model.remove(holder);
  });
  if (!jobs.length) throw new Error(`В «${itemDef.name}» нет мешей`);

  const totalVerts = jobs.reduce((s, j) => s + j.geometry.attributes.position.count, 0);
  const idbKey = key + '|v5|' + totalVerts;

  // готовые веса из IndexedDB?
  let stored = await idbGet(idbKey).catch(() => null);
  let from = 'IndexedDB';
  const storedValid = stored && stored.length === jobs.length &&
    stored.every((s, i) =>
      s.skinIndex?.length === jobs[i].geometry.attributes.position.count * 4);
  if (!storedValid) {
    from = 'расчёт в воркере';
    const workerPayload = {
      bodyPos: bodyData.pos,
      bodyIdx: bodyData.sIdx,
      bodyWt: bodyData.sWt,
      k: cfg.knn ?? 6,
      smoothIters: cfg.smooth ?? 2,
    };
    stored = await Promise.all(jobs.map((job) => {
      const geo = job.geometry;
      return runAutoSkinWorker({
        ...workerPayload,
        pos: new Float32Array(geo.attributes.position.array),
        index: geo.index ? toUint32(geo.index.array) : null,
        matrix: new Float64Array(job.worldMatrix.elements),
      });
    }));
    idbPut(idbKey, stored.map((res) => ({
      skinIndex: res.skinIndex,
      skinWeight: res.skinWeight,
    }))).catch((e) => console.warn('Кэш экипировки не сохранился:', e));
  }

  const templates = jobs.map((job, i) => {
    const geo = job.geometry;
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(stored[i].skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(stored[i].skinWeight, 4));
    return { geometry: geo, srcMaterial: job.srcMaterial, name: job.name };
  });

  console.info(`Автоскиннинг «${itemDef.name}» на «${fighter.def.name}»: ` +
    `${totalVerts} вершин за ${Math.round(performance.now() - t0)} мс (${from})`);
  return templates;
}

const toUint32 = (arr) =>
  arr instanceof Uint32Array ? new Uint32Array(arr) : Uint32Array.from(arr);

/**
 * Упростить статичный меш перед автоскиннингом: квантование близких вершин.
 * Meshy/Tripo отдают сотни тысяч вершин — расчёт минутами; 15–20k хватает.
 */
function simplifyForAutoskin(geometry, maxVerts) {
  const n = geometry.attributes.position.count;
  if (n <= maxVerts) return geometry;

  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const diag = size.length() || 1;
  let quant = diag / Math.cbrt(maxVerts * 2);

  for (let attempt = 0; attempt < 14; attempt++) {
    const welded = weldGeometry(geometry, quant);
    if (welded.attributes.position.count <= maxVerts) return welded;
    quant *= 1.4;
  }
  return weldGeometry(geometry, quant);
}

/** Сварить вершины в пределах quant (метры), пересобрать индексы. */
function weldGeometry(geometry, quant) {
  const srcPos = geometry.attributes.position;
  const srcN = srcPos.count;
  const invQ = 1 / quant;
  const lut = new Int32Array(srcN);
  const buckets = new Map();
  const outPos = [];
  const repQ = [];
  let m = 0;

  for (let i = 0; i < srcN; i++) {
    const x = srcPos.getX(i);
    const y = srcPos.getY(i);
    const z = srcPos.getZ(i);
    const qx = Math.round(x * invQ);
    const qy = Math.round(y * invQ);
    const qz = Math.round(z * invQ);
    const h = ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) | 0;
    let arr = buckets.get(h);
    let rep = -1;
    if (arr) {
      for (let j = 0; j < arr.length; j++) {
        const r = arr[j];
        const ri = r * 3;
        if (repQ[ri] === qx && repQ[ri + 1] === qy && repQ[ri + 2] === qz) {
          rep = r;
          break;
        }
      }
    } else {
      buckets.set(h, (arr = []));
    }
    if (rep < 0) {
      rep = m++;
      arr.push(rep);
      outPos.push(x, y, z);
      repQ.push(qx, qy, qz);
    }
    lut[i] = rep;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));

  if (geometry.index) {
    const srcIdx = geometry.index.array;
    const dstIdx = new Uint32Array(srcIdx.length);
    for (let i = 0; i < srcIdx.length; i++) dstIdx[i] = lut[srcIdx[i]];
    out.setIndex(new THREE.BufferAttribute(dstIdx, 1));
  } else {
    const dstIdx = new Uint32Array(srcN);
    for (let i = 0; i < srcN; i++) dstIdx[i] = lut[i];
    out.setIndex(new THREE.BufferAttribute(dstIdx, 1));
  }

  if (geometry.attributes.normal) {
    const srcNorm = geometry.attributes.normal;
    const norms = new Float32Array(m * 3);
    const counts = new Uint16Array(m);
    for (let i = 0; i < srcN; i++) {
      const r = lut[i];
      norms[r * 3] += srcNorm.getX(i);
      norms[r * 3 + 1] += srcNorm.getY(i);
      norms[r * 3 + 2] += srcNorm.getZ(i);
      counts[r]++;
    }
    for (let r = 0; r < m; r++) {
      const c = counts[r] || 1;
      const nx = norms[r * 3] / c;
      const ny = norms[r * 3 + 1] / c;
      const nz = norms[r * 3 + 2] / c;
      const len = Math.hypot(nx, ny, nz) || 1;
      norms[r * 3] = nx / len;
      norms[r * 3 + 1] = ny / len;
      norms[r * 3 + 2] = nz / len;
    }
    out.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
  } else {
    out.computeVertexNormals();
  }

  if (geometry.attributes.uv) {
    const srcUv = geometry.attributes.uv;
    const uvs = new Float32Array(m * 2);
    const counts = new Uint16Array(m);
    for (let i = 0; i < srcN; i++) {
      const r = lut[i];
      uvs[r * 2] += srcUv.getX(i);
      uvs[r * 2 + 1] += srcUv.getY(i);
      counts[r]++;
    }
    for (let r = 0; r < m; r++) {
      const c = counts[r] || 1;
      uvs[r * 2] /= c;
      uvs[r * 2 + 1] /= c;
    }
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }

  return out;
}

/**
 * Образцы скиннинга тела: позиции вершин (мир, bind-поза) + индексы/веса
 * костей, приведённые к нумерации главного скелета.
 */
function collectBodySamples(fighter, main) {
  const boneIdx = new Map(main.skeleton.bones.map((b, i) => [b, i]));
  const meshes = [];
  let total = 0;
  fighter.model.traverse((o) => {
    if (!o.isSkinnedMesh || o.name.startsWith('equip:')) return;
    const lut = o.skeleton.bones.map((b) => boneIdx.get(b) ?? -1);
    if (!lut.some((i) => i >= 0)) return;
    meshes.push({ mesh: o, lut });
    total += o.geometry.attributes.position.count;
  });

  // на качество переноса хватает ~40k образцов — гуще не нужно
  const stride = Math.max(1, Math.floor(total / 40000));
  const cap = Math.ceil(total / stride) + meshes.length;
  const pos = new Float32Array(cap * 3);
  const sIdx = new Int32Array(cap * 4);
  const sWt = new Float32Array(cap * 4);
  let n = 0;
  const v = new THREE.Vector3();

  for (const { mesh, lut } of meshes) {
    const p = mesh.geometry.attributes.position;
    const si = mesh.geometry.attributes.skinIndex;
    const sw = mesh.geometry.attributes.skinWeight;
    for (let i = 0; i < p.count; i += stride) {
      let sum = 0;
      for (let j = 0; j < 4; j++) {
        const bi = lut[si.getComponent(i, j)];
        const w = bi >= 0 ? sw.getComponent(i, j) : 0;
        sIdx[n * 4 + j] = bi >= 0 ? bi : 0;
        sWt[n * 4 + j] = w;
        sum += w;
      }
      if (sum <= 1e-6) continue;
      for (let j = 0; j < 4; j++) sWt[n * 4 + j] /= sum;
      // реальная позиция на поверхности (скиннинг), а не сырые bind-вершины
      mesh.getVertexPosition(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      pos[n * 3] = v.x;
      pos[n * 3 + 1] = v.y;
      pos[n * 3 + 2] = v.z;
      n++;
    }
  }
  if (!n) throw new Error('Не удалось собрать веса тела персонажа');
  return {
    pos: pos.slice(0, n * 3),
    sIdx: sIdx.slice(0, n * 4),
    sWt: sWt.slice(0, n * 4),
  };
}

// ---------------------------------------------------------------------------
// Воркер автоскиннинга: один на страницу, запросы по id
// ---------------------------------------------------------------------------

let autoWorker = null;
let workerReqId = 0;
const workerInflight = new Map();   // id -> { resolve, reject }

function runAutoSkinWorker(payload) {
  if (!autoWorker) {
    autoWorker = new Worker(new URL('./autoskin.worker.js', import.meta.url));
    autoWorker.onmessage = (e) => {
      const { id, ok, skinIndex, skinWeight, error } = e.data;
      const req = workerInflight.get(id);
      if (!req) return;
      workerInflight.delete(id);
      if (ok) req.resolve({ skinIndex, skinWeight });
      else req.reject(new Error('Автоскиннинг: ' + error));
    };
    autoWorker.onerror = (e) => {
      const err = new Error('Воркер автоскиннинга: ' + (e.message || 'ошибка'));
      for (const req of workerInflight.values()) req.reject(err);
      workerInflight.clear();
      autoWorker = null;   // следующий запрос создаст воркер заново
    };
  }
  const id = ++workerReqId;
  // тело персонажа не передаём во владение — оно нужно для следующих мешей
  const transfers = [payload.pos.buffer, payload.matrix.buffer];
  if (payload.index) transfers.push(payload.index.buffer);
  return new Promise((resolve, reject) => {
    workerInflight.set(id, { resolve, reject });
    autoWorker.postMessage({ id, ...payload }, transfers);
  });
}

// ---------------------------------------------------------------------------
// IndexedDB-кэш рассчитанных весов: переживает перезагрузку страницы
// ---------------------------------------------------------------------------

let idbPromise = null;

function idbOpen() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('arena-equip', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('autoskin');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction('autoskin').objectStore('autoskin').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('autoskin', 'readwrite');
    tx.objectStore('autoskin').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
