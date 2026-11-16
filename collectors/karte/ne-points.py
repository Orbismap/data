#!/usr/bin/env python3
"""Liest einen Natural-Earth-Punkt-Shapefile (ohne Zusatzpakete) und schreibt GeoJSON-Zeilen.
Aufruf: ne-points.py <ordner-mit-shapefile> <layer> > out.geojsonseq
layer = places  : Hauptstädte und Millionenstädte (ne_10m_populated_places)
layer = regions : Inseln, Kaps ... (ne_10m_geography_regions_points)
layer = polys   : Gebirge, Wüsten, Becken ... (ne_10m_geography_regions_polys, jeweils ein Mittelpunkt)"""
import json, struct, sys
from pathlib import Path

def read_dbf(path):
    f = open(path, 'rb'); h = f.read(32)
    n, hl, rl = struct.unpack('<IHH', h[4:12])
    fields = []
    while True:
        d = f.read(32)
        if d[0] == 0x0D: break
        fields.append((d[:11].split(b'\0')[0].decode().lower(), d[16]))
    f.seek(hl)
    for _ in range(n):
        rec = f.read(rl)
        if rec[0:1] == b'*': yield None; continue
        pos, row = 1, {}
        for name, ln in fields:
            row[name] = rec[pos:pos + ln].decode('utf-8', 'replace').strip(); pos += ln
        yield row

def read_points(path):
    b = Path(path).read_bytes(); pos = 100
    while pos < len(b):
        ln = struct.unpack('>i', b[pos + 4:pos + 8])[0] * 2
        t = struct.unpack('<i', b[pos + 8:pos + 12])[0]
        yield struct.unpack('<2d', b[pos + 12:pos + 28]) if t == 1 else None
        pos += 8 + ln

def read_poly_centres(path):
    """Mittelpunkt des größten Außenrings jedes Polygons (Flächenschwerpunkt)."""
    b = Path(path).read_bytes(); pos = 100
    while pos < len(b):
        ln = struct.unpack('>i', b[pos + 4:pos + 8])[0] * 2
        t = struct.unpack('<i', b[pos + 8:pos + 12])[0]
        if t not in (5, 15, 25):
            yield None; pos += 8 + ln; continue
        base = pos + 12
        nparts, npts = struct.unpack('<2i', b[base + 32:base + 40])
        parts = list(struct.unpack(f'<{nparts}i', b[base + 40:base + 40 + 4 * nparts]))
        po = base + 40 + 4 * nparts
        pts = struct.unpack(f'<{2 * npts}d', b[po:po + 16 * npts])
        best = None
        for i, st in enumerate(parts):
            en = parts[i + 1] if i + 1 < nparts else npts
            ring = [(pts[2 * k], pts[2 * k + 1]) for k in range(st, en)]
            a = cx = cy = 0.0
            for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
                c = x0 * y1 - x1 * y0; a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
            if a and (best is None or abs(a) > abs(best[0])): best = (a, cx / (3 * a), cy / (3 * a))
        yield (best[1], best[2]) if best else None
        pos += 8 + ln

folder, layer = Path(sys.argv[1]), sys.argv[2]
stem = folder.name
out = []
reader = read_poly_centres if layer == 'polys' else read_points
for row, pt in zip(read_dbf(folder / f'{stem}.dbf'), reader(folder / f'{stem}.shp')):
    if row is None or pt is None: continue
    num = lambda k, d=0.0: float(row.get(k) or d)
    if layer == 'places':
        cap = row.get('adm0cap') == '1'
        pop = num('pop_max')
        if not cap and pop < 1_500_000: continue
        props = {'name': row.get('name_de') or row.get('name'), 'cap': 1 if cap else 0, 'pop': int(pop), 'rank': int(num('scalerank', 9))}
    elif layer == 'polys':
        props = {'name': row.get('name_de') or row.get('name'), 'cls': row.get('featurecla'), 'rank': int(num('scalerank', 9)), 'minz': num('min_label', 9)}
    else:
        props = {'name': row.get('name_de') or row.get('name'), 'cls': row.get('featurecla'), 'rank': int(num('scalerank', 9)), 'minz': num('min_zoom', 9)}
    if not props['name']: continue
    sys.stdout.write(json.dumps({'type': 'Feature', 'properties': props, 'geometry': {'type': 'Point', 'coordinates': [pt[0], pt[1]]}}, ensure_ascii=False) + '\n')
