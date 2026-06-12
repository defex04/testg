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
  const mode = hasSkin ? 'skin' : (cfg.mode || 'bone');

  const override = itemDef.material ? buildItemMaterial(itemDef.material) : null;

  if (mode === 'skin') return equipSkinned(fighter, itemDef, scene, override);
  if (mode === 'autoskin') return equipAutoSkin(fighter, itemDef, cfg, scene, override);
  return equipRigid(fighter, itemDef, cfg, scene, override);
}

/**
 * Выполнить fn в bind-позе (симметричная Т-поза). Меряем и привязываем только
 * в ней: боевая стойка скручивает корпус, и перекос «замораживался» бы в
 * привязке. Текущая поза анимации сохраняется и восстанавливается.
 */
export function withBindPose(fighter, fn) {
  const saved = [];
  fighter.model.traverse((o) => {
    if (o.isBone) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
  });
  fighter.model.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  fighter.model.updateMatrixWorld(true);
  try {
    return fn();
  } finally {
    for (const [b, p, q, s] of saved) {
      b.position.copy(p);
      b.quaternion.copy(q);
      b.scale.copy(s);
    }
    fighter.model.updateMatrixWorld(true);
  }
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

/**
 * Подогнать предмет к персонажу (вызывается в bind-позе): масштаб от эталонной
 * длины между костями, позиция на якорной точке. Возвращает holder —
 * НЕприкреплённую группу, чей matrixWorld = мировой трансформ предмета.
 */
function fitTransform(fighter, itemRoot, cfg) {
  const wp = (matcher) => {
    const b = fighter.findBone(matcher);
    if (!b) throw new Error(`Кость ${matcher} не найдена у «${fighter.def.name}»`);
    return b.getWorldPosition(new THREE.Vector3());
  };

  const refPair = cfg.ref || [/Neck$/i, /Hips$/i];
  const ref = wp(refPair[0]).distanceTo(wp(refPair[1])) || 0.5;

  const at = cfg.at || [cfg.bone, cfg.bone, 0];
  const anchor = wp(at[0]).lerp(wp(at[1]), at[2] ?? 0);

  itemRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(itemRoot);
  const size = box.getSize(new THREE.Vector3());
  const dim = cfg.axis === 'max' ? Math.max(size.x, size.y, size.z)
    : cfg.axis === 'x' ? (size.x || size.y || 1)
    : (size.y || 1);
  const scale = (ref * (cfg.cover ?? 1.35)) / (dim || 1) * (cfg.scale ?? 1);

  if (cfg.align === 'top') anchor.y -= (size.y * scale) / 2;
  else if (cfg.align === 'bottom') anchor.y += (size.y * scale) / 2;

  // куда смотрит боец (мир); в bind-позе корпус не скручен,
  // поэтому «ровно по направлению взгляда» = ровно по груди
  const yaw = fighter.root.rotation.y;
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const up = new THREE.Vector3(0, 1, 0);
  const left = new THREE.Vector3().crossVectors(up, fwd);
  const off = cfg.offset || [0, 0, 0];
  anchor.addScaledVector(fwd, off[0]).addScaledVector(up, off[1]).addScaledVector(left, off[2]);

  const rot = (cfg.rotation || [0, 0, 0]).map(THREE.MathUtils.degToRad);
  const holder = new THREE.Group();
  holder.position.copy(anchor);
  holder.rotation.set(rot[0], yaw + rot[1], rot[2]);
  holder.scale.setScalar(scale);
  // пивот предмета может быть где угодно — центруем по габаритам
  itemRoot.position.copy(box.getCenter(new THREE.Vector3())).negate();
  holder.add(itemRoot);
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
  return [mode, itemDef.model, fighter.def.model, cfgStr].join('|');
}

// ---------------------------------------------------------------------------
// Режим 'bone' — жёсткое крепление к кости
// ---------------------------------------------------------------------------

function equipRigid(fighter, itemDef, cfg, scene, override) {
  const item = scene.clone(true);
  item.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      // материалы свои у каждого бойца: вспышка урона не задевает соседа
      o.material = override || cloneMats(o.material);
    }
  });

  return withBindPose(fighter, () => {
    const holder = fitTransform(fighter, item, cfg);
    const bone = fighter.findBone(cfg.bone || /Spine1$/i);
    if (!bone) throw new Error(`Кость для предмета не найдена у «${fighter.def.name}»`);
    bone.attach(holder); // three сам пересчитает трансформ в систему кости
    return {
      itemDef,
      nodes: [holder],
      dispose() {
        holder.removeFromParent();
        disposeNodeMats(holder);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Режим 'skin' — предмет отскинен на совместимый скелет
// ---------------------------------------------------------------------------

const normBoneName = (s) =>
  String(s).toLowerCase().replace(/^mixamorig[:_]?/, '').replace(/[^a-z0-9]/g, '');

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

/** Собрать SkinnedMesh-узлы из готовых частей и привязать к скелету бойца. */
function attachSkinnedParts(fighter, itemDef, parts, override, skeleton) {
  const nodes = parts.map(({ geometry, srcMaterial, name }) => {
    const mesh = new THREE.SkinnedMesh(geometry, override || cloneMats(srcMaterial));
    mesh.name = `equip:${itemDef.slot || 'misc'}:${name}`;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // скелетные меши неверно отсекаются камерой
    fighter.model.add(mesh);
    // геометрия уже в системе скелета — bindMatrix единичная
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  });
  return {
    itemDef,
    nodes,
    dispose() {
      for (const n of nodes) {
        n.removeFromParent();
        matsOf(n).forEach((m) => m.dispose()); // геометрия остаётся в кэше
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

async function equipAutoSkin(fighter, itemDef, cfg, scene, override) {
  const main = mainSkinnedMesh(fighter);
  const key = cacheKey(fighter, itemDef, cfg, 'autoskin');

  let parts = partsCache.get(key);
  if (!parts) {
    if (!pendingAuto.has(key)) {
      pendingAuto.set(key,
        buildAutoSkinParts(fighter, itemDef, cfg, scene, main, key)
          .finally(() => pendingAuto.delete(key)));
    }
    parts = await pendingAuto.get(key);
    partsCache.set(key, parts);
  }

  return attachSkinnedParts(fighter, itemDef, parts, override, main.skeleton);
}

async function buildAutoSkinParts(fighter, itemDef, cfg, scene, main, key) {
  const t0 = performance.now();

  // Снимок данных в bind-позе (синхронно): посадка предмета, образцы тела,
  // матрицы. Дальше можно считать асинхронно — всё уже скопировано.
  const jobs = [];
  let bodyData = null;
  withBindPose(fighter, () => {
    const holder = fitTransform(fighter, scene.clone(true), cfg);
    bodyData = collectBodySamples(fighter, main);
    const skelInv = skeletonSpaceInverse(main.skeleton);
    holder.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      jobs.push({
        geometry: o.geometry.clone(),
        srcMaterial: o.material,
        name: o.name,
        worldMatrix: o.matrixWorld.clone(),
        bakeMatrix: new THREE.Matrix4().multiplyMatrices(skelInv, o.matrixWorld),
      });
    });
  });
  if (!jobs.length) throw new Error(`В «${itemDef.name}» нет мешей`);

  const totalVerts = jobs.reduce((s, j) => s + j.geometry.attributes.position.count, 0);
  const idbKey = key + '|' + totalVerts;   // замена модели = другой счётчик вершин

  // готовые веса из IndexedDB?
  let stored = await idbGet(idbKey).catch(() => null);
  let from = 'IndexedDB';
  const storedValid = stored && stored.length === jobs.length &&
    stored.every((s, i) =>
      s.skinIndex?.length === jobs[i].geometry.attributes.position.count * 4);
  if (!storedValid) {
    from = 'расчёт в воркере';
    stored = [];
    for (const job of jobs) {
      const geo = job.geometry;
      const res = await runAutoSkinWorker({
        pos: new Float32Array(geo.attributes.position.array),
        index: geo.index ? toUint32(geo.index.array) : null,
        matrix: new Float64Array(job.worldMatrix.elements),
        bodyPos: bodyData.pos,
        bodyIdx: bodyData.sIdx,
        bodyWt: bodyData.sWt,
        k: cfg.knn ?? 6,
        smoothIters: cfg.smooth ?? 2,
      });
      stored.push({ skinIndex: res.skinIndex, skinWeight: res.skinWeight });
    }
    idbPut(idbKey, stored).catch((e) => console.warn('Кэш экипировки не сохранился:', e));
  }

  const parts = jobs.map((job, i) => {
    const geo = job.geometry;
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(stored[i].skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(stored[i].skinWeight, 4));
    // вершины -> система скелета персонажа (см. skeletonSpaceInverse)
    geo.applyMatrix4(job.bakeMatrix);
    return { geometry: geo, srcMaterial: job.srcMaterial, name: job.name };
  });

  console.info(`Автоскиннинг «${itemDef.name}» на «${fighter.def.name}»: ` +
    `${totalVerts} вершин за ${Math.round(performance.now() - t0)} мс (${from})`);
  return parts;
}

const toUint32 = (arr) =>
  arr instanceof Uint32Array ? new Uint32Array(arr) : Uint32Array.from(arr);

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
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
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
