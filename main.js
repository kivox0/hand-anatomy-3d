// 1. Подключаем Three.js, управление мышкой и загрузчик моделей
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Наш справочник названий и описаний (файл parts.js)
import { getPartInfo, LAYER_LABELS } from './parts.js';
// Движение: суставы, позы, «работающие» мышцы (файл motion.js)
import { createMotion, muscleActivation, PRESETS, neutralPose } from './motion.js';
// Управление через вебкамеру (файл tracking.js)
import { createHandTracker, palmFrame } from './tracking.js';
// Перенос позы с камеры на суставы модели (файл retarget.js)
import { createRetargeter } from './retarget.js';

// 2. СЦЕНА
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1f24);

// 3. КАМЕРА (модель в метрах: кисть с запястьем ≈ 0.23 м)
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 10);
camera.position.set(0, 0, 0.4);
scene.add(camera);

// 4. РЕНДЕРЕР
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// 5. СВЕТ: «небо/земля» + «фонарик на камере»
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a2a35, 1.2));
const headLight = new THREE.DirectionalLight(0xffffff, 1.8);
headLight.position.set(0.3, 0.5, 1);
camera.add(headLight);

// 6. УПРАВЛЕНИЕ МЫШКОЙ
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.08;
controls.maxDistance = 1.5;

// 7. СЛОИ
// key — имя группы внутри модели (так их назвал скрипт сборки tools/build_hand.py)
// order — порядок отрисовки: чем больше, тем позже рисуется (кожа последней, она снаружи)
const LAYERS = [
  { key: 'skin',      label: 'Кожа',   color: 0xf2c6a8, opacity: 0.35, order: 4 },
  { key: 'muscles',   label: 'Мышцы',  color: 0xb8433a, opacity: 1,    order: 3 },
  { key: 'ligaments', label: 'Связки', color: 0xa9d3e6, opacity: 1,    order: 2 },
  { key: 'bones',     label: 'Кости',  color: 0xe9dfc8, opacity: 1,    order: 1 },
];

// Для каждого слоя запомним его группу и все его материалы
const layerState = {};

function setLayerOpacity(key, value) {
  layerState[key].opacity = value; // запоминаем: пригодится, чтобы «кликать сквозь» прозрачные слои
  for (const mat of layerState[key].materials) {
    mat.opacity = value;
    mat.transparent = value < 1;  // полупрозрачность включаем, только когда нужна
    mat.depthWrite = value >= 1;  // прозрачный слой не «закрывает» то, что под ним
    mat.needsUpdate = true;
  }
}

function setLayerVisible(key, visible) {
  layerState[key].group.visible = visible;
}

// 8. ЗАГРУЗКА МОДЕЛИ
// Пока модель грузится (≈ 3 МБ), виден экран загрузки с полоской прогресса
const info = document.getElementById('info');
const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const loaderText = document.getElementById('loader-text');

function hideLoader() {
  loader.classList.add('done'); // плавно исчезает (см. style.css)
  setTimeout(() => loader.remove(), 600);
}

new GLTFLoader().load(
  'models/hand.glb',

  (gltf) => {
    const hand = gltf.scene;

    for (const layer of LAYERS) {
      const group = hand.getObjectByName(layer.key);
      const materials = [];

      group.traverse((obj) => {
        if (!obj.isMesh) return;
        // Каждой мышце даём чуть-чуть свой оттенок, чтобы они не сливались в одно пятно
        const color = new THREE.Color(layer.color);
        if (layer.key === 'muscles') color.offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);

        const mat = new THREE.MeshStandardMaterial({
          color,
          roughness: layer.key === 'bones' ? 0.6 : 0.5,
          // кожу рисуем только снаружи, остальные слои с обеих сторон
          // (они обрезаны на запястье, и иначе в срезе была бы «дыра»)
          side: layer.key === 'skin' ? THREE.FrontSide : THREE.DoubleSide,
        });
        obj.material = mat;
        obj.renderOrder = layer.order;
        // Части «приклеены» к суставам и двигаются. Отключаем проверку «видна ли часть камере»:
        // она считается по позе в покое и иначе могла бы спрятать согнутый палец.
        obj.frustumCulled = false;
        materials.push(mat);

        // Достаём из справочника русское и латинское название.
        // При загрузке пробелы в именах стали «_», возвращаем пробелы.
        const englishName = obj.name.replace(/_\d+$/, '').replace(/_/g, ' ');
        obj.userData.layer = layer.key;
        obj.userData.englishName = englishName;
        obj.userData.activation = 0; // насколько «работает» мышца (0..1), см. motion.js
        obj.userData.info = getPartInfo(englishName);
        if (obj.userData.info.la === '') console.warn('Нет в справочнике:', englishName);
        pickable.push(obj);
      });

      layerState[layer.key] = { group, materials };
      setLayerOpacity(layer.key, layer.opacity);
    }

    scene.add(hand);
    motion = createMotion(hand);
    handRoot = hand;
    restPalmFrame = modelPalmFrame(); // запоминаем, пока модель в исходной позе
    palmToModel.setFromRotationMatrix(restPalmFrame);
    retargeter = createRetargeter(hand);
    buildPanel();
    buildMotionPanel();
    buildCameraPanel();
    buildHelp();
    info.textContent = isNarrow
      ? 'Коснись части, чтобы узнать название. Один палец: вращать. Два: приблизить. ? — справка.'
      : 'Наведи на часть: название. Клик: описание. Мышь: вращать, колёсико: приблизить, правая кнопка: сдвинуть.';
    info.hidden = false;
    hideLoader();
    showHelpOnFirstVisit();
  },

  (event) => {
    if (!event.total) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    loaderBar.style.width = `${percent}%`;
    loaderText.textContent = `Загружаю 3D-модель… ${percent}%`;
  },

  (error) => {
    console.error(error);
    loader.classList.add('failed');
    loaderText.textContent = 'Не удалось загрузить модель. Проверь интернет и обнови страницу (F5). '
      + 'Если открываешь файл двойным щелчком, запусти сайт через Live Server.';
  }
);

// 8б. СПРАВКА «КАК ПОЛЬЗОВАТЬСЯ»: кнопка «?» в панели; при первом визите открывается сама
const help = document.getElementById('help');

function buildHelp() {
  document.getElementById('help-open').addEventListener('click', () => help.showModal());
  for (const id of ['help-close', 'help-ok']) {
    document.getElementById(id).addEventListener('click', () => help.close());
  }
  // клик по затемнённому фону вокруг окна тоже закрывает его
  help.addEventListener('click', (event) => {
    if (event.target === help) help.close();
  });
}

// Браузер запоминает, что справку уже показывали (localStorage). В режиме инкогнито
// это хранилище может быть недоступно — тогда просто покажем справку ещё раз.
function showHelpOnFirstVisit() {
  let seen = false;
  try {
    seen = localStorage.getItem('helpSeen') === '1';
    localStorage.setItem('helpSeen', '1');
  } catch {
    // ничего страшного
  }
  if (!seen) help.showModal();
}

// 9. ПАНЕЛЬ СЛОЁВ: для каждого слоя галочка «показать» и ползунок прозрачности
function buildPanel() {
  const list = document.getElementById('layers');

  for (const layer of LAYERS) {
    const row = document.createElement('div');
    row.className = 'layer';
    row.innerHTML = `
      <label class="layer-name">
        <input type="checkbox" checked>
        <span class="swatch" style="background:#${layer.color.toString(16).padStart(6, '0')}"></span>
        ${layer.label}
      </label>
      <input type="range" min="0" max="100" value="${layer.opacity * 100}" aria-label="Прозрачность: ${layer.label}">
      <span class="value">${Math.round(layer.opacity * 100)}%</span>
    `;

    const checkbox = row.querySelector('input[type=checkbox]');
    const slider = row.querySelector('input[type=range]');
    const value = row.querySelector('.value');

    checkbox.addEventListener('change', () => setLayerVisible(layer.key, checkbox.checked));
    slider.addEventListener('input', () => {
      const v = slider.value / 100;
      value.textContent = `${slider.value}%`;
      setLayerOpacity(layer.key, v);
    });

    // сохраняем ссылки, чтобы кнопки быстрого выбора могли менять галочки
    layer.checkbox = checkbox;
    list.appendChild(row);
  }

  // Кнопки быстрого выбора
  const presets = {
    all: ['skin', 'muscles', 'ligaments', 'bones'],
    bones: ['bones'],
    deep: ['ligaments', 'bones'],
  };
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const show = presets[btn.dataset.preset];
      for (const layer of LAYERS) {
        const on = show.includes(layer.key);
        layer.checkbox.checked = on;
        setLayerVisible(layer.key, on);
      }
    });
  });

  // На телефоне панель можно свернуть
  const panel = document.getElementById('panel');
  document.getElementById('panel-toggle').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
  });

  // Вкладки «Слои» / «Движение»
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-page').forEach((page) => {
        page.hidden = page.id !== `tab-${tab.dataset.tab}`;
      });
      panel.classList.remove('collapsed');
    });
  });
}

// 9б. ПАНЕЛЬ ДВИЖЕНИЯ: ползунки сгибания пальцев и запястья, готовые позы
let motion = null;

const MOTION_SLIDERS = [
  { key: 'thumb',     label: 'Большой',      min: -20, max: 100, unit: '%' },
  { key: 'thumbAbd',  label: 'Отвести большой', min: -20, max: 100, unit: '%' },
  { key: 'index',     label: 'Указательный', min: -20, max: 100, unit: '%' },
  { key: 'middle',    label: 'Средний',      min: -20, max: 100, unit: '%' },
  { key: 'ring',      label: 'Безымянный',   min: -20, max: 100, unit: '%' },
  { key: 'little',    label: 'Мизинец',      min: -20, max: 100, unit: '%' },
  { key: 'spread',    label: 'Развести',     min: 0,   max: 100, unit: '%' },
  { key: 'wristFlex', label: 'Запястье ↕',   min: -70, max: 80,  unit: '°' },
  { key: 'wristDev',  label: 'Запястье ↔',   min: -20, max: 30,  unit: '°' },
];

// в позе пальцы хранятся как 0..1, а на ползунке показываем проценты
const toSlider = (s, v) => (s.unit === '%' ? Math.round(v * 100) : Math.round(v));
const fromSlider = (s, v) => (s.unit === '%' ? v / 100 : v);

function buildMotionPanel() {
  const list = document.getElementById('motion-sliders');
  for (const s of MOTION_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'motion-row';
    row.innerHTML = `
      <span>${s.label}</span>
      <input type="range" min="${s.min}" max="${s.max}" value="0" aria-label="${s.label}">
      <span class="value">0${s.unit}</span>
    `;
    s.slider = row.querySelector('input');
    s.value = row.querySelector('.value');
    s.slider.addEventListener('input', () => {
      motion.stopWave();
      setWaveButton(false);
      s.value.textContent = `${s.slider.value}${s.unit}`;
      motion.setTargetPose({ [s.key]: fromSlider(s, Number(s.slider.value)) });
    });
    list.appendChild(row);
  }

  document.querySelectorAll('[data-pose]').forEach((btn) => {
    btn.addEventListener('click', () => {
      motion.stopWave();
      setWaveButton(false);
      const name = btn.dataset.pose;
      motion.setTargetPose(name === 'reset' ? neutralPose() : PRESETS[name]);
      syncMotionSliders();
    });
  });

  document.getElementById('wave').addEventListener('click', () => {
    if (motion.isWaving()) {
      motion.stopWave();
      setWaveButton(false);
    } else {
      motion.startWave(clock.elapsedTime);
      setWaveButton(true);
    }
  });
}

function setWaveButton(on) {
  const btn = document.getElementById('wave');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '■ Стоп' : '▶ Волна';
}

// Ставим ползунки в положение текущей позы (после кнопки позы или во время «волны»)
function syncMotionSliders() {
  const pose = motion.getPose();
  for (const s of MOTION_SLIDERS) {
    const v = toSlider(s, pose[s.key]);
    s.slider.value = v;
    s.value.textContent = `${v}${s.unit}`;
  }
}

// 9в. ПАНЕЛЬ КАМЕРЫ: включение вебкамеры и управление рукой
let tracker = null;
let handRoot = null;                         // вся модель целиком (её поворачиваем вслед за рукой)
let restPalmFrame = null;                    // как лежит ладонь в модели в исходной позе
const palmToModel = new THREE.Quaternion(); // поворот «координаты ладони -> координаты модели»
let retargeter = null;                       // переносит позу с камеры на суставы модели
const handTarget = new THREE.Quaternion();   // поворот, к которому плавно ведём модель
let camStatusText = '';

function setCamStatus(text) {
  if (text === camStatusText) return; // не трогаем страницу, если ничего не поменялось
  camStatusText = text;
  document.getElementById('cam-status').textContent = text;
}

// Как ладонь лежит в самой модели: запястье и основания пальцев берём из суставов
const jointPosition = (name) => handRoot.getObjectByName(`joint_${name}`).getWorldPosition(new THREE.Vector3());
function modelPalmFrame() {
  handRoot.updateMatrixWorld(true);
  return palmFrame(jointPosition('wrist'), jointPosition('index_mcp'), jointPosition('middle_mcp'),
    jointPosition('little_mcp'));
}


function buildCameraPanel() {
  const button = document.getElementById('cam-toggle');
  const preview = document.getElementById('cam-preview');

  button.addEventListener('click', async () => {
    if (tracker?.isRunning()) {
      stopCamera();
      return;
    }
    tracker ??= createHandTracker({
      video: document.getElementById('cam-video'),
      overlay: document.getElementById('cam-overlay'),
      modelFrame: restPalmFrame,
    });
    button.disabled = true;
    preview.hidden = false;
    document.body.classList.add('camera-on');
    motion.stopWave();
    setWaveButton(false);
    // запястье камера не измеряет: его поворот входит в поворот всей модели
    motion.setTargetPose({ wristFlex: 0, wristDev: 0 });
    syncMotionSliders();
    try {
      await tracker.start(setCamStatus);
      button.textContent = 'Выключить камеру';
    } catch (err) {
      console.error(err);
      stopCamera();
      setCamStatus(cameraErrorText(err));
    }
    button.disabled = false;
  });

  document.getElementById('cam-rotate').addEventListener('change', (event) => {
    if (!event.target.checked) handTarget.identity(); // модель плавно вернётся в обычное положение
  });
}

function stopCamera() {
  tracker?.stop();
  document.getElementById('cam-preview').hidden = true;
  document.getElementById('cam-toggle').textContent = 'Включить камеру';
  document.body.classList.remove('camera-on');
  handTarget.identity();
  setCamStatus('Камера выключена.');
}

// Понятное объяснение, почему камера не включилась
function cameraErrorText(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Нет доступа к камере. Разреши его (значок камеры в адресной строке) и нажми ещё раз.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Камера не найдена. Подключи вебкамеру и попробуй ещё раз.';
    case 'NotReadableError':
      return 'Камера занята другой программой (Zoom, Telegram…). Закрой её и попробуй ещё раз.';
    default:
      if (err.message?.includes('https')) return err.message;
      return 'Не удалось загрузить распознавание руки. Проверь интернет и попробуй ещё раз.';
  }
}

// Каждый новый кадр с камеры: передаём позу пальцев и поворот ладони в модель
function applyTracking(result) {
  if (!result.found) {
    setCamStatus('Руки не видно. Держи её целиком в кадре.');
    return;
  }
  setCamStatus(result.side === 'right'
    ? 'Правая рука: вид как у тебя перед глазами.'
    : 'Левая рука: вид как в зеркале.');
  const { angles } = retargeter.solve(result.points, palmToModel);
  motion.setJointAngles(angles);
  syncMotionSliders();
  if (document.getElementById('cam-rotate').checked) handTarget.copy(result.rotation);
}

// 10. ВЫБОР ЧАСТЕЙ: наведение и клик
//
// Raycaster — «лазерная указка»: из камеры через точку под курсором пускается луч,
// и Three.js сообщает, в какие объекты он попал (ближайший первым).
const pickable = [];          // все части, на которые можно навести или кликнуть
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
const details = document.getElementById('details');
let hovered = null;           // часть под курсором
let selected = null;          // выбранная кликом часть

// Цвет подсветки задаём через emissive: это «собственное свечение» материала
function updateHighlight(mesh) {
  if (!mesh) return;
  const mat = mesh.material;
  if (mesh === selected) {
    mat.emissive.set(0x3d6bff);
    mat.emissiveIntensity = 0.5;
  } else if (mesh === hovered) {
    mat.emissive.set(0xffffff);
    mat.emissiveIntensity = 0.2;
  } else if (mesh.userData.activation > 0.02) {
    // мышца «работает»: тёплое свечение, тем ярче, чем сильнее движение
    mat.emissive.set(0xff7a1a);
    mat.emissiveIntensity = 0.6 * mesh.userData.activation;
  } else {
    mat.emissive.set(0x000000);
  }
}

// После движения пересчитываем, какие мышцы «работают»
function updateMuscleActivation() {
  const state = motion.currentState();
  for (const mesh of layerState.muscles.group.children) {
    mesh.userData.activation = muscleActivation(mesh.userData.englishName, state);
    updateHighlight(mesh);
  }
}

// Чтобы клик попадал в согнутый палец, после движения границы частей нужно пересчитать
let posed = false;
function refreshBoundsIfPosed() {
  if (!posed) return;
  for (const mesh of pickable) {
    mesh.boundingSphere = null; // Three.js пересчитает их сам при следующем луче
    mesh.boundingBox = null;
  }
  posed = false;
}

// Что находится под точкой экрана (x, y)?
function pick(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  // переводим пиксели в координаты от -1 до 1, как нужно Three.js
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  refreshBoundsIfPosed();

  for (const hit of raycaster.intersectObjects(pickable, false)) {
    const state = layerState[hit.object.userData.layer];
    // скрытые слои пропускаем, а сквозь полупрозрачные (меньше 50%) «кликаем насквозь»
    if (state.group.visible && state.opacity >= 0.5) return hit.object;
  }
  return null;
}

function setHovered(mesh, event) {
  if (mesh !== hovered) {
    const previous = hovered;
    hovered = mesh;
    updateHighlight(previous);
    updateHighlight(mesh);
  }
  renderer.domElement.style.cursor = mesh ? 'pointer' : '';
  if (mesh) {
    const { ru, la } = mesh.userData.info;
    tooltip.innerHTML = `<strong>${ru}</strong>${la ? `<em>${la}</em>` : ''}`;
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.hidden = false;
  } else {
    tooltip.hidden = true;
  }
}

function select(mesh) {
  const previous = selected;
  selected = mesh;
  updateHighlight(previous);
  updateHighlight(mesh);

  if (!mesh) {
    details.hidden = true;
    document.body.classList.remove('has-selection');
    return;
  }
  const { ru, la, desc, schematic } = mesh.userData.info;
  document.getElementById('d-layer').textContent = LAYER_LABELS[mesh.userData.layer];
  document.getElementById('d-layer').dataset.layer = mesh.userData.layer;
  document.getElementById('d-ru').textContent = ru;
  document.getElementById('d-la').textContent = la;
  document.getElementById('d-desc').textContent = desc;
  document.getElementById('d-schematic').hidden = !schematic;
  details.hidden = false;
  document.body.classList.add('has-selection');
}

// Наведение (только мышью; на телефоне наводить нечем).
// Сам поиск делаем в цикле анимации, не чаще одного раза за кадр.
let pendingMove = null;
renderer.domElement.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse' || event.buttons !== 0) {
    pendingMove = null;
    setHovered(null);
    return;
  }
  pendingMove = event;
});
renderer.domElement.addEventListener('pointerleave', () => {
  pendingMove = null;
  setHovered(null);
});

// Клик: отличаем его от вращения. Если между нажатием и отпусканием мышь
// почти не сдвинулась, считаем это кликом.
let downX = 0;
let downY = 0;
renderer.domElement.addEventListener('pointerdown', (event) => {
  downX = event.clientX;
  downY = event.clientY;
  info.classList.add('faded'); // подсказка нужна только в начале: после первого касания прячем
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return; // это было вращение
  select(pick(event.clientX, event.clientY)); // клик по пустому месту снимает выбор
});

document.getElementById('details-close').addEventListener('click', () => select(null));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') select(null);
});

// 11. Подстройка под размер окна
// Камера отходит так далеко, чтобы кисть (≈ 0.2 × 0.25 м) целиком влезла и в узкое окно телефона
let cameraFitted = false;
// Ширина свободного места: на компьютере слева стоит панель, на телефоне она внизу
function freeWidth() {
  const w = window.innerWidth;
  return w > 600 ? w - document.getElementById('panel').offsetWidth - 32 : w;
}

function fitCamera() {
  // окно может быть ещё нулевого размера (например, вкладка открылась в фоне): подождём resize
  if (!(camera.aspect > 0)) return;
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const freeAspect = Math.max(freeWidth(), 100) / window.innerHeight;
  const byHeight = 0.13 / Math.tan(halfFov);
  const byWidth = 0.11 / (Math.tan(halfFov) * freeAspect);
  camera.position.setLength(Math.max(byHeight, byWidth) * 1.15);
  cameraFitted = true;
}

function onResize() {
  const wasPortrait = camera.aspect < 1;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // телефон повернули (было вертикально, стало горизонтально или наоборот): кисть заново вписываем в экран
  if (!cameraFitted || wasPortrait !== camera.aspect < 1) fitCamera();
}
window.addEventListener('resize', onResize);
fitCamera();

// На телефоне подсказка про пальцы, а не про мышку, и панель сначала свёрнута
const isNarrow = window.innerWidth <= 600;
if (isNarrow) document.getElementById('panel').classList.add('collapsed');

// Панель закрывает часть экрана: на телефоне снизу, на компьютере слева. Сдвигаем картинку
// на половину панели, чтобы кисть оказалась по центру свободной части.
const panelEl = document.getElementById('panel');
function updateViewOffset() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w <= 600) camera.setViewOffset(w, h, 0, panelEl.offsetHeight / 2, w, h);
  else camera.setViewOffset(w, h, -(w - freeWidth()) / 2, 0, w, h);
}
new ResizeObserver(updateViewOffset).observe(panelEl); // срабатывает, когда панель раскрывают или сворачивают
window.addEventListener('resize', updateViewOffset);

// 12. ЦИКЛ АНИМАЦИИ
const clock = new THREE.Clock(); // считает время между кадрами

renderer.setAnimationLoop(frame);

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const tracking = tracker?.isRunning() ?? false;
  if (tracking) {
    const result = tracker.update(performance.now());
    if (result) applyTracking(result);
  }

  if (motion && motion.update(dt, clock.elapsedTime, tracking ? 20 : 10)) {
    posed = true;
    updateMuscleActivation();
    if (motion.isWaving()) syncMotionSliders();
  }

  // плавно поворачиваем всю модель вслед за ладонью (или обратно, когда камеру выключили)
  if (handRoot && handRoot.quaternion.angleTo(handTarget) > 1e-4) {
    handRoot.quaternion.slerp(handTarget, 1 - Math.exp(-dt * 15));
    posed = true;
  }

  if (pendingMove) {
    setHovered(pick(pendingMove.clientX, pendingMove.clientY), pendingMove);
    pendingMove = null;
  }
  controls.update();
  renderer.render(scene, camera);
}
