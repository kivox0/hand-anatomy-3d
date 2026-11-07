// ПЕРЕНОС ПОЗЫ С КАМЕРЫ НА МОДЕЛЬ
//
// На входе — 21 точка руки с камеры в «координатах ладони» (см. tracking.js):
// x — к большому пальцу, y — к пальцам, z — из ладони, длина ладони = 1.
// На выходе — углы суставов модели в градусах.
//
// Как это устроено:
// 1. Пальцы (кроме большого). По точкам считаем угол каждого сустава так, как его видит камера,
//    и переводим в угол модели по калибровке.
// 2. Большой палец. Сначала поворачиваем его суставы так, чтобы фаланги смотрели туда же, куда у тебя.
// 3. Большой палец рядом с другими пальцами (жест «ОК», щепоть, кулак с пальцем внутри).
//    Тут важны не углы, а КУДА пришёл кончик. Маленькие ошибки углов складываются,
//    и кончик промахивается на 1–2 см. Поэтому смотрим, где кончик большого пальца находится
//    относительно ближайших точек других пальцев на камере, и ставим его в такое же место
//    относительно пальцев модели. Углы, при которых кончик туда попадает, подбираем
//    обратной кинематикой (IK): пробуем чуть менять каждый угол и оставляем то, что ближе к цели.
//    Если большой палец касается кончика другого пальца, досгибаем и этот палец, чтобы колечко замкнулось.

import * as THREE from 'three';

const toRad = THREE.MathUtils.degToRad;
const toDeg = THREE.MathUtils.radToDeg;
const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;

// Цепочки суставов и точки камеры для них: [основание, следующий сустав, …, кончик]
const FINGER_CHAINS = {
  thumb:  { joints: ['thumb_cmc', 'thumb_mcp', 'thumb_ip'],    points: [1, 2, 3, 4],     bone: 'thumb' },
  index:  { joints: ['index_mcp', 'index_pip', 'index_dip'],    points: [5, 6, 7, 8],     bone: 'index finger' },
  middle: { joints: ['middle_mcp', 'middle_pip', 'middle_dip'], points: [9, 10, 11, 12],  bone: 'middle finger' },
  ring:   { joints: ['ring_mcp', 'ring_pip', 'ring_dip'],       points: [13, 14, 15, 16], bone: 'ring finger' },
  little: { joints: ['little_mcp', 'little_pip', 'little_dip'], points: [17, 18, 19, 20], bone: 'little finger' },
};
const FOUR = ['index', 'middle', 'ring', 'little'];

// Пределы суставов в градусах (меньше нуля — переразгибание), чтобы палец не выворачивался
const LIMITS = {
  thumb_cmc: { flex: [-40, 60], abd: [-30, 70] },
  thumb_mcp: { flex: [-15, 70] },
  thumb_ip:  { flex: [-25, 90] },
  mcp: { flex: [-30, 95], abd: [-20, 30] },
  pip: { flex: [-10, 110] },
  dip: { flex: [-10, 90] },
};
const limitsOf = (name) => LIMITS[name] ?? LIMITS[name.split('_')[1]];

// ---------- калибровка (подобрана проверкой на картинках нашей модели) ----------

// Пальцы: [какой угол камера видит у прямого пальца модели, на сколько градусов он вырастает,
// когда сустав модели согнут полностью]; side — наклон вбок: [при сомкнутых пальцах, при «развести»]
const JOINT_CAL = {
  index:  { mcp: [10, 60], pip: [8, 60],  dip: [5, 40], side: [8, 13] },
  middle: { mcp: [11, 62], pip: [12, 80], dip: [5, 40] },
  ring:   { mcp: [14, 66], pip: [10, 85], dip: [6, 40], side: [-13, -10] },
  little: { mcp: [15, 65], pip: [3, 90],  dip: [7, 40], side: [-21, -23] },
};
// полное сгибание и разведение суставов модели (те же числа, что в motion.js)
const FULL_FLEX = { mcp: 90, pip: 100, dip: 70 };
const FULL_SPREAD = { index: 15, ring: 12, little: 25 };
// Последний сустав пальца камера видит плохо (кончик загибается «в камеру»).
// У живой руки он почти всегда сгибается вместе со средним, поэтому берём его в основном от среднего.
const DIP_FROM_PIP = 0.7;

// Большой палец: такие углы получаются, если показать камере прямую руку модели (вычитаем их)
const THUMB_REST = { thumb_cmc: [12, -18], thumb_mcp: [-6, 0], thumb_ip: [-10, 0] };
const THUMB_GAIN = 1.2; // сгиб его суставов камера видит немного меньше, чем он есть

// Перевод расстояний «в долях ладони» в метры модели: вдоль ладони и поперёк неё
// (глубину камера видит сжатой, поэтому второе число меньше)
const PALM_SCALE = 0.080;
const DEPTH_SCALE = 0.056;
// Большой палец «рядом с пальцами», если до ближайшей их точки меньше 0,2 ладони (и точно нет, если больше 0,4)
const NEAR = [0.2, 0.4];
// Касание кончиками (жест «ОК»): ближе 0,22 ладони — точно касаются, дальше 0,38 — нет.
// Числа такие большие, потому что точки кончиков камера ставит не на самый край пальца,
// а у повёрнутой руки ещё и ошибается в глубине.
const TOUCH = [0.22, 0.38];

// ---------- геометрия ----------

const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const SIDE = new THREE.Vector3(1, 0, 0);   // в координатах ладони: к большому пальцу
const UP = new THREE.Vector3(0, 1, 0);     // к пальцам
const NORMAL = new THREE.Vector3(0, 0, 1); // из ладони

// Угол сгиба в точке b: между отрезками a→b и b→c (0° — прямо)
function bend(a, b, c) {
  va.subVectors(b, a);
  vb.subVectors(c, b);
  return toDeg(va.angleTo(vb));
}

// Угол поворота от направления a к направлению b вокруг оси ax (со знаком)
function angleAbout(a, b, ax) {
  va.copy(a).projectOnPlane(ax);
  vb.copy(b).projectOnPlane(ax);
  return toDeg(Math.atan2(vc.crossVectors(va, vb).dot(ax), va.dot(vb)));
}

export function createRetargeter(hand) {
  const rig = Object.fromEntries(hand.userData.rig.map((r) => [r.name, r]));
  const joint = (name) => {
    const r = rig[name];
    return {
      pos: new THREE.Vector3(...r.position),
      flexAxis: r.flexAxis && new THREE.Vector3(...r.flexAxis),
      abdAxis: r.abdAxis && new THREE.Vector3(...r.abdAxis),
    };
  };

  // Цепочки модели. Кончик пальца — дальняя точка кости ногтевой фаланги (+3 мм на мякоть)
  const bones = hand.getObjectByName('bones');
  const chains = {};
  for (const [finger, c] of Object.entries(FINGER_CHAINS)) {
    const joints = c.joints.map(joint);
    const last = joints[joints.length - 1].pos;
    const mesh = bones.children.find((m) =>
      m.name.replace(/_/g, ' ').toLowerCase().startsWith(`distal phalanx of right ${c.bone}`));
    const pos = mesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    const center = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) center.add(v.fromBufferAttribute(pos, i));
    center.divideScalar(pos.count);
    const dir = center.sub(last).normalize();
    let far = 0;
    for (let i = 0; i < pos.count; i++) far = Math.max(far, v.fromBufferAttribute(pos, i).sub(last).dot(dir));
    const tip = last.clone().addScaledVector(dir, far + 0.003);
    const points = [...joints.map((j) => j.pos), tip];
    chains[finger] = {
      names: c.joints,
      joints,
      points: c.points,
      rest: points.slice(1).map((p, i) => p.clone().sub(points[i]).normalize()), // направления фаланг
      offsets: points.slice(1).map((p, i) => p.clone().sub(points[i])),        // сами фаланги
    };
  }

  // ---------- прямая кинематика: углы -> где окажутся суставы и кончик ----------
  const qFlex = new THREE.Quaternion();
  const qAbd = new THREE.Quaternion();
  const qLocal = new THREE.Quaternion();
  const W = new THREE.Quaternion();

  // поворот сустава так же, как в motion.js: сначала сгибание, потом отведение
  function localRotation(j, flex, abd, out) {
    qFlex.setFromAxisAngle(j.flexAxis, toRad(flex));
    if (j.abdAxis) {
      qAbd.setFromAxisAngle(j.abdAxis, toRad(abd));
      return out.multiplyQuaternions(qAbd, qFlex);
    }
    return out.copy(qFlex);
  }

  // Точки цепочки (суставы и кончик) при углах angles = [[flex, abd], …]
  function chainPoints(chain, angles) {
    W.identity();
    const pts = [chain.joints[0].pos.clone()];
    for (let k = 0; k < chain.joints.length; k++) {
      localRotation(chain.joints[k], angles[k][0], angles[k][1], qLocal);
      W.multiply(qLocal);
      pts.push(pts[k].clone().add(va.copy(chain.offsets[k]).applyQuaternion(W)));
    }
    return pts;
  }
  const tipOf = (chain, angles) => chainPoints(chain, angles)[chain.joints.length];

  // ---------- 1. пальцы ----------
  const norm = (value, [rest, range]) => (value - rest) / range;

  function fingerAngles(L, finger) {
    const cal = JOINT_CAL[finger];
    const [m, p, d, t] = FINGER_CHAINS[finger].points;
    const metacarpal = vb.subVectors(L[m], L[0]).clone();
    const phalanx = new THREE.Vector3().subVectors(L[p], L[m]);

    let mcp = norm(angleAbout(metacarpal, phalanx, SIDE), cal.mcp);
    // переразгибание камера видит плохо и часто «находит» его там, где его нет: уменьшаем вдвое
    if (mcp < 0) mcp *= 0.5;
    const pip = norm(bend(L[m], L[p], L[d]), cal.pip);
    const dip = DIP_FROM_PIP * pip + (1 - DIP_FROM_PIP) * Math.max(0, norm(bend(L[p], L[d], L[t]), cal.dip));
    let abd = 0;
    if (cal.side) {
      // наклон пальца вбок; у согнутого пальца его не видно и не нужно, поэтому ослабляем
      const side = -angleAbout(UP, phalanx, NORMAL);
      abd = norm(side, cal.side) * clamp(1 - mcp * 1.2, 0, 1) * FULL_SPREAD[finger];
    }
    const lim = (name, x) => clamp(x, ...limitsOf(name).flex);
    return [
      [lim('mcp', mcp * FULL_FLEX.mcp), clamp(abd, ...LIMITS.mcp.abd)],
      [lim('pip', pip * FULL_FLEX.pip), 0],
      [lim('dip', dip * FULL_FLEX.dip), 0],
    ];
  }

  // ---------- 2. большой палец: направления фаланг ----------
  const from = new THREE.Vector3();
  const axis = new THREE.Vector3();

  // Основание большого пальца двигается в двух направлениях: подбираем оба угла перебором
  // (сначала с шагом 5°, потом точнее, с шагом 1°)
  function solveTwoAxes(j, rest, target, lim) {
    let best = { flex: 0, abd: 0, err: Infinity };
    const test = (flex, abd) => {
      if (flex < lim.flex[0] || flex > lim.flex[1] || abd < lim.abd[0] || abd > lim.abd[1]) return;
      localRotation(j, flex, abd, qLocal);
      const err = from.copy(rest).applyQuaternion(qLocal).distanceToSquared(target);
      if (err < best.err) best = { flex, abd, err };
    };
    for (let f = lim.flex[0]; f <= lim.flex[1]; f += 5) for (let a = lim.abd[0]; a <= lim.abd[1]; a += 5) test(f, a);
    const { flex: f0, abd: a0 } = best;
    for (let f = f0 - 4; f <= f0 + 4; f++) for (let a = a0 - 4; a <= a0 + 4; a++) test(f, a);
    return [best.flex, best.abd];
  }

  function thumbAngles(L, toModel) {
    const chain = chains.thumb;
    const dir = (a, b) => new THREE.Vector3().subVectors(L[b], L[a]).applyQuaternion(toModel).normalize();
    const dirs = [dir(1, 2), dir(2, 3), dir(3, 4)];
    const angles = [];
    W.identity();
    for (let k = 0; k < 3; k++) {
      const j = chain.joints[k];
      const name = chain.names[k];
      const lim = limitsOf(name);
      let flex;
      let abd = 0;
      if (j.abdAxis) {
        [flex, abd] = solveTwoAxes(j, chain.rest[k], dirs[k], lim);
      } else {
        // один угол: поворот вокруг оси сустава (ось повёрнута вместе с пальцем)
        axis.copy(j.flexAxis).applyQuaternion(W);
        from.copy(chain.rest[k]).applyQuaternion(W);
        flex = angleAbout(from, dirs[k], axis);
      }
      // следующую фалангу считаем от того, как реально повёрнута эта
      localRotation(j, flex, abd, qLocal);
      W.multiply(qLocal);
      const [restFlex, restAbd] = THUMB_REST[name];
      const gain = k === 0 ? 1 : THUMB_GAIN;
      angles.push([clamp((flex - restFlex) * gain, ...lim.flex), lim.abd ? clamp(abd - restAbd, ...lim.abd) : 0]);
    }
    return angles;
  }

  // ---------- 3. обратная кинематика: довести кончик пальца до точки ----------
  // Перебор по одному углу: пробуем чуть больше и чуть меньше и оставляем, если кончик
  // стал ближе к цели. Шаг постепенно уменьшаем. Небольшой «штраф» за отход от исходных
  // углов не даёт пальцу выворачиваться без нужды.
  function reach(chain, start, target) {
    const angles = start.map((a) => [...a]);
    const cost = () => {
      let c = tipOf(chain, angles).distanceToSquared(target);
      for (let k = 0; k < angles.length; k++) {
        c += 2e-8 * ((angles[k][0] - start[k][0]) ** 2 + (angles[k][1] - start[k][1]) ** 2);
      }
      return c;
    };
    let best = cost();
    for (const stepDeg of [8, 4, 2, 1, 0.5]) {
      for (let pass = 0; pass < 3; pass++) {
        for (let k = 0; k < angles.length; k++) {
          const lim = limitsOf(chain.names[k]);
          for (const d of lim.abd ? [0, 1] : [0]) {
            const range = d === 0 ? lim.flex : lim.abd;
            for (const sign of [1, -1]) {
              const old = angles[k][d];
              angles[k][d] = clamp(old + sign * stepDeg, range[0], range[1]);
              const c = cost();
              if (c < best) best = c;
              else angles[k][d] = old;
            }
          }
        }
      }
    }
    return angles;
  }

  const blend = (a, b, w) => a.map((x, k) => [
    THREE.MathUtils.lerp(x[0], b[k][0], w),
    THREE.MathUtils.lerp(x[1], b[k][1], w),
  ]);

  // ---------- всё вместе ----------
  // L — 21 точка в координатах ладони, toModel — поворот «координаты ладони -> координаты модели»
  function solve(L, toModel) {
    const result = {};
    for (const finger of FOUR) result[finger] = fingerAngles(L, finger);
    result.thumb = thumbAngles(L, toModel);

    // Где кончик большого пальца относительно ближайших точек других пальцев (на камере)
    const anchors = [];
    for (const finger of FOUR) {
      const pts = chainPoints(chains[finger], result[finger]); // те же точки у модели
      chains[finger].points.forEach((i, k) => {
        anchors.push({ finger, isTip: k === 3, model: pts[k], distance: L[4].distanceTo(L[i]), offset: L[4].clone().sub(L[i]) });
      });
    }
    anchors.sort((a, b) => a.distance - b.distance);
    const nearest = anchors[0];
    const near = 1 - smoothstep(nearest.distance, NEAR[0], NEAR[1]);
    let touch = null;

    if (near > 0) {
      // ставим кончик большого пальца модели туда же относительно трёх ближайших точек
      const target = new THREE.Vector3();
      let total = 0;
      for (const a of anchors.slice(0, 3)) {
        const w = 1 / (a.distance + 0.05);
        const offset = new THREE.Vector3(a.offset.x * PALM_SCALE, a.offset.y * PALM_SCALE, a.offset.z * DEPTH_SCALE)
          .applyQuaternion(toModel);
        target.addScaledVector(a.model.clone().add(offset), w);
        total += w;
      }
      target.divideScalar(total);
      result.thumb = blend(result.thumb, reach(chains.thumb, result.thumb, target), near);

      // Касание кончиками: углы пальца с камеры в таких позах особенно неточны, поэтому
      // кончики встречаются посередине: оба пальца тянутся друг к другу, пока не сойдутся.
      if (nearest.isTip) {
        const weight = 1 - smoothstep(nearest.distance, TOUCH[0], TOUCH[1]);
        if (weight > 0) {
          const f = nearest.finger;
          touch = { finger: f, weight };
          const meet = tipOf(chains.thumb, result.thumb).lerp(tipOf(chains[f], result[f]), 0.5);
          result[f] = blend(result[f], reach(chains[f], result[f], meet), weight);
          result.thumb = blend(result.thumb, reach(chains.thumb, result.thumb, meet), weight);
        }
      }
    }

    // в виде { имя_сустава: { flex, abd } }
    const angles = {};
    for (const [finger, chain] of Object.entries(chains)) {
      chain.names.forEach((name, k) => {
        angles[name] = { flex: result[finger][k][0], abd: result[finger][k][1] };
      });
    }
    return { angles, near, touch, nearest: { finger: nearest.finger, isTip: nearest.isTip, distance: nearest.distance } };
  }

  // для проверки наружу отдаём и внутренние части
  return { solve, chains, chainPoints, tipOf, reach };
}
