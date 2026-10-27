"""Turn downloaded OpenStreetMap cells into the practice spots the Routes tab uses.

Reads every raw cell that fetch.py saved (default: tools/route-spots/.cache), works out the spots across
all of them at once (so intersections on a cell edge come out whole), and writes one small JSON file per
0.1-degree cell to docs/route-spots/, plus an index.json the app reads first.

    python -I tools/route-spots/build.py [cache_dir]

Each spot is a short array so the files stay small. Every via point sits exactly on the road it belongs
to, so the router snaps to the right carriageway:
  lt  left at a light       [lat, lon, approachLat, approachLon, exitLat, exitLon, fromName, toName]
  ul  unprotected left      same as lt (no signal within 60 m)
  rb  roundabout            [lat, lon, approachLat, approachLon, entryName, ringName]
  sz  school zone           [lat, lon, schoolName, roadName]       (lat/lon on the street in front)
  ml  multi-lane stretch    [aLat, aLon, bLat, bLon, roadName, lanesEachWay, meters]
  fw  freeway merge         [lat, lon, freewayName, fromName]       (lat/lon on the on-ramp)
  rr  railroad crossing     [lat, lon, roadName, kind]              (kind: rail or light)
  qs  quiet street          [lat, lon, streetName]
  pl  parking lot           [lat, lon, lotName, roadName]           (lat/lon on a parking aisle)
4-way stops are left out on purpose: almost none are tagged in this area, and guessing from stop signs
picked up parking-lot exits.

It also writes docs/route-spots/streets/<cell>.json, where each pair of named streets meets, for test routes an
admin types in as a list of turns: {"n": [street names], "j": [[nameIndexA, nameIndexB, lat, lon], ...]}.
"""
import glob, json, math, os, random, sys
from collections import defaultdict
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "tools", "route-spots", ".cache")
OUT = os.path.join(ROOT, "docs", "route-spots")
CELL = 0.1
random.seed(20261027)  # same input, same output

RANK = {"motorway": 7, "trunk": 6, "primary": 5, "secondary": 4, "tertiary": 3, "unclassified": 2, "residential": 1, "living_street": 1}
NO_ACCESS = {"private", "no"}


def dist(a, b):
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))


def bearing(a, b):
    return math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) % 360


def turn_angle(h_in, h_out):
    """-90 is a left, +90 a right, 0 straight on."""
    return (h_out - h_in + 180) % 360 - 180


def r5(x):
    return round(x, 5)


SUFFIX = {"Street": "St", "Road": "Rd", "Avenue": "Ave", "Boulevard": "Blvd", "Drive": "Dr", "Parkway": "Pkwy",
          "Lane": "Ln", "Place": "Pl", "Court": "Ct", "Circle": "Cir", "Way": "Way", "Trail": "Trl", "Highway": "Hwy",
          "Freeway": "Fwy", "Expressway": "Expy", "Terrace": "Ter"}


def short(name):
    """How instructors say it: "East Chandler Boulevard" -> "Chandler Blvd"."""
    words = name.split()
    if len(words) > 1 and words[0] in ("North", "South", "East", "West", "N", "S", "E", "W"):
        words = words[1:]
    if len(words) > 1 and words[-1] in SUFFIX:
        words[-1] = SUFFIX[words[-1]]
    return " ".join(words)


def freeway(tags):
    """Local names: AZ 202 is Loop 202, AZ 51 is SR 51, I 10 is I-10."""
    ref = (tags.get("ref") or "").split(";")[0].strip()
    if ref.startswith("I "):
        return "I-" + ref[2:]
    if ref.startswith(("AZ ", "SR ")):
        num = ref.split()[1]
        return f"Loop {num}" if num in ("101", "202", "303") or "Loop" in ref else f"SR {num}"
    return ref or short(tags.get("name", ""))


# ---------- load and merge every cell ----------

ways, nodes, rails, schools, parking, aisles = {}, {}, {}, {}, {}, {}
files = sorted(glob.glob(os.path.join(CACHE, "c_*.json")))
if not files:
    sys.exit(f"No raw cells in {CACHE}. Run fetch.py first.")
for f in files:
    for e in json.load(open(f, encoding="utf-8"))["elements"]:
        t = e.get("tags", {})
        if e["type"] == "way" and "highway" in t and "geometry" in e:
            ways[e["id"]] = e
        elif e["type"] == "node" and ("highway" in t or "railway" in t):
            nodes[e["id"]] = e
        elif e["type"] == "way" and "railway" in t:
            rails[e["id"]] = e
        elif t.get("amenity") == "school":
            schools[(e["type"], e["id"])] = e
        elif t.get("amenity") == "parking":
            parking[(e["type"], e["id"])] = e
        elif e["type"] == "way" and not t and "center" in e:
            aisles[e["id"]] = e
print(f"{len(files)} cells: {len(ways)} roads, {len(nodes)} tagged nodes, {len(schools)} schools, {len(parking)} lots, {len(aisles)} aisles")

# ---------- road graph ----------


class Road:
    __slots__ = ("id", "hw", "rank", "link", "name", "oneway", "pts", "ids", "lanes", "ring", "public")


roads = {}
for w in ways.values():
    t = w["tags"]
    hw = t["highway"]
    base = hw.replace("_link", "")
    r = Road()
    r.id, r.hw, r.rank, r.link = w["id"], hw, RANK.get(base, 0), hw.endswith("_link")
    r.name = short(t.get("name") or "") or (freeway(t) if base == "motorway" else t.get("ref") or "")
    r.ring = t.get("junction") in ("roundabout", "circular")
    ow = t.get("oneway", "")
    r.oneway = 1 if ow in ("yes", "true", "1") else -1 if ow == "-1" else 0
    if r.oneway == 0 and (r.ring or base == "motorway") and ow != "no":
        r.oneway = 1
    r.pts = [(g["lat"], g["lon"]) for g in w["geometry"]]
    r.ids = w["nodes"]
    try:
        r.lanes = int(str(t.get("lanes", "0")).split(";")[0])
    except ValueError:
        r.lanes = 0
    r.public = t.get("access") not in NO_ACCESS and t.get("motor_vehicle") not in NO_ACCESS
    roads[r.id] = r

coord = {}
on_node = defaultdict(list)  # node id -> [(road, index)]
for r in roads.values():
    for i, (nid, p) in enumerate(zip(r.ids, r.pts)):
        coord[nid] = p
        on_node[nid].append((r, i))


def along(r, i, d, meters):
    """Walk `meters` from point i of road r in direction d (+1/-1). Stops early at the road's end or at the
    next junction (less 10 m), so the point stays on this stretch. Returns (point, walked) or None."""
    walked, j, p = 0.0, i, r.pts[i]
    while 0 <= j + d < len(r.pts):
        q = r.pts[j + d]
        seg = dist(p, q)
        junction = len(on_node[r.ids[j + d]]) > 1
        limit = meters if not junction else min(meters, walked + seg - 10)
        if walked + seg >= limit:
            if limit <= walked:
                return (p, walked) if walked > 0 else None
            f = (limit - walked) / seg
            return ((p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f), limit)
        walked += seg
        p, j = q, j + d
        if junction:
            return (p, walked)
    return (p, walked) if walked > 0 else None


def arms_at(nid, cluster_ids):
    """The road stretches leaving a junction node, skipping ones that lead to another node of the same cluster."""
    out = []
    for r, i in on_node[nid]:
        if not r.public:
            continue
        for d in (1, -1):
            k = i + d
            if not 0 <= k < len(r.pts):
                continue
            if r.ids[k] in cluster_ids:
                continue
            inbound = r.oneway in (0, -d)   # traffic can drive toward the junction along this arm
            outbound = r.oneway in (0, d)   # traffic can drive away from the junction along this arm
            out.append({"road": r, "i": i, "d": d, "brg": bearing(r.pts[i], r.pts[k]), "in": inbound, "out": outbound})
    return out


def clusters(seed_ids, radius):
    """Group nearby junction nodes (dual carriageways cross at 2-4 nodes)."""
    seed_ids = list(seed_ids)
    grid = defaultdict(list)
    for nid in seed_ids:
        p = coord[nid]
        grid[(int(p[0] / 0.0005), int(p[1] / 0.0005))].append(nid)
    parent = {n: n for n in seed_ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for nid in seed_ids:
        p = coord[nid]
        gx, gy = int(p[0] / 0.0005), int(p[1] / 0.0005)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for m in grid[(gx + dx, gy + dy)]:
                    if m != nid and dist(p, coord[m]) < radius:
                        parent[find(m)] = find(nid)
    groups = defaultdict(list)
    for n in seed_ids:
        groups[find(n)].append(n)
    return list(groups.values())


def center(ids):
    return (sum(coord[n][0] for n in ids) / len(ids), sum(coord[n][1] for n in ids) / len(ids))


def left_turns(ids, approach_ok, exit_ok, approach_m=70, exit_m=70):
    """Every legal-looking left turn through a junction cluster: [lat, lon, aLat, aLon, eLat, eLon, from, to]."""
    cid = set(ids)
    arms = [a for n in ids for a in arms_at(n, cid)]
    c = center(ids)
    found = []
    for a in arms:
        if not a["in"] or not approach_ok(a["road"]):
            continue
        h_in = (a["brg"] + 180) % 360
        for b in arms:
            if b is a or not b["out"] or not exit_ok(b["road"]) or b["road"] is a["road"]:
                continue
            if a["road"].name and a["road"].name == b["road"].name:
                continue
            if not -140 <= turn_angle(h_in, b["brg"]) <= -40:
                continue
            ap = along(a["road"], a["i"], a["d"], approach_m)
            ex = along(b["road"], b["i"], b["d"], exit_m)
            if not ap or not ex or ap[1] < 20 or ex[1] < 20:
                continue
            found.append([r5(c[0]), r5(c[1]), r5(ap[0][0]), r5(ap[0][1]), r5(ex[0][0]), r5(ex[0][1]), a["road"].name, b["road"].name])
    return found


# ---------- signals: lefts at a light ----------

signal_ids = [n for n, e in nodes.items() if e["tags"].get("highway") == "traffic_signals"]
signal_pts = [(e["lat"], e["lon"]) for n, e in nodes.items() if e["tags"].get("highway") == "traffic_signals"]
junction_ids = [n for n, lst in on_node.items() if len({r.id for r, _ in lst}) > 1 and any(r.public for r, _ in lst)]

sig_grid = defaultdict(list)
for p in signal_pts:
    sig_grid[(int(p[0] / 0.001), int(p[1] / 0.001))].append(p)


def near_signal(p, radius):
    gx, gy = int(p[0] / 0.001), int(p[1] / 0.001)
    return any(dist(p, q) < radius for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in sig_grid[(gx + dx, gy + dy)])


major = lambda r: r.rank >= 3 and not r.link
road_ok = lambda r: 1 <= r.rank <= 6 and not r.ring
spots = defaultdict(list)

sig_junctions = [n for n in junction_ids if near_signal(coord[n], 35) and any(major(r) for r, _ in on_node[n])]
for group in clusters(sig_junctions, 45):
    turns = left_turns(group, road_ok, road_ok)
    random.shuffle(turns)
    spots["lt"].extend(turns[:2])

# ---------- unprotected lefts: side street and busy road, no light ----------

busy = lambda r: r.rank >= 4 and not r.link and not r.ring
side = lambda r: 1 <= r.rank <= 3 and not r.link and not r.ring
ul_junctions = [n for n in junction_ids
                if not near_signal(coord[n], 60)
                and any(busy(r) for r, _ in on_node[n]) and any(side(r) for r, _ in on_node[n])]
for group in clusters(ul_junctions, 40):
    # Waiting at the side street to turn left onto the busy road, or turning left off it across oncoming
    # traffic. One per junction keeps the files small; there are hundreds of these in every cell.
    turns = left_turns(group, side, busy) + left_turns(group, busy, side)
    if turns:
        spots["ul"].append(random.choice(turns))

# ---------- roundabouts ----------

ring_roads = [r for r in roads.values() if r.ring and r.public and r.rank >= 1]
ring_nodes = defaultdict(set)
for r in ring_roads:
    for n in r.ids:
        ring_nodes[n].add(r.id)
# join ring segments that share nodes into one roundabout
seen = set()
for r in ring_roads:
    if r.id in seen:
        continue
    stack, members = [r], []
    seen.add(r.id)
    while stack:
        x = stack.pop()
        members.append(x)
        for n in x.ids:
            for rid in ring_nodes[n]:
                if rid not in seen:
                    seen.add(rid)
                    stack.append(roads[rid])
    ids = {n for m in members for n in m.ids}
    pts = [coord[n] for n in ids]
    c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    ring_name = next((m.name for m in members if m.name), "")
    entries = []
    for n in ids:
        for a in arms_at(n, ids):
            if a["road"].ring or not a["in"] or a["road"].rank < 1:
                continue
            ap = along(a["road"], a["i"], a["d"], 45)
            if ap and ap[1] >= 15:
                entries.append([r5(c[0]), r5(c[1]), r5(ap[0][0]), r5(ap[0][1]), a["road"].name, ring_name])
    random.shuffle(entries)
    spots["rb"].extend(entries[:2])

# ---------- railroad crossings ----------

rail_kind = {}
for rw in rails.values():
    kind = rw["tags"].get("railway")
    if kind in ("rail", "light_rail", "tram"):
        for n in rw.get("nodes", []):
            if rail_kind.get(n) != "rail":
                rail_kind[n] = "rail" if kind == "rail" else "light"
for n, e in nodes.items():
    if e["tags"].get("railway") != "level_crossing" or n not in rail_kind:
        continue
    on = [r for r, _ in on_node.get(n, []) if r.public and 1 <= r.rank <= 6]
    p = (e["lat"], e["lon"])
    # both halves of a divided road cross the same tracks; keep one
    if on and not any(dist(p, (s[0], s[1])) < 80 for s in spots["rr"]):
        spots["rr"].append([r5(p[0]), r5(p[1]), on[0].name, rail_kind[n]])

# ---------- nearest-street helper for schools and lots ----------

seg_grid = defaultdict(list)
for r in roads.values():
    if not r.public or not 1 <= r.rank <= 5 or r.link or r.ring:
        continue
    for i in range(len(r.pts) - 1):
        p = r.pts[i]
        seg_grid[(int(p[0] / 0.002), int(p[1] / 0.002))].append((r, i))


def nearest_street(p, max_m, ok=lambda r: True):
    best = None
    gx, gy = int(p[0] / 0.002), int(p[1] / 0.002)
    for dx in (-2, -1, 0, 1, 2):
        for dy in (-2, -1, 0, 1, 2):
            for r, i in seg_grid[(gx + dx, gy + dy)]:
                if not ok(r):
                    continue
                a, b = r.pts[i], r.pts[i + 1]
                kx = 111320 * math.cos(math.radians(p[0]))
                ax, ay, bx, by, px, py = a[1] * kx, a[0] * 111320, b[1] * kx, b[0] * 111320, p[1] * kx, p[0] * 111320
                vx, vy = bx - ax, by - ay
                L = vx * vx + vy * vy or 1e-9
                f = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L))
                q = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
                dd = dist(p, q)
                if dd <= max_m and (best is None or dd < best[0]):
                    best = (dd, q, r)
    return best


def place(e):
    if "lat" in e:
        return (e["lat"], e["lon"])
    if "center" in e:
        return (e["center"]["lat"], e["center"]["lon"])
    b = e.get("bounds")
    return ((b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2) if b else None


# ---------- school zones ----------

NOT_K12 = ("driving", "beauty", "barber", "massage", "cosmetology", "flight", "dance", "martial", "karate", "traffic",
           "college", "university", "institute of", "swim", "music", "art school", "cdl", "truck")
for e in schools.values():
    name = e["tags"].get("name", "")
    if not name or any(w in name.lower() for w in NOT_K12):
        continue
    p = place(e)
    hit = p and nearest_street(p, 250, lambda r: r.rank <= 4)
    if hit:
        spots["sz"].append([r5(hit[1][0]), r5(hit[1][1]), name, hit[2].name])

# ---------- parking lots ----------

aisle_grid = defaultdict(list)
for a in aisles.values():
    c = (a["center"]["lat"], a["center"]["lon"])
    aisle_grid[(int(c[0] / 0.002), int(c[1] / 0.002))].append(c)
for e in parking.values():
    t = e["tags"]
    if t.get("access") in ("private", "no", "permit", "delivery") or t.get("parking") not in (None, "surface"):
        continue
    b = e.get("bounds")
    if not b:
        continue
    w_m = dist((b["minlat"], b["minlon"]), (b["minlat"], b["maxlon"]))
    h_m = dist((b["minlat"], b["minlon"]), (b["maxlat"], b["minlon"]))
    if w_m * h_m < 6000:
        continue
    c = place(e)
    inside = [q for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in aisle_grid[(int(c[0] / 0.002) + dx, int(c[1] / 0.002) + dy)]
              if b["minlat"] <= q[0] <= b["maxlat"] and b["minlon"] <= q[1] <= b["maxlon"]]
    if not inside:
        continue  # without a mapped aisle the router would snap to the street outside
    q = min(inside, key=lambda x: dist(x, c))
    hit = nearest_street(c, 400)
    spots["pl"].append([r5(q[0]), r5(q[1]), t.get("name", ""), hit[2].name if hit else ""])

# ---------- freeway on-ramps ----------

motorway_nodes = {n for r in roads.values() if r.hw == "motorway" for n in r.ids}
link_by_end = defaultdict(list)
for r in roads.values():
    if r.hw == "motorway_link" and r.oneway == 1:
        link_by_end[r.ids[-1]].append(r)
for r in roads.values():
    if r.hw != "motorway_link" or r.oneway != 1 or r.ids[-1] not in motorway_nodes or r.ids[0] in motorway_nodes:
        continue
    # walk back up the ramp to the street it starts from
    chain, cur = [r], r
    while not any(x.hw != "motorway_link" for x, _ in on_node[cur.ids[0]]) and len(chain) < 6:
        prev = [x for x in link_by_end[cur.ids[0]] if x not in chain and x.ids[0] not in motorway_nodes]
        if not prev:
            break
        cur = prev[0]
        chain.append(cur)
    start_streets = [x for x, _ in on_node[cur.ids[0]] if x.hw != "motorway_link" and x.rank < 7]
    if not start_streets:
        continue  # a ramp from another freeway, not from a street
    fwy = next((x for x, _ in on_node[r.ids[-1]] if x.hw == "motorway"), None)
    fwy_name = freeway(ways[fwy.id]["tags"]) if fwy else ""
    mid = r.pts[len(r.pts) // 2]
    spots["fw"].append([r5(mid[0]), r5(mid[1]), fwy_name, start_streets[0].name])

# ---------- multi-lane stretches ----------


def lanes_each_way(r):
    if r.oneway:
        return r.lanes
    return r.lanes // 2


ml_ok = lambda r: 3 <= r.rank <= 6 and not r.link and not r.ring and r.public and lanes_each_way(r) >= 2
next_by_start = defaultdict(list)  # (node, travel dir) chains of same-named multi-lane roads
for r in roads.values():
    if ml_ok(r):
        for d in ((1,) if r.oneway == 1 else (-1,) if r.oneway == -1 else (1, -1)):
            first = r.ids[0] if d == 1 else r.ids[-1]
            next_by_start[first].append((r, d))
used = set()
for r in roads.values():
    if not ml_ok(r) or not r.name:
        continue
    for d in ((1,) if r.oneway == 1 else (-1,) if r.oneway == -1 else (1, -1)):
        if (r.id, d) in used:
            continue
        # follow the same road in this direction for ~1.6 km
        pts, cur, cd, lanes = [], r, d, lanes_each_way(r)
        while cur and len(pts) < 2000:
            used.add((cur.id, cd))
            seq = cur.pts if cd == 1 else cur.pts[::-1]
            pts.extend(seq if not pts else seq[1:])
            lanes = min(lanes, lanes_each_way(cur))
            end = cur.ids[-1] if cd == 1 else cur.ids[0]
            nxt = [(x, xd) for x, xd in next_by_start[end] if x.name == r.name and (x.id, xd) not in used and x is not cur]
            cur, cd = nxt[0] if nxt else (None, None)
            total = sum(dist(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
            if total > 1700:
                break
        total = sum(dist(pts[k], pts[k + 1]) for k in range(len(pts) - 1)) if len(pts) > 1 else 0
        if total < 1000:
            continue
        # A just past the start, B at the far end
        acc, a_pt = 0.0, None
        for k in range(len(pts) - 1):
            acc += dist(pts[k], pts[k + 1])
            if a_pt is None and acc > 40:
                a_pt = pts[k + 1]
        b_pt = pts[-2] if len(pts) > 2 else pts[-1]
        spots["ml"].append([r5(a_pt[0]), r5(a_pt[1]), r5(b_pt[0]), r5(b_pt[1]), r.name, lanes, int(total)])

# ---------- quiet residential streets ----------

busy_pts = defaultdict(list)
for r in roads.values():
    if r.rank >= 4:
        for p in r.pts:
            busy_pts[(int(p[0] / 0.003), int(p[1] / 0.003))].append(p)


def far_from_busy(p, meters):
    gx, gy = int(p[0] / 0.003), int(p[1] / 0.003)
    return all(dist(p, q) >= meters for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in busy_pts[(gx + dx, gy + dy)])


taken = set()
for r in sorted(roads.values(), key=lambda x: x.id):
    if r.rank != 1 or r.oneway or not r.public or not r.name or r.ring:
        continue
    if len(on_node[r.ids[0]]) < 2 or len(on_node[r.ids[-1]]) < 2:
        continue  # dead ends would need a turnaround
    p = r.pts[len(r.pts) // 2]
    key = (int(p[0] / 0.006), int(p[1] / 0.006))  # one per ~600 m square
    if key in taken or not far_from_busy(p, 250):
        continue
    taken.add(key)
    spots["qs"].append([r5(p[0]), r5(p[1]), r.name])

# ---------- where named streets meet (for test routes typed in as a list of turns) ----------
# One point per pair of street names per crossing; a divided road's 2-4 crossing nodes are averaged.

crossings = defaultdict(list)  # (nameA, nameB) -> [points]
for nid, lst in on_node.items():
    names = sorted({r.name for r, _ in lst if r.public and r.name and 1 <= r.rank <= 6 and not r.link})
    if len(names) < 2:
        continue
    p = coord[nid]
    for i in range(len(names)):
        for k in range(i + 1, len(names)):
            crossings[(names[i], names[k])].append(p)
street_cells = defaultdict(list)
for pair, pts in crossings.items():
    groups = []
    for p in pts:
        for g in groups:
            if dist(g[0], p) < 70:
                g.append(p)
                break
        else:
            groups.append([p])
    for g in groups:
        c = (sum(q[0] for q in g) / len(g), sum(q[1] for q in g) / len(g))
        key = f"{math.floor(c[0] / CELL + 1e-9) * CELL:.2f}_{math.floor(c[1] / CELL + 1e-9) * CELL:.2f}"
        street_cells[key].append((pair[0], pair[1], r5(c[0]), r5(c[1])))

# ---------- write one file per cell ----------

os.makedirs(OUT, exist_ok=True)
for old in glob.glob(os.path.join(OUT, "*.json")):
    os.remove(old)
cells = defaultdict(lambda: defaultdict(list))
for kind, items in spots.items():
    for s in items:  # every kind starts with a lat, lon
        key = f"{math.floor(s[0] / CELL + 1e-9) * CELL:.2f}_{math.floor(s[1] / CELL + 1e-9) * CELL:.2f}"
        cells[key][kind].append(s)
covered = sorted({os.path.basename(f)[2:-5] for f in files})
os.makedirs(os.path.join(OUT, "streets"), exist_ok=True)
for old in glob.glob(os.path.join(OUT, "streets", "*.json")):
    os.remove(old)
for key in covered:
    with open(os.path.join(OUT, f"{key}.json"), "w", encoding="utf-8") as fh:
        json.dump(cells.get(key, {}), fh, ensure_ascii=False, separators=(",", ":"))
    # streets/<cell>.json: {"n": [street names], "j": [[nameIndexA, nameIndexB, lat, lon], ...]}
    names, index, rows = [], {}, []
    for a, b, la, lo in street_cells.get(key, []):
        for nm in (a, b):
            if nm not in index:
                index[nm] = len(names)
                names.append(nm)
        rows.append([index[a], index[b], la, lo])
    with open(os.path.join(OUT, "streets", f"{key}.json"), "w", encoding="utf-8") as fh:
        json.dump({"n": names, "j": rows}, fh, ensure_ascii=False, separators=(",", ":"))
with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
    json.dump({"v": 1, "built": date.today().isoformat(), "cell": CELL, "cells": covered}, fh, separators=(",", ":"))
print({k: len(v) for k, v in sorted(spots.items())})
size = sum(os.path.getsize(f) for f in glob.glob(os.path.join(OUT, "*.json")))
print(f"wrote {len(covered)} cells to {OUT}, {size / 1e6:.2f} MB")
