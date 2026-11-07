// УПРАВЛЕНИЕ ЧЕРЕЗ ВЕБКАМЕРУ
//
// Как это устроено:
// 1. getUserMedia включает камеру, картинка идёт в элемент <video>.
// 2. MediaPipe Hand Landmarker (нейросеть от Google) на каждом кадре находит 21 точку руки:
//    0 — запястье, 1–4 — большой палец, 5–8 — указательный, 9–12 — средний,
//    13–16 — безымянный, 17–20 — мизинец (от основания пальца к кончику).
// 3. Переводим точки в «координаты ладони» (так они не зависят от того, как повёрнута рука)
//    и сглаживаем, чтобы модель не дрожала.
// 4. По ним retarget.js считает углы суставов модели, а поворот ладони поворачивает всю модель.
// Всё считается прямо в браузере, видео никуда не отправляется.

import * as THREE from 'three';

// Библиотеку и нейросеть загружаем только когда включают камеру (это ≈ 17 МБ)
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Какие точки соединять линиями на превью
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

let landmarkerPromise = null;

// Загружаем MediaPipe один раз. Сначала пробуем видеокарту (быстрее), если не вышло — процессор.
export function loadLandmarker(runningMode = 'VIDEO') {
  if (runningMode === 'VIDEO' && landmarkerPromise) return landmarkerPromise;
  const promise = (async () => {
    const { FilesetResolver, HandLandmarker } = await import(`${VISION_URL}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    const create = (delegate) =>
      HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode,
        numHands: 1,
      });
    try {
      return await create('GPU');
    } catch (err) {
      console.warn('Распознавание на видеокарте не запустилось, пробую на процессоре', err);
      return create('CPU');
    }
  })();
  if (runningMode === 'VIDEO') {
    landmarkerPromise = promise;
    promise.catch(() => { landmarkerPromise = null; }); // при ошибке можно попробовать ещё раз
  }
  return promise;
}

// ---------- геометрия ----------

// «Система координат ладони»: side — к большому пальцу, up — к пальцам, normal — из ладони.
// Её же считаем и для нашей 3D-модели, а потом поворачиваем модель так, чтобы они совпали.
export function palmFrame(wrist, indexBase, middleBase, littleBase) {
  const up = new THREE.Vector3().subVectors(middleBase, wrist).normalize();
  const side = new THREE.Vector3().subVectors(indexBase, littleBase);
  const normal = new THREE.Vector3().crossVectors(side, up).normalize();
  side.crossVectors(up, normal); // делаем все три оси точно перпендикулярными
  return new THREE.Matrix4().makeBasis(side, up, normal);
}

// Точки MediaPipe на картинке: x вправо и y вниз (доли ширины и высоты кадра),
// z — глубина относительно запястья (меньше — ближе к камере, в тех же единицах, что x).
// Переводим в пиксели и в оси Three.js (y вверх, z к зрителю) и разворачиваем так,
// как модель должна показывать руку:
//  'camera' — как видит камера (нужно только для проверки);
//  'self'   — правая рука: так, как ты сам видишь свою руку (поворот на 180° вокруг вертикали);
//  'mirror' — левая рука: как в зеркале (отражение слева направо превращает её в правую).
// Почему не «мировые» 3D-точки MediaPipe (worldLandmarks)? Проверка на нашей модели показала:
// у руки, повёрнутой боком, они ошибаются в повороте до 80°, а точки картинки — не больше 25°.
export function toPoints(landmarks, width, height, view) {
  const sx = view === 'camera' ? 1 : -1;
  const sz = view === 'self' ? 1 : -1;
  return landmarks.map((p) => new THREE.Vector3(sx * p.x * width, -p.y * height, sz * p.z * width));
}

// 21 точка в координатах ладони: начало — запястье, оси — как в palmFrame, длина ладони
// (от запястья до основания среднего пальца) = 1. Так поза пальцев не зависит от того,
// как рука повёрнута и далеко ли она от камеры.
export function palmPoints(P) {
  const frame = palmFrame(P[0], P[5], P[9], P[17]);
  const toPalm = frame.clone().transpose(); // обратный поворот
  const size = P[0].distanceTo(P[9]);
  const points = P.map((p) => p.clone().sub(P[0]).applyMatrix4(toPalm).divideScalar(size));
  return { frame, points };
}

// Какая это рука. Кадр с камеры мы не отзеркаливаем (отражаем только картинку превью),
// и для такого кадра MediaPipe называет руку правильно. Проверено на картинках нашей модели.
export function sideOf(result) {
  return result.handedness[0][0].categoryName === 'Right' ? 'right' : 'left';
}

// ---------- сглаживание ----------

// Фильтр One Euro: когда рука почти не двигается, сильно гасит дрожание;
// когда двигается быстро, сглаживает слабо, чтобы модель не отставала.
class OneEuro {
  constructor(minCutoff = 1.2, beta = 1.5, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    this.dx += smoothing(this.dCutoff, dt) * ((value - this.x) / dt - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothing(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

// Какую долю пути к новому значению проходить за шаг dt (cutoff — «частота среза» в герцах)
function smoothing(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

// ---------- сам трекер ----------

// modelFrame — как лежит ладонь в модели
export function createHandTracker({ video, overlay, modelFrame }) {
  const ctx = overlay.getContext('2d');
  const modelFrameInverse = modelFrame.clone().invert();
  // по фильтру на каждую координату каждой из 21 точки
  const filters = Array.from({ length: 21 * 3 }, () => new OneEuro());

  let landmarker = null;
  let stream = null;
  let lastVideoTime = -1;
  let lastSeen = 0;
  let side = null;            // 'right' или 'left'
  let otherSideFrames = 0;    // сколько кадров подряд нейросеть говорит «другая рука»
  const rotation = new THREE.Quaternion(); // сглаженный поворот ладони
  let rotationTime = null;                 // когда его обновляли (null — ещё ни разу)
  const target = new THREE.Quaternion();
  const m = new THREE.Matrix4();

  function resetSmoothing() {
    for (const f of filters) f.reset();
    rotationTime = null;
  }

  async function start(onStatus) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Камера работает только на https:// или localhost.');
    }
    onStatus('Жду разрешения на камеру…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    onStatus('Загружаю распознавание руки… (≈ 17 МБ, только в первый раз)');
    landmarker = await loadLandmarker('VIDEO');
    if (!stream) return; // камеру выключили, пока грузилось
    side = null;
    lastSeen = performance.now();
    resetSmoothing();
    onStatus('Покажи руку в камеру.');
  }

  function stop() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    video.srcObject = null;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // Вызывается каждый кадр анимации. Возвращает null, если нового кадра с камеры нет.
  function update(nowMs) {
    if (!landmarker || !stream || video.readyState < 2) return null;
    if (video.currentTime === lastVideoTime) return null;
    lastVideoTime = video.currentTime;

    const result = landmarker.detectForVideo(video, nowMs);
    drawOverlay(result.landmarks[0]);

    if (!result.landmarks.length) {
      if (nowMs - lastSeen > 1000) side = null; // рука ушла надолго: следующая может быть другой
      return { found: false };
    }
    lastSeen = nowMs;

    // Нейросеть иногда путает руки, особенно когда пальцы сжаты в кулак. Меняем руку,
    // только если нейросеть уверена в другой руке (больше 85%) примерно секунду подряд,
    // иначе модель резко переворачивалась бы.
    const guess = sideOf(result);
    const sure = result.handedness[0][0].score > 0.85;
    if (side === null) {
      side = guess;
      resetSmoothing();
    } else if (guess !== side && sure) {
      if (++otherSideFrames >= 25) {
        side = guess;
        otherSideFrames = 0;
        resetSmoothing();
      }
    } else {
      otherSideFrames = 0;
    }

    const view = side === 'right' ? 'self' : 'mirror';
    const P = toPoints(result.landmarks[0], video.videoWidth, video.videoHeight, view);
    const { frame, points } = palmPoints(P);
    const t = nowMs / 1000;
    points.forEach((p, i) => {
      p.set(
        filters[i * 3].filter(p.x, t),
        filters[i * 3 + 1].filter(p.y, t),
        filters[i * 3 + 2].filter(p.z, t),
      );
    });

    // Поворот модели = поворот ладони относительно того, как ладонь лежит в модели
    m.multiplyMatrices(frame, modelFrameInverse);
    target.setFromRotationMatrix(m);
    if (rotationTime === null) {
      rotation.copy(target);
    } else {
      // как One Euro, только для поворота: чем быстрее поворачивается рука, тем меньше сглаживание
      const dt = Math.max(t - rotationTime, 1e-3);
      const speed = rotation.angleTo(target) / dt; // радиан в секунду
      rotation.slerp(target, smoothing(1.2 + 0.8 * speed, dt));
    }
    rotationTime = t;

    return { found: true, side, points, rotation };
  }

  function drawOverlay(points) {
    const { width: w, height: h } = overlay;
    ctx.clearRect(0, 0, w, h);
    if (!points) return;
    const r = Math.max(3, w / 110); // превью маленькое, поэтому линии потолще
    ctx.lineWidth = r;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(points[a].x * w, points[a].y * h);
      ctx.lineTo(points[b].x * w, points[b].y * h);
    }
    ctx.stroke();
    ctx.fillStyle = '#ffa25c';
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, r * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { start, stop, update, isRunning: () => stream !== null };
}
