// Geometry utilities for polygon nesting
export type Point = { x: number; y: number };
export type Polygon = Point[]; // closed: last != first

export interface PartGeometry {
  outer: Polygon;
  holes: Polygon[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
  perimeter: number;
  centroid: Point;
  width: number;
  height: number;
  signature: string;
}

export function polygonArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function polygonPerimeter(poly: Polygon): number {
  let p = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

export function bbox(poly: Polygon) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function centroid(poly: Polygon): Point {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const b = bbox(poly);
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(pt: Point, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonContains(outer: Polygon, inner: Polygon): boolean {
  for (const p of inner) if (!pointInPolygon(p, outer)) return false;
  return true;
}

export function rotatePolygon(poly: Polygon, deg: number, origin: Point = { x: 0, y: 0 }): Polygon {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return poly.map((p) => ({
    x: origin.x + (p.x - origin.x) * cos - (p.y - origin.y) * sin,
    y: origin.y + (p.x - origin.x) * sin + (p.y - origin.y) * cos,
  }));
}

export function translatePolygon(poly: Polygon, dx: number, dy: number): Polygon {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function mirrorPolygon(poly: Polygon): Polygon {
  return poly.map((p) => ({ x: -p.x, y: p.y }));
}

// Segment intersection
function segIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

export function polygonsIntersect(a: Polygon, b: Polygon): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (segIntersect(a1, a2, b1, b2)) return true;
    }
  }
  if (pointInPolygon(a[0], b)) return true;
  if (pointInPolygon(b[0], a)) return true;
  return false;
}

export function bboxOverlap(a: PartGeometry["bbox"], b: PartGeometry["bbox"], gap = 0): boolean {
  return !(a.maxX + gap < b.minX || a.minX > b.maxX + gap || a.maxY + gap < b.minY || a.minY > b.maxY + gap);
}

// Inflate polygon outward by `d` (approximate, vertex normal expansion).
export function inflatePolygon(poly: Polygon, d: number): Polygon {
  if (d <= 0) return poly;
  const c = centroid(poly);
  return poly.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * d, y: p.y + (dy / len) * d };
  });
}

export function buildGeometry(outer: Polygon, holes: Polygon[] = []): PartGeometry {
  const b = bbox(outer);
  const area = polygonArea(outer) - holes.reduce((s, h) => s + polygonArea(h), 0);
  const perimeter = polygonPerimeter(outer);
  const c = centroid(outer);
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;
  // signature: rounded area / perimeter / sorted edge lengths
  const edges: number[] = [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], q = outer[(i + 1) % outer.length];
    edges.push(Math.round(Math.hypot(q.x - a.x, q.y - a.y)));
  }
  edges.sort((a, b) => a - b);
  const signature = `${Math.round(area)}|${Math.round(perimeter)}|${edges.join(",")}`;
  return { outer, holes, bbox: b, area, perimeter, centroid: c, width, height, signature };
}

export function normalizeToOrigin(poly: Polygon): Polygon {
  const b = bbox(poly);
  return translatePolygon(poly, -b.minX, -b.minY);
}