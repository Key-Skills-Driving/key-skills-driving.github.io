"""Download the school's map area from OpenStreetMap (Overpass API) for build.py.

One request per 0.1-degree cell, one at a time, skipping cells already saved, with backoff when the
free server is busy (it often is: expect 30-60 s a cell and some retries). Raw cells are big (up to
~7 MB) and stay out of git in tools/route-spots/.cache.

    python -I tools/route-spots/fetch.py            # the whole area below
    python -I tools/route-spots/fetch.py --fresh    # download everything again (say, once a season)

To cover more of the valley, widen AREA, run this, then build.py.
"""
import json, os, sys, time, urllib.parse, urllib.request

# south, west, north, east: Phoenix and Tempe down to Sun Lakes, west Chandler/Laveen to Queen Creek.
AREA = (33.10, -112.30, 33.60, -111.50)
CELL = 0.1
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
UA = "KSDS-route-maker/1.0 (+https://key-skills-driving.github.io)"
ROADS = ("motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|"
         "tertiary|tertiary_link|unclassified|residential|living_street")


def query(s, w, n, e):
    return f"""[out:json][timeout:300][bbox:{s},{w},{n},{e}];
way["highway"~"^({ROADS})$"];
out body geom qt;
node["highway"~"^(traffic_signals|stop|mini_roundabout)$"]; out qt;
node["railway"="level_crossing"]->.lc; .lc out qt;
way(bn.lc)["railway"]; out body qt;
nwr["amenity"="school"]; out tags center qt;
nwr["amenity"="parking"]; out tags center bb qt;
way["highway"="service"]["service"="parking_aisle"]; out ids center qt;
"""


def fetch(s, w, n, e, path):
    body = urllib.parse.urlencode({"data": query(s, w, n, e)}).encode()
    for attempt in range(7):
        started = time.time()
        try:
            req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=body, headers={"User-Agent": UA})
            data = urllib.request.urlopen(req, timeout=360).read()
            json.loads(data)  # only keep complete answers
            with open(path, "wb") as fh:
                fh.write(data)
            print(f"{os.path.basename(path)}: {len(data) / 1e6:.1f} MB in {time.time() - started:.0f}s", flush=True)
            return True
        except Exception as err:  # busy server, timeout, cut-off answer
            wait = 20 * 2 ** attempt
            print(f"{os.path.basename(path)} try {attempt + 1} failed ({err}); waiting {wait}s", flush=True)
            time.sleep(wait)
    return False


def main():
    os.makedirs(CACHE, exist_ok=True)
    fresh = "--fresh" in sys.argv
    s0, w0, n0, e0 = AREA
    rows = round((n0 - s0) / CELL)
    cols = round((e0 - w0) / CELL)
    failed = []
    # Nearest the office (6909 W Ray Rd) first, so the cells that matter most arrive first.
    cells = sorted(((round(s0 + r * CELL, 2), round(w0 + c * CELL, 2)) for r in range(rows) for c in range(cols)),
                   key=lambda sw: (sw[0] + CELL / 2 - 33.319) ** 2 + (sw[1] + CELL / 2 + 111.962) ** 2)
    for s, w in cells:
        path = os.path.join(CACHE, f"c_{s:.2f}_{w:.2f}.json")
        if os.path.exists(path) and not fresh:
            continue
        if not fetch(s, w, round(s + CELL, 2), round(w + CELL, 2), path):
            failed.append(path)
        time.sleep(5)  # be gentle with a free, shared server
    print("done" if not failed else f"these cells failed, run again to retry: {failed}")


if __name__ == "__main__":
    main()
