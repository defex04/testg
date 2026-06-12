/**
 * Воркер автоскиннинга: перенос весов скиннинга с меша тела персонажа на
 * вершины статичного предмета (брони/одежды). Вынесен в отдельный поток,
 * потому что модели из генераторов бывают огромными (миллионы вершин) —
 * расчёт идёт фоном, интерфейс не замирает.
 *
 * Алгоритм (всё на типизированных массивах, без аллокаций в горячих циклах):
 *  1) сварка дубликатов вершин (швы UV/нормалей) — веса считаются один раз
 *     на точку, швы гарантированно не расходятся в движении;
 *  2) k ближайших вершин тела через равномерную хэш-сетку, смешивание
 *     весов с коэффициентом 1/d²;
 *  3) лапласово сглаживание весов по рёбрам меша (CSR-смежность);
 *  4) на вершину остаются 4 сильнейшие кости (лимит GPU-скиннинга three).
 *
 * Вход (postMessage):  { id, pos, index?, matrix, bodyPos, bodyIdx, bodyWt,
 *                        k, smoothIters }
 *   pos    Float32Array(n*3)  — вершины предмета (локальные);
 *   index  Uint32Array | null — индексы треугольников (если меш индексный);
 *   matrix Float64Array(16)   — локальные -> мировые (column-major);
 *   bodyPos/bodyIdx/bodyWt    — образцы тела: позиция (мир) + 4 пары
 *                               кость/вес на образец.
 * Выход: { id, ok, skinIndex: Uint16Array(n*4), skinWeight: Float32Array(n*4) }
 */
'use strict';

self.onmessage = (e) => {
  const d = e.data;
  try {
    const out = transfer(d);
    self.postMessage(
      { id: d.id, ok: true, skinIndex: out.skinIndex, skinWeight: out.skinWeight },
      [out.skinIndex.buffer, out.skinWeight.buffer]
    );
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) });
  }
};

const INFL = 8;        // костей-кандидатов на сваренную точку (до отбора топ-4)
const WELD_Q = 1e4;    // сварка с точностью 0.1 мм (мировые координаты в метрах)

function transfer({ pos, index, matrix, bodyPos, bodyIdx, bodyWt, k, smoothIters }) {
  const n = pos.length / 3;

  // --- вершины предмета -> мировые координаты ---
  const world = new Float32Array(n * 3);
  applyMatrix(pos, world, matrix);

  // --- 1. сварка дубликатов ---
  const repOf = new Int32Array(n);
  const repQ = new Int32Array(n * 3);     // квантованные координаты реп. точек
  const repXYZ = new Float32Array(n * 3);
  const buckets = new Map();              // hash -> int[] (точное сравнение по repQ)
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = world[i * 3];
    const y = world[i * 3 + 1];
    const z = world[i * 3 + 2];
    const qx = Math.round(x * WELD_Q) | 0;
    const qy = Math.round(y * WELD_Q) | 0;
    const qz = Math.round(z * WELD_Q) | 0;
    const h = ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) | 0;
    let arr = buckets.get(h);
    let rep = -1;
    if (arr) {
      for (let j = 0; j < arr.length; j++) {
        const r = arr[j];
        if (repQ[r * 3] === qx && repQ[r * 3 + 1] === qy && repQ[r * 3 + 2] === qz) {
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
      repQ[rep * 3] = qx;
      repQ[rep * 3 + 1] = qy;
      repQ[rep * 3 + 2] = qz;
      repXYZ[rep * 3] = x;
      repXYZ[rep * 3 + 1] = y;
      repXYZ[rep * 3 + 2] = z;
    }
    repOf[i] = rep;
  }

  // --- 2. k ближайших вершин тела на каждую реп. точку ---
  const grid = buildGrid(bodyPos);
  let repB = new Int32Array(m * INFL).fill(-1);
  let repW = new Float32Array(m * INFL);
  const bestI = new Int32Array(k);
  const bestD = new Float64Array(k);
  for (let r = 0; r < m; r++) {
    const cnt = nearest(grid, bodyPos,
      repXYZ[r * 3], repXYZ[r * 3 + 1], repXYZ[r * 3 + 2], k, bestI, bestD);
    for (let c = 0; c < cnt; c++) {
      const s = bestI[c];
      const wNear = 1 / (bestD[c] + 1e-8);
      for (let j = 0; j < 4; j++) {
        const w = bodyWt[s * 4 + j] * wNear;
        if (w > 0) addInfluence(repB, repW, r, bodyIdx[s * 4 + j], w);
      }
    }
    normalizeRow(repB, repW, r);
  }

  // --- 3. сглаживание по топологии ---
  if (smoothIters > 0 && m > 1) {
    const adj = buildAdjacency(index, repOf, n, m);
    const accB = new Int32Array(64);
    const accW = new Float32Array(64);
    for (let it = 0; it < smoothIters; it++) {
      const nextB = new Int32Array(m * INFL).fill(-1);
      const nextW = new Float32Array(m * INFL);
      for (let r = 0; r < m; r++) {
        const from = adj.offsets[r];
        const to = adj.offsets[r + 1];
        const deg = to - from;
        if (!deg) {
          for (let j = 0; j < INFL; j++) {
            nextB[r * INFL + j] = repB[r * INFL + j];
            nextW[r * INFL + j] = repW[r * INFL + j];
          }
          continue;
        }
        // аккумулятор: 0.5 своего веса + 0.5 среднего по соседям
        let used = 0;
        used = accumulate(accB, accW, used, repB, repW, r, 0.5);
        const kNbr = 0.5 / deg;
        for (let a = from; a < to; a++) {
          used = accumulate(accB, accW, used, repB, repW, adj.list[a], kNbr);
        }
        // топ-INFL аккумулятора -> следующая итерация
        writeTop(accB, accW, used, nextB, nextW, r);
        normalizeRow(nextB, nextW, r);
      }
      repB = nextB;
      repW = nextW;
    }
  }

  // --- 4. топ-4 кости на вершину, нормировка ---
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = repOf[i];
    // частичная сортировка: 4 максимума из INFL
    let sum = 0;
    for (let pick = 0; pick < 4; pick++) {
      let best = -1;
      let bw = 0;
      for (let j = 0; j < INFL; j++) {
        const b = repB[r * INFL + j];
        if (b < 0) continue;
        const w = repW[r * INFL + j];
        if (w <= bw) continue;
        // уже выбран?
        let taken = false;
        for (let t = 0; t < pick; t++) {
          if (skinIndex[i * 4 + t] === b && skinWeight[i * 4 + t] < 0) { taken = true; break; }
        }
        if (!taken) { best = j; bw = w; }
      }
      if (best < 0) break;
      skinIndex[i * 4 + pick] = repB[r * INFL + best];
      skinWeight[i * 4 + pick] = -repW[r * INFL + best]; // знак = метка «занято»
      sum += repW[r * INFL + best];
    }
    if (sum > 0) {
      for (let j = 0; j < 4; j++) skinWeight[i * 4 + j] = -skinWeight[i * 4 + j] / sum;
    } else {
      skinWeight[i * 4] = 1; // совсем без кандидатов — к кости 0 (корень)
    }
  }
  return { skinIndex, skinWeight };
}

function applyMatrix(src, dst, m) {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    dst[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    dst[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    dst[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
}

/** Вставить влияние кости в строку из INFL слотов (вытесняя слабейшее). */
function addInfluence(repB, repW, r, bone, w) {
  const base = r * INFL;
  let minJ = 0;
  let minW = Infinity;
  for (let j = 0; j < INFL; j++) {
    const b = repB[base + j];
    if (b === bone) { repW[base + j] += w; return; }
    if (b < 0) { repB[base + j] = bone; repW[base + j] = w; return; }
    if (repW[base + j] < minW) { minW = repW[base + j]; minJ = j; }
  }
  if (w > minW) { repB[base + minJ] = bone; repW[base + minJ] = w; }
}

function normalizeRow(repB, repW, r) {
  const base = r * INFL;
  let sum = 0;
  for (let j = 0; j < INFL; j++) if (repB[base + j] >= 0) sum += repW[base + j];
  if (sum > 0) for (let j = 0; j < INFL; j++) repW[base + j] /= sum;
}

/** Добавить веса строки src*scale в аккумулятор (линейный merge). */
function accumulate(accB, accW, used, repB, repW, src, scale) {
  const base = src * INFL;
  for (let j = 0; j < INFL; j++) {
    const b = repB[base + j];
    if (b < 0) continue;
    const w = repW[base + j] * scale;
    let found = -1;
    for (let a = 0; a < used; a++) if (accB[a] === b) { found = a; break; }
    if (found >= 0) accW[found] += w;
    else if (used < accB.length) { accB[used] = b; accW[used] = w; used++; }
  }
  return used;
}

/** Перенести топ-INFL аккумулятора в строку результата. */
function writeTop(accB, accW, used, outB, outW, r) {
  const base = r * INFL;
  for (let pick = 0; pick < INFL; pick++) {
    let best = -1;
    let bw = 0;
    for (let a = 0; a < used; a++) {
      if (accW[a] > bw) { bw = accW[a]; best = a; }
    }
    if (best < 0) { outB[base + pick] = -1; outW[base + pick] = 0; continue; }
    outB[base + pick] = accB[best];
    outW[base + pick] = accW[best];
    accW[best] = -1; // выбрано
  }
}

// --- равномерная хэш-сетка точек тела ---

function buildGrid(bodyPos) {
  const bn = bodyPos.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < bn; i++) {
    const x = bodyPos[i * 3], y = bodyPos[i * 3 + 1], z = bodyPos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const vol = Math.max(1e-9, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
  // ячейка ~ среднее расстояние между точками: в ячейке единицы точек
  const cell = Math.max(1e-6, Math.cbrt(vol / bn) * 1.5);
  const map = new Map(); // hash ячейки -> int[] (коллизии безопасны: отсев по d²)
  for (let i = 0; i < bn; i++) {
    const h = cellHash(
      Math.floor(bodyPos[i * 3] / cell),
      Math.floor(bodyPos[i * 3 + 1] / cell),
      Math.floor(bodyPos[i * 3 + 2] / cell));
    const arr = map.get(h);
    if (arr) arr.push(i);
    else map.set(h, [i]);
  }
  return { map, cell };
}

const cellHash = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;

/** k ближайших точек тела; результат в bestI/bestD, возвращает их число. */
function nearest(grid, bodyPos, x, y, z, k, bestI, bestD) {
  const cx = Math.floor(x / grid.cell);
  const cy = Math.floor(y / grid.cell);
  const cz = Math.floor(z / grid.cell);
  let count = 0;
  let stopR = -1;
  for (let r = 0; r < 64; r++) {
    // только оболочка куба радиуса r (внутренность уже просмотрена)
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const onFace = Math.abs(dx) === r || Math.abs(dy) === r;
        const step = onFace ? 1 : 2 * r || 1;
        for (let dz = -r; dz <= r; dz += step) {
          const arr = grid.map.get(cellHash(cx + dx, cy + dy, cz + dz));
          if (!arr) continue;
          for (let a = 0; a < arr.length; a++) {
            const i = arr[a];
            const ddx = bodyPos[i * 3] - x;
            const ddy = bodyPos[i * 3 + 1] - y;
            const ddz = bodyPos[i * 3 + 2] - z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            // вставка в отсортированный буфер из k лучших
            if (count < k) {
              let p = count++;
              while (p > 0 && bestD[p - 1] > d2) {
                bestD[p] = bestD[p - 1];
                bestI[p] = bestI[p - 1];
                p--;
              }
              bestD[p] = d2;
              bestI[p] = i;
            } else if (d2 < bestD[k - 1]) {
              let p = k - 1;
              while (p > 0 && bestD[p - 1] > d2) {
                bestD[p] = bestD[p - 1];
                bestI[p] = bestI[p - 1];
                p--;
              }
              bestD[p] = d2;
              bestI[p] = i;
            }
          }
        }
      }
    }
    // нашли кандидатов — добираем ещё одну оболочку (сосед может оказаться
    // чуть дальше по диагонали) и выходим; если точек мало (вершина далеко
    // от тела), не раздуваем поиск — хватит и того, что есть
    if (stopR >= 0 && r >= stopR) break;
    if (stopR < 0 && (count >= k || (count > 0 && r >= 2))) stopR = r + 1;
  }
  return count;
}

/** CSR-списки соседей сваренных точек по рёбрам треугольников. */
function buildAdjacency(index, repOf, n, m) {
  const triVerts = index || null;
  const total = triVerts ? triVerts.length : n;
  // первый проход — степени вершин (дубликаты рёбер не дедуплицируем:
  // лишний повтор соседа чуть увеличивает его вклад в сглаживание, на
  // качестве это не сказывается, зато не нужен дорогой Set на миллионы рёбер)
  const deg = new Int32Array(m);
  for (let t = 0; t < total; t += 3) {
    const a = repOf[triVerts ? triVerts[t] : t];
    const b = repOf[triVerts ? triVerts[t + 1] : t + 1];
    const c = repOf[triVerts ? triVerts[t + 2] : t + 2];
    if (a !== b) { deg[a]++; deg[b]++; }
    if (b !== c) { deg[b]++; deg[c]++; }
    if (c !== a) { deg[c]++; deg[a]++; }
  }
  const offsets = new Int32Array(m + 1);
  for (let r = 0; r < m; r++) offsets[r + 1] = offsets[r] + deg[r];
  const list = new Int32Array(offsets[m]);
  const cursor = offsets.slice(0, m);
  for (let t = 0; t < total; t += 3) {
    const a = repOf[triVerts ? triVerts[t] : t];
    const b = repOf[triVerts ? triVerts[t + 1] : t + 1];
    const c = repOf[triVerts ? triVerts[t + 2] : t + 2];
    if (a !== b) { list[cursor[a]++] = b; list[cursor[b]++] = a; }
    if (b !== c) { list[cursor[b]++] = c; list[cursor[c]++] = b; }
    if (c !== a) { list[cursor[c]++] = a; list[cursor[a]++] = c; }
  }
  return { offsets, list };
}
