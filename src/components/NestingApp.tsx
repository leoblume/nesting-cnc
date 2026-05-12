import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parsePdf, groupParts, type ParsedPart } from "@/lib/nesting/parser";
import { runNesting, type NestResult, type PlacedPart, type NestingOptions } from "@/lib/nesting/nesting";
import { type Point } from "@/lib/nesting/geometry";
import { Loader2, Upload, Layers, Play, AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Plus, Trash2, Zap, Package, RefreshCw, Printer } from "lucide-react";

// ─── Versão ───────────────────────────────────────────────────────────────────
const APP_VERSION = "10";

// ─── Terminologia de eixos (convenção única em todo o arquivo) ─────────────
//   Largura  → eixo X → dimensão horizontal
//   Altura   → eixo Y → dimensão vertical
//   Espessura → eixo Z → profundidade / espessura da letra (padrão 50 mm)

const PART_COLORS = [
  "#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6",
  "#06b6d4","#f97316","#84cc16","#ec4899","#14b8a6",
  "#6366f1","#eab308","#22c55e","#e11d48","#0ea5e9",
];

function getColor(sig: string, idx: number): string {
  let hash = 0;
  for (let i = 0; i < sig.length; i++) hash = (hash * 31 + sig.charCodeAt(i)) >>> 0;
  return PART_COLORS[(hash + idx) % PART_COLORS.length];
}

// ─── LED Registration ──────────────────────────────────────────────────────
export interface LedModel {
  id: string;
  name: string;
  /** Largura visual do LED (eixo X), mm */
  widthMm: number;
  /** Altura visual do LED (eixo Y), mm */
  heightMm: number;
  power: number;   // W por unidade
  photoUrl?: string;
}

/** Desconto de respiro para cálculo de aproveitamento.
 *  O LED tem tamanho visual (widthMm × heightMm).
 *  Para fins de cálculo subtraímos: 2 mm na largura (X) e 1 mm na altura (Y).
 */
function ledCalcDims(led: LedModel, rotation: 0 | 90 = 0): { calcW: number; calcH: number } {
  const MARGIN_X = 2; // mm descontados da largura para cálculo
  const MARGIN_Y = 1; // mm descontados da altura para cálculo
  if (rotation === 90) {
    // girado: largura-de-cálculo vira o que era altura visual, altura-de-cálculo vira o que era largura visual
    return { calcW: Math.max(1, led.heightMm - MARGIN_Y), calcH: Math.max(1, led.widthMm - MARGIN_X) };
  }
  return { calcW: Math.max(1, led.widthMm - MARGIN_X), calcH: Math.max(1, led.heightMm - MARGIN_Y) };
}

// ─── LED Assignment per part group ────────────────────────────────────────
type LedAssignment = Record<string, string>;

// ─── Point-in-polygon test ─────────────────────────────────────────────────
function pointInPoly(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Shrink polygon (offset inward along normals) ─────────────────────────
function shrinkPolygon(poly: Point[], margin: number): Point[] {
  const n = poly.length;
  if (n < 3) return poly;
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];
    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const e2x = next.x - curr.x, e2y = next.y - curr.y;
    const len1 = Math.hypot(e1x, e1y) || 1;
    const len2 = Math.hypot(e2x, e2y) || 1;
    let n1x = -e1y / len1, n1y = e1x / len1;
    let n2x = -e2y / len2, n2y = e2x / len2;
    if (n1x * (cx - curr.x) + n1y * (cy - curr.y) < 0) { n1x = -n1x; n1y = -n1y; }
    if (n2x * (cx - curr.x) + n2y * (cy - curr.y) < 0) { n2x = -n2x; n2y = -n2y; }
    let bx = n1x + n2x, by = n1y + n2y;
    const blen = Math.hypot(bx, by) || 1;
    bx /= blen; by /= blen;
    result.push({ x: curr.x + bx * margin, y: curr.y + by * margin });
  }
  return result;
}

// ─── LED Calculation Engine ────────────────────────────────────────────────
export type LedEngine = "grid" | "centerline";

/** Espessura padrão do eixo Z (profundidade da letra), em mm */
const DEFAULT_LETTER_THICKNESS_MM = 50;

/**
 * Distância entre módulos LED = espessura da letra × (1 - 15%) = espessura × 0.85
 * Aplica na direção X e na direção Y (pitch uniforme).
 */
function calcPitchFromLetterThickness(letterThicknessMm: number): number {
  return letterThicknessMm * 0.85;
}

// ── GRID ENGINE ───────────────────────────────────────────────────────────────
function calcLedsGrid(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  letterThicknessMm: number | null,
  rotation: 0 | 90,
): { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }> } {
  if (polygon.length < 3) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [] };

  // Bounding box da peça
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  // innerW = largura (eixo X), innerH = altura (eixo Y)
  const innerW = maxX - minX;
  const innerH = maxY - minY;
  if (innerW <= 0 || innerH <= 0) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [] };

  // Dimensões de cálculo do LED (com margem de respiro aplicada)
  const { calcW: ledCalcW, calcH: ledCalcH } = ledCalcDims(ledModel, rotation);

  let pitchX: number;
  let pitchY: number;

  if (letterThicknessMm && letterThicknessMm > 0) {
    // Pitch derivado da espessura da letra (eixo Z), aplicado em X e Y
    const p = calcPitchFromLetterThickness(letterThicknessMm);
    pitchX = p;
    pitchY = p;
  } else {
    // Sem letra definida: pitch = dimensão de cálculo do LED em cada eixo
    pitchX = ledCalcW;
    pitchY = ledCalcH;
  }

  if (pitchX <= 0 || pitchY <= 0) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [] };

  // Garante ao menos 1 coluna e 1 linha mesmo em espaços pequenos
  const cols = Math.max(1, Math.floor(innerW / pitchX));
  const rows = Math.max(1, Math.floor(innerH / pitchY));
  const actualPitchX = innerW / cols;
  const actualPitchY = innerH / rows;

  const positions: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = minX + (col + 0.5) * actualPitchX;
      const y = minY + (row + 0.5) * actualPitchY;
      const pt = { x, y };
      if (!pointInPoly(pt, polygon)) continue;
      let inHole = false;
      for (const hole of holes) { if (pointInPoly(pt, hole)) { inHole = true; break; } }
      if (inHole) continue;
      positions.push({ x, y });
    }
  }
  return { totalLeds: positions.length, pitch: Math.max(actualPitchX, actualPitchY), pitchX: actualPitchX, pitchY: actualPitchY, positions };
}

// ── CENTERLINE ENGINE ─────────────────────────────────────────────────────────
/**
 * Linha central: scanlines perpendiculares à direção principal.
 * Suporta múltiplas linhas paralelas ao centro (numLines > 1).
 * O número de linhas de LEDs é calculado com base na espessura disponível vs. tamanho do LED.
 */
function calcLedsCenterline(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  letterThicknessMm: number | null,
  numLinesOverride?: number, // se fornecido, usa este número de linhas
): { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }>; numLines: number } {
  if (polygon.length < 3) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [], numLines: 1 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const W = maxX - minX; // largura X
  const H = maxY - minY; // altura Y
  if (W <= 0 || H <= 0) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [], numLines: 1 };

  const thickness = letterThicknessMm && letterThicknessMm > 0 ? letterThicknessMm : DEFAULT_LETTER_THICKNESS_MM;
  const pitch = calcPitchFromLetterThickness(thickness);

  // Dimensões de cálculo do LED (com margem de respiro)
  const { calcW: ledCalcW, calcH: ledCalcH } = ledCalcDims(ledModel, 0);
  const ledRef = Math.min(ledCalcW, ledCalcH); // menor dimensão para caber na espessura

  // Direção principal: eixo mais longo
  const alongX = W >= H;

  // scanline helpers
  function scanlineX(ty: number, poly: Point[]): number[] {
    const xs: number[] = [];
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if ((a.y <= ty && b.y > ty) || (b.y <= ty && a.y > ty)) {
        const t = (ty - a.y) / (b.y - a.y);
        xs.push(a.x + t * (b.x - a.x));
      }
    }
    return xs.sort((a, b) => a - b);
  }

  function scanlineY(tx: number, poly: Point[]): number[] {
    const ys: number[] = [];
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if ((a.x <= tx && b.x > tx) || (b.x <= tx && a.x > tx)) {
        const t = (tx - a.x) / (b.x - a.x);
        ys.push(a.y + t * (b.y - a.y));
      }
    }
    return ys.sort((a, b) => a - b);
  }

  // Calcula quantas linhas de LED cabem na dimensão transversal
  // Dimensão transversal = a dimensão menor (perpendicular ao comprimento principal)
  const transversal = alongX ? H : W;
  let numLines: number;
  if (numLinesOverride !== undefined && numLinesOverride >= 1) {
    numLines = numLinesOverride;
  } else {
    // Calcula automaticamente: quantas linhas de LED (com pitch transversal) cabem
    numLines = Math.max(1, Math.floor(transversal / (ledRef > 0 ? ledRef : pitch)));
  }

  // Offsets transversais das linhas relativas ao centro (0 = linha central)
  const lineOffsets: number[] = [];
  if (numLines === 1) {
    lineOffsets.push(0);
  } else {
    const transStep = transversal / numLines;
    for (let l = 0; l < numLines; l++) {
      lineOffsets.push(-transversal / 2 + transStep * (l + 0.5));
    }
  }

  const positions: Array<{ x: number; y: number }> = [];

  if (alongX) {
    // Varre X com passo = pitch; para cada X, encontra a linha central em Y e aplica offsets
    const steps = Math.max(1, Math.round(W / pitch));
    const actualPitch = W / steps;
    for (let i = 0; i < steps; i++) {
      const tx = minX + (i + 0.5) * actualPitch;
      const ys = scanlineY(tx, polygon);
      if (ys.length < 2) continue;
      for (let j = 0; j + 1 < ys.length; j += 2) {
        const yMid = (ys[j] + ys[j + 1]) / 2;
        for (const offset of lineOffsets) {
          const pt = { x: tx, y: yMid + offset };
          if (!pointInPoly(pt, polygon)) continue;
          let inHole = false;
          for (const hole of holes) { if (pointInPoly(pt, hole)) { inHole = true; break; } }
          if (!inHole) positions.push(pt);
        }
      }
    }
    return { totalLeds: positions.length, pitch, pitchX: W / steps, pitchY: transversal / numLines, positions, numLines };
  } else {
    // Varre Y com passo = pitch; para cada Y, linha central em X e aplica offsets
    const steps = Math.max(1, Math.round(H / pitch));
    const actualPitch = H / steps;
    for (let i = 0; i < steps; i++) {
      const ty = minY + (i + 0.5) * actualPitch;
      const xs = scanlineX(ty, polygon);
      if (xs.length < 2) continue;
      for (let j = 0; j + 1 < xs.length; j += 2) {
        const xMid = (xs[j] + xs[j + 1]) / 2;
        for (const offset of lineOffsets) {
          const pt = { x: xMid + offset, y: ty };
          if (!pointInPoly(pt, polygon)) continue;
          let inHole = false;
          for (const hole of holes) { if (pointInPoly(pt, hole)) { inHole = true; break; } }
          if (!inHole) positions.push(pt);
        }
      }
    }
    return { totalLeds: positions.length, pitch, pitchX: transversal / numLines, pitchY: H / steps, positions, numLines };
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function calcLedsForPart(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  letterThicknessMm: number | null = null,
  engine: LedEngine = "centerline",
  numCenterlines?: number,
): { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }>; bestRotation: 0 | 90; numLines: number } {
  if (!polygon.length) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [], bestRotation: 0, numLines: 1 };

  if (engine === "centerline") {
    const r = calcLedsCenterline(polygon, holes, ledModel, letterThicknessMm, numCenterlines);
    return { ...r, bestRotation: 0 };
  }

  // Grid: testa rotação 0° e 90°, escolhe a que dá mais LEDs
  const r0 = calcLedsGrid(polygon, holes, ledModel, letterThicknessMm, 0);
  const r90 = calcLedsGrid(polygon, holes, ledModel, letterThicknessMm, 90);

  if (r0.totalLeds === 0 && r90.totalLeds === 0) {
    return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [], bestRotation: 0, numLines: 1 };
  }

  const best = r90.totalLeds > r0.totalLeds ? r90 : r0;
  const bestRotation: 0 | 90 = r90.totalLeds > r0.totalLeds ? 90 : 0;
  return { ...best, bestRotation, numLines: 1 };
}

/**
 * Cálculo de aproveitamento por bbox (para tabela resumo).
 * Usa dimensões reais do LED menos margem de respiro.
 */
function calcLedsForBbox(
  /** Largura da peça (eixo X), mm */
  partWidthMm: number,
  /** Altura da peça (eixo Y), mm */
  partHeightMm: number,
  ledModel: LedModel,
  letterThicknessMm: number | null = null,
): { ledsX: number; ledsY: number; totalLeds: number; pitch: number; pitchX: number; pitchY: number } {
  const W = partWidthMm;
  const H = partHeightMm;
  if (W <= 0 || H <= 0) return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0 };

  const calcForRotation = (rot: 0 | 90) => {
    const { calcW: ledCalcW, calcH: ledCalcH } = ledCalcDims(ledModel, rot);
    let pitchX: number;
    let pitchY: number;
    if (letterThicknessMm && letterThicknessMm > 0) {
      const p = calcPitchFromLetterThickness(letterThicknessMm);
      pitchX = p;
      pitchY = p;
    } else {
      pitchX = ledCalcW;
      pitchY = ledCalcH;
    }
    if (pitchX <= 0 || pitchY <= 0) return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0 };
    // Ao menos 1 em cada eixo
    const ledsX = Math.max(1, Math.floor(W / pitchX));
    const ledsY = Math.max(1, Math.floor(H / pitchY));
    const actualPX = W / ledsX;
    const actualPY = H / ledsY;
    return { ledsX, ledsY, totalLeds: ledsX * ledsY, pitch: Math.max(actualPX, actualPY), pitchX: actualPX, pitchY: actualPY };
  };

  const r0 = calcForRotation(0);
  const r90 = calcForRotation(90);
  return r90.totalLeds > r0.totalLeds ? r90 : r0;
}

// ─── Canvas rendering (plano de nesting) ────────────────────────────────────
function renderSheet(
  canvas: HTMLCanvasElement,
  placed: PlacedPart[],
  sheetWidth: number,
  sheetHeight: number,
  margin: number,
  ledModel: LedModel | null,
  showLeds: boolean,
  letterThicknessMm: number | null = null,
) {
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const cw = container.clientWidth - 2;
  const ch = container.clientHeight - 2;
  const scale = Math.min(cw / sheetWidth, ch / sheetHeight) * 0.96;
  const drawW = sheetWidth * scale;
  const drawH = sheetHeight * scale;

  canvas.width = drawW * dpr;
  canvas.height = drawH * dpr;
  canvas.style.width = `${drawW}px`;
  canvas.style.height = `${drawH}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, 0, drawW, drawH);
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, drawW - 1, drawH - 1);

  if (margin > 0) {
    ctx.strokeStyle = "#334155";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(margin * scale, margin * scale, (sheetWidth - 2 * margin) * scale, (sheetHeight - 2 * margin) * scale);
    ctx.setLineDash([]);
  }

  const sigColorMap = new Map<string, string>();
  let idx = 0;

  let maxX = margin, maxY = margin;
  for (const part of placed) {
    if (part.bbox.maxX > maxX) maxX = part.bbox.maxX;
    if (part.bbox.maxY > maxY) maxY = part.bbox.maxY;
  }

  for (const part of placed) {
    if (!sigColorMap.has(part.groupSig)) {
      sigColorMap.set(part.groupSig, getColor(part.groupSig, idx++));
    }
    const color = sigColorMap.get(part.groupSig)!;
    const poly = part.polygon;
    if (poly.length === 0) continue;

    ctx.beginPath();
    ctx.moveTo(poly[0].x * scale, poly[0].y * scale);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * scale, poly[i].y * scale);
    ctx.closePath();
    ctx.fillStyle = color + "40";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (const hole of part.holes) {
      if (hole.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(hole[0].x * scale, hole[0].y * scale);
      for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x * scale, hole[i].y * scale);
      ctx.closePath();
      ctx.fillStyle = "#1e293b";
      ctx.fill();
      ctx.strokeStyle = color + "99";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (part.rotation !== 0 || part.mirrored) {
      const cx = (part.bbox.minX + part.bbox.maxX) / 2 * scale;
      const cy = (part.bbox.minY + part.bbox.maxY) / 2 * scale;
      const sz = Math.max(8, Math.min(11, (part.bbox.maxX - part.bbox.minX) * scale / 5));
      ctx.fillStyle = color;
      ctx.font = `${sz}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(part.mirrored ? `M${part.rotation}°` : `${part.rotation}°`, cx, cy);
    }

    // LEDs no nesting: usa dimensões visuais reais do LED
    if (showLeds && ledModel) {
      const { positions, bestRotation: partRot } = calcLedsForPart(part.polygon, part.holes, ledModel, letterThicknessMm, "centerline");
      // Tamanho visual real do LED na tela (não subtraímos margem aqui, exibição real)
      const rawW = partRot === 90 ? ledModel.heightMm : ledModel.widthMm;
      const rawH = partRot === 90 ? ledModel.widthMm : ledModel.heightMm;
      const ledW = Math.max(2, rawW * scale);
      const ledH = Math.max(2, rawH * scale);

      for (const pos of positions) {
        const lx = pos.x * scale;
        const ly = pos.y * scale;
        ctx.fillStyle = "#fde68a";
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 0.5;
        ctx.fillRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
        ctx.strokeRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
      }

      const labelX = (part.bbox.minX + part.bbox.maxX) / 2 * scale;
      const labelY = part.bbox.maxY * scale + 4;
      const labelSz = Math.max(7, Math.min(10, (part.bbox.maxX - part.bbox.minX) * scale / 6));
      ctx.font = `bold ${labelSz}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#fde68a";
      ctx.fillText(`${positions.length} LEDs`, labelX, labelY);
    }
  }

  // Sobra útil (área não usada)
  if (placed.length > 0) {
    const leftoverW = sheetWidth - maxX - margin;
    const leftoverH = sheetHeight - 2 * margin;
    if (leftoverW > 10) {
      ctx.fillStyle = "rgba(16,185,129,0.08)";
      ctx.fillRect(maxX * scale, margin * scale, leftoverW * scale, leftoverH * scale);
      ctx.strokeStyle = "#10b98166";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(maxX * scale, margin * scale, leftoverW * scale, leftoverH * scale);
      ctx.setLineDash([]);
      const lx = (maxX + leftoverW / 2) * scale;
      const ly = (margin + leftoverH / 2) * scale;
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#10b981";
      ctx.fillText(`Sobra: ${leftoverW.toFixed(0)} × ${leftoverH.toFixed(0)} mm`, lx, ly);
    }
  }
}

function NumericField({ label, unit, value, onChange, min = 0, step = 1 }: {
  label: string; unit: string; value: number; onChange: (v: number) => void; min?: number; step?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">
        {label} <span className="text-muted-foreground/60">({unit})</span>
      </Label>
      <Input type="number" min={min} step={step} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= min) onChange(v); }}
        className="h-8 text-sm" />
    </div>
  );
}

// ─── LED Registration Panel ────────────────────────────────────────────────
function LedRegistrationPanel({
  leds, onAdd, onRemove, selectedId, onSelect,
}: {
  leds: LedModel[];
  onAdd: (m: LedModel) => void;
  onRemove: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [form, setForm] = useState({ name: "", widthMm: 5, heightMm: 5, power: 0.5 });
  const [photoUrl, setPhotoUrl] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleAdd = () => {
    if (!form.name.trim()) return;
    onAdd({
      id: `led-${Date.now()}`,
      name: form.name.trim(),
      widthMm: form.widthMm,
      heightMm: form.heightMm,
      power: form.power,
      photoUrl,
    });
    setForm({ name: "", widthMm: 5, heightMm: 5, power: 0.5 });
    setPhotoUrl(undefined);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-4">
      {leds.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Modelos cadastrados</p>
          {leds.map((led) => {
            const { calcW, calcH } = ledCalcDims(led, 0);
            return (
              <div
                key={led.id}
                onClick={() => onSelect(led.id)}
                className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  selectedId === led.id
                    ? "border-yellow-500/60 bg-yellow-500/10"
                    : "border-border bg-background hover:border-border/80"
                }`}
              >
                {led.photoUrl ? (
                  <img src={led.photoUrl} alt={led.name} className="h-10 w-10 rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="h-10 w-10 rounded bg-muted flex items-center justify-center flex-shrink-0">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{led.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Visual: {led.widthMm}×{led.heightMm} mm · Cálculo: {calcW.toFixed(1)}×{calcH.toFixed(1)} mm · {led.power} W/un
                  </p>
                </div>
                {selectedId === led.id && (
                  <span className="text-[10px] font-bold text-yellow-400 bg-yellow-500/20 px-1.5 py-0.5 rounded">ATIVO</span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(led.id); }}
                  className="text-muted-foreground hover:text-destructive transition-colors ml-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Cadastrar novo LED
        </p>

        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Foto do LED</Label>
          <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed border-border bg-background p-3 hover:border-primary/50 transition-colors">
            {photoUrl ? (
              <img src={photoUrl} alt="preview" className="h-12 w-12 rounded object-cover flex-shrink-0" />
            ) : (
              <div className="h-12 w-12 rounded bg-muted flex items-center justify-center flex-shrink-0">
                <Upload className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
            <span className="text-xs text-muted-foreground">{photoUrl ? "Alterar foto" : "Clique para adicionar foto"}</span>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Nome / Referência</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Ex: LED SMD 5050"
            className="h-8 text-sm"
          />
        </div>

        <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-2">
          <p className="text-[9px] text-blue-300/80 mb-1">
            Dimensões visuais do módulo. Para cálculo: largura −2 mm, altura −1 mm (margem de respiro).
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Larg. X (mm)</Label>
              <Input type="number" min={0.1} step={0.1} value={form.widthMm}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setForm((f) => ({ ...f, widthMm: v })); }}
                className="h-8 text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Alt. Y (mm)</Label>
              <Input type="number" min={0.1} step={0.1} value={form.heightMm}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setForm((f) => ({ ...f, heightMm: v })); }}
                className="h-8 text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Potência (W)</Label>
              <Input type="number" min={0} step={0.01} value={form.power}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setForm((f) => ({ ...f, power: v })); }}
                className="h-8 text-sm" />
            </div>
          </div>
          {form.widthMm > 0 && form.heightMm > 0 && (
            <p className="text-[9px] text-muted-foreground/70 mt-1">
              Cálculo: {Math.max(1, form.widthMm - 2).toFixed(1)} × {Math.max(1, form.heightMm - 1).toFixed(1)} mm
            </p>
          )}
        </div>

        <Button onClick={handleAdd} disabled={!form.name.trim()} variant="secondary" className="w-full h-8 text-sm">
          <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar LED
        </Button>
      </div>
    </div>
  );
}

// ─── LED Visualization Canvas (shape-aware, multi-LED) ───────────────────────
function LedDrawingCanvas({
  groups, ledModels, selectedLedId, ledAssignments,
  letterThicknessMm = null, engine = "centerline", numCenterlines = 1,
}: {
  groups: ReturnType<typeof groupParts>;
  ledModels: LedModel[];
  selectedLedId: string | null;
  ledAssignments: LedAssignment;
  letterThicknessMm?: number | null;
  engine?: LedEngine;
  numCenterlines?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const resolveLed = useCallback((groupKey: string): LedModel | null => {
    const assignedId = ledAssignments[groupKey] ?? selectedLedId;
    return ledModels.find((l) => l.id === assignedId) ?? null;
  }, [ledModels, selectedLedId, ledAssignments]);

  useEffect(() => {
    if (!canvasRef.current || groups.length === 0) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;

    const COLS = Math.min(4, groups.length);
    const ROWS = Math.ceil(groups.length / COLS);
    const CELL_PAD = 24;
    const LABEL_TOP = 16;
    const LABEL_BOTTOM = 56; // aumentado para caber dimensões reais
    const MAX_PART = 150;

    let maxW = 0, maxH = 0;
    for (const g of groups) { if (g.width > maxW) maxW = g.width; if (g.height > maxH) maxH = g.height; }
    if (maxW === 0) maxW = 100; if (maxH === 0) maxH = 100;

    const cellW = Math.min(MAX_PART, maxW) + 2 * CELL_PAD;
    const cellH = Math.min(MAX_PART, maxH) + 2 * CELL_PAD + LABEL_TOP + LABEL_BOTTOM;

    const totalW = COLS * cellW;
    const totalH = ROWS * cellH;

    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = `${totalW}px`;
    canvas.style.height = `${totalH}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = engine === "centerline" ? "#f8fafc" : "#0f172a";
    ctx.fillRect(0, 0, totalW, totalH);

    groups.forEach((g, gi) => {
      const col = gi % COLS;
      const row = Math.floor(gi / COLS);
      const ledModel = resolveLed(g.key);

      const scaleX = Math.min(1, (cellW - 2 * CELL_PAD) / g.width);
      const scaleY = Math.min(1, (cellH - 2 * CELL_PAD - LABEL_TOP - LABEL_BOTTOM) / g.height);
      const s = Math.min(scaleX, scaleY);

      const pw = g.width * s;
      const ph = g.height * s;

      const ox = col * cellW + CELL_PAD + (cellW - 2 * CELL_PAD - pw) / 2;
      const oy = row * cellH + CELL_PAD + LABEL_TOP;

      const poly = g.parts[0]?.outer ?? null;
      const holes = g.parts[0]?.holes ?? [];

      if (poly && poly.length > 0) {
        let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
        for (const p of poly) {
          if (p.x < pminX) pminX = p.x; if (p.x > pmaxX) pmaxX = p.x;
          if (p.y < pminY) pminY = p.y; if (p.y > pmaxY) pmaxY = p.y;
        }

        const toScreen = (p: Point) => ({
          x: ox + (p.x - pminX) * s,
          y: oy + (p.y - pminY) * s,
        });

        ctx.beginPath();
        const sp0 = toScreen(poly[0]);
        ctx.moveTo(sp0.x, sp0.y);
        for (let i = 1; i < poly.length; i++) {
          const sp = toScreen(poly[i]);
          ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();
        ctx.fillStyle = engine === "centerline" ? "#f0f9ff" : "#1e3a5f";
        ctx.fill();
        ctx.strokeStyle = engine === "centerline" ? "#2563eb" : "#3b82f6";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        for (const hole of holes) {
          if (!hole.length) continue;
          ctx.beginPath();
          const sh0 = toScreen(hole[0]);
          ctx.moveTo(sh0.x, sh0.y);
          for (let i = 1; i < hole.length; i++) {
            const sh = toScreen(hole[i]);
            ctx.lineTo(sh.x, sh.y);
          }
          ctx.closePath();
          ctx.fillStyle = engine === "centerline" ? "#f8fafc" : "#0f172a";
          ctx.fill();
          ctx.strokeStyle = "#60a5fa88";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (ledModel) {
          const { positions, totalLeds, pitchX, pitchY, bestRotation: partRot, numLines } = calcLedsForPart(poly, holes, ledModel, letterThicknessMm, engine, numCenterlines);

          // Tamanho visual real do LED na tela
          const rawW = partRot === 90 ? ledModel.heightMm : ledModel.widthMm;
          const rawH = partRot === 90 ? ledModel.widthMm : ledModel.heightMm;
          const ledDispW = Math.max(2, rawW * s);
          const ledDispH = Math.max(2, rawH * s);
          const ledR = Math.max(2, Math.min(ledDispW, ledDispH) / 2);

          for (const pos of positions) {
            const lx = ox + (pos.x - pminX) * s;
            const ly = oy + (pos.y - pminY) * s;

            if (engine === "centerline") {
              // Glow + dot circular
              const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, ledR * 2.2);
              grd.addColorStop(0, "#fde68a99");
              grd.addColorStop(1, "#f59e0b00");
              ctx.beginPath();
              ctx.arc(lx, ly, ledR * 2.2, 0, Math.PI * 2);
              ctx.fillStyle = grd;
              ctx.fill();
              ctx.beginPath();
              ctx.arc(lx, ly, ledR, 0, Math.PI * 2);
              ctx.fillStyle = "#fde68a";
              ctx.fill();
              ctx.strokeStyle = "#d97706";
              ctx.lineWidth = 0.7;
              ctx.stroke();
            } else {
              // Grid: retângulo com glow
              const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(ledDispW, ledDispH));
              grd.addColorStop(0, "#fde68aaa");
              grd.addColorStop(1, "#f59e0b00");
              ctx.beginPath();
              ctx.arc(lx, ly, Math.max(ledDispW, ledDispH), 0, Math.PI * 2);
              ctx.fillStyle = grd;
              ctx.fill();
              ctx.fillStyle = "#fde68a";
              ctx.strokeStyle = "#f59e0b";
              ctx.lineWidth = 0.5;
              ctx.fillRect(lx - ledDispW / 2, ly - ledDispH / 2, ledDispW, ledDispH);
              ctx.strokeRect(lx - ledDispW / 2, ly - ledDispH / 2, ledDispW, ledDispH);
            }
          }

          // Label topo: dimensão real da peça (largura X × altura Y)
          ctx.fillStyle = engine === "centerline" ? "#475569" : "#94a3b8";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${g.width.toFixed(0)}(X) × ${g.height.toFixed(0)}(Y) mm`, ox + pw / 2, oy - 2);

          // Label inferior: LEDs, pitch, dimensão real LED
          const ledSzLabel = `LED: ${ledModel.widthMm}×${ledModel.heightMm}mm`;
          ctx.fillStyle = engine === "centerline" ? "#1e40af" : "#fde68a";
          ctx.font = "bold 9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`${totalLeds} LEDs  ↔${pitchX.toFixed(1)} ↕${pitchY.toFixed(1)} mm`, ox + pw / 2, oy + ph + 8);

          ctx.fillStyle = engine === "centerline" ? "#7c3aed" : "#a855f7";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const lineInfo = engine === "centerline" ? ` · ${numLines} linha${numLines > 1 ? "s" : ""}` : (partRot === 90 ? " ↺90°" : "");
          ctx.fillText(`${ledModel.name}${lineInfo}`, ox + pw / 2, oy + ph + 20);

          ctx.fillStyle = "#64748b";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(ledSzLabel, ox + pw / 2, oy + ph + 30);

          const { totalLeds: bboxTotal } = calcLedsForBbox(g.width, g.height, ledModel, letterThicknessMm);
          const coverage = bboxTotal > 0 ? Math.round((totalLeds / bboxTotal) * 100) : 0;
          ctx.fillStyle = "#10b981";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`aproveit. ${coverage}%`, ox + pw / 2, oy + ph + 42);
        } else {
          ctx.fillStyle = engine === "centerline" ? "#94a3b8" : "#94a3b8";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${g.width.toFixed(0)}(X) × ${g.height.toFixed(0)}(Y) mm`, ox + pw / 2, oy - 2);
          ctx.fillStyle = "#ef4444";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText("Sem LED atribuído", ox + pw / 2, oy + ph + 8);
        }

        // Badge quantidade
        const badgeW = 24, badgeH = 14;
        ctx.fillStyle = "#1e40af";
        ctx.beginPath();
        ctx.roundRect(ox + pw - badgeW - 2, oy + 2, badgeW, badgeH, 3);
        ctx.fill();
        ctx.fillStyle = "#93c5fd";
        ctx.font = "bold 8px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`×${g.quantity}`, ox + pw - badgeW / 2 - 2, oy + 2 + badgeH / 2);

      } else {
        // Fallback bbox
        ctx.fillStyle = engine === "centerline" ? "#e0f2fe" : "#1e3a5f";
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1.5;
        ctx.fillRect(ox, oy, pw, ph);
        ctx.strokeRect(ox, oy, pw, ph);

        if (ledModel) {
          const { totalLeds, pitchX, pitchY } = calcLedsForBbox(g.width, g.height, ledModel, letterThicknessMm);
          ctx.fillStyle = "#94a3b8";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${g.width.toFixed(0)}(X) × ${g.height.toFixed(0)}(Y) mm`, ox + pw / 2, oy - 2);
          ctx.fillStyle = "#fde68a";
          ctx.font = "bold 9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`${totalLeds} LEDs · ↔${pitchX.toFixed(1)} ↕${pitchY.toFixed(1)} mm`, ox + pw / 2, oy + ph + 8);
        }
      }
    });
  }, [groups, ledModels, selectedLedId, ledAssignments, letterThicknessMm, engine, numCenterlines, resolveLed]);

  const bgColor = engine === "centerline" ? "#f8fafc" : "#0f172a";

  return (
    <div className="overflow-auto rounded-lg border border-border p-2" style={{ background: bgColor }}>
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

// ─── Impressão separada: Plano de Corte ──────────────────────────────────────
function printCutPlan(
  result: NestResult,
  opts: NestingOptions,
  fileName: string,
  stats: { placed: number; unplaced: number; utilization: number; sheets: number } | null,
) {
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) { alert("Permita popups para imprimir."); return; }

  // Renderiza cada chapa em canvas
  const sheetDataUrls: string[] = [];
  for (let si = 0; si < result.sheets.length; si++) {
    const canvas = document.createElement("canvas");
    canvas.width = 1100; canvas.height = 750;
    const wrapper = document.createElement("div");
    wrapper.style.width = "1100px"; wrapper.style.height = "750px";
    wrapper.appendChild(canvas);
    document.body.appendChild(wrapper);
    renderSheet(canvas, result.sheets[si], opts.sheetWidth, opts.sheetHeight, opts.margin, null, false, null);
    sheetDataUrls.push(canvas.toDataURL("image/png", 1.0));
    document.body.removeChild(wrapper);
  }

  const now = new Date().toLocaleString("pt-BR");
  const totalParts = result.sheets.reduce((s, sh) => s + sh.length, 0);

  let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Plano de Corte – ${fileName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: #fff; color: #111; padding: 20px; }
  h1 { font-size: 17px; font-weight: 700; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 4px; }
  .meta { font-size: 10px; color: #555; margin-bottom: 16px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-bottom: 10px; color: #333; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
  .stat-box { border: 1px solid #ddd; padding: 8px; }
  .stat-label { font-size: 8px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-val { font-size: 18px; font-weight: 700; }
  .sheet-block { page-break-inside: avoid; margin-bottom: 20px; }
  .sheet-label { font-size: 10px; font-weight: 700; margin-bottom: 5px; }
  .sheet-img { border: 1px solid #bbb; display: block; max-width: 100%; }
  .no-print { position: fixed; top: 12px; right: 12px; }
  @media print {
    .no-print { display: none; }
    @page { margin: 1cm; size: A4 landscape; }
    .sheet-block { page-break-before: always; }
    .sheet-block:first-of-type { page-break-before: auto; }
  }
</style></head><body>`;

  html += `<h1>✂️ Plano de Corte – ${fileName}</h1>
<div class="meta">Gerado: ${now} &nbsp;|&nbsp; Chapa: ${opts.sheetWidth}(X)×${opts.sheetHeight}(Y) mm &nbsp;|&nbsp; Folga: ${opts.gap} mm &nbsp;|&nbsp; Margem: ${opts.margin} mm</div>`;

  html += `<div class="section"><div class="section-title">Resumo</div>
<div class="stats-grid">
  <div class="stat-box"><div class="stat-label">Chapas usadas</div><div class="stat-val">${result.sheets.length}</div></div>
  <div class="stat-box"><div class="stat-label">Peças posicionadas</div><div class="stat-val">${totalParts}</div></div>
  ${stats?.unplaced ? `<div class="stat-box"><div class="stat-label" style="color:#c00">Não posicionadas</div><div class="stat-val" style="color:#c00">${stats.unplaced}</div></div>` : ""}
  <div class="stat-box"><div class="stat-label">Aproveitamento</div><div class="stat-val">${stats ? (stats.utilization * 100).toFixed(1) : "–"}%</div></div>
</div></div>`;

  html += `<div class="section"><div class="section-title">Chapas de Corte</div>`;
  for (let si = 0; si < result.sheets.length; si++) {
    const sh = result.sheets[si];
    html += `<div class="sheet-block">
<div class="sheet-label">Chapa ${si + 1} — ${sh.length} peça(s) — ${opts.sheetWidth}×${opts.sheetHeight} mm</div>
<img class="sheet-img" src="${sheetDataUrls[si]}" />
</div>`;
  }
  html += `</div>`;

  html += `<div class="no-print"><button onclick="window.print()" style="background:#111;color:#fff;border:none;padding:10px 20px;font-size:14px;cursor:pointer;font-family:monospace;">🖨️ Imprimir Corte</button></div>`;
  html += `</body></html>`;

  win.document.write(html);
  win.document.close();
  setTimeout(() => win.focus(), 300);
}

// ─── Impressão separada: Plano de LED ────────────────────────────────────────
function printLedPlan(
  groups: ReturnType<typeof groupParts>,
  ledModels: LedModel[],
  selectedLedId: string | null,
  ledAssignments: LedAssignment,
  ledSummary: { rows: any[]; totalLeds: number; totalPower: number } | null,
  letterThicknessMm: number | null,
  engine: LedEngine,
  numCenterlines: number,
  fileName: string,
) {
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) { alert("Permita popups para imprimir."); return; }

  const resolveLed = (groupKey: string): LedModel | null => {
    const assignedId = ledAssignments[groupKey] ?? selectedLedId;
    return ledModels.find((l) => l.id === assignedId) ?? null;
  };

  // Renderiza cada grupo em canvas individual (alta resolução para impressão)
  const ledUrls: string[] = [];
  for (const g of groups) {
    const ledModel = resolveLed(g.key);
    const poly = g.parts[0]?.outer ?? [];
    const holes = g.parts[0]?.holes ?? [];

    // Escala para impressão: ao menos 200px de largura, máx 350px
    const S = Math.min(5, Math.max(1, 280 / Math.max(g.width, g.height)));
    const pw = Math.round(g.width * S);
    const ph = Math.round(g.height * S);
    const PAD = 28;
    const FOOTER = 60;
    const cw = pw + 2 * PAD;
    const ch = ph + 2 * PAD + FOOTER;

    const canvas = document.createElement("canvas");
    canvas.width = cw * 2; canvas.height = ch * 2; // 2x para HiDPI
    const ctx = canvas.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);

    const ox = PAD, oy = PAD;

    if (poly.length > 0) {
      let pminX = Infinity, pminY = Infinity;
      for (const p of poly) { if (p.x < pminX) pminX = p.x; if (p.y < pminY) pminY = p.y; }
      const toS = (p: { x: number; y: number }) => ({ x: ox + (p.x - pminX) * S, y: oy + (p.y - pminY) * S });

      // Forma da peça
      ctx.beginPath();
      const sp0 = toS(poly[0]); ctx.moveTo(sp0.x, sp0.y);
      for (let i = 1; i < poly.length; i++) { const sp = toS(poly[i]); ctx.lineTo(sp.x, sp.y); }
      ctx.closePath();
      ctx.fillStyle = "#e8f4fd"; ctx.fill();
      ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1.5; ctx.stroke();

      // Furos
      for (const hole of holes) {
        if (!hole.length) continue;
        ctx.beginPath();
        const sh0 = toS(hole[0]); ctx.moveTo(sh0.x, sh0.y);
        for (let i = 1; i < hole.length; i++) { const sh = toS(hole[i]); ctx.lineTo(sh.x, sh.y); }
        ctx.closePath();
        ctx.fillStyle = "#fff"; ctx.fill();
        ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 1; ctx.stroke();
      }

      // LEDs
      if (ledModel) {
        const { positions, bestRotation: partRot, numLines } = calcLedsForPart(poly, holes, ledModel, letterThicknessMm, engine, numCenterlines);
        // Tamanho visual real do LED
        const rawW = partRot === 90 ? ledModel.heightMm : ledModel.widthMm;
        const rawH = partRot === 90 ? ledModel.widthMm : ledModel.heightMm;
        const ledDispW = Math.max(2, rawW * S);
        const ledDispH = Math.max(2, rawH * S);

        for (const pos of positions) {
          const lx = ox + (pos.x - pminX) * S;
          const ly = oy + (pos.y - pminY) * S;

          if (engine === "centerline") {
            ctx.beginPath();
            ctx.arc(lx, ly, Math.min(ledDispW, ledDispH) / 2, 0, Math.PI * 2);
            ctx.fillStyle = "#facc15"; ctx.fill();
            ctx.strokeStyle = "#92400e"; ctx.lineWidth = 0.5; ctx.stroke();
          } else {
            ctx.fillStyle = "#facc15"; ctx.strokeStyle = "#d97706"; ctx.lineWidth = 0.5;
            ctx.fillRect(lx - ledDispW / 2, ly - ledDispH / 2, ledDispW, ledDispH);
            ctx.strokeRect(lx - ledDispW / 2, ly - ledDispH / 2, ledDispW, ledDispH);
          }
        }

        // Dimensões reais indicadas na figura
        const { totalLeds, pitchX, pitchY } = calcLedsForPart(poly, holes, ledModel, letterThicknessMm, engine, numCenterlines);
        // Setas de cota: largura X
        ctx.strokeStyle = "#374151"; ctx.lineWidth = 0.7; ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.moveTo(ox, oy + ph + 8); ctx.lineTo(ox + pw, oy + ph + 8); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#111"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${g.width.toFixed(0)} mm`, ox + pw / 2, oy + ph + 7);

        // Footer
        const ledInfo = ledModel ? `LED: ${ledModel.widthMm}×${ledModel.heightMm}mm (calc: ${(ledModel.widthMm - 2).toFixed(1)}×${(ledModel.heightMm - 1).toFixed(1)}mm)` : "Sem LED";
        const lineInfo = engine === "centerline" ? ` · ${numLines} linha${numLines > 1 ? "s" : ""}` : "";
        ctx.fillStyle = "#111"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(`${g.width.toFixed(0)}(X) × ${g.height.toFixed(0)}(Y) mm  |  ×${g.quantity} pç`, cw / 2, oy + ph + 16);
        ctx.font = "8px monospace";
        ctx.fillText(`${totalLeds} LEDs  |  Pitch: ↔${pitchX.toFixed(1)} ↕${pitchY.toFixed(1)} mm${lineInfo}`, cw / 2, oy + ph + 28);
        ctx.fillText(ledInfo, cw / 2, oy + ph + 40);
      }
    } else {
      // Bbox fallback
      ctx.fillStyle = "#e8f4fd"; ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1.5;
      ctx.fillRect(ox, oy, pw, ph); ctx.strokeRect(ox, oy, pw, ph);
      if (ledModel) {
        const { totalLeds, pitchX, pitchY } = calcLedsForBbox(g.width, g.height, ledModel, letterThicknessMm);
        ctx.fillStyle = "#111"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(`${g.width.toFixed(0)}(X) × ${g.height.toFixed(0)}(Y) mm | ${totalLeds} LEDs | ×${g.quantity}`, cw / 2, oy + ph + 8);
        ctx.font = "8px monospace";
        ctx.fillText(`Pitch: ↔${pitchX.toFixed(1)} ↕${pitchY.toFixed(1)} mm | LED: ${ledModel.widthMm}×${ledModel.heightMm}mm`, cw / 2, oy + ph + 20);
      }
    }

    ledUrls.push(canvas.toDataURL("image/png", 1.0));
  }

  const now = new Date().toLocaleString("pt-BR");
  const thicknessInfo = letterThicknessMm ? `Espessura Z: ${letterThicknessMm}mm · Pitch: ${calcPitchFromLetterThickness(letterThicknessMm).toFixed(1)}mm` : `Espessura Z: ${DEFAULT_LETTER_THICKNESS_MM}mm (padrão) · Pitch: ${calcPitchFromLetterThickness(DEFAULT_LETTER_THICKNESS_MM).toFixed(1)}mm`;

  let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Plano de LED – ${fileName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: #fff; color: #111; padding: 20px; }
  h1 { font-size: 17px; font-weight: 700; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 4px; }
  .meta { font-size: 10px; color: #555; margin-bottom: 16px; }
  .section { margin-bottom: 24px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #ccc; padding-bottom: 3px; margin-bottom: 10px; color: #333; }
  .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
  .stat-box { border: 1px solid #ddd; padding: 8px; }
  .stat-label { font-size: 8px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-val { font-size: 18px; font-weight: 700; }
  .led-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .led-card { border: 1px solid #ddd; padding: 8px; page-break-inside: avoid; background: #fafafa; }
  .led-img { display: block; border: 1px solid #eee; max-width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { background: #f3f4f6; text-align: right; padding: 5px 8px; border: 1px solid #ddd; font-weight: 700; }
  th:first-child { text-align: left; }
  td { padding: 4px 8px; border: 1px solid #eee; text-align: right; }
  td:first-child { text-align: left; }
  tr:nth-child(even) td { background: #f9fafb; }
  .total-row td { font-weight: 700; background: #f3f4f6 !important; border-top: 2px solid #bbb; }
  .legend { font-size: 9px; color: #555; margin-top: 6px; font-style: italic; }
  .no-print { position: fixed; top: 12px; right: 12px; }
  @media print {
    .no-print { display: none; }
    @page { margin: 1cm; size: A4 portrait; }
    .led-card { page-break-inside: avoid; }
  }
</style></head><body>`;

  html += `<h1>💡 Plano de Posicionamento LED – ${fileName}</h1>
<div class="meta">Gerado: ${now} &nbsp;|&nbsp; ${thicknessInfo} &nbsp;|&nbsp; Motor: ${engine === "centerline" ? "Linha Central" : "Grid"}</div>`;

  if (ledSummary) {
    html += `<div class="section"><div class="section-title">Resumo de LEDs</div>
<div class="stats-grid">
  <div class="stat-box"><div class="stat-label">Total de LEDs</div><div class="stat-val">${ledSummary.totalLeds.toLocaleString("pt-BR")}</div></div>
  <div class="stat-box"><div class="stat-label">Potência total</div><div class="stat-val">${ledSummary.totalPower.toFixed(1)} W</div></div>
  <div class="stat-box"><div class="stat-label">Motor</div><div class="stat-val" style="font-size:13px">${engine === "centerline" ? "Linha Central" : "Grid"}</div></div>
</div>
<p class="legend">Dimensões: Largura = eixo X (horizontal) · Altura = eixo Y (vertical) · Espessura = eixo Z (profundidade da letra)<br>
Margem de respiro: −2mm na largura, −1mm na altura do módulo para cálculo</p>
</div>`;
  }

  if (ledUrls.length) {
    html += `<div class="section"><div class="section-title">Posicionamento por Peça</div>
<div class="led-grid">`;
    groups.forEach((g, gi) => {
      html += `<div class="led-card"><img class="led-img" src="${ledUrls[gi]}" /></div>`;
    });
    html += `</div></div>`;
  }

  if (ledSummary) {
    html += `<div class="section"><div class="section-title">Detalhamento por Modelo</div>
<table><thead><tr>
<th>Dimensões (X×Y mm)</th><th>LED</th><th>Qtd peças</th><th>Pitch X (mm)</th><th>Pitch Y (mm)</th><th>LEDs/peça</th><th>Total LEDs</th><th>Potência (W)</th>
</tr></thead><tbody>`;
    for (const row of ledSummary.rows) {
      html += `<tr><td>${row.width.toFixed(0)} × ${row.height.toFixed(0)}</td><td>${row.ledName}</td><td>${row.qty}</td><td>${row.pitchX.toFixed(1)}</td><td>${row.pitchY.toFixed(1)}</td><td>${row.ledsPerPiece}</td><td>${row.totalLeds}</td><td>${row.totalPower.toFixed(1)}</td></tr>`;
    }
    html += `</tbody><tfoot><tr class="total-row"><td colspan="6">TOTAL</td><td>${ledSummary.totalLeds.toLocaleString("pt-BR")}</td><td>${ledSummary.totalPower.toFixed(1)}</td></tr></tfoot></table></div>`;
  }

  html += `<div class="no-print"><button onclick="window.print()" style="background:#f59e0b;color:#111;border:none;padding:10px 20px;font-size:14px;cursor:pointer;font-family:monospace;font-weight:700;">🖨️ Imprimir LED</button></div>`;
  html += `</body></html>`;

  win.document.write(html);
  win.document.close();
  setTimeout(() => win.focus(), 300);
}

// ─── Main App ──────────────────────────────────────────────────────────────
export default function NestingApp() {
  const [fileName, setFileName] = useState("");
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [parts, setParts] = useState<ParsedPart[]>([]);
  const [groups, setGroups] = useState<ReturnType<typeof groupParts>>([]);
  const [parsing, setParsing] = useState(false);
  const [nesting, setNesting] = useState(false);
  const [result, setResult] = useState<NestResult | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"nesting" | "leds" | "ledcad">("nesting");
  const [opts, setOpts] = useState<NestingOptions>({ sheetWidth: 2750, sheetHeight: 1830, gap: 5, margin: 10, allowRotation: true, allowMirror: false, priority: "yield" });

  // LED state — persisted in localStorage
  const [ledModels, setLedModels] = useState<LedModel[]>(() => {
    try {
      const saved = localStorage.getItem("nestcnc_led_models_v10");
      if (saved) {
        const parsed = JSON.parse(saved);
        // Migração: renomeia width→widthMm, height→heightMm se necessário
        return parsed.map((l: any) => ({
          ...l,
          widthMm: l.widthMm ?? l.width ?? 5,
          heightMm: l.heightMm ?? l.height ?? 5,
        }));
      }
      return [];
    } catch { return []; }
  });
  const [selectedLedId, setSelectedLedId] = useState<string | null>(() => {
    try { return localStorage.getItem("nestcnc_led_selected"); } catch { return null; }
  });
  const [ledAssignments, setLedAssignments] = useState<LedAssignment>({});
  // Espessura da letra (eixo Z) para cálculo de pitch
  const [letterThicknessMm, setLetterThicknessMm] = useState<number | null>(null);
  const [letterThicknessInput, setLetterThicknessInput] = useState("");
  // Motor de cálculo
  const [ledEngine, setLedEngine] = useState<LedEngine>("centerline");
  // Número de linhas de LEDs no modo centerline
  const [numCenterlines, setNumCenterlines] = useState(1);

  const [showLeds, setShowLeds] = useState(true);
  const [renderedLedId, setRenderedLedId] = useState<string | null>(null);
  const [ledKey, setLedKey] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) => setOpts((p) => ({ ...p, [key]: val }));

  const selectedLed = ledModels.find((l) => l.id === selectedLedId) ?? null;

  const assignLedToGroup = useCallback((groupKey: string, ledId: string) => {
    setLedAssignments((prev) => ({ ...prev, [groupKey]: ledId }));
    setLedKey((k) => k + 1);
  }, []);

  const clearGroupAssignment = useCallback((groupKey: string) => {
    setLedAssignments((prev) => {
      const next = { ...prev };
      delete next[groupKey];
      return next;
    });
    setLedKey((k) => k + 1);
  }, []);

  const handleUpdateLed = useCallback(() => {
    setLedKey((k) => k + 1);
    setRenderedLedId(selectedLedId);
  }, [selectedLedId]);

  useEffect(() => {
    if (selectedLedId && renderedLedId === null) {
      setRenderedLedId(selectedLedId);
      setLedKey((k) => k + 1);
    }
  }, [selectedLedId]);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    if (file.type !== "application/pdf") { alert("Selecione um PDF."); e.target.value = ""; return; }
    try {
      const buffer = await file.arrayBuffer();
      setPdfBuffer(buffer); setFileName(file.name); setParts([]); setGroups([]); setResult(null); setParseError(null);
    } catch { alert("Não foi possível ler o arquivo."); } finally { e.target.value = ""; }
  };

  const onParse = async () => {
    if (!pdfBuffer || parsing) return;
    setParsing(true); setResult(null); setParseError(null);
    try {
      const p = await parsePdf(pdfBuffer);
      if (!p.length) { setParseError("Nenhuma geometria vetorial válida encontrada."); }
      else { setParts(p); setGroups(groupParts(p)); }
    } catch (e) { setParseError((e as Error).message); } finally { setParsing(false); }
  };

  const onNest = useCallback(async () => {
    if (!parts.length) return;
    setNesting(true);
    try { const r = runNesting(parts, opts); setResult(r); setActiveSheet(0); } finally { setNesting(false); }
  }, [parts, opts]);

  // Persistência
  useEffect(() => {
    try { localStorage.setItem("nestcnc_led_models_v10", JSON.stringify(ledModels)); } catch {}
  }, [ledModels]);
  useEffect(() => {
    try {
      if (selectedLedId) localStorage.setItem("nestcnc_led_selected", selectedLedId);
      else localStorage.removeItem("nestcnc_led_selected");
    } catch {}
  }, [selectedLedId]);

  const redraw = useCallback(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    renderSheet(canvasRef.current, result.sheets[activeSheet] ?? [], opts.sheetWidth, opts.sheetHeight, opts.margin, selectedLed, showLeds, letterThicknessMm);
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin, selectedLed, showLeds, letterThicknessMm]);

  useEffect(() => { redraw(); }, [redraw]);
  useEffect(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    const obs = new ResizeObserver(redraw);
    obs.observe(containerRef.current!);
    return () => obs.disconnect();
  }, [redraw]);

  const stats = useMemo(() => {
    if (!result) return null;
    const placed = result.sheets.reduce((s, sh) => s + sh.length, 0);
    const sheetArea = opts.sheetWidth * opts.sheetHeight;
    const perSheet = result.sheets.map((sh, i) => {
      const bboxUsed = sh.reduce((s, p) => s + p.bboxArea, 0);
      const polyUsed = sh.reduce((s, p) => s + p.area, 0);
      let maxX = opts.margin, maxY = opts.margin;
      for (const p of sh) { if (p.bbox.maxX > maxX) maxX = p.bbox.maxX; if (p.bbox.maxY > maxY) maxY = p.bbox.maxY; }
      const leftoverW = Math.max(0, opts.sheetWidth - maxX - opts.margin);
      const leftoverH = Math.max(0, opts.sheetHeight - 2 * opts.margin);
      return { index: i + 1, count: sh.length, bboxUtil: sheetArea > 0 ? bboxUsed / sheetArea : 0, polyUtil: sheetArea > 0 ? polyUsed / sheetArea : 0, bboxArea: bboxUsed, polyArea: polyUsed, wasteArea: sheetArea - bboxUsed, leftoverW, leftoverH };
    });
    return { placed, unplaced: result.unplaced.length, models: groups.length, total: parts.length, utilization: result.utilization, sheets: result.sheets.length, totalBboxArea: result.totalBboxArea, totalPartArea: result.totalPartArea, totalSheetArea: result.totalSheetArea, sheetArea, perSheet };
  }, [result, parts, groups, opts.sheetWidth, opts.sheetHeight, opts.margin]);

  // Resumo de LEDs
  const ledSummary = useMemo(() => {
    if (!groups.length || !ledModels.length) return null;
    const hasAnyLed = groups.some((g) => {
      const id = ledAssignments[g.key] ?? selectedLedId;
      return !!id && ledModels.some((l) => l.id === id);
    });
    if (!hasAnyLed) return null;

    const rows = groups.map((g) => {
      const assignedId = ledAssignments[g.key] ?? selectedLedId;
      const ledModel = ledModels.find((l) => l.id === assignedId) ?? null;
      if (!ledModel) return { width: g.width, height: g.height, qty: g.quantity, ledsPerPiece: 0, ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, totalPower: 0, ledName: "–" };

      const poly = g.parts[0]?.outer ?? [];
      const holes = g.parts[0]?.holes ?? [];
      let totalLeds = 0, pitch = 0, pitchX = 0, pitchY = 0;
      if (poly.length) {
        const r = calcLedsForPart(poly, holes, ledModel, letterThicknessMm, ledEngine, numCenterlines);
        totalLeds = r.totalLeds; pitch = r.pitch; pitchX = r.pitchX; pitchY = r.pitchY;
      } else {
        const r = calcLedsForBbox(g.width, g.height, ledModel, letterThicknessMm);
        totalLeds = r.totalLeds; pitch = r.pitch; pitchX = r.pitchX; pitchY = r.pitchY;
      }
      const { ledsX, ledsY } = calcLedsForBbox(g.width, g.height, ledModel, letterThicknessMm);
      const totalPower = totalLeds * ledModel.power * g.quantity;
      return { width: g.width, height: g.height, qty: g.quantity, ledsPerPiece: totalLeds, ledsX, ledsY, totalLeds: totalLeds * g.quantity, pitch, pitchX, pitchY, totalPower, ledName: ledModel.name };
    });
    const totalLeds = rows.reduce((s, r) => s + r.totalLeds, 0);
    const totalPower = rows.reduce((s, r) => s + r.totalPower, 0);
    return { rows, totalLeds, totalPower };
  }, [groups, ledModels, selectedLedId, ledAssignments, letterThicknessMm, ledKey, ledEngine, numCenterlines]);

  const colorLegend = useMemo(() => {
    if (!result) return [];
    const m = new Map<string, string>(); let idx = 0;
    for (const sh of result.sheets) for (const p of sh) if (!m.has(p.groupSig)) m.set(p.groupSig, getColor(p.groupSig, idx++));
    return groups.map((g) => ({ label: `${g.width.toFixed(0)}×${g.height.toFixed(0)} mm`, qty: g.quantity, color: m.get(g.key) ?? "#888" }));
  }, [result, groups]);

  const currentSheetParts = result?.sheets[activeSheet] ?? [];
  const activeLedForDisplay = ledModels.find((l) => l.id === renderedLedId) ?? null;
  const computedPitch = letterThicknessMm && letterThicknessMm > 0 ? calcPitchFromLetterThickness(letterThicknessMm) : calcPitchFromLetterThickness(DEFAULT_LETTER_THICKNESS_MM);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <button
          onClick={() => window.location.reload()}
          className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-80"
          title="Recarregar página"
        >
          <Layers className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-base font-semibold tracking-tight">NestCNC</h1>
          <p className="text-xs text-muted-foreground">Aproveitamento automático de chapas</p>
          <p className="text-[10px] text-muted-foreground/60 leading-none mt-0.5">vers {APP_VERSION}</p>
        </div>
        <div className="ml-auto flex gap-1 rounded-lg border border-border p-1">
          <button onClick={() => setActiveTab("nesting")} className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${activeTab === "nesting" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Layers className="h-3.5 w-3.5" /> Nesting
          </button>
          <button onClick={() => setActiveTab("leds")} className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${activeTab === "leds" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Lightbulb className="h-3.5 w-3.5" /> LEDs
          </button>
          <button onClick={() => setActiveTab("ledcad")} className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${activeTab === "ledcad" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <Package className="h-3.5 w-3.5" /> Cadastro LED
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-72 flex-col gap-5 overflow-y-auto border-r border-border bg-card p-4">
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">PDF Vetorial</h2>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-background p-4 text-center transition-colors hover:border-primary/50">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{fileName || "Clique ou arraste um PDF"}</span>
              <input type="file" accept="application/pdf" className="hidden" onChange={onFileChange} />
            </label>
            <Button onClick={onParse} disabled={!pdfBuffer || parsing} className="mt-3 w-full" variant="secondary">
              {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Interpretar PDF
            </Button>
            {parseError && (
              <div className="mt-2 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div><p className="font-medium">Erro ao interpretar</p>{parseError.split("\n").map((l, i) => <p key={i} className="mt-0.5">{l}</p>)}</div>
              </div>
            )}
            {parts.length > 0 && !parseError && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-xs text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{parts.length} peça{parts.length !== 1 ? "s" : ""} ({groups.length} modelo{groups.length !== 1 ? "s" : ""})</span>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chapa</h2>
            <div className="grid grid-cols-2 gap-3">
              <NumericField label="Largura (X)" unit="mm" value={opts.sheetWidth} onChange={(v) => setOpt("sheetWidth", v)} min={1} />
              <NumericField label="Altura (Y)" unit="mm" value={opts.sheetHeight} onChange={(v) => setOpt("sheetHeight", v)} min={1} />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Processo</h2>
            <div className="grid grid-cols-2 gap-3">
              <NumericField label="Folga" unit="mm" value={opts.gap} onChange={(v) => setOpt("gap", v)} />
              <NumericField label="Margem" unit="mm" value={opts.margin} onChange={(v) => setOpt("margin", v)} />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between"><Label className="text-xs">Permitir rotação</Label><Switch checked={opts.allowRotation} onCheckedChange={(v) => setOpt("allowRotation", v)} /></div>
              <div className="flex items-center justify-between"><Label className="text-xs">Permitir espelhamento</Label><Switch checked={opts.allowMirror} onCheckedChange={(v) => setOpt("allowMirror", v)} /></div>
            </div>
            <div className="mt-3 flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Prioridade</Label>
              <Select value={opts.priority} onValueChange={(v) => setOpt("priority", v as NestingOptions["priority"])}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="yield">Maior aproveitamento</SelectItem>
                  <SelectItem value="speed">Menor tempo de corte</SelectItem>
                  <SelectItem value="sheets">Menor número de chapas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <Button onClick={onNest} disabled={!parts.length || nesting} className="w-full">
            {nesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />} Calcular Nesting
          </Button>

          {/* Botões de impressão separados */}
          {result && (
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="w-full border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white"
                onClick={() => printCutPlan(result, opts, fileName || "sem-nome.pdf", stats)}
              >
                <Printer className="mr-2 h-4 w-4" /> Imprimir Plano de Corte
              </Button>
              {groups.length > 0 && ledModels.length > 0 && (
                <Button
                  variant="outline"
                  className="w-full border-yellow-600/50 text-yellow-300 hover:bg-yellow-900/20"
                  onClick={() => printLedPlan(groups, ledModels, selectedLedId, ledAssignments, ledSummary, letterThicknessMm, ledEngine, numCenterlines, fileName || "sem-nome.pdf")}
                >
                  <Zap className="mr-2 h-4 w-4" /> Imprimir Plano de LED
                </Button>
              )}
            </div>
          )}

          {/* LED overlay toggle (no nesting) */}
          {result && ledModels.length > 0 && (
            <section className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-yellow-400/80">Visualização LED no Nesting</h2>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs">Mostrar LEDs</Label>
                <Switch checked={showLeds} onCheckedChange={setShowLeds} />
              </div>
              {showLeds && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Modelo ativo</Label>
                    <Select value={selectedLedId ?? ""} onValueChange={(v) => { setSelectedLedId(v); }}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                      <SelectContent>
                        {ledModels.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name} ({l.widthMm}×{l.heightMm}mm)</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedLedId && (
                    <Button onClick={handleUpdateLed} variant="outline" className="w-full h-8 text-xs border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10">
                      <RefreshCw className="h-3.5 w-3.5 mr-1" /> Atualizar LED
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}

          {stats && (
            <div className="rounded-md border border-border bg-background p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Peças total</span><span>{stats.total}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Modelos</span><span>{stats.models}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Posicionadas</span><span>{stats.placed}</span></div>
              {stats.unplaced > 0 && <div className="flex justify-between text-destructive"><span>Não posicionadas</span><span>{stats.unplaced}</span></div>}
              <div className="flex justify-between font-medium"><span className="text-muted-foreground">Aproveit. retangular</span><span className="text-green-400">{(stats.utilization * 100).toFixed(1)}%</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Chapas</span><span>{stats.sheets}</span></div>
            </div>
          )}

          {colorLegend.length > 0 && (
            <div className="rounded-md border border-border bg-background p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Legenda</p>
              <div className="space-y-1.5">
                {colorLegend.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <div className="h-3 w-3 rounded-sm flex-shrink-0" style={{ backgroundColor: c.color }} />
                    <span className="flex-1">{c.label}</span>
                    <span className="text-muted-foreground">×{c.qty}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* ── NESTING TAB ── */}
          {activeTab === "nesting" && (
            <>
              <main ref={containerRef} className="relative flex flex-1 items-center justify-center bg-background overflow-hidden">
                {result ? (
                  <canvas ref={canvasRef} className="block" />
                ) : (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="rounded-full border border-border p-4"><Layers className="h-8 w-8 text-muted-foreground/40" /></div>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      {parts.length > 0 ? "Clique em Calcular Nesting para visualizar as peças na chapa" : "Importe um PDF vetorial e clique em Interpretar PDF"}
                    </p>
                  </div>
                )}
                {result && result.sheets.length > 1 && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
                    <button onClick={() => setActiveSheet((s) => Math.max(0, s - 1))} disabled={activeSheet === 0} className="disabled:opacity-30 hover:text-primary"><ChevronLeft className="h-4 w-4" /></button>
                    <span className="text-xs font-medium">
                      Chapa {activeSheet + 1} / {result.sheets.length}
                      <span className="ml-2 text-muted-foreground">({currentSheetParts.length} peça{currentSheetParts.length !== 1 ? "s" : ""})</span>
                    </span>
                    <button onClick={() => setActiveSheet((s) => Math.min(result.sheets.length - 1, s + 1))} disabled={activeSheet === result.sheets.length - 1} className="disabled:opacity-30 hover:text-primary"><ChevronRight className="h-4 w-4" /></button>
                  </div>
                )}
              </main>

              <div className="grid grid-cols-2 border-t border-border">
                <div className="border-r border-border p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Peças Detectadas</h3>
                  {groups.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nenhuma peça detectada ainda.</p>
                  ) : (
                    <div className="space-y-1 text-xs max-h-28 overflow-y-auto pr-1">
                      {groups.map((g, i) => (
                        <div key={i} className="flex justify-between gap-4">
                          <span className="text-muted-foreground">{g.width.toFixed(0)}(X) × {g.height.toFixed(0)}(Y) mm</span>
                          <span className="font-medium">× {g.quantity}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Relatório Técnico</h3>
                  {!stats ? (
                    <p className="text-xs text-muted-foreground">Execute o nesting para gerar o relatório.</p>
                  ) : (
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-muted-foreground">Chapas usadas</span><span>{stats.sheets}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Peças posicionadas</span><span>{stats.placed}/{stats.total}</span></div>
                      {stats.unplaced > 0 && <div className="flex justify-between text-destructive"><span>Sem posição</span><span>{stats.unplaced}</span></div>}
                      <div className="border-t border-border pt-2 mt-1">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">Aproveitamento (retangular)</p>
                        <div className="flex justify-between font-bold text-green-400"><span className="text-muted-foreground font-normal">Geral</span><span>{(stats.utilization * 100).toFixed(1)}%</span></div>
                        {stats.perSheet.map((s: any) => (
                          <div key={s.index} className="flex justify-between text-muted-foreground">
                            <span>Chapa {s.index} ({s.count} pç)</span>
                            <span className={s.bboxUtil >= 0.7 ? "text-green-400" : s.bboxUtil >= 0.5 ? "text-yellow-400" : "text-red-400"}>{(s.bboxUtil * 100).toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-border pt-2">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">Sobra útil por chapa</p>
                        {stats.perSheet.map((s: any) => (
                          <div key={s.index} className="flex justify-between">
                            <span className="text-muted-foreground">Chapa {s.index}</span>
                            <span className="text-emerald-400 font-mono font-semibold">
                              {s.leftoverW.toFixed(0)} × {s.leftoverH.toFixed(0)} mm
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── LEDs TAB ── */}
          {activeTab === "leds" && (
            <div className="flex flex-1 overflow-hidden">
              {/* Painel de controles */}
              <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-card p-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-yellow-500/20">
                    <Lightbulb className="h-3.5 w-3.5 text-yellow-400" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">Calculadora de LEDs</h2>
                    <p className="text-[10px] text-muted-foreground">Posicionamento automático por forma real</p>
                  </div>
                </div>

                {/* Motor de cálculo */}
                <div className="rounded-lg border border-border bg-background p-3 flex flex-col gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Motor de Cálculo</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => { setLedEngine("centerline"); setLedKey((k) => k + 1); }}
                      className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[10px] font-medium transition-all ${ledEngine === "centerline" ? "border-yellow-500/60 bg-yellow-500/10 text-yellow-300" : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"}`}
                    >
                      <span className="text-base">〰️</span>
                      <span>Linha Central</span>
                      <span className="text-[9px] opacity-60">esqueleto da forma</span>
                    </button>
                    <button
                      onClick={() => { setLedEngine("grid"); setLedKey((k) => k + 1); }}
                      className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[10px] font-medium transition-all ${ledEngine === "grid" ? "border-blue-500/60 bg-blue-500/10 text-blue-300" : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"}`}
                    >
                      <span className="text-base">⊞</span>
                      <span>Grid</span>
                      <span className="text-[9px] opacity-60">grade filtrada</span>
                    </button>
                  </div>
                  <p className="text-[9px] text-muted-foreground/60 italic">
                    {ledEngine === "centerline"
                      ? "LEDs no centro da espessura, ao longo do comprimento"
                      : "Grade uniforme com filtro pela forma real do polígono"}
                  </p>
                </div>

                {/* Linhas de LED (apenas centerline) */}
                {ledEngine === "centerline" && (
                  <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 flex flex-col gap-2">
                    <Label className="text-[10px] font-semibold text-yellow-300 uppercase tracking-wider">Linhas de LED (Linha Central)</Label>
                    <div className="flex gap-2 items-center">
                      <Input
                        type="number" min={1} max={10} step={1}
                        value={numCenterlines}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          if (!isNaN(v) && v >= 1) { setNumCenterlines(v); setLedKey((k) => k + 1); }
                        }}
                        className="h-7 text-xs w-20"
                      />
                      <span className="text-[10px] text-muted-foreground">linha{numCenterlines > 1 ? "s" : ""} paralela{numCenterlines > 1 ? "s" : ""}</span>
                    </div>
                    <p className="text-[9px] text-yellow-400/70">
                      1 = linha central única · 2+ = múltiplas linhas paralelas ao centro
                    </p>
                  </div>
                )}

                {/* Espessura da letra (eixo Z) para pitch */}
                <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 flex flex-col gap-2">
                  <Label className="text-[10px] font-semibold text-yellow-300 uppercase tracking-wider">Espessura da Letra · eixo Z (mm)</Label>
                  <div className="flex gap-2 items-center">
                    <Input
                      type="number" min={1} step={1} placeholder={`Ex: ${DEFAULT_LETTER_THICKNESS_MM}`}
                      value={letterThicknessInput}
                      onChange={(e) => {
                        setLetterThicknessInput(e.target.value);
                        const v = parseFloat(e.target.value);
                        setLetterThicknessMm(!isNaN(v) && v > 0 ? v : null);
                      }}
                      className="h-7 text-xs flex-1"
                    />
                    <div className="text-[10px] text-yellow-300 font-mono whitespace-nowrap">
                      → <strong>{computedPitch.toFixed(1)} mm</strong>
                    </div>
                  </div>
                  <p className="text-[9px] text-yellow-400/70">
                    Pitch = espessura Z × 0,85 (padrão: {DEFAULT_LETTER_THICKNESS_MM} mm → {calcPitchFromLetterThickness(DEFAULT_LETTER_THICKNESS_MM).toFixed(1)} mm)
                  </p>
                </div>

                {/* Seletor de LED global */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">LED padrão</Label>
                  {ledModels.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">Cadastre um LED na aba "Cadastro LED"</p>
                  ) : (
                    <div className="flex gap-2">
                      <Select value={selectedLedId ?? ""} onValueChange={(v) => { setSelectedLedId(v); }}>
                        <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                        <SelectContent>
                          {ledModels.map((l) => (
                            <SelectItem key={l.id} value={l.id}>{l.name} ({l.widthMm}×{l.heightMm}mm)</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedLedId && (
                        <Button onClick={handleUpdateLed} variant="outline" className="h-7 text-[10px] border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10 px-2">
                          <RefreshCw className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {/* Atribuição por grupo */}
                {ledModels.length > 1 && (
                  <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 flex flex-col gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-300 flex items-center gap-1">
                      <Zap className="h-3 w-3" /> LED por peça
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {groups.map((g) => {
                        const assignedId = ledAssignments[g.key] ?? selectedLedId ?? "";
                        return (
                          <div key={g.key} className="flex items-center gap-1.5">
                            <div className="text-[10px] text-muted-foreground w-24 shrink-0 font-mono truncate">
                              {g.width.toFixed(0)}×{g.height.toFixed(0)} ×{g.quantity}
                            </div>
                            <Select value={assignedId} onValueChange={(v) => assignLedToGroup(g.key, v)}>
                              <SelectTrigger className="h-6 text-[10px] flex-1"><SelectValue placeholder="padrão" /></SelectTrigger>
                              <SelectContent>
                                {ledModels.map((l) => (
                                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {ledAssignments[g.key] && (
                              <button onClick={() => clearGroupAssignment(g.key)} className="text-muted-foreground hover:text-destructive shrink-0">
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Cards de resumo */}
                {ledSummary && (
                  <div className="flex flex-col gap-2">
                    <div className="rounded-lg border border-border bg-background p-3">
                      <p className="text-[10px] text-muted-foreground mb-0.5">Total de LEDs</p>
                      <p className="text-xl font-bold text-yellow-400">{ledSummary.totalLeds.toLocaleString("pt-BR")}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg border border-border bg-background p-3">
                        <p className="text-[10px] text-muted-foreground mb-0.5">Potência</p>
                        <p className="text-base font-bold text-orange-400">{ledSummary.totalPower.toFixed(1)} W</p>
                      </div>
                      <div className="rounded-lg border border-border bg-background p-3">
                        <p className="text-[10px] text-muted-foreground mb-0.5">Pitch Z→XY</p>
                        <p className="text-base font-bold text-blue-400">{computedPitch.toFixed(1)} mm</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Tabela de detalhe */}
                {ledSummary && (
                  <div className="rounded-lg border border-border bg-background overflow-hidden">
                    <div className="px-3 py-2 border-b border-border">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Por Modelo</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Dim X×Y (mm)</th>
                            <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Qtd</th>
                            <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">LEDs/pç</th>
                            <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledSummary.rows.map((row, i) => (
                            <tr key={i} className="border-b border-border/40 hover:bg-muted/20">
                              <td className="px-2 py-1 font-mono">{row.width.toFixed(0)}×{row.height.toFixed(0)}</td>
                              <td className="px-2 py-1 text-right">{row.qty}</td>
                              <td className="px-2 py-1 text-right text-yellow-400 font-medium">{row.ledsPerPiece}</td>
                              <td className="px-2 py-1 text-right font-bold">{row.totalLeds}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-muted/30 font-semibold">
                            <td className="px-2 py-1.5 text-muted-foreground" colSpan={3}>TOTAL</td>
                            <td className="px-2 py-1.5 text-right text-yellow-400">{ledSummary.totalLeds.toLocaleString("pt-BR")}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Canvas de visualização LED */}
              <div className="flex flex-1 flex-col overflow-hidden">
                {!groups.length ? (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-sm text-muted-foreground">Importe e interprete um PDF para visualizar os LEDs.</p>
                  </div>
                ) : ledModels.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center flex-col gap-2">
                    <Zap className="h-8 w-8 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground">Cadastre um LED para calcular o posicionamento.</p>
                    <Button variant="secondary" className="mt-2 text-xs h-8" onClick={() => setActiveTab("ledcad")}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Cadastrar LED
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <div className="flex items-center justify-between border-b border-border px-4 py-2 bg-card shrink-0">
                      <div className="flex items-center gap-2">
                        <Zap className="h-3.5 w-3.5 text-yellow-400" />
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Desenho de Posicionamento
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${ledEngine === "centerline" ? "bg-yellow-500/20 text-yellow-400" : "bg-blue-500/20 text-blue-400"}`}>
                          {ledEngine === "centerline" ? `Linha Central ×${numCenterlines}` : "Grid"}
                        </span>
                      </div>
                      <Button onClick={handleUpdateLed} variant="outline" size="sm" className="h-6 text-[10px] border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10">
                        <RefreshCw className="h-3 w-3 mr-1" /> Atualizar
                      </Button>
                    </div>
                    <div className="flex-1 overflow-auto p-4">
                      <LedDrawingCanvas
                        key={ledKey}
                        groups={groups}
                        ledModels={ledModels}
                        selectedLedId={activeLedForDisplay?.id ?? selectedLedId}
                        ledAssignments={ledAssignments}
                        letterThicknessMm={letterThicknessMm}
                        engine={ledEngine}
                        numCenterlines={numCenterlines}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── LED CADASTRO TAB ── */}
          {activeTab === "ledcad" && (
            <div className="flex flex-1 flex-col overflow-y-auto p-6 gap-6">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/20">
                  <Package className="h-4 w-4 text-blue-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Cadastro de LEDs</h2>
                  <p className="text-xs text-muted-foreground">Registre os modelos de LED com dimensões visuais — o cálculo aplica margem de respiro automaticamente</p>
                </div>
              </div>
              <LedRegistrationPanel
                leds={ledModels}
                onAdd={(m) => { setLedModels((p) => [...p, m]); setSelectedLedId(m.id); }}
                onRemove={(id) => { setLedModels((p) => p.filter((l) => l.id !== id)); if (selectedLedId === id) setSelectedLedId(null); }}
                selectedId={selectedLedId}
                onSelect={setSelectedLedId}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
