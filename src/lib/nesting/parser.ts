import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Polygon } from "./geometry";
import {
  buildGeometry,
  polygonArea,
  pointInPolygon,
  normalizeToOrigin,
  bbox,
  type PartGeometry,
} from "./geometry";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const PT_TO_MM = 25.4 / 72;
const MIN_AREA_MM2 = 0.5; // limiar menor para capturar peças pequenas

export interface ParsedPart extends PartGeometry {
  id: string;
}

type Point = [number, number];

function mm(v: number) {
  return v * PT_TO_MM;
}

function bezierPoint(
  p0: Point, p1: Point, p2: Point, p3: Point, t: number,
): Point {
  const mt = 1 - t;
  return [
    mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
    mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
  ];
}

function discretizeBezier(
  p0: Point, p1: Point, p2: Point, p3: Point, steps = 16,
): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) pts.push(bezierPoint(p0, p1, p2, p3, i / steps));
  return pts;
}

function closeEnough(a: Point, b: Point, eps = 0.5) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function toPolygon(path: Point[]): Polygon | null {
  if (path.length < 3) return null;
  const first = path[0];
  const last = path[path.length - 1];
  if (!closeEnough(first, last)) path = [...path, first];
  const poly = path.map(([x, y]) => ({ x: mm(x), y: mm(y) }));
  if (polygonArea(poly) < MIN_AREA_MM2) return null;
  return poly;
}

// ─── pdfjs ≥ 4: constructPath Float32Array sub-op codes ──────────────────────
// 0 = moveTo(x,y)   1 = lineTo(x,y)   2 = curveTo(x1,y1,x2,y2,x3,y3)   4 = closePath
function decodeConstructPath(pathArray: Float32Array, steps = 16): Polygon[] {
  const polys: Polygon[] = [];
  let current: Point[] = [];
  let cursor: Point | null = null;
  const subpaths: Point[][] = [];

  const flushCurrent = () => {
    if (current.length >= 3) subpaths.push([...current]);
    current = [];
    cursor = null;
  };

  const flushAll = () => {
    flushCurrent();
    for (const sp of subpaths) {
      const poly = toPolygon(sp);
      if (poly) polys.push(poly);
    }
    subpaths.length = 0;
  };

  let i = 0;
  while (i < pathArray.length) {
    const op = pathArray[i++];
    if (op === 0) {
      // moveTo
      flushCurrent();
      cursor = [pathArray[i++], pathArray[i++]];
      current.push(cursor);
    } else if (op === 1) {
      // lineTo
      if (!cursor) { i += 2; continue; }
      const p: Point = [pathArray[i++], pathArray[i++]];
      current.push(p);
      cursor = p;
    } else if (op === 2) {
      // curveTo (cubic bezier: 6 args)
      if (!cursor) { i += 6; continue; }
      const p1: Point = [pathArray[i++], pathArray[i++]];
      const p2: Point = [pathArray[i++], pathArray[i++]];
      const p3: Point = [pathArray[i++], pathArray[i++]];
      current.push(...discretizeBezier(cursor, p1, p2, p3, steps));
      cursor = p3;
    } else if (op === 4) {
      // closePath
      if (current.length >= 3) subpaths.push([...current]);
      current = [];
      cursor = null;
    } else {
      // Operador desconhecido — encerra leitura segura
      break;
    }
  }

  flushAll();
  return polys;
}

async function extractPolygonsFromPage(page: any): Promise<Polygon[]> {
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const polys: Polygon[] = [];

  let current: Point[] = [];
  let cursor: Point | null = null;
  const subpaths: Point[][] = [];

  const flushCurrent = () => {
    if (current.length >= 3) subpaths.push([...current]);
    current = [];
    cursor = null;
  };

  const flushAll = () => {
    flushCurrent();
    for (const sp of subpaths) {
      const poly = toPolygon(sp);
      if (poly) polys.push(poly);
    }
    subpaths.length = 0;
    current = [];
    cursor = null;
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    switch (fn) {

      // ── pdfjs ≥ 4: todos os caminhos em um único constructPath ────────────
      case OPS.constructPath: {
        const pathData: Float32Array | undefined = args?.[1]?.[0];
        if (pathData instanceof Float32Array) {
          polys.push(...decodeConstructPath(pathData, 16));
        }
        break;
      }

      // ── Operadores individuais legacy (pdfjs < 4 / outros exportadores) ──
      case OPS.moveTo: {
        flushCurrent();
        cursor = [args[0], args[1]];
        current.push(cursor);
        break;
      }
      case OPS.lineTo: {
        if (!cursor) break;
        const lp: Point = [args[0], args[1]];
        current.push(lp);
        cursor = lp;
        break;
      }
      case OPS.curveTo: {
        if (!cursor) break;
        const cp1: Point = [args[0], args[1]];
        const cp2: Point = [args[2], args[3]];
        const cp3: Point = [args[4], args[5]];
        current.push(...discretizeBezier(cursor, cp1, cp2, cp3, 16));
        cursor = cp3;
        break;
      }
      case OPS.curveTo2: {
        if (!cursor) break;
        const c2p1 = cursor;
        const c2p2: Point = [args[0], args[1]];
        const c2p3: Point = [args[2], args[3]];
        current.push(...discretizeBezier(cursor, c2p1, c2p2, c2p3, 16));
        cursor = c2p3;
        break;
      }
      case OPS.curveTo3: {
        if (!cursor) break;
        const c3p1: Point = [args[0], args[1]];
        const c3p2: Point = [args[2], args[3]];
        current.push(...discretizeBezier(cursor, c3p1, c3p2, c3p2, 16));
        cursor = c3p2;
        break;
      }
      case OPS.closePath: {
        if (current.length >= 3) subpaths.push([...current]);
        current = [];
        cursor = null;
        break;
      }
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.stroke: {
        flushAll();
        break;
      }
      case OPS.rectangle: {
        flushAll();
        const rx = args[0], ry = args[1], rw = args[2], rh = args[3];
        if (Math.abs(rw * rh) * PT_TO_MM * PT_TO_MM >= MIN_AREA_MM2) {
          polys.push([
            { x: mm(rx),      y: mm(ry) },
            { x: mm(rx + rw), y: mm(ry) },
            { x: mm(rx + rw), y: mm(ry + rh) },
            { x: mm(rx),      y: mm(ry + rh) },
            { x: mm(rx),      y: mm(ry) },
          ]);
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

// ─── Determina se `inner` é um furo dentro de `outer` ────────────────────────
// Verifica múltiplos pontos distribuídos no contorno para maior robustez.
function isHoleOf(outer: Polygon, inner: Polygon): boolean {
  if (inner.length === 0) return false;
  // Testa até 4 pontos espaçados do inner para confirmar contenção
  const step = Math.max(1, Math.floor(inner.length / 4));
  for (let k = 0; k < inner.length; k += step) {
    if (!pointInPolygon(inner[k], outer)) return false;
  }
  return true;
}

function buildParts(polys: Polygon[]): ParsedPart[] {
  if (polys.length === 0) return [];

  // Ordena por área decrescente: os maiores são outer, os menores podem ser furos
  const sorted = [...polys].sort((a, b) => polygonArea(b) - polygonArea(a));

  const used = new Set<number>();
  const parts: ParsedPart[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const outer = sorted[i];
    const outerArea = polygonArea(outer);
    const holes: Polygon[] = [];

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const inner = sorted[j];
      // Um furo deve ser significativamente menor que o outer
      if (polygonArea(inner) >= outerArea * 0.95) continue;
      if (isHoleOf(outer, inner)) {
        holes.push(inner);
        used.add(j);
      }
    }

    used.add(i);
    const normalizedOuter = normalizeToOrigin(outer);
    const normalizedHoles = holes.map(normalizeToOrigin);
    const geom = buildGeometry(normalizedOuter, normalizedHoles);

    parts.push({ ...geom, id: `part-${parts.length}` });
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
    throw new Error("PDF inválido, protegido ou corrompido.");
  }

  const polys: Polygon[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    try {
      const pagePolys = await extractPolygonsFromPage(page);
      polys.push(...pagePolys);
    } catch (e) {
      console.warn(`Falha ao processar página ${pageNum}:`, e);
    }
  }

  if (polys.length === 0) {
    throw new Error(
      "Nenhum caminho vetorial encontrado neste PDF.\n" +
      "Certifique-se de exportar o arquivo com vetores (não rasterizado).\n" +
      "Formatos compatíveis: CorelDRAW, Illustrator, Inkscape, AutoCAD (DXF→PDF)."
    );
  }

  const parts = buildParts(polys);

  if (parts.length === 0) {
    throw new Error(
      `Foram encontrados ${polys.length} caminhos mas nenhuma peça pôde ser formada. ` +
      "Verifique se os contornos estão fechados no arquivo original."
    );
  }

  return parts;
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
    const key = `${Math.round(part.area)}-${Math.round(b.maxX - b.minX)}-${Math.round(b.maxY - b.minY)}`;
    const found = groups.find((g) => g.key === key);
    if (found) {
      found.quantity += 1;
      found.parts.push(part);
    } else {
      groups.push({
        key,
        quantity: 1,
        width: b.maxX - b.minX,
        height: b.maxY - b.minY,
        area: part.area,
        parts: [part],
      });
    }
  }

  return groups;
}
