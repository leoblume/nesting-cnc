import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Polygon } from "./geometry";
import {
  buildGeometry,
  polygonArea,
  polygonContains,
  normalizeToOrigin,
  bbox,
  type PartGeometry,
} from "./geometry";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const PT_TO_MM = 25.4 / 72;
// Área mínima reduzida para capturar peças pequenas
const MIN_AREA_MM2 = 1;

export interface ParsedPart extends PartGeometry {
  id: string;
}

type Point = [number, number];

function mm(v: number) {
  return v * PT_TO_MM;
}

function bezierPoint(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const mt = 1 - t;
  const x =
    mt * mt * mt * p0[0] +
    3 * mt * mt * t * p1[0] +
    3 * mt * t * t * p2[0] +
    t * t * t * p3[0];

  const y =
    mt * mt * mt * p0[1] +
    3 * mt * mt * t * p1[1] +
    3 * mt * t * t * p2[1] +
    t * t * t * p3[1];

  return [x, y];
}

function discretizeBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  steps = 16,
): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    pts.push(bezierPoint(p0, p1, p2, p3, i / steps));
  }
  return pts;
}

function closeEnough(a: Point, b: Point, eps = 0.5) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function toPolygon(path: Point[]): Polygon | null {
  if (path.length < 3) return null;

  const first = path[0];
  const last = path[path.length - 1];

  if (!closeEnough(first, last)) {
    path = [...path, first];
  }

  const poly = path.map(([x, y]) => ({
    x: mm(x),
    y: mm(y),
  }));

  if (polygonArea(poly) < MIN_AREA_MM2) return null;

  return poly;
}

async function extractPolygonsFromPage(page: any): Promise<Polygon[]> {
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const polys: Polygon[] = [];

  let current: Point[] = [];
  let cursor: Point | null = null;
  // subpath support: accumulate multiple subpaths per compound path
  let subpaths: Point[][] = [];

  const flushCurrent = () => {
    if (current.length >= 3) {
      subpaths.push([...current]);
    }
    current = [];
    cursor = null;
  };

  const flushAll = () => {
    flushCurrent();
    for (const sp of subpaths) {
      const poly = toPolygon(sp);
      if (poly) polys.push(poly);
    }
    subpaths = [];
    current = [];
    cursor = null;
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    switch (fn) {
      case OPS.moveTo: {
        // moveTo starts a new subpath — flush current but keep subpaths
        flushCurrent();
        const x = args[0];
        const y = args[1];
        cursor = [x, y];
        current.push(cursor);
        break;
      }

      case OPS.lineTo: {
        if (!cursor) break;
        const p: Point = [args[0], args[1]];
        current.push(p);
        cursor = p;
        break;
      }

      case OPS.curveTo: {
        if (!cursor) break;
        const p1: Point = [args[0], args[1]];
        const p2: Point = [args[2], args[3]];
        const p3: Point = [args[4], args[5]];
        current.push(...discretizeBezier(cursor, p1, p2, p3, 16));
        cursor = p3;
        break;
      }

      case OPS.curveTo2: {
        if (!cursor) break;
        const p1 = cursor;
        const p2: Point = [args[0], args[1]];
        const p3: Point = [args[2], args[3]];
        current.push(...discretizeBezier(cursor, p1, p2, p3, 16));
        cursor = p3;
        break;
      }

      case OPS.curveTo3: {
        if (!cursor) break;
        const p1: Point = [args[0], args[1]];
        const p2: Point = [args[2], args[3]];
        current.push(...discretizeBezier(cursor, p1, p2, p2, 16));
        cursor = p2;
        break;
      }

      case OPS.closePath: {
        // close current subpath but don't flush all yet
        if (current.length >= 3) {
          subpaths.push([...current]);
        }
        current = [];
        cursor = null;
        break;
      }

      // fill/stroke operators signal end of a compound path
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.stroke: {
        flushAll();
        break;
      }

      // rectangle operator — very common in CAD exports
      case OPS.rectangle: {
        flushAll();
        const rx = args[0], ry = args[1], rw = args[2], rh = args[3];
        if (Math.abs(rw * rh) * PT_TO_MM * PT_TO_MM >= MIN_AREA_MM2) {
          const poly: Polygon = [
            { x: mm(rx),      y: mm(ry) },
            { x: mm(rx + rw), y: mm(ry) },
            { x: mm(rx + rw), y: mm(ry + rh) },
            { x: mm(rx),      y: mm(ry + rh) },
            { x: mm(rx),      y: mm(ry) },
          ];
          polys.push(poly);
        }
        break;
      }

      default:
        break;
    }
  }

  flushAll();

  return polys;
}

function buildParts(polys: Polygon[]): ParsedPart[] {
  const used = new Set<number>();
  const parts: ParsedPart[] = [];

  for (let i = 0; i < polys.length; i++) {
    if (used.has(i)) continue;

    const outer = polys[i];
    const holes: Polygon[] = [];

    for (let j = 0; j < polys.length; j++) {
      if (i === j || used.has(j)) continue;

      const inner = polys[j];

      if (polygonContains(outer, inner[0])) {
        holes.push(inner);
        used.add(j);
      }
    }

    const normalizedOuter = normalizeToOrigin(outer);
    const normalizedHoles = holes.map(normalizeToOrigin);

    const geom = buildGeometry(normalizedOuter, normalizedHoles);

    parts.push({
      ...geom,
      id: `part-${parts.length}`,
    });
  }

  return parts;
}

export async function parsePdf(buffer: ArrayBuffer): Promise<ParsedPart[]> {
  let pdf;

  try {
    pdf = await pdfjsLib.getDocument({
      data: buffer,
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise;
  } catch {
    throw new Error("PDF inválido, protegido ou não legível.");
  }

  const polys: Polygon[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    try {
      const pagePolys = await extractPolygonsFromPage(page);
      polys.push(...pagePolys);
    } catch (e) {
      console.warn(`Falha ao interpretar página ${pageNum}`, e);
    }
  }

  if (!polys.length) {
    throw new Error(
      "Nenhum vetor encontrado. Certifique-se que o PDF foi exportado com vetores (não rasterizado). Formatos aceitos: CAD (DXF→PDF), CorelDRAW, Illustrator, Inkscape.",
    );
  }

  return buildParts(polys);
}

export function groupParts(parts: ParsedPart[]) {
  const groups: Array<{
    key: string;
    quantity: number;
    width: number;
    height: number;
    area: number;
    parts: ParsedPart[];
  }> = [];

  for (const part of parts) {
    const b = bbox(part.outer);
    const key = `${Math.round(part.area)}-${Math.round(b.width)}-${Math.round(b.height)}`;

    const found = groups.find((g) => g.key === key);

    if (found) {
      found.quantity += 1;
      found.parts.push(part);
    } else {
      groups.push({
        key,
        quantity: 1,
        width: b.width,
        height: b.height,
        area: part.area,
        parts: [part],
      });
    }
  }

  return groups;
}
