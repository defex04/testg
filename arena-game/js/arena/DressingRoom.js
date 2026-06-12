/**
 * Примерочная («гардероб»): отдельный 3D-вьюпорт с персонажем, стоящим
 * лицом к камере. Здесь предметы надеваются/снимаются на тот же класс
 * Fighter, что дерётся на арене, — посадка вещей в бою совпадает 1-в-1.
 *
 * Модель можно вращать мышью/пальцем. При надевании вещи персонаж
 * проигрывает анимацию «taunt» (боевой клич), если она есть в конфиге.
 */
import * as THREE from 'three';
import { Fighter } from './Fighter.js';
import { applyEnvironment } from './Arena.js';

export class DressingRoom {
  constructor(viewport) {
    this.viewport = viewport;
    this.fighter = null;
    this.renderer = null;     // создаётся лениво при первом open
    this._running = false;
    this._zoom = 1;           // 1 = персонаж целиком; больше — крупнее
  }

  /** Приблизить/отдалить камеру (кнопки «лупа» в кукле). */
  zoom(factor) {
    this._zoom = THREE.MathUtils.clamp(this._zoom * factor, 0.7, 2.4);
    if (this.renderer) this._resize();
  }

  _ensureScene() {
    if (this.renderer) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'dressing-canvas';
    this.viewport.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    applyEnvironment(renderer, this.scene);

    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x44392c, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1.5, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -1.5;
    key.shadow.camera.right = 1.5;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -0.5;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb7ff, 0.9);
    rim.position.set(-2, 2.5, -3);
    this.scene.add(rim);

    // пятачок под ногами
    const catcher = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 40),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    catcher.rotation.x = -Math.PI / 2;
    catcher.receiveShadow = true;
    this.scene.add(catcher);

    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, 'rgba(20,14,8,0.45)');
    g.addColorStop(1, 'rgba(20,14,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const disc = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    this.scene.add(disc);

    this.clock = new THREE.Clock();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.viewport);
    this._resize();

    // вращение модели перетаскиванием
    let dragging = false;
    let lastX = 0;
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || !this.fighter) return;
      this.fighter.root.rotation.y += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
    });
    const stop = (e) => { dragging = false; };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  /** Показать персонажа по конфигу бойца (лицом к камере). Если этот боец
   *  уже стоит в примерочной (в т.ч. после фонового прогрева) — переиспользуем
   *  его: клонирование модели и привязка вещей не повторяются. */
  async show(def) {
    this._ensureScene();
    if (this.fighter && this._def === def) {
      this.fighter.play('idle', { fade: 0, randomStart: true });
      return this.fighter;
    }
    if (this.fighter) {
      this.scene.remove(this.fighter.root);
      this.fighter.dispose();
      this.fighter = null;
    }
    const fighter = await Fighter.create(def);
    fighter.root.rotation.y = 0; // модели Mixamo смотрят в +Z — прямо в камеру
    this.scene.add(fighter.root);
    this.fighter = fighter;
    this._def = def;
    fighter.play('idle', { fade: 0, randomStart: true });
    // прогреваем taunt в фоне, чтобы первый клик не ждал загрузку
    fighter._ensureAction('taunt');
    return fighter;
  }

  /** Отрисовать один кадр без запуска цикла: при фоновом прогреве геометрия
   *  и текстуры уезжают в GPU заранее, и первое открытие не дёргается. */
  renderFrame() {
    if (!this.renderer || this._running) return;
    if (this.fighter) this.fighter.update(0);
    this.renderer.render(this.scene, this.camera);
  }

  /** Надеть с показом «боевого клича». */
  async equip(itemDef) {
    if (!this.fighter) return;
    await this.fighter.equip(itemDef);
    const f = this.fighter;
    f.play('taunt', { once: true, fade: 0.25 }).then(() => {
      if (this.fighter === f) f.play('idle', { fade: 0.3 });
    });
  }

  unequip(slot) {
    this.fighter && this.fighter.unequip(slot);
  }

  start() {
    this._ensureScene(); // первый вызов может прийти раньше show()
    if (this._running) return;
    this._running = true;
    this.clock.getDelta();
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.05);
      if (this.fighter) this.fighter.update(dt);
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop() {
    if (!this.renderer) return;
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  _resize() {
    const w = this.viewport.clientWidth;
    const h = this.viewport.clientHeight;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // вписываем рост ~2.1 м и по высоте, и по ширине кадра
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfH = 1.12;
    const dH = halfH / Math.tan(halfFov);
    const dW = 0.85 / (Math.tan(halfFov) * this.camera.aspect);
    // зум: камера подъезжает и смотрит чуть выше — крупный план груди/головы
    const d = Math.max(dH, dW) / this._zoom;
    const focusY = 0.98 + (this._zoom - 1) * 0.22;
    this.camera.position.set(0, focusY + 0.14, d + 0.25);
    this.camera.lookAt(0, focusY, 0);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.stop();
    this._resizeObserver && this._resizeObserver.disconnect();
    if (this.fighter) {
      this.scene.remove(this.fighter.root);
      this.fighter.dispose();
      this.fighter = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }
}
