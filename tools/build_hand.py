"""
Сборка модели кисти из BodyParts3D в один файл models/hand.glb.

Для работы сайта его запускать не нужно: готовая модель уже лежит в models/hand.glb.
Скрипт лежит в проекте, чтобы было видно, как получена модель, и чтобы её можно было пересобрать.
Исходные данные (BodyParts3D 4.0, isa_BP3D_4.0_obj_99.zip и isa_element_parts.txt):
https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/

Запуск:
    python -I tools/build_hand.py <папка с OBJ> <isa_element_parts.txt> models/hand.glb

Что делает:
  1. Берёт из BodyParts3D кости, мышцы, кожу и связку запястья.
  2. Оставляет только область правой кисти и запястья (всё выше запястья отрезает).
  3. Строит схематичные боковые (коллатеральные) связки суставов пальцев.
  4. Переводит миллиметры в метры, ставит кисть пальцами вверх, ладонью к зрителю.
  5. Добавляет скелет для анимации (17 суставов) и веса привязки кожи, мышц и связок к костям.
  6. Записывает всё в GLB. У каждого объекта в extras.layer указан слой.

Только стандартная библиотека Python, без установки пакетов.
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

# ---------- настройки ----------
WRIST_ABOVE_CARPALS_MM = 30   # сколько предплечья оставить выше костей запястья
BOX_MARGIN_MM = 18            # запас вокруг костей кисти по бокам
MIN_TRIANGLES = 40            # кусочки меньше этого отбрасываем

HAND_PARTS = re.compile(
    r"finger|thumb|metacarpal|scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate",
    re.I,
)
RIGHT = re.compile(r"\bright\b", re.I)
LEFT = re.compile(r"\bleft\b", re.I)
FOREARM_BONES = re.compile(r"^right (radius|ulna)$", re.I)

CONCEPT_LAYER = {
    "FMA5018": "bones",      # bone organ
    "FMA5022": "muscles",    # muscle organ
    "FMA85453": "muscles",   # head of muscle organ (головки мышц, например приводящей б. пальца)
    "FMA32558": "muscles",   # musculature (наборы: межкостные, червеобразные мышцы)
    "FMA7163": "skin",       # skin
    "FMA40120": "ligaments", # flexor retinaculum of right wrist
}


# ---------- чтение OBJ ----------
def read_obj(path):
    name = path.stem
    verts, norms, tris = [], [], []
    with path.open("r", errors="replace") as fh:
        for line in fh:
            if line.startswith("# English name"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("v "):
                _, x, y, z = line.split()[:4]
                verts.append((float(x), float(y), float(z)))
            elif line.startswith("vn "):
                _, x, y, z = line.split()[:4]
                norms.append((float(x), float(y), float(z)))
            elif line.startswith("f "):
                idx = []
                for tok in line.split()[1:]:
                    parts = tok.split("/")
                    vi = int(parts[0]) - 1
                    ni = int(parts[2]) - 1 if len(parts) > 2 and parts[2] else vi
                    idx.append((vi, ni))
                for k in range(1, len(idx) - 1):  # многоугольник -> треугольники
                    tris.append((idx[0], idx[k], idx[k + 1]))
    return name, verts, norms, tris


# ---------- перевод координат ----------
# BodyParts3D: миллиметры, ось Z вверх, рука висит вдоль тела.
# Нам: метры, ось Y вверх, кисть пальцами вверх, ладонью к зрителю (+Z).
# (x, y, z) -> Y-up (x, z, -y) -> поворот на 180° вокруг Z -> (-x, -z, -y)
def to_final(p):
    x, y, z = p
    return (-x * 0.001, -z * 0.001, -y * 0.001)


def to_final_dir(n):
    x, y, z = n
    return (-x, -z, -y)


# ---------- немного векторной математики ----------
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def mul(a, s): return (a[0] * s, a[1] * s, a[2] * s)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def length(a): return math.sqrt(dot(a, a))
def norm(a):
    l = length(a)
    return (a[0] / l, a[1] / l, a[2] / l) if l > 1e-12 else (0.0, 0.0, 0.0)


def centroid(pts):
    n = len(pts)
    return (sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n, sum(p[2] for p in pts) / n)


def principal_axes(pts):
    """Главные оси облака точек (самая длинная и вторая) через степенной метод."""
    c = centroid(pts)
    cov = [[0.0] * 3 for _ in range(3)]
    for p in pts:
        d = sub(p, c)
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i] * d[j]

    def mv(m, v):
        return (dot(m[0], v), dot(m[1], v), dot(m[2], v))

    def power(m, seed):
        v = norm(seed)
        for _ in range(100):
            v = norm(mv(m, v))
        return v

    a1 = power(cov, (0.3, 1.0, 0.2))
    lam1 = dot(a1, mv(cov, a1))
    cov2 = [[cov[i][j] - lam1 * a1[i] * a1[j] for j in range(3)] for i in range(3)]
    a2 = power(cov2, cross(a1, (0.1, 0.2, 1.0)))
    a2 = norm(sub(a2, mul(a1, dot(a2, a1))))
    return c, a1, a2


# ---------- геометрия частей ----------
class Part:
    def __init__(self, name, layer, positions, normals, indices, schematic=False):
        self.name, self.layer = name, layer
        self.positions, self.normals, self.indices = positions, normals, indices
        self.schematic = schematic


def build_part(name, layer, verts, norms, tris, keep_tri=None):
    """Переводит OBJ в нужные координаты, по желанию оставляет только часть треугольников."""
    remap, positions, normals, indices = {}, [], [], []
    for tri in tris:
        if keep_tri and not keep_tri(tri):
            continue
        for vi, ni in tri:
            key = (vi, ni)
            if key not in remap:
                remap[key] = len(positions)
                positions.append(to_final(verts[vi]))
                n = norms[ni] if ni < len(norms) else (0.0, 0.0, 1.0)
                normals.append(norm(to_final_dir(n)))
            indices.append(remap[key])
    if len(indices) // 3 < MIN_TRIANGLES:
        return None
    return Part(name, layer, positions, normals, indices)


def box_mesh(p0, p1, side_dir, width, thickness):
    """Плоская «ленточка» от p0 до p1: так рисуем схематичную связку."""
    along = sub(p1, p0)
    wdir = norm(cross(norm(along), side_dir))  # ширина ленты (ладонь—тыл)
    hw, ht = width / 2, thickness / 2
    corners = []
    for a in (p0, p1):
        for sw in (-1, 1):
            for st in (-1, 1):
                corners.append(add(add(a, mul(wdir, sw * hw)), mul(side_dir, st * ht)))
    # 6 граней, у каждой свои 4 вершины, чтобы освещение было ровным
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    positions, normals, indices = [], [], []
    center = mul(add(p0, p1), 0.5)
    for f in faces:
        quad = [corners[i] for i in f]
        n = norm(cross(sub(quad[1], quad[0]), sub(quad[2], quad[0])))
        if dot(n, sub(centroid(quad), center)) < 0:  # нормаль наружу
            quad.reverse()
            n = mul(n, -1)
        base = len(positions)
        positions += quad
        normals += [n] * 4
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return positions, normals, indices


# ---------- схематичные связки ----------
FINGERS = [
    ("thumb", ["right first metacarpal bone", "proximal phalanx of right thumb", "distal phalanx of right thumb"]),
    ("index finger", ["right second metacarpal bone", "proximal phalanx of right index finger",
                      "middle phalanx of right index finger", "distal phalanx of right index finger"]),
    ("middle finger", ["right third metacarpal bone", "proximal phalanx of right middle finger",
                       "middle phalanx of right middle finger", "distal phalanx of right middle finger"]),
    ("ring finger", ["right fourth metacarpal bone", "proximal phalanx of right ring finger",
                     "middle phalanx of right ring finger", "distal phalanx of right ring finger"]),
    ("little finger", ["right fifth metacarpal bone", "proximal phalanx of right little finger",
                       "middle phalanx of right little finger", "distal phalanx of right little finger"]),
]


def make_ligaments(bones_by_name):
    def get(n):
        return bones_by_name[n.lower()]

    info = {}
    for p in bones_by_name.values():
        c, a1, a2 = principal_axes(p.positions)
        info[p.name.lower()] = (c, a1, a2, p.positions)

    # «лучевое» направление: от мизинца к большому пальцу
    radial = norm(sub(info["right second metacarpal bone"][0], info["right fifth metacarpal bone"][0]))
    thumb_side = norm(sub(info["right first metacarpal bone"][0], info["right second metacarpal bone"][0]))

    parts, joints = [], []
    for finger, chain in FINGERS:
        for k in range(len(chain) - 1):
            a_name, b_name = chain[k].lower(), chain[k + 1].lower()
            ca, axa, a2a, pa = info[a_name]
            cb, axb, a2b, pb = info[b_name]
            # оси направляем от запястья к кончику пальца
            if dot(axa, sub(cb, ca)) < 0:
                axa = mul(axa, -1)
            if dot(axb, sub(cb, ca)) < 0:
                axb = mul(axb, -1)
            a_end = add(ca, mul(axa, max(dot(sub(v, ca), axa) for v in pa)))
            b_start = add(cb, mul(axb, min(dot(sub(v, cb), axb) for v in pb)))
            joint = mul(add(a_end, b_start), 0.5)
            axis = norm(add(axa, axb))

            if finger == "thumb":
                lat = a2b  # у большого пальца своя плоскость, берём ширину самой фаланги
                if dot(lat, thumb_side) < 0:
                    lat = mul(lat, -1)
            else:
                lat = radial
            lat = norm(sub(lat, mul(axis, dot(lat, axis))))

            # полуширина кости у сустава
            near = [v for v in pa + pb if abs(dot(sub(v, joint), axis)) < 0.006]
            hw = max((abs(dot(sub(v, joint), lat)) for v in near), default=0.004)

            len_b = max(dot(sub(v, cb), axb) for v in pb) - min(dot(sub(v, cb), axb) for v in pb)
            reach = min(0.22 * len_b, 0.006)
            if k == 0:
                jname = "metacarpophalangeal"
            elif finger == "thumb" or k == 2:
                jname = "distal interphalangeal" if finger != "thumb" else "interphalangeal"
            else:
                jname = "proximal interphalangeal"

            joints.append({"name": f"{jname} joint of right {finger}", "finger": finger,
                           "proximal": chain[k], "distal": chain[k + 1],
                           "position": list(joint), "axis": list(axis), "lateral": list(lat)})

            for sign, side in ((1, "radial"), (-1, "ulnar")):
                off = mul(lat, sign * (hw + 0.0006))
                p0 = add(sub(joint, mul(axa, reach)), off)
                p1 = add(add(joint, mul(axb, reach)), off)
                width = 0.0028 if k == 0 else 0.0022
                pos, nrm, idx = box_mesh(p0, p1, lat, width, 0.0008)
                name = f"{side} collateral ligament of {jname} joint of right {finger}"
                parts.append(Part(name.capitalize(), "ligaments", pos, nrm, idx, schematic=True))
    return parts, joints, info, radial


# ---------- скелет для движения (суставы) ----------
# Каждый сустав — точка вращения. Кость принадлежит суставу, который её двигает.
# Кожа, мышцы и связки получают «веса»: насколько каждая их точка следует за каждым суставом.
FINGER_KEY = {"thumb": "thumb", "index finger": "index", "middle finger": "middle",
              "ring finger": "ring", "little finger": "little"}
FINGER_RU = {"thumb": "большой", "index": "указательный", "middle": "средний", "ring": "безымянный", "little": "мизинец"}


def rotate(v, axis, ang):
    """Поворот вектора v вокруг оси axis на угол ang (формула Родрига)."""
    c, s = math.cos(ang), math.sin(ang)
    return add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)))


def axis_toward(direction, target):
    """Ось, поворот вокруг которой на +угол двигает direction в сторону target."""
    a = cross(direction, target)
    return norm(a)


def make_rig(info, joints, radial):
    Z = (0.0, 0.0, 1.0)  # ладонь смотрит на зрителя (+Z)
    joint_by_distal = {j["distal"].lower(): j for j in joints}

    def pos_of(distal_bone):
        return tuple(joint_by_distal[distal_bone.lower()]["position"])

    def tip_of(bone, from_point):
        c, a1, _, pts = info[bone.lower()]
        if dot(a1, sub(c, from_point)) < 0:
            a1 = mul(a1, -1)
        return add(c, mul(a1, max(dot(sub(v, c), a1) for v in pts)))

    # Запястье: центр вращения кисти примерно у головки головчатой кости
    cap = info["right capitate"][3]
    miny = min(v[1] for v in cap)
    wrist = centroid([v for v in cap if v[1] < miny + 0.004])
    mid_mcp = pos_of("proximal phalanx of right middle finger")
    H = norm(sub(mid_mcp, wrist))                    # направление кисти (к пальцам)
    R = norm(sub(radial, mul(H, dot(radial, H))))    # к большому пальцу
    ulnar = mul(R, -1)
    thumb_target = norm(add(ulnar, mul(Z, 0.5)))     # большой палец сгибается поперёк ладони

    rig = []

    def node(key, ru, parent, pos, bones, segs, flex=None, abd=None):
        rig.append({"name": key, "ru": ru, "parent": parent, "position": list(pos),
                    "flexAxis": list(flex) if flex else None, "abdAxis": list(abd) if abd else None,
                    "bones": bones, "segs": segs})
        return len(rig) - 1

    forearm = node("forearm", "предплечье", None, add(wrist, (0, -0.03, 0)),
                   ["right radius", "right ulna"], [(add(wrist, (0, -0.004, 0)), add(wrist, (0, -0.09, 0)))])

    wrist_segs = []
    wrist_bones = ["right scaphoid", "right lunate", "right triquetral", "right pisiform",
                   "right trapezium", "right trapezoid", "right capitate", "right hamate",
                   "right second metacarpal bone", "right third metacarpal bone",
                   "right fourth metacarpal bone", "right fifth metacarpal bone"]
    w = node("wrist", "запястье", forearm, wrist, wrist_bones, wrist_segs,
             flex=axis_toward(H, Z), abd=axis_toward(H, ulnar))

    for finger, chain in FINGERS:
        key = FINGER_KEY[finger]
        target = thumb_target if key == "thumb" else Z
        if key == "thumb":
            # запястно-пястный сустав большого пальца: основание I пястной кости
            mc = chain[0].lower()
            mcp_pos = pos_of(chain[1])
            c, a1, _, pts = info[mc]
            if dot(a1, sub(mcp_pos, c)) < 0:
                a1 = mul(a1, -1)
            cmc_pos = add(c, mul(a1, min(dot(sub(v, c), a1) for v in pts)))
            d = norm(sub(mcp_pos, cmc_pos))
            parent = node("thumb_cmc", "большой палец, запястно-пястный сустав", w, cmc_pos, [mc],
                          [(cmc_pos, mcp_pos)], flex=axis_toward(d, target), abd=axis_toward(d, Z))
            wrist_segs.append((wrist, cmc_pos))
            names = ["mcp", "ip"]
        else:
            parent = w
            wrist_segs.append((wrist, pos_of(chain[1])))
            names = ["mcp", "pip", "dip"]

        ru_joint = {"mcp": "пястно-фаланговый", "pip": "проксимальный межфаланговый",
                    "dip": "дистальный межфаланговый", "ip": "межфаланговый"}
        for k, jn in enumerate(names):
            bone = chain[k + 1]
            p = pos_of(bone)
            nxt = pos_of(chain[k + 2]) if k + 2 < len(chain) else tip_of(bone, p)
            d = norm(sub(nxt, p))
            abd = None
            if jn == "mcp" and key in ("index", "ring", "little"):
                abd = axis_toward(d, R if key == "index" else ulnar)  # +угол = развести от среднего
            parent = node(f"{key}_{jn}", f"{FINGER_RU[key]}, {ru_joint[jn]}", parent, p, [bone.lower()],
                          [(p, nxt)], flex=axis_toward(d, target), abd=abd)
    return rig


def seg_dist(v, a, b):
    ab = sub(b, a)
    t = dot(sub(v, a), ab) / max(dot(ab, ab), 1e-12)
    t = max(0.0, min(1.0, t))
    return length(sub(v, add(a, mul(ab, t))))


def skin_weights(part, rig, sigma=0.0015):
    """Каждой вершине: ближайший сустав и его сосед по цепочке, веса плавно делятся у сустава."""
    n = len(rig)
    neighbors = [set() for _ in range(n)]
    for i, r in enumerate(rig):
        if r["parent"] is not None:
            neighbors[i].add(r["parent"])
            neighbors[r["parent"]].add(i)
    js, ws = [], []
    for v in part.positions:
        d = [min(seg_dist(v, a, b) for a, b in r["segs"]) for r in rig]
        s = min(range(n), key=lambda i: d[i])
        t = min(neighbors[s], key=lambda i: d[i])
        wt = math.exp(-(d[t] - d[s]) / sigma)
        if wt < 0.01:
            js.append((s, 0, 0, 0))
            ws.append((1.0, 0.0, 0.0, 0.0))
        else:
            js.append((s, t, 0, 0))
            ws.append((1 / (1 + wt), wt / (1 + wt), 0.0, 0.0))
    part.joints, part.weights = js, ws


def bind_parts(parts, rig):
    owner = {b: i for i, r in enumerate(rig) for b in r["bones"]}
    for p in parts:
        key = p.name.lower()
        if p.layer == "bones" and key in owner:
            # кость двигается целиком вместе со своим суставом
            p.joints = [(owner[key], 0, 0, 0)] * len(p.positions)
            p.weights = [(1.0, 0.0, 0.0, 0.0)] * len(p.positions)
        else:
            skin_weights(p, rig)


# ---------- запись GLB ----------
def write_glb(out_path, parts, scene_extras, rig):
    layers = ["bones", "ligaments", "muscles", "skin"]
    bin_chunks, buffer_views, accessors, meshes, nodes = [], [], [], [], []
    offset = 0

    def push(data, target):
        nonlocal offset
        pad = (-len(data)) % 4
        bin_chunks.append(data + b"\x00" * pad)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            bv["target"] = target
        buffer_views.append(bv)
        offset += len(data) + pad
        return len(buffer_views) - 1

    layer_children = {l: [] for l in layers}
    for p in parts:
        pos = b"".join(struct.pack("<3f", *v) for v in p.positions)
        nrm = b"".join(struct.pack("<3f", *v) for v in p.normals)
        idx = struct.pack(f"<{len(p.indices)}I", *p.indices)
        jnt = b"".join(struct.pack("<4H", *j) for j in p.joints)
        wgt = b"".join(struct.pack("<4f", *w) for w in p.weights)
        bv_p, bv_n, bv_i = push(pos, 34962), push(nrm, 34962), push(idx, 34963)
        bv_j, bv_w = push(jnt, 34962), push(wgt, 34962)
        mins = [min(v[i] for v in p.positions) for i in range(3)]
        maxs = [max(v[i] for v in p.positions) for i in range(3)]
        accessors += [
            {"bufferView": bv_p, "componentType": 5126, "count": len(p.positions), "type": "VEC3", "min": mins, "max": maxs},
            {"bufferView": bv_n, "componentType": 5126, "count": len(p.normals), "type": "VEC3"},
            {"bufferView": bv_i, "componentType": 5125, "count": len(p.indices), "type": "SCALAR"},
            {"bufferView": bv_j, "componentType": 5123, "count": len(p.joints), "type": "VEC4"},
            {"bufferView": bv_w, "componentType": 5126, "count": len(p.weights), "type": "VEC4"},
        ]
        a = len(accessors)
        meshes.append({"name": p.name, "primitives": [{
            "attributes": {"POSITION": a - 5, "NORMAL": a - 4, "JOINTS_0": a - 2, "WEIGHTS_0": a - 1},
            "indices": a - 3}]})
        nodes.append({"name": p.name, "mesh": len(meshes) - 1, "skin": 0,
                      "extras": {"layer": p.layer, "schematic": p.schematic}})
        layer_children[p.layer].append(len(nodes) - 1)

    root_nodes = []
    for l in layers:
        nodes.append({"name": l, "children": layer_children[l], "extras": {"layerGroup": l}})
        root_nodes.append(len(nodes) - 1)

    # Суставы: узлы-«кости анимации», вложенные друг в друга (запястье -> пальцы)
    first_joint = len(nodes)
    for r in rig:
        parent_pos = rig[r["parent"]]["position"] if r["parent"] is not None else [0, 0, 0]
        nodes.append({"name": "joint_" + r["name"],
                      "translation": [r["position"][i] - parent_pos[i] for i in range(3)]})
    for i, r in enumerate(rig):
        if r["parent"] is not None:
            nodes[first_joint + r["parent"]].setdefault("children", []).append(first_joint + i)
        else:
            root_nodes.append(first_joint + i)
    ibm = b"".join(struct.pack("<16f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
                               -r["position"][0], -r["position"][1], -r["position"][2], 1) for r in rig)
    accessors.append({"bufferView": push(ibm, None), "componentType": 5126, "count": len(rig), "type": "MAT4"})
    skins = [{"name": "hand_rig", "joints": [first_joint + i for i in range(len(rig))],
              "inverseBindMatrices": len(accessors) - 1, "skeleton": first_joint}]

    doc = {
        "asset": {"version": "2.0", "generator": "tools/build_hand.py",
                  "copyright": "BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"},
        "scene": 0,
        "scenes": [{"name": "Right hand", "nodes": root_nodes, "extras": scene_extras}],
        "nodes": nodes, "meshes": meshes, "skins": skins, "accessors": accessors,
        "bufferViews": buffer_views, "buffers": [{"byteLength": offset}],
    }
    js = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    js += b" " * ((-len(js)) % 4)
    binary = b"".join(bin_chunks)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(out_path, "wb") as fh:
        fh.write(struct.pack("<4sII", b"glTF", 2, total))
        fh.write(struct.pack("<I4s", len(js), b"JSON") + js)
        fh.write(struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


# ---------- главное ----------
def main(obj_dir, table_path, out_path):
    obj_dir = Path(obj_dir)
    # какой файл к какому слою относится
    layer_of = {}
    with open(table_path, encoding="utf-8", errors="replace") as fh:
        next(fh)
        for line in fh:
            cols = line.rstrip("\n").split("\t")
            if len(cols) >= 3 and cols[0] in CONCEPT_LAYER:
                layer_of.setdefault(cols[2], CONCEPT_LAYER[cols[0]])

    raw = {}
    for fj, layer in layer_of.items():
        p = obj_dir / f"{fj}.obj"
        if p.exists():
            raw[fj] = (layer,) + read_obj(p)

    # 1. кости кисти -> граница области
    hand_ids = [fj for fj, (l, n, *_r) in raw.items() if l == "bones" and RIGHT.search(n) and HAND_PARTS.search(n)]
    carpal = re.compile(r"scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate", re.I)
    all_v = [v for fj in hand_ids for v in raw[fj][2]]
    lo = [min(v[i] for v in all_v) for i in range(3)]
    hi = [max(v[i] for v in all_v) for i in range(3)]
    carpal_top = max(v[2] for fj in hand_ids if carpal.search(raw[fj][1]) for v in raw[fj][2])
    z_cut = carpal_top + WRIST_ABOVE_CARPALS_MM
    m = BOX_MARGIN_MM
    box_lo = (lo[0] - m, lo[1] - m, lo[2] - 12)
    box_hi = (hi[0] + m, hi[1] + m, z_cut)

    def inside(v):
        return all(box_lo[i] <= v[i] <= box_hi[i] for i in range(3))

    parts = []
    for fj, (layer, name, verts, norms, tris) in sorted(raw.items(), key=lambda kv: kv[1][1]):
        if layer == "bones":
            if LEFT.search(name):
                continue
            if fj in hand_ids:
                part = build_part(name, layer, verts, norms, tris)
            elif FOREARM_BONES.search(name):
                part = build_part(name, layer, verts, norms, tris,
                                  keep_tri=lambda t, V=verts: all(inside(V[vi]) for vi, _ in t))
            else:
                continue
        else:
            # быстрый отсев: если ни одна вершина не в области, пропускаем
            if not any(inside(v) for v in verts[::7]) and not any(inside(v) for v in verts):
                continue
            part = build_part(name, layer, verts, norms, tris,
                              keep_tri=lambda t, V=verts: all(inside(V[vi]) for vi, _ in t))
        if part:
            # В BodyParts3D у некоторых мышц перепутаны right/left в названии.
            # Мы берём только то, что лежит у правой кисти, поэтому исправляем название.
            part.name = re.sub(r"\bleft\b", "right", re.sub(r"\bLeft\b", "Right", part.name))
            parts.append(part)

    # Части с одинаковым названием (например, две головки одной мышцы) объединяем в одну
    merged = {}
    for p in parts:
        key = (p.layer, p.name.lower())
        if key not in merged:
            merged[key] = p
        else:
            q = merged[key]
            base = len(q.positions)
            q.positions += p.positions
            q.normals += p.normals
            q.indices += [i + base for i in p.indices]
    parts = list(merged.values())

    # 2. центрируем по костям кисти
    hand_parts = [p for p in parts if p.layer == "bones" and HAND_PARTS.search(p.name)]
    hv = [v for p in hand_parts for v in p.positions]
    c = tuple((min(v[i] for v in hv) + max(v[i] for v in hv)) / 2 for i in range(3))
    for p in parts:
        p.positions = [sub(v, c) for v in p.positions]

    # 3. схематичные связки
    bones_by_name = {p.name.lower(): p for p in hand_parts}
    ligs, joints, info, radial = make_ligaments(bones_by_name)
    parts += ligs

    # 4. суставы и веса для движения
    rig = make_rig(info, joints, radial)
    bind_parts(parts, rig)
    rig_public = [{k: r[k] for k in ("name", "ru", "parent", "position", "flexAxis", "abdAxis")} for r in rig]

    write_glb(out_path, parts, {"rig": rig_public, "note": "Collateral ligaments are schematic (generated)."}, rig)

    by_layer = {}
    for p in parts:
        by_layer.setdefault(p.layer, []).append(p)
    for l, ps in by_layer.items():
        tris = sum(len(p.indices) // 3 for p in ps)
        print(f"{l}: {len(ps)} parts, {tris} triangles")
    print("rig joints:", [r["name"] for r in rig])
    # сколько вершин каждый сустав «держит» (проверка весов)
    counts = [0] * len(rig)
    for p in parts:
        for j, w in zip(p.joints, p.weights):
            counts[j[0]] += 1
    print("vertices per joint:", dict(zip([r["name"] for r in rig], counts)))
    print("wrote", out_path, round(Path(out_path).stat().st_size / 1e6, 2), "MB")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    main(*sys.argv[1:])
