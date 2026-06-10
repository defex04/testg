/**
 * Загрузка GLB-моделей и анимаций.
 *
 * Особенность: некоторые конвертеры (Assimp, mixamo-mini) разбивают одну
 * анимацию на десятки клипов — по одному на кость. extractClip() умеет
 * склеивать их обратно в один клип, поэтому движку всё равно,
 * как был экспортирован файл.
 */
import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from '../../vendor/three/examples/jsm/loaders/FBXLoader.js';

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();
const gltfCache = new Map();   // url -> Promise<{scene, animations}>
const clipCache = new Map();   // url|clipName -> AnimationClip

/** Грузит модель любого поддерживаемого формата (.glb/.gltf/.fbx)
 *  и приводит результат к единому виду { scene, animations }. */
export function loadGLTF(url) {
  if (!gltfCache.has(url)) {
    const ext = url.split('.').pop().toLowerCase();
    let promise;
    if (ext === 'fbx') {
      promise = fbxLoader.loadAsync(url).then((group) => ({
        scene: group,
        animations: group.animations || [],
      }));
    } else {
      promise = gltfLoader.loadAsync(url);
    }
    gltfCache.set(url, promise);
  }
  return gltfCache.get(url);
}

/**
 * Достаёт клип анимации из загруженного GLTF.
 * - если указано имя клипа — ищет по имени;
 * - если клип один — возвращает его;
 * - если клипов много и имя не указано — считает это "разрезанным"
 *   экспортом и склеивает все треки в один клип.
 */
export function extractClip(gltf, url, clipName, label) {
  const key = url + '|' + (clipName || '*');
  if (clipCache.has(key)) return clipCache.get(key);

  const clips = gltf.animations || [];
  if (!clips.length) {
    throw new Error(`В файле ${url} нет анимаций`);
  }

  let clip;
  if (clipName) {
    clip = THREE.AnimationClip.findByName(clips, clipName);
    if (!clip) {
      throw new Error(`Клип "${clipName}" не найден в ${url}. Доступны: ${clips.map(c => c.name).join(', ')}`);
    }
  } else if (clips.length === 1) {
    clip = clips[0];
  } else {
    const tracks = [];
    const seen = new Set();
    for (const c of clips) {
      for (const t of c.tracks) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        tracks.push(t);
      }
    }
    clip = new THREE.AnimationClip(label || 'merged', -1, tracks);
  }

  clipCache.set(key, clip);
  return clip;
}

/**
 * Убирает горизонтальное перемещение корневой кости (X/Z), оставляя высоту:
 * движением бойца по арене управляет движок (выпад к цели), а не сам клип.
 * Иначе встроенный root motion клипа и выпад складываются и боец "уезжает".
 */
function makeInPlace(clip) {
  const c = clip.clone();
  let targets = c.tracks.filter((t) => t.name.endsWith('.position') && /hips|root/i.test(t.name));
  if (!targets.length) {
    const posTracks = c.tracks.filter((t) => t.name.endsWith('.position'));
    if (posTracks.length === 1) targets = posTracks;
  }
  for (const t of targets) {
    const v = t.values;
    for (let i = 3; i < v.length; i += 3) {
      v[i] = v[0];         // X — как в первом кадре
      v[i + 2] = v[2];     // Z — как в первом кадре (Y оставляем: присед/прыжок)
    }
  }
  return c;
}

/** Загружает клип анимации по описанию { file, clip, inPlace } из конфига бойца. */
export async function loadClip(spec, defaultFile, label) {
  const url = spec.file || defaultFile;
  const gltf = await loadGLTF(url);
  const clip = extractClip(gltf, url, spec.clip, label);
  return spec.inPlace ? makeInPlace(clip) : clip;
}

// ---------------------------------------------------------------------------
// Текстуры и PBR-материалы предметов
// ---------------------------------------------------------------------------

const texLoader = new THREE.TextureLoader();
const texCache = new Map();

export function loadTexture(url, { srgb = false } = {}) {
  const key = url + (srgb ? '|srgb' : '');
  if (!texCache.has(key)) {
    const t = texLoader.load(url);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return texCache.get(key);
}

/**
 * Собирает MeshStandardMaterial из набора карт
 * { map, normalMap, metalnessMap, roughnessMap, emissiveMap }.
 * FBX из генераторов (Meshy и т.п.) дают только Phong с цветом — отдельные
 * PBR-карты делают металл металлом.
 */
export function buildItemMaterial(cfg) {
  const m = new THREE.MeshStandardMaterial();
  if (cfg.map) m.map = loadTexture(cfg.map, { srgb: true });
  if (cfg.normalMap) m.normalMap = loadTexture(cfg.normalMap);
  if (cfg.metalnessMap) m.metalnessMap = loadTexture(cfg.metalnessMap);
  m.metalness = cfg.metalness ?? (cfg.metalnessMap ? 1 : 0.2);
  if (cfg.roughnessMap) m.roughnessMap = loadTexture(cfg.roughnessMap);
  m.roughness = cfg.roughness ?? 1;
  if (cfg.emissiveMap) {
    m.emissiveMap = loadTexture(cfg.emissiveMap, { srgb: true });
    m.emissive = new THREE.Color(0xffffff);
  }
  return m;
}
