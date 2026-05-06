// Nesting algorithm: bottom-left fill with rotation and polygon collision
import {
  type Polygon,
  type PartGeometry,
  rotatePolygon,
  translatePolygon,
  bbox,
  bboxOverlap,
  polygonsIntersect,
  inflatePolygon,
  mirrorPolygon,
} from "./geometry";
import type { ParsedPart } from "./parser";

export interface NestingOptions {
  sheetWidth: number;
  sheetHeight: number;
  gap: number;
  margin: number;
  allowRotation: boolean;
  allowMirror: boolean;
  priority: "yield" | "time" | "travel";
}

export interface PlacedPart {
  partId: string;
  groupSig: string;
  sheetIndex: number;
  rotation: number;
  mirrored: boolean;
  x: number;
  y: number;
  polygon: Polygon; // final placed polygon (with margin offset already applied on x/y)
  holes: Polygon[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
}

export interface NestResult {
  sheets: PlacedPart[][];
  unplaced: { partId: string; groupSig: string }[];
  totalPartArea: number;
  totalSheetArea: number;
  utilization: number;
}

function transformGeom(geom: PartGeometry, rotation: number, mirror: boolean) {
  let outer = geom.outer;
  let holes = geom.holes;
  if (mirror) {
    outer = mirrorPolygon(outer);
    holes = holes.map(mirrorPolygon);
  }
  if (rotation) {
    outer = rotatePolygon(outer, rotation);
    holes = holes.map((h) => rotatePolygon(h, rotation));
  }
  const b = bbox(outer);
  const dx = -b.minX, dy = -b.minY;
  outer = translatePolygon(outer, dx, dy);
  holes = holes.map((h) => translatePolygon(h, dx, dy));
  return { outer, holes };
}

export function runNesting(parts: ParsedPart[], opts: NestingOptions): NestResult {
  const innerW = opts.sheetWidth - 2 * opts.margin;
  const innerH = opts.sheetHeight - 2 * opts.margin;

  // Sort by area descending (yield) or by max dimension
  const sorted = [...parts].sort((a, b) => {
    if (opts.priority === "time") return b.perimeter - a.perimeter;
    if (opts.priority === "travel") return Math.max(b.width, b.height) - Math.max(a.width, a.height);
    return b.area - a.area;
  });

  const rotations = opts.allowRotation ? [0, 90, 180, 270] : [0];
  const mirrors = opts.allowMirror ? [false, true] : [false];

  const sheets: PlacedPart[][] = [[]];
  const unplaced: { partId: string; groupSig: string }[] = [];
  let totalArea = 0;

  // Candidate grid step (mm) — adaptive
  const step = Math.max(2, Math.min(opts.sheetWidth, opts.sheetHeight) / 100);

  for (const part of sorted) {
    let placed = false;

    // Try existing sheets first
    for (let s = 0; s < sheets.length && !placed; s++) {
      placed = tryPlace(part, s);
    }
    if (!placed) {
      // open new sheet
      sheets.push([]);
      placed = tryPlace(part, sheets.length - 1);
    }
    if (!placed) unplaced.push({ partId: part.id, groupSig: part.signature });
    else totalArea += part.area;

    function tryPlace(part: ParsedPart, sheetIdx: number): boolean {
      const existing = sheets[sheetIdx];
      let best: PlacedPart | null = null;

      for (const mirror of mirrors) {
        for (const rot of rotations) {
          const { outer, holes } = transformGeom(part, rot, mirror);
          const b = bbox(outer);
          const w = b.maxX - b.minX;
          const h = b.maxY - b.minY;
          if (w > innerW || h > innerH) continue;

          // Inflated for collision (gap)
          const inflated = opts.gap > 0 ? inflatePolygon(outer, opts.gap / 2) : outer;

          // Bottom-left scan
          for (let y = 0; y + h <= innerH + 0.001; y += step) {
            for (let x = 0; x + w <= innerW + 0.001; x += step) {
              const placedPoly = translatePolygon(outer, x, y);
              const placedInflated = translatePolygon(inflated, x, y);
              const pb = bbox(placedPoly);

              let collides = false;
              for (const e of existing) {
                if (!bboxOverlap(pb, e.bbox, opts.gap)) continue;
                if (polygonsIntersect(placedInflated, e.polygon)) {
                  collides = true;
                  break;
                }
              }
              if (!collides) {
                const placedHoles = holes.map((hp) => translatePolygon(hp, x, y));
                const candidate: PlacedPart = {
                  partId: part.id,
                  groupSig: part.signature,
                  sheetIndex: sheetIdx,
                  rotation: rot,
                  mirrored: mirror,
                  x: x + opts.margin,
                  y: y + opts.margin,
                  polygon: translatePolygon(placedPoly, opts.margin, opts.margin),
                  holes: placedHoles.map((hp) => translatePolygon(hp, opts.margin, opts.margin)),
                  bbox: {
                    minX: pb.minX + opts.margin,
                    minY: pb.minY + opts.margin,
                    maxX: pb.maxX + opts.margin,
                    maxY: pb.maxY + opts.margin,
                  },
                  area: part.area,
                };
                if (!best || candidate.bbox.minY < best.bbox.minY ||
                    (candidate.bbox.minY === best.bbox.minY && candidate.bbox.minX < best.bbox.minX)) {
                  best = candidate;
                }
                break; // first fit on this row
              }
            }
            if (best && best.bbox.minY <= y + opts.margin) break;
          }
        }
      }
      if (best) {
        existing.push(best);
        return true;
      }
      return false;
    }
  }

  const totalSheetArea = sheets.length * opts.sheetWidth * opts.sheetHeight;
  return {
    sheets,
    unplaced,
    totalPartArea: totalArea,
    totalSheetArea,
    utilization: totalSheetArea ? totalArea / totalSheetArea : 0,
  };
}