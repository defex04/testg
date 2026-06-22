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
    // КАДР боя (подгоняется под фон-картинку: бойцы должны стоять на круге).
    // frameMargin — запас по бокам сверх полу-дистанции (меньше → бойцы крупнее);
    // lookAtY/camHeight — выше точка взгляда → ноги ниже в кадре (садятся на круг).
    this.frameMargin = opts.frameMargin ?? 0.9;   // было 1.05 — бойцы чуть крупнее
    this.frameHalfH = opts.frameHalfH ?? 1.28;
    this.lookAtY = opts.lookAtY ?? 1.05;           // было 0.74 — ноги ниже в кадре
    this.camHeight = opts.camHeight ?? 1.6;        // было 1.42
    this.fighters = { left: null, right: null };

    // --- режим оптимизации (меньше нагрев телефона) и счётчики нагрузки ----------
    // dprCap — потолок плотности пикселей (в оптимизации режем до 1×: на телефоне
    // dpr 2.5–3 заставляет рисовать в разы больше точек). _minFrameMs — ограничение
    // кадров (в оптимизации ~30 к/с). _fps/_cpuMs/_gpuMs — сглаженные метрики для
    // индикатора нагрузки под пингом (см. getPerf / main.js).
    this._perfMode = false;
    this._dprCap = 2;
    this._minFrameMs = 0;
    this._lastTick = null;
    this._fps = 0;
    this._cpuMs = 0;
    this._gpuMs = null;
    this._gpuQuery = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._dprCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = 'arena-canvas';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // замер времени GPU на кадр — расширение WebGL2 (на части мобильных браузеров
    // отключено из соображений приватности; тогда метрика ГП будет недоступна)
    try {
      const gl = renderer.getContext();
      this._gl = gl;
      this._timerExt = (typeof WebGL2RenderingContext !== 'undefined'
        && gl instanceof WebGL2RenderingContext)
        ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
        : null;
    } catch { this._gl = null; this._timerExt = null; }

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
    this._key = key;   // ключевой свет с тенями — гасим в режиме оптимизации
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

    // autostart: false — рендер-цикл запускается вручную (start/stop),
    // чтобы скрытая арена не жгла GPU, пока игрок ходит по локациям
    this._running = false;
    if (opts.autostart ?? true) this.start();
  }

  /** Запустить рендер-цикл (повторный вызов безопасен). */
  start() {
    if (this._running) return;
    this._running = true;
    this.clock.getDelta();   // сбросить накопленное за паузу время
    this.renderer.setAnimationLoop(() => this._tick());
  }

  /** Остановить рендер-цикл; сцена и бойцы остаются загруженными. */
  stop() {
    if (!this._running) return;
    this._running = false;
    this.renderer.setAnimationLoop(null);
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
    // обновляем при каждом ресайзе, иначе картинка мылится. В режиме оптимизации
    // потолок dpr ниже (this._dprCap), чтобы рисовать меньше пикселей.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._dprCap));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // камера отъезжает ровно настолько, чтобы оба бойца попали в кадр
    // и по ширине, и по высоте — на любом экране
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfWidth = this.spacing / 2 + this.frameMargin;
    const halfHeight = this.frameHalfH;
    const distW = halfWidth / (Math.tan(halfFov) * this.camera.aspect);
    const distH = halfHeight / Math.tan(halfFov);
    const dist = Math.max(distW, distH, 3);
    // смотрим выше — ноги опускаются ближе к нижней кромке сцены, которая на
    // фоне совпадает с кругом арены (бойцы «стоят» на круге)
    this.camera.position.set(0, this.camHeight, dist + 0.5);
    this.camera.lookAt(0, this.lookAtY, 0);
    this.camera.updateProjectionMatrix();

    if (this.onResize) this.onResize();
  }

  resize() {
    this._resize();
  }

  /**
   * Экранная раскладка боевого колеса: центр — ровно между бойцами (на высоте
   * груди), диаметр — доля проекции дистанции между ними, чтобы колесо влезало
   * в зазор и не перекрывало модели. Возвращает null, пока сцена без размера.
   */
  wheelLayout(scale = 0.72) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return null;
    const yc = 1.06;                       // высота груди бойца, м
    const half = this.spacing / 2;
    const a = this.worldToScreen(new THREE.Vector3(-half, yc, 0));
    const b = this.worldToScreen(new THREE.Vector3(half, yc, 0));
    const gap = Math.abs(b.x - a.x);
    const cx = (a.x + b.x) / 2;
    // крупное колесо, но с тремя ограничителями, чтобы не лезть на другой UI:
    //  - зазор между бойцами (не накрывает модели),
    //  - высота сцены (не упирается в шапку/слоты),
    //  - ширина сцены (на узких экранах).
    let d = Math.min(gap * scale, h * 0.6, w * 0.72);
    d = Math.max(150, d);
    // держим круг в сцене: сверху запас под «Пропустить ход», снизу — под ряд
    // слотов заклинаний (.combat-bar у низа сцены), чтобы колесо их не накрывало.
    let cy = (a.y + b.y) / 2;
    cy = Math.min(Math.max(cy, d / 2 + 40), h - (d / 2 + 72));
    return { x: cx, y: cy, diameter: d };
  }

  /**
   * Режим оптимизации: меньше нагрев телефона и расход батареи.
   *  - тени выключаются (самый дорогой проход на кадр);
   *  - плотность пикселей режется до 1× (на телефоне dpr 2.5–3 → в разы меньше точек);
   *  - кадры ограничиваются ~30 к/с (примерно вдвое меньше работы CPU/GPU).
   */
  setPerfMode(on) {
    on = !!on;
    this._perfMode = on;
    // 1) тени
    this.renderer.shadowMap.enabled = !on;
    if (this._key) this._key.castShadow = !on;
    // материалы пересобрать, чтобы шейдеры перестали/снова стали учитывать тень
    this.scene.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    this.renderer.shadowMap.needsUpdate = true;
    // 2) плотность пикселей и 3) частота кадров
    this._dprCap = on ? 1 : 2;
    this._minFrameMs = on ? 30 : 0;   // 30мс ≈ 30 к/с при экране 60/120 Гц
    this._resize();                   // применить новый потолок dpr
  }

  /** Снимок нагрузки для индикатора под пингом (см. main.js). */
  getPerf() {
    return {
      running: this._running,
      perfMode: this._perfMode,
      fps: this._fps || 0,
      cpuMs: this._cpuMs || 0,
      gpuMs: this._timerExt ? this._gpuMs : null,
      gpuSupported: !!this._timerExt,
    };
  }

  /** Рендер с замером времени GPU (если доступно расширение таймера). */
  _render() {
    const gl = this._gl, ext = this._timerExt;
    if (!gl || !ext) { this.renderer.render(this.scene, this.camera); return; }
    try {
      // забрать результат прошлого запроса, когда он готов
      if (this._gpuQuery) {
        const avail = gl.getQueryParameter(this._gpuQuery, gl.QUERY_RESULT_AVAILABLE);
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (avail || disjoint) {
          if (avail && !disjoint) {
            this._gpuMs = gl.getQueryParameter(this._gpuQuery, gl.QUERY_RESULT) / 1e6;
          }
          gl.deleteQuery(this._gpuQuery);
          this._gpuQuery = null;
        }
      }
      // одновременно держим только один запрос; иначе просто рисуем
      if (!this._gpuQuery) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        this.renderer.render(this.scene, this.camera);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        this._gpuQuery = q;
      } else {
        this.renderer.render(this.scene, this.camera);
      }
    } catch {
      // таймер дал сбой — дальше рисуем без него, метрику ГП отключаем
      if (this._gpuQuery) { try { gl.deleteQuery(this._gpuQuery); } catch {} this._gpuQuery = null; }
      this._timerExt = null;
      this.renderer.render(this.scene, this.camera);
    }
  }

  _tick() {
    const now = performance.now();
    // ограничение кадров (режим оптимизации): рано — пропускаем кадр целиком.
    // _lastTick хранит время последнего НАРИСОВАННОГО кадра, накопленное в Clock
    // время отдадим следующему кадру (анимация не «дёргается»).
    if (this._minFrameMs && this._lastTick != null && (now - this._lastTick) < this._minFrameMs) {
      return;
    }
    // FPS — по интервалу между фактическими кадрами (сглаживаем)
    if (this._lastTick != null) {
      const frameMs = now - this._lastTick;
      if (frameMs > 0) {
        const fps = 1000 / frameMs;
        this._fps = this._fps ? this._fps * 0.9 + fps * 0.1 : fps;
      }
    }
    this._lastTick = now;

    // ЦП — время работы JS на кадр (обновление + выдача команд рендера)
    const c0 = performance.now();
    // ограничиваем dt, чтобы возврат на вкладку не "перематывал" анимацию
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.fighters.left) this.fighters.left.update(dt);
    if (this.fighters.right) this.fighters.right.update(dt);
    if (this.onTick) this.onTick(dt);
    this._render();
    const cpuMs = performance.now() - c0;
    this._cpuMs = this._cpuMs ? this._cpuMs * 0.9 + cpuMs * 0.1 : cpuMs;
  }

  dispose() {
    this.stop();
    this._resizeObserver.disconnect();
    window.removeEventListener('resize', this._onWinResize);
    this.removeFighter('left');
    this.removeFighter('right');
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
