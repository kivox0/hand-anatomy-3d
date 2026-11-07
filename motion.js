// ДВИЖЕНИЕ КИСТИ
//
// Как это устроено:
// • В модели есть «скелет для анимации»: 17 суставов (joint_wrist, joint_index_mcp, …).
//   Каждый сустав — точка вращения (pivot). Суставы вложены друг в друга:
//   запястье -> пястно-фаланговый -> проксимальный межфаланговый -> дистальный.
//   Поэтому, если согнуть сустав, всё, что «ниже» по цепочке, поворачивается вместе с ним.
// • Кости привязаны к своему суставу целиком. Кожа, мышцы и связки привязаны «с весами»:
//   точка возле сустава наполовину следует за одной фалангой, наполовину за другой,
//   поэтому кожа на сгибе плавно изгибается.
// • Для каждого сустава в модели записаны оси: flexAxis (сгибание) и abdAxis (отведение вбок).

import * as THREE from 'three';

// Насколько сгибается каждый сустав при «сгибании пальца на 100%» (в градусах)
const CURL = {
  thumb:  { thumb_cmc: 35, thumb_mcp: 55, thumb_ip: 80 },
  index:  { index_mcp: 90, index_pip: 100, index_dip: 70 },
  middle: { middle_mcp: 90, middle_pip: 100, middle_dip: 70 },
  ring:   { ring_mcp: 90, ring_pip: 100, ring_dip: 70 },
  little: { little_mcp: 90, little_pip: 100, little_dip: 70 },
};

// «Развести пальцы на 100%»: отведение в пястно-фаланговых суставах (средний палец — ось, он не двигается)
const SPREAD = { index_mcp: 15, ring_mcp: 12, little_mcp: 25 };

// «Отвести большой палец на 100%»: большой палец уходит вперёд от ладони (в градусах).
// Вместе со сгибанием это даёт противопоставление: большой палец тянется к мизинцу.
const THUMB_ABD = 45;

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

// Поза — это несколько простых чисел. Из них считаются углы всех суставов.
export function neutralPose() {
  return { thumb: 0, thumbAbd: 0, index: 0, middle: 0, ring: 0, little: 0, spread: 0, wristFlex: 0, wristDev: 0 };
}

const makePose = (p) => ({ ...neutralPose(), ...p });
export const PRESETS = {
  open:   makePose({ spread: 0.8, thumbAbd: 0.2 }),
  fist:   makePose({ thumb: 0.8, index: 1, middle: 1, ring: 1, little: 1 }),
  point:  makePose({ thumb: 0.8, middle: 1, ring: 1, little: 1 }),
  like:   makePose({ thumb: -0.1, index: 1, middle: 1, ring: 1, little: 1 }),
  oppose: makePose({ thumb: 0.6, thumbAbd: 0.6, ring: 0.25, little: 0.5 }), // кончик большого касается мизинца
  rest:   makePose({ thumb: 0.25, thumbAbd: 0.2, index: 0.2, middle: 0.25, ring: 0.3, little: 0.35, spread: 0.2, wristFlex: -10 }),
};

// Поза -> углы суставов { имя_сустава: { flex, abd } } в градусах
function poseToAngles(p) {
  const a = {};
  const set = (j, flex = 0, abd = 0) => {
    a[j] = a[j] || { flex: 0, abd: 0 };
    a[j].flex += flex;
    a[j].abd += abd;
  };

  for (const f of FINGERS) {
    const c = p[f];
    for (const [joint, deg] of Object.entries(CURL[f])) {
      if (c >= 0) set(joint, c * deg);
      // отрицательное значение = лёгкое переразгибание, в основном в первом суставе пальца
      else if (joint.endsWith('_mcp') || joint === 'thumb_ip') set(joint, c * deg);
    }
  }
  for (const [joint, deg] of Object.entries(SPREAD)) set(joint, 0, p.spread * deg);
  set('thumb_cmc', -p.spread * 20); // большой палец при разведении уходит в сторону
  set('thumb_cmc', 0, p.thumbAbd * THUMB_ABD); // и вперёд от ладони

  set('wrist', p.wristFlex, p.wristDev);
  return a;
}

export function createMotion(hand) {
  const rig = hand.userData.rig; // описание суставов, которое записал скрипт сборки
  const joints = {};
  for (const r of rig) {
    joints[r.name] = {
      bone: hand.getObjectByName('joint_' + r.name),
      flexAxis: r.flexAxis ? new THREE.Vector3(...r.flexAxis) : null,
      abdAxis: r.abdAxis ? new THREE.Vector3(...r.abdAxis) : null,
      // текущие углы и углы, к которым стремимся (для плавности)
      flex: 0, abd: 0, targetFlex: 0, targetAbd: 0,
    };
  }

  const qFlex = new THREE.Quaternion();
  const qAbd = new THREE.Quaternion();
  const toRad = THREE.MathUtils.degToRad;

  let pose = neutralPose();       // поза, которую задали ползунки
  let wave = null;                // анимация «волна» (время старта) или null

  function setTargetPose(p) {
    pose = { ...pose, ...p };
    const angles = poseToAngles(pose);
    for (const [name, j] of Object.entries(joints)) {
      j.targetFlex = angles[name]?.flex ?? 0;
      j.targetAbd = angles[name]?.abd ?? 0;
    }
  }

  // Камера задаёт угол каждого сустава напрямую (в градусах): { index_pip: { flex, abd }, … }.
  // Их считает retarget.js.
  function setJointAngles(angles) {
    for (const [name, { flex, abd }] of Object.entries(angles)) {
      joints[name].targetFlex = flex;
      joints[name].targetAbd = abd;
    }
    // ползункам показываем средний сгиб каждого пальца
    for (const f of FINGERS) {
      let sum = 0;
      let full = 0;
      for (const [joint, deg] of Object.entries(CURL[f])) {
        sum += joints[joint].targetFlex;
        full += deg;
      }
      pose[f] = sum / full;
    }
    pose.spread = joints.little_mcp.targetAbd / SPREAD.little_mcp;
    pose.thumbAbd = joints.thumb_cmc.targetAbd / THUMB_ABD;
  }

  // Каждый кадр: подтягиваем текущие углы к целевым и поворачиваем суставы.
  // speed — насколько быстро догоняем цель (с камерой быстрее: числа там уже сглажены).
  // Возвращает true, если что-то сдвинулось (тогда нужно обновить подсветку мышц).
  function update(dt, time, speed = 10) {
    if (wave !== null) {
      const t = time - wave;
      const p = {};
      FINGERS.forEach((f, i) => {
        p[f] = 0.5 - 0.5 * Math.cos(t * 3 - i * 0.7); // каждый палец чуть позже предыдущего
      });
      p.wristFlex = 15 * Math.sin(t * 1.5);
      setTargetPose(p);
    }

    // чем больше число, тем быстрее догоняем цель; формула не зависит от частоты кадров
    const k = 1 - Math.exp(-dt * speed);
    let moved = false;
    for (const j of Object.values(joints)) {
      if (!j.flexAxis) continue;
      const dFlex = j.targetFlex - j.flex;
      const dAbd = j.targetAbd - j.abd;
      if (Math.abs(dFlex) < 0.01 && Math.abs(dAbd) < 0.01) continue;
      j.flex += dFlex * k;
      j.abd += dAbd * k;
      // сначала сгибание вокруг своей оси, затем отведение вбок
      qFlex.setFromAxisAngle(j.flexAxis, toRad(j.flex));
      if (j.abdAxis) {
        qAbd.setFromAxisAngle(j.abdAxis, toRad(j.abd));
        j.bone.quaternion.multiplyQuaternions(qAbd, qFlex);
      } else {
        j.bone.quaternion.copy(qFlex);
      }
      moved = true;
    }
    return moved;
  }

  // Текущее состояние для подсветки мышц: насколько согнут каждый палец и запястье
  function currentState() {
    const s = {};
    for (const f of FINGERS) {
      // сумма текущих углов пальца / сумма углов при полном сгибании: 0 — прямой, 1 — согнут
      let now = 0;
      let full = 0;
      for (const [joint, deg] of Object.entries(CURL[f])) {
        now += joints[joint].flex;
        full += deg;
      }
      s[f] = now / full;
    }
    // разведение — в среднем по трём пальцам (с камеры они могут разводиться по-разному)
    s.spread = (joints.index_mcp.abd / SPREAD.index_mcp + joints.ring_mcp.abd / SPREAD.ring_mcp
      + joints.little_mcp.abd / SPREAD.little_mcp) / 3;
    s.thumbAbd = joints.thumb_cmc.abd / THUMB_ABD;
    s.wristFlex = joints.wrist.flex;
    s.wristDev = joints.wrist.abd;
    return s;
  }

  return {
    joints,
    getPose: () => ({ ...pose }),
    setTargetPose,
    setJointAngles,
    update,
    currentState,
    startWave: (time) => { wave = time; },
    stopWave: () => { wave = null; },
    isWaving: () => wave !== null,
  };
}

// ---------- «работающие» мышцы ----------
// Очень упрощённо: мышца светится тем сильнее, чем больше то движение, которое она выполняет.
// На вход — английское название мышцы и состояние из currentState().
export function muscleActivation(name, s) {
  const n = name.toLowerCase();
  const pos = (x) => Math.max(0, x);
  const curl = (pos(s.index) + pos(s.middle) + pos(s.ring) + pos(s.little)) / 4;
  const ext = (pos(-s.index) + pos(-s.middle) + pos(-s.ring) + pos(-s.little)) / 4;
  const flexW = pos(s.wristFlex) / 70;
  const extW = pos(-s.wristFlex) / 60;
  const radDev = pos(-s.wristDev) / 20;
  const ulnDev = pos(s.wristDev) / 30;

  let a = 0;
  if (/flexor digitorum|lumbrical/.test(n)) a = curl;
  else if (/palmar interossei/.test(n)) a = curl * 0.6;
  else if (/dorsal interossei/.test(n)) a = pos(s.spread);
  else if (/abductor digiti minimi/.test(n)) a = pos(s.spread);
  else if (/digiti minimi brevis|opponens digiti minimi/.test(n)) a = pos(s.little);
  else if (/flexor pollicis|adductor pollicis/.test(n)) a = pos(s.thumb);
  else if (/opponens pollicis/.test(n)) a = (pos(s.thumb) + pos(s.thumbAbd)) / 2;
  else if (/abductor pollicis brevis/.test(n)) a = pos(s.thumbAbd) + pos(s.thumb) * 0.3;
  else if (/abductor pollicis longus|extensor pollicis/.test(n)) {
    a = pos(-s.thumb) * 4 + pos(s.spread) * 0.6 + pos(s.thumbAbd) * 0.4;
  }
  else if (/extensor digitorum|extensor indicis|extensor digiti minimi/.test(n)) a = ext * 4 + extW * 0.3;
  else if (/flexor carpi radialis/.test(n)) a = flexW + radDev * 0.6;
  else if (/flexor carpi ulnaris/.test(n)) a = flexW + ulnDev * 0.6;
  else if (/palmaris longus/.test(n)) a = flexW;
  else if (/extensor carpi radialis/.test(n)) a = extW + radDev * 0.6;
  else if (/extensor carpi ulnaris/.test(n)) a = extW + ulnDev * 0.6;
  return Math.min(1, a);
}
