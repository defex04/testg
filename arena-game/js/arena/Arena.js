/**
 * Арена — самодостаточный 3D-модуль.
 *
 * Встраивается в любой DOM-контейнер: new Arena(container).
 * Сам следит за размером контейнера (ResizeObserver), держит камеру так,
 * чтобы оба бойца всегда были в кадре на любом соотношении сторон
 * (телефон/десктоп), и рисует поверх сменяемого 2D-фона.
 */
import * as THREE from 'three';
import { RoomEnvironment } from '../../vendor/three/examples/jsm/environments/RoomEnvironment.js';
import { Fighter } from './Fighter.js';

/** Окружение для PBR-материалов: без него metalness=1 выглядит чёрным. */
export function applyEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
}

export class Arena {
  constructor(container, opts = {}) {
    this.container = container;
    this.spacing = opts.spacing ?? 2.7;       // дистанция между бойцами, м
    this.fighters = { left: null, right: null };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'arena-canvas';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    applyEnvironment(renderer, this.scene);

    // свет: тёплый небесный + ключевой с тенями + холодная подсветка сзади
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x44392c, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -2;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb7ff, 0.8);
    rim.position.set(-3, 3, -4);
    this.scene.add(rim);

    this._buildGround();

    this.clock = new THREE.Clock();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    // зум браузера меняет dpr без изменения размеров контейнера
    this._onWinResize = () => this._resize();
    window.addEventListener('resize', this._onWinResize);
    this._resize();

    renderer.setAnimationLoop(() => this._tick());
  }

  _buildGround() {
    // ловец теней
    const shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(4, 48),
      new THREE.ShadowMaterial({ opacity: 0.38 })
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.receiveShadow = true;
    this.scene.add(shadowCatcher);

    // полупрозрачный диск, "заземляющий" бойцов на фоне-картинке
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(20,14,8,0.42)');
    g.addColorStop(0.65, 'rgba(20,14,8,0.18)');
    g.addColorStop(1, 'rgba(20,14,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    const disc = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 4.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    this.scene.add(disc);
  }

  /** Сменить фон арены: { image: 'url.jpg' } или { css: 'linear-gradient(...)' }. */
  setBackground(bg) {
    const s = this.container.style;
    if (bg.image) {
      s.background = `url("${bg.image}") center bottom / cover no-repeat`;
    } else if (bg.css) {
      s.background = bg.css;
    }
  }

  /** Добавить бойца из конфига. side: 'left' | 'right'. */
  async addFighter(side, def) {
    this.removeFighter(side);
    const fighter = await Fighter.create(def);
    const x = (side === 'left' ? -1 : 1) * this.spacing / 2;
    fighter.placeAt(x, side);
    this.scene.add(fighter.root);
    this.fighters[side] = fighter;
    fighter.play('idle', { fade: 0, randomStart: true });
    return fighter;
  }

  removeFighter(side) {
    const f = this.fighters[side];
    if (!f) return;
    this.scene.remove(f.root);
    f.dispose();
    this.fighters[side] = null;
  }

  /** Перевод мировой точки в пиксели контейнера (для цифр урона). */
  worldToScreen(v3, target = { x: 0, y: 0 }) {
    const v = v3.clone().project(this.camera);
    target.x = (v.x * 0.5 + 0.5) * this.container.clientWidth;
    target.y = (-v.y * 0.5 + 0.5) * this.container.clientHeight;
    return target;
  }

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    // dpr может меняться (другой монитор, зум браузера, телефон) —
    // обновляем при каждом ресайзе, иначе картинка мылится
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // камера отъезжает ровно настолько, чтобы оба бойца попали в кадр
    // и по ширине, и по высоте — на любом экране
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfWidth = this.spacing / 2 + 1.05;
    const halfHeight = 1.3;
    const distW = halfWidth / (Math.tan(halfFov) * this.camera.aspect);
    const distH = halfHeight / Math.tan(halfFov);
    const dist = Math.max(distW, distH, 3);
    this.camera.position.set(0, 1.5, dist + 0.5);
    this.camera.lookAt(0, 0.92, 0);
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    // ограничиваем dt, чтобы возврат на вкладку не "перематывал" анимацию
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.fighters.left) this.fighters.left.update(dt);
    if (this.fighters.right) this.fighters.right.update(dt);
    if (this.onTick) this.onTick(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this._resizeObserver.disconnect();
    window.removeEventListener('resize', this._onWinResize);
    this.removeFighter('left');
    this.removeFighter('right');
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
