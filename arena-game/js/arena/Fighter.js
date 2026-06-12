/**
 * Боец на арене: модель + скелетные анимации + процедурные эффекты
 * (выпад к противнику, реакция на удар, смерть).
 *
 * Модель нормализуется автоматически: любой GLB масштабируется до заданного
 * роста и ставится ногами на землю, поэтому новые модели можно добавлять
 * без подгонки руками.
 */
import * as THREE from 'three';
import { clone as cloneSkeleton } from '../../vendor/three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF, loadClip } from './loaders.js';
import { equipItem } from './EquipEngine.js';

const FLASH_COLOR = new THREE.Color(0xff2211);

export class Fighter {
  constructor(def) {
    this.def = def;
    this.root = new THREE.Group();          // позиция/разворот на арене
    this.pivot = new THREE.Group();         // процедурные наклоны (смерть)
    this.root.add(this.pivot);
    this.model = null;
    this.mixer = null;
    this.actions = {};                      // name -> { action, spec }
    this.equipment = {};                    // slot -> { holder, itemDef }
    this.current = null;
    this.side = 'left';
    this.basePos = new THREE.Vector3();
    this.height = def.height || 1.8;
    this.alive = true;
    this._tweens = [];
    this._shake = 0;
    this._flashTimer = 0;
    this._flashMats = [];
  }

  static async create(def) {
    const f = new Fighter(def);
    await f._load();
    return f;
  }

  async _load() {
    const gltf = await loadGLTF(this.def.model);
    const model = cloneSkeleton(gltf.scene);

    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        // скелетные меши часто неверно отсекаются камерой
        o.frustumCulled = false;
        // материалы клонируем, чтобы эффекты (вспышка урона) не задевали соседа
        o.material = Array.isArray(o.material)
          ? o.material.map((m) => m.clone())
          : o.material.clone();
      }
    });

    this.model = model;
    this.pivot.add(model);
    this.mixer = new THREE.AnimationMixer(model);

    const anims = this.def.animations || {};
    for (const [name, spec] of Object.entries(anims)) {
      if (spec.lazy) continue; // загрузится при первом play()
      await this._ensureAction(name);
    }

    this._normalize();
  }

  /** Создаёт action по имени из конфига; lazy-анимации грузятся здесь. */
  async _ensureAction(name) {
    if (this.actions[name]) return this.actions[name];
    const spec = (this.def.animations || {})[name];
    if (!spec) return null;
    const clip = await loadClip(spec, this.def.model, name);
    // пока ждали загрузку, могли запросить ещё раз
    if (!this.actions[name]) {
      this.actions[name] = { action: this.mixer.clipAction(clip), spec };
    }
    return this.actions[name];
  }

  /**
   * Нормализация размера: рост -> def.height, ноги -> y=0, центр -> x/z=0.
   * Меряем по костям скелета в позе первого кадра idle — bind-pose меша у
   * конвертированных ригов (Assimp/Mixamo) часто имеет неверный масштаб.
   */
  _normalize() {
    const model = this.model;
    const first = this.actions.idle || Object.values(this.actions)[0];
    if (first) {
      first.action.play();
      this.mixer.update(0);
    }
    model.updateMatrixWorld(true);

    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    let hasBones = false;
    model.traverse((o) => {
      if (o.isBone) {
        hasBones = true;
        box.expandByPoint(o.getWorldPosition(v));
      }
    });
    if (!hasBones) box.setFromObject(model);

    const size = box.getSize(new THREE.Vector3());
    if (size.y <= 0) return;
    // кости не учитывают макушку и ступни — скелет чуть ниже реального роста
    const scale = this.height / (size.y * 1.08);
    model.scale.setScalar(scale);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

    if (first) first.action.stop();
  }

  placeAt(x, side) {
    this.side = side;
    this.root.position.set(x, 0, 0);
    // модели Mixamo смотрят вдоль +Z; разворачиваем бойцов лицом друг к другу
    this.root.rotation.y = side === 'left' ? Math.PI / 2 : -Math.PI / 2;
    this.basePos.copy(this.root.position);
  }

  /** Точка над головой — для всплывающих цифр урона. */
  headPoint(target = new THREE.Vector3()) {
    return target.copy(this.root.position).add(new THREE.Vector3(0, this.height + 0.25, 0));
  }

  async play(name, opts = {}) {
    if (!this.alive && !opts.force) return;
    const entry = this.actions[name] || await this._ensureAction(name);
    if (!entry) return;
    const { action, spec } = entry;
    const fade = opts.fade ?? 0.25;
    const prev = this.current;

    action.reset();
    action.enabled = true;
    action.timeScale = opts.timeScale ?? spec.timeScale ?? 1;
    if (opts.once) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
      if (opts.randomStart) action.time = Math.random() * action.getClip().duration;
    }

    if (prev && prev !== action) prev.fadeOut(fade);
    action.fadeIn(fade).play();
    this.current = action;

    if (!opts.once) return Promise.resolve();
    return new Promise((resolve) => {
      const onFinished = (e) => {
        if (e.action !== action) return;
        this.mixer.removeEventListener('finished', onFinished);
        resolve();
      };
      this.mixer.addEventListener('finished', onFinished);
    });
  }

  /**
   * Полный цикл удара: анимация атаки стартует сразу, выпад к противнику
   * идёт параллельно с замахом (без "скольжения" перед ударом), в момент
   * попадания вызывается onHit, затем возврат на место и idle.
   */
  async strike(targetFighter, onHit, animName = 'attack') {
    const entry = this.actions[animName];
    if (!entry) { onHit && onHit(); return; }

    const reach = entry.spec.reach ?? 1.2;
    const dir = Math.sign(targetFighter.basePos.x - this.basePos.x) || 1;
    const lungeX = targetFighter.basePos.x - dir * reach;

    const clip = entry.action.getClip();
    const timeScale = entry.spec.timeScale ?? 1;
    const hitDelay = ((entry.spec.hitTime ?? 0.5) * clip.duration) / timeScale * 1000;
    const hitTimer = setTimeout(() => onHit && onHit(), hitDelay);

    const animDone = this.play(animName, { once: true, fade: 0.18 });
    // выпад укладывается в замах — к моменту попадания боец уже у цели
    await this._tweenPos(this.root.position.x, lungeX,
      Math.min(0.3, (hitDelay / 1000) * 0.8));
    await animDone;
    clearTimeout(hitTimer);

    this.play('idle', { fade: 0.25 });
    await this._tweenPos(this.root.position.x, this.basePos.x, 0.3);
  }

  /** Поиск кости по имени или регулярному выражению. */
  findBone(matcher) {
    let bone = null;
    this.model.traverse((o) => {
      if (bone || !o.isBone) return;
      if (matcher instanceof RegExp ? matcher.test(o.name) : o.name === matcher) bone = o;
    });
    return bone;
  }

  /**
   * Надеть предмет (см. EquipEngine.js). Способ посадки выбирается сам:
   * отскиненный на совместимый скелет предмет перепривязывается к скелету
   * персонажа, статичная броня/одежда автоскинится (переносом весов с тела)
   * и деформируется в анимациях, оружие/шлемы жёстко крепятся к кости.
   *
   * itemDef.attach переопределяет посадку слота: { mode, bone, at, ref,
   * cover, axis, align, scale, offset, rotation, knn, smooth } —
   * подробности в EquipEngine.js.
   */
  async equip(itemDef) {
    const slot = itemDef.slot || 'misc';
    this.unequip(slot);
    this.equipment[slot] = await equipItem(this, itemDef);
    return this;
  }

  /** Снять предмет из слота. */
  unequip(slot) {
    const eq = this.equipment[slot];
    if (!eq) return false;
    eq.dispose();
    delete this.equipment[slot];
    return true;
  }

  hasEquipped(slot) {
    return !!this.equipment[slot];
  }

  /** Реакция на полученный удар: отдача назад + красная вспышка. */
  hitReact() {
    if (!this.alive) return;
    this._shake = 0.4;
    this._flashTimer = 0.18;
    this._flashMats = [];
    this.model.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) {
        this._flashMats.push({ mat: o.material, color: o.material.emissive.clone() });
        o.material.emissive.copy(FLASH_COLOR);
      }
    });
  }

  /** Смерть: падение навзничь (процедурно, без отдельной анимации). */
  async die() {
    this.alive = false;
    if (this.current) this.current.fadeOut(0.4);
    this.current = null;
    await this._tween(0.9, (t) => {
      const e = t * t * (3 - 2 * t); // smoothstep
      this.pivot.rotation.x = -Math.PI / 2 * 0.96 * e;
      this.pivot.position.y = 0.06 * Math.sin(e * Math.PI);
    });
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);

    for (let i = this._tweens.length - 1; i >= 0; i--) {
      const tw = this._tweens[i];
      tw.t += dt / tw.dur;
      if (tw.t >= 1) {
        tw.fn(1);
        this._tweens.splice(i, 1);
        tw.resolve();
      } else {
        tw.fn(tw.t);
      }
    }

    if (this._shake > 0) {
      this._shake = Math.max(0, this._shake - dt);
      const dir = this.side === 'left' ? -1 : 1;
      const k = this._shake / 0.4;
      this.root.position.x = this.basePos.x +
        dir * 0.14 * k * Math.abs(Math.sin(this._shake * 28));
      if (this._shake === 0) this.root.position.x = this.basePos.x;
    }

    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
      if (this._flashTimer <= 0) {
        for (const { mat, color } of this._flashMats) mat.emissive.copy(color);
        this._flashMats = [];
      }
    }
  }

  _tween(dur, fn) {
    return new Promise((resolve) => this._tweens.push({ t: 0, dur, fn, resolve }));
  }

  _tweenPos(fromX, toX, dur) {
    return this._tween(dur, (t) => {
      const e = t * t * (3 - 2 * t);
      this.root.position.x = fromX + (toX - fromX) * e;
    });
  }

  dispose() {
    this.mixer && this.mixer.stopAllAction();
    // геометрии общие (кэш загрузчика) — удаляем только клоны материалов
    this.model && this.model.traverse((o) => {
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
}
