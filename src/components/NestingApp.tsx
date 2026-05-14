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
import { Loader2, Upload, Layers, Play, AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Plus, Trash2, Zap, Package, RefreshCw, Printer, Brain, BookOpen, FileUp, Sparkles, CheckCheck } from "lucide-react";

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
  width: number;   // mm
  height: number;  // mm
  power: number;   // W per unit
  photoUrl?: string;
}

// ─── LED Assignment per part group ────────────────────────────────────────
// Maps groupKey -> ledModelId (or null = use global selected)
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

// ─── Improved shrink polygon (offset inward along normals) ────────────────
function shrinkPolygon(poly: Point[], margin: number): Point[] {
  const n = poly.length;
  if (n < 3) return poly;

  // Compute centroid
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;

  // For each vertex, compute the bisector of the two adjacent edge normals
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];

    // Edge vectors
    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const e2x = next.x - curr.x, e2y = next.y - curr.y;

    // Inward normals (perpendicular, pointing toward centroid)
    const len1 = Math.hypot(e1x, e1y) || 1;
    const len2 = Math.hypot(e2x, e2y) || 1;
    let n1x = -e1y / len1, n1y = e1x / len1;
    let n2x = -e2y / len2, n2y = e2x / len2;

    // Ensure normals point inward
    if (n1x * (cx - curr.x) + n1y * (cy - curr.y) < 0) { n1x = -n1x; n1y = -n1y; }
    if (n2x * (cx - curr.x) + n2y * (cy - curr.y) < 0) { n2x = -n2x; n2y = -n2y; }

    // Bisector
    let bx = n1x + n2x, by = n1y + n2y;
    const blen = Math.hypot(bx, by) || 1;
    bx /= blen; by /= blen;

    result.push({ x: curr.x + bx * margin, y: curr.y + by * margin });
  }
  return result;
}

// ─── LED Calculation Engine v12.1 ──────────────────────────────────────────────
// Motor A: GRID     — grade uniforme, pitch = tamanho do LED, mínimo 1 LED por objeto
// Motor B: AI       — usa Claude API aprendendo com exemplos de PDFs

export type LedEngine = "grid" | "ai";

// ── Exemplos de aprendizagem para o Motor IA ──────────────────────────────────
export interface AiTrainingExample {
  id: string;
  fileName: string;
  pdfDataUrl: string;   // base64 do PDF
  uploadedAt: number;
}

function calcPitchFromLetterHeight(
  letterHeight: number,
  ledW?: number,
  ledH?: number,
): number | { pitchX: number; pitchY: number } {
  // regra: espessura útil = 70%
  const usable = letterHeight * 0.7;

  // compatibilidade antiga — sem ledW/ledH retorna escalar
  if (ledW == null || ledH == null) {
    return usable;
  }

  return {
    pitchX: Math.max(ledW, usable),
    pitchY: Math.max(ledH, usable),
  };
}

// ── GRID ENGINE v12.1 — corrigido: espaçamento real por tamanho do módulo ──────
// Regras:
//  1. pitchX = ledW, pitchY = ledH (espaço real do módulo)
//  2. Grid começa no centro da primeira célula a partir do bbox da peça
//  3. Cada objeto tem pelo menos 1 LED no centróide se o grid não cobrir
//  4. Recalcula automaticamente ao mudar tamanho do LED
function calcLedsGrid(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  letterHeight: number | null,
  rotation: 0 | 90,
): { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }> } {
  if (polygon.length < 3) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [] };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const innerW = maxX - minX;
  const innerH = maxY - minY;
  if (innerW <= 0 || innerH <= 0) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [] };

  // v12.1: pitchX = largura do LED, pitchY = altura do LED (espaçamento real)
  const ledW = rotation === 90 ? ledModel.height : ledModel.width;
  const ledH = rotation === 90 ? ledModel.width : ledModel.height;

  let pitchX: number;
  let pitchY: number;

  if (letterHeight && letterHeight > 0) {
    const adaptive = calcPitchFromLetterHeight(
      letterHeight,
      ledW,
      ledH,
    ) as { pitchX: number; pitchY: number };

    pitchX = adaptive.pitchX;
    pitchY = adaptive.pitchY;
  } else {
    // Pitch real = dimensão do módulo LED
    pitchX = ledW > 0 ? ledW : 1;
    pitchY = ledH > 0 ? ledH : 1;
  }

  // (colmeia usa bbox direto de workPoly, não precisa de cols/rows fixos)
  // margem dinâmica — afasta LEDs da borda
  const insetMargin = Math.min(pitchX, pitchY) * 0.35;

  // polígono interno (offset para dentro)
  const workPoly = shrinkPolygon(polygon, insetMargin);

  const positions: Array<{ x: number; y: number }> = [];

  // bbox do polígono interno
  let wMinX = Infinity, wMinY = Infinity, wMaxX = -Infinity, wMaxY = -Infinity;
  for (const p of workPoly) {
    if (p.x < wMinX) wMinX = p.x;
    if (p.x > wMaxX) wMaxX = p.x;
    if (p.y < wMinY) wMinY = p.y;
    if (p.y > wMaxY) wMaxY = p.y;
  }

  // distribuição adaptativa tipo colmeia (offset em linhas alternadas)
  for (let y = wMinY + pitchY / 2; y <= wMaxY; y += pitchY) {
    const rowOffset =
      Math.floor((y - wMinY) / pitchY) % 2 === 0
        ? 0
        : pitchX / 2;

    for (let x = wMinX + pitchX / 2 + rowOffset; x <= wMaxX; x += pitchX) {
      const pt = { x, y };

      // dentro do polígono interno
      if (!pointInPoly(pt, workPoly)) continue;

      // ignora furos
      let inHole = false;
      for (const hole of holes) {
        if (pointInPoly(pt, hole)) { inHole = true; break; }
      }
      if (inHole) continue;

      positions.push(pt);
    }
  }

  // Garantia: ao menos 1 LED no centróide se nenhum foi posicionado
  if (positions.length === 0) {
    let cx = 0, cy = 0;
    for (const p of polygon) { cx += p.x; cy += p.y; }
    cx /= polygon.length; cy /= polygon.length;
    const centroid = { x: cx, y: cy };
    if (pointInPoly(centroid, polygon)) {
      let inHole = false;
      for (const hole of holes) { if (pointInPoly(centroid, hole)) { inHole = true; break; } }
      if (!inHole) positions.push(centroid);
    }
  }

  const pitchBase = Math.max(pitchX, pitchY);
  return { totalLeds: positions.length, pitch: pitchBase, pitchX, pitchY, positions };
}

// ── AI ENGINE — posições calculadas por Claude API ────────────────────────────
// Cache de resultados por hash do polígono + ledModel + letterHeight
const aiLedCache = new Map<string, { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }> }>();

function polyHash(polygon: Point[], ledModel: LedModel, letterHeight: number | null, rotation: 0 | 90): string {
  const pts = polygon.slice(0, 8).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("|");
  return `${pts}_${ledModel.width}x${ledModel.height}_lh${letterHeight}_rot${rotation}`;
}

async function calcLedsAI(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  letterHeight: number | null,
  trainingExamples: AiTrainingExample[],
): Promise<{ totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }> }> {
  const hash = polyHash(polygon, ledModel, letterHeight, 0);
  if (aiLedCache.has(hash)) return aiLedCache.get(hash)!;

  if (polygon.length < 3) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [] };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const W = maxX - minX, H = maxY - minY;

  // Resumo do polígono (primeiros 20 pontos)
  const polyStr = polygon.slice(0, 20).map(p => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(", ");
  const holesStr = holes.map(h => `[${h.slice(0, 6).map(p => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`).join(",")}]`).join("; ");

  const trainingContext = trainingExamples.length > 0
    ? `Você tem ${trainingExamples.length} exemplo(s) de treinamento carregados: ${trainingExamples.map(e => e.fileName).join(", ")}. Use-os como referência de padrões de posicionamento LED em letras/formas de luminoso.`
    : "Nenhum exemplo de treinamento carregado ainda. Use seu conhecimento de luminosos e letras iluminadas.";

  const pitchInstr = letterHeight && letterHeight > 0
    ? `Altura da letra: ${letterHeight}mm → pitch recomendado: ${(
        calcPitchFromLetterHeight(letterHeight, ledModel.width, ledModel.height) as { pitchX: number; pitchY: number }
      ).pitchX.toFixed(1)}mm`
    : `Sem altura de letra. Use o módulo LED como pitch: ${Math.max(ledModel.width, ledModel.height)}mm`;

  const prompt = `Você é um especialista em posicionamento de LEDs em letras e formas para luminosos (letreiros luminosos, fachadas, letras em acrílico/metal).

${trainingContext}

PEÇA A CALCULAR:
- Dimensões do bounding box: ${W.toFixed(1)} × ${H.toFixed(1)} mm
- Polígono (${polygon.length} pontos, primeiros 20): ${polyStr}
- Furos (${holes.length}): ${holesStr || "nenhum"}
- Módulo LED: ${ledModel.name} — ${ledModel.width}×${ledModel.height}mm, ${ledModel.power}W/un
- ${pitchInstr}

REGRAS:
1. Calcule posições (x,y) em mm dentro do polígono onde LEDs devem ser colocados
2. Espaçamento real = dimensão do módulo LED (pitchX = ${ledModel.width}mm, pitchY = ${ledModel.height}mm)
3. Todo objeto deve ter pelo menos 1 LED no centro
4. Evite furos e bordas (margem mínima: ${Math.min(ledModel.width, ledModel.height) / 2}mm)
5. Posições devem estar DENTRO do polígono
6. O sistema de coordenadas tem minX=${minX.toFixed(1)}, minY=${minY.toFixed(1)}, maxX=${maxX.toFixed(1)}, maxY=${maxY.toFixed(1)}

Responda APENAS em JSON válido, sem explicações:
{
  "positions": [{"x": número, "y": número}, ...],
  "pitch": número,
  "pitchX": número,
  "pitchY": número,
  "reasoning": "breve explicação da estratégia"
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.map((b: any) => b.type === "text" ? b.text : "").join("") ?? "";
    const clean = text.replace(/```json|```/g, "").trim();

    let parsed: any;
    try { parsed = JSON.parse(clean); } catch {
      // Fallback para grid se JSON inválido
      return calcLedsGrid(polygon, holes, ledModel, letterHeight, 0);
    }

    const positions: Array<{ x: number; y: number }> = (parsed.positions ?? []).filter((p: any) =>
      typeof p.x === "number" && typeof p.y === "number" &&
      p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY &&
      pointInPoly({ x: p.x, y: p.y }, polygon)
    );

    // Garantia: pelo menos 1 LED
    if (positions.length === 0) {
      let cx = 0, cy = 0;
      for (const p of polygon) { cx += p.x; cy += p.y; }
      cx /= polygon.length; cy /= polygon.length;
      positions.push({ x: cx, y: cy });
    }

    const result = {
      totalLeds: positions.length,
      pitch: parsed.pitch ?? Math.max(ledModel.width, ledModel.height),
      pitchX: parsed.pitchX ?? ledModel.width,
      pitchY: parsed.pitchY ?? ledModel.height,
      positions,
    };
    aiLedCache.set(hash, result);
    return result;
  } catch {
    // Fallback para grid em caso de erro de rede
    return calcLedsGrid(polygon, holes, ledModel, letterHeight, 0);
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function calcLedsForPart(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  _borderMargin = 0,
  letterHeight: number | null = null,
  ledRotation: 0 | 90 = 0,
  engine: LedEngine = "grid",
): { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }>; bestRotation: 0 | 90 } {
  if (!polygon.length) return { totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0, positions: [], bestRotation: ledRotation };

  // AI engine: retorna resultado placeholder (cálculo assíncrono feito separadamente)
  if (engine === "ai") {
    // Fallback síncrono para o grid enquanto AI não retornou
    const r = calcLedsGrid(polygon, holes, ledModel, letterHeight, ledRotation);
    return { ...r, bestRotation: ledRotation };
  }

  // Grid: testa 0° e 90° e usa o melhor
  const r0 = calcLedsGrid(polygon, holes, ledModel, letterHeight, 0);
  const r90 = calcLedsGrid(polygon, holes, ledModel, letterHeight, 90);

  if (r0.totalLeds === 0 && r90.totalLeds === 0) {
    // Garantia: centróide
    let cx = 0, cy = 0;
    for (const p of polygon) { cx += p.x; cy += p.y; }
    cx /= polygon.length; cy /= polygon.length;
    return { totalLeds: 1, pitch: Math.max(ledModel.width, ledModel.height), pitchX: ledModel.width, pitchY: ledModel.height, positions: [{ x: cx, y: cy }], bestRotation: 0 };
  }

  const best = r90.totalLeds > r0.totalLeds ? r90 : r0;
  const bestRotation: 0 | 90 = r90.totalLeds > r0.totalLeds ? 90 : 0;
  return { ...best, bestRotation };
}

// Aproximação bbox (para sumário e tabela) — v12.1: pitch = tamanho do LED
function calcLedsForBbox(
  partWidth: number,
  partHeight: number,
  ledModel: LedModel,
  _borderMargin = 0,
  letterHeight: number | null = null,
  ledRotation: 0 | 90 = 0,
): { ledsX: number; ledsY: number; totalLeds: number; pitch: number; pitchX: number; pitchY: number } {
  const W = partWidth;
  const H = partHeight;
  if (W <= 0 || H <= 0) return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0, pitchX: 0, pitchY: 0 };
  void ledRotation;

  let pitchX: number, pitchY: number;
  if (letterHeight && letterHeight > 0) {
    const adaptive = calcPitchFromLetterHeight(letterHeight, ledModel.width, ledModel.height) as { pitchX: number; pitchY: number };
    pitchX = adaptive.pitchX;
    pitchY = adaptive.pitchY;
  } else {
    pitchX = ledModel.width > 0 ? ledModel.width : 1;
    pitchY = ledModel.height > 0 ? ledModel.height : 1;
  }

  const ledsX = Math.max(1, Math.floor(W / pitchX));
  const ledsY = Math.max(1, Math.floor(H / pitchY));
  const totalLeds = ledsX * ledsY;
  const pitch = Math.max(pitchX, pitchY);
  return { ledsX, ledsY, totalLeds, pitch, pitchX, pitchY };
}

// ─── Canvas rendering ─────────────────────────────────────────────────────
function renderSheet(
  canvas: HTMLCanvasElement,
  placed: PlacedPart[],
  sheetWidth: number,
  sheetHeight: number,
  margin: number,
  ledModel: LedModel | null,
  showLeds: boolean,
  borderMargin: number,
  letterHeight: number | null = null,
  ledRotation: 0 | 90 = 0,
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

    // LEDs are NOT drawn on the cut plan sheet (only in the LED positioning tab)
    void showLeds; void ledModel; void letterHeight; void ledRotation;
  }

  // Leftover area
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
  leds,
  onAdd,
  onRemove,
  selectedId,
  onSelect,
}: {
  leds: LedModel[];
  onAdd: (m: LedModel) => void;
  onRemove: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [form, setForm] = useState({ name: "", width: 5, height: 5, power: 0.5 });
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
      width: form.width,
      height: form.height,
      power: form.power,
      photoUrl,
    });
    setForm({ name: "", width: 5, height: 5, power: 0.5 });
    setPhotoUrl(undefined);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="flex flex-col gap-4">
      {leds.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Modelos cadastrados</p>
          {leds.map((led) => (
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
                  {led.width} × {led.height} mm · {led.power} W/un
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
          ))}
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

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Largura (mm)</Label>
            <Input type="number" min={0.1} step={0.1} value={form.width}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setForm((f) => ({ ...f, width: v })); }}
              className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Altura (mm)</Label>
            <Input type="number" min={0.1} step={0.1} value={form.height}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setForm((f) => ({ ...f, height: v })); }}
              className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Potência (W)</Label>
            <Input type="number" min={0} step={0.01} value={form.power}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setForm((f) => ({ ...f, power: v })); }}
              className="h-8 text-sm" />
          </div>
        </div>

        <Button onClick={handleAdd} disabled={!form.name.trim()} variant="secondary" className="w-full h-8 text-sm">
          <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar LED
        </Button>
      </div>
    </div>
  );
}

// ─── LED Visualization Canvas (shape-aware, multi-LED, rotatable) ─────────
function LedDrawingCanvas({
  groups,
  ledModels,
  selectedLedId,
  ledAssignments,
  borderMargin = 4,
  letterHeight = null,
  ledRotation = 0,
  engine = "grid",
  trainingExamples = [],
}: {
  groups: ReturnType<typeof groupParts>;
  ledModels: LedModel[];
  selectedLedId: string | null;
  ledAssignments: LedAssignment;
  borderMargin?: number;
  letterHeight?: number | null;
  ledRotation?: 0 | 90;
  engine?: LedEngine;
  trainingExamples?: AiTrainingExample[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aiPositions, setAiPositions] = useState<Map<string, { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }> }>>(new Map());
  const [aiLoading, setAiLoading] = useState(false);

  // Resolve which LED model to use for a given group key
  const resolveLed = useCallback((groupKey: string): LedModel | null => {
    const assignedId = ledAssignments[groupKey] ?? selectedLedId;
    return ledModels.find((l) => l.id === assignedId) ?? null;
  }, [ledModels, selectedLedId, ledAssignments]);

  // Fetch AI positions when engine = "ai"
  useEffect(() => {
    if (engine !== "ai") { setAiPositions(new Map()); return; }
    let cancelled = false;
    setAiLoading(true);

    const fetchAll = async () => {
      const results = new Map<string, any>();
      for (const g of groups) {
        if (cancelled) break;
        const ledModel = resolveLed(g.key);
        if (!ledModel) continue;
        const poly = g.parts[0]?.outer ?? [];
        const holes = g.parts[0]?.holes ?? [];
        if (poly.length < 3) continue;
        const r = await calcLedsAI(poly, holes, ledModel, letterHeight, trainingExamples);
        results.set(g.key, r);
      }
      if (!cancelled) {
        setAiPositions(new Map(results));
        setAiLoading(false);
      }
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [engine, groups, resolveLed, letterHeight, trainingExamples]);

  useEffect(() => {
    if (!canvasRef.current || groups.length === 0) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;

    const COLS = Math.min(4, groups.length);
    const ROWS = Math.ceil(groups.length / COLS);
    const CELL_PAD = 24;
    const LABEL_TOP = 16;
    const LABEL_BOTTOM = 48;
    const MAX_PART = 150;

    const maxW = Math.max(...groups.map((g) => g.width));
    const maxH = Math.max(...groups.map((g) => g.height));
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
    ctx.fillStyle = engine === "ai" ? "#f0fdf4" : "#0f172a";
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
        ctx.fillStyle = engine === "ai" ? "#dcfce7" : "#1e3a5f";
        ctx.fill();
        ctx.strokeStyle = engine === "ai" ? "#16a34a" : "#3b82f6";
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
          ctx.fillStyle = engine === "ai" ? "#f0fdf4" : "#0f172a";
          ctx.fill();
          ctx.strokeStyle = "#60a5fa88";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (ledModel) {
          let ledResult: { totalLeds: number; pitch: number; pitchX: number; pitchY: number; positions: Array<{ x: number; y: number }>; bestRotation: 0 | 90 };
          if (engine === "ai" && aiPositions.has(g.key)) {
            const r = aiPositions.get(g.key)!;
            ledResult = { ...r, bestRotation: 0 };
          } else {
            ledResult = calcLedsForPart(poly, holes, ledModel, 0, letterHeight, ledRotation, "grid");
          }
          const { positions, totalLeds, pitch, pitchX, pitchY, bestRotation: partRot } = ledResult;

          // LED dims with auto-selected rotation
          const rawW = partRot === 90 ? ledModel.height : ledModel.width;
          const rawH = partRot === 90 ? ledModel.width : ledModel.height;
          const ledW = Math.max(2, rawW * s);
          const ledH = Math.max(2, rawH * s);
          const ledR = Math.max(2, Math.min(ledW, ledH) / 2);

          for (const pos of positions) {
            const lx = ox + (pos.x - pminX) * s;
            const ly = oy + (pos.y - pminY) * s;

            if (engine === "ai") {
              // IA: estrela verde brilhante
              const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, ledR * 2.5);
              grd.addColorStop(0, "#86efac99");
              grd.addColorStop(1, "#22c55e00");
              ctx.beginPath();
              ctx.arc(lx, ly, ledR * 2.5, 0, Math.PI * 2);
              ctx.fillStyle = grd;
              ctx.fill();
              ctx.beginPath();
              ctx.arc(lx, ly, ledR, 0, Math.PI * 2);
              ctx.fillStyle = "#4ade80";
              ctx.fill();
              ctx.strokeStyle = "#16a34a";
              ctx.lineWidth = 0.7;
              ctx.stroke();
            } else {
              // Grid: rectangle with glow
              const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(ledW, ledH));
              grd.addColorStop(0, "#fde68aaa");
              grd.addColorStop(1, "#f59e0b00");
              ctx.beginPath();
              ctx.arc(lx, ly, Math.max(ledW, ledH), 0, Math.PI * 2);
              ctx.fillStyle = grd;
              ctx.fill();
              ctx.fillStyle = "#fde68a";
              ctx.strokeStyle = "#f59e0b";
              ctx.lineWidth = 0.5;
              ctx.fillRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
              ctx.strokeRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
            }
          }

          ctx.fillStyle = engine === "ai" ? "#475569" : "#94a3b8";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);

          const engineLabel = engine === "ai" ? (aiLoading && !aiPositions.has(g.key) ? "⏳ IA calculando..." : "✓ Motor IA") : `⊞ Grid`;
          ctx.fillStyle = engine === "ai" ? "#16a34a" : "#fde68a";
          ctx.font = "bold 9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`${totalLeds} LEDs · ↔${pitchX.toFixed(1)} ↕${pitchY.toFixed(1)} mm`, ox + pw / 2, oy + ph + 8);

          ctx.fillStyle = engine === "ai" ? "#7c3aed" : "#a855f7";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(ledModel.name + ` (${engineLabel})`, ox + pw / 2, oy + ph + 20);

          const { totalLeds: bboxTotal } = calcLedsForBbox(g.width, g.height, ledModel, 0, letterHeight, ledRotation);
          const coverage = bboxTotal > 0 ? Math.round((totalLeds / bboxTotal) * 100) : 0;
          ctx.fillStyle = "#10b981";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`aproveit. ${coverage}%`, ox + pw / 2, oy + ph + 32);
        } else {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);
          ctx.fillStyle = "#ef4444";
          ctx.font = "8px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText("Sem LED atribuído", ox + pw / 2, oy + ph + 8);
        }

        // Qty badge
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
        ctx.fillStyle = engine === "ai" ? "#dcfce7" : "#1e3a5f";
        ctx.strokeStyle = engine === "ai" ? "#16a34a" : "#3b82f6";
        ctx.lineWidth = 1.5;
        ctx.fillRect(ox, oy, pw, ph);
        ctx.strokeRect(ox, oy, pw, ph);

        if (ledModel) {
          const { totalLeds, pitchX, pitchY } = calcLedsForBbox(g.width, g.height, ledModel, 0, letterHeight, ledRotation);
          ctx.fillStyle = "#94a3b8";
          ctx.font = "9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);
          ctx.fillStyle = "#fde68a";
          ctx.font = "bold 9px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(`${totalLeds} LEDs · ↔${pitchX.toFixed(1)} ↕${pitchY.toFixed(1)} mm`, ox + pw / 2, oy + ph + 8);
        }
      }
    });
  }, [groups, ledModels, selectedLedId, ledAssignments, letterHeight, engine, resolveLed, aiPositions, aiLoading]);

  const bgColor = engine === "ai" ? "#f0fdf4" : "#0f172a";

  return (
    <div className="flex flex-col gap-2">
      {engine === "ai" && aiLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Motor IA calculando posicionamento de LEDs via Claude API...</span>
        </div>
      )}
      {engine === "ai" && !aiLoading && aiPositions.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-400">
          <CheckCheck className="h-3.5 w-3.5" />
          <span>Posicionamento calculado pelo Motor IA · {aiPositions.size} modelo(s) processado(s)</span>
        </div>
      )}
      <div className="overflow-auto rounded-lg border border-border p-2" style={{ background: bgColor }}>
        <canvas ref={canvasRef} className="block" />
      </div>
    </div>
  );
}


// ─── Print Plan ───────────────────────────────────────────────────────────────
function printPlan(
  result: NestResult,
  opts: NestingOptions,
  ledModels: LedModel[],
  selectedLedId: string | null,
  ledAssignments: LedAssignment,
  showLeds: boolean,
  borderMargin: number,
  letterHeight: number | null,
  ledRotation: 0 | 90,
  groups: ReturnType<typeof groupParts>,
  ledSummary: { rows: any[]; totalLeds: number; totalPower: number } | null,
  fileName: string,
  ledEngine: LedEngine = "grid",
) {
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) { alert("Permita popups para imprimir."); return; }

  const resolveLed = (groupKey: string): LedModel | null => {
    const assignedId = ledAssignments[groupKey] ?? selectedLedId;
    return ledModels.find((l) => l.id === assignedId) ?? null;
  };

  const globalLed = ledModels.find((l) => l.id === selectedLedId) ?? null;

  // ── Build sheet canvases ──────────────────────────────────────────────────
  // A4 portrait at 96dpi ≈ 794×1123px; usable width ~740px
  const SHEET_PX_W = 760;
  const SHEET_PX_H = Math.round(SHEET_PX_W * (opts.sheetHeight / opts.sheetWidth));

  const sheetDataUrls: string[] = [];
  for (let si = 0; si < result.sheets.length; si++) {
    const canvas = document.createElement("canvas");
    canvas.width  = SHEET_PX_W;
    canvas.height = SHEET_PX_H;
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `width:${SHEET_PX_W}px;height:${SHEET_PX_H}px;position:absolute;left:-9999px`;
    wrapper.appendChild(canvas);
    document.body.appendChild(wrapper);
    renderSheet(canvas, result.sheets[si], opts.sheetWidth, opts.sheetHeight, opts.margin, globalLed, showLeds, 0, letterHeight, ledRotation);
    sheetDataUrls.push(canvas.toDataURL("image/png"));
    document.body.removeChild(wrapper);
  }

  // ── Build per-group LED thumbnail canvases ────────────────────────────────
  // Cards rendered at 280×280 drawing zone — large enough to see LED dots clearly
  const DRAW = 260;
  const PAD  = 14;
  const CANVAS_W = DRAW + PAD * 2;
  const CANVAS_H = DRAW + PAD * 2;

  interface LedCard {
    dataUrl: string;
    partLabel: string;      // "120 × 80 mm"
    ledName: string;        // "LED SMD 5050"
    ledDims: string;        // "5 × 5 mm"
    ledsPerPiece: number;
    totalLeds: number;      // ledsPerPiece × quantity
    pitchX: number;
    pitchY: number;
    quantity: number;
    power: number;          // W per piece
  }

  const ledCards: LedCard[] = [];

  for (const g of groups) {
    const ledModel = resolveLed(g.key);
    const poly  = g.parts[0]?.outer ?? [];
    const holes = g.parts[0]?.holes ?? [];

    let ledsPerPiece = 0, pitchX = 0, pitchY = 0;
    let positions: Array<{x:number;y:number}> = [];
    let bestRotation: 0 | 90 = 0;

    if (ledModel) {
      if (poly.length) {
        const r = calcLedsForPart(poly, holes, ledModel, 0, letterHeight, ledRotation, ledEngine);
        ledsPerPiece = r.totalLeds; pitchX = r.pitchX; pitchY = r.pitchY;
        positions = r.positions; bestRotation = r.bestRotation;
      } else {
        const r = calcLedsForBbox(g.width, g.height, ledModel, 0, letterHeight, ledRotation);
        ledsPerPiece = r.totalLeds; pitchX = r.pitchX; pitchY = r.pitchY;
      }
    }

    // Scale so the largest dimension fills the drawing zone
    const S = Math.min(DRAW / Math.max(g.width, g.height, 1), 6);
    const pw = g.width * S;
    const ph = g.height * S;
    const ox = PAD + (DRAW - pw) / 2;
    const oy = PAD + (DRAW - ph) / 2;

    const canvas = document.createElement("canvas");
    canvas.width  = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext("2d")!;

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (poly.length > 0) {
      let pminX = Infinity, pminY = Infinity;
      for (const p of poly) {
        if (p.x < pminX) pminX = p.x;
        if (p.y < pminY) pminY = p.y;
      }
      const toS = (p: {x:number;y:number}) => ({ x: ox + (p.x - pminX) * S, y: oy + (p.y - pminY) * S });

      // Part shape
      ctx.beginPath();
      const sp0 = toS(poly[0]); ctx.moveTo(sp0.x, sp0.y);
      for (let i = 1; i < poly.length; i++) { const sp = toS(poly[i]); ctx.lineTo(sp.x, sp.y); }
      ctx.closePath();
      ctx.fillStyle = "#dbeafe"; ctx.fill();
      ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1.5; ctx.stroke();

      // Holes
      for (const hole of holes) {
        if (!hole.length) continue;
        ctx.beginPath();
        const sh0 = toS(hole[0]); ctx.moveTo(sh0.x, sh0.y);
        for (let i = 1; i < hole.length; i++) { ctx.lineTo(toS(hole[i]).x, toS(hole[i]).y); }
        ctx.closePath();
        ctx.fillStyle = "#ffffff"; ctx.fill();
        ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 1; ctx.stroke();
      }

      // LED dots
      if (ledModel && positions.length) {
        const rawW = bestRotation === 90 ? ledModel.height : ledModel.width;
        const rawH = bestRotation === 90 ? ledModel.width  : ledModel.height;
        const lw = Math.max(3, rawW * S);
        const lh = Math.max(3, rawH * S);
        for (const pos of positions) {
          const lx = ox + (pos.x - pminX) * S;
          const ly = oy + (pos.y - pminY) * S;
          // Outer glow
          ctx.beginPath(); ctx.arc(lx, ly, Math.max(lw, lh) * 0.7, 0, Math.PI * 2);
          ctx.fillStyle = "#fef9c3"; ctx.fill();
          // LED rect
          ctx.fillStyle = "#fbbf24"; ctx.strokeStyle = "#92400e"; ctx.lineWidth = 0.5;
          ctx.fillRect(lx - lw/2, ly - lh/2, lw, lh);
          ctx.strokeRect(lx - lw/2, ly - lh/2, lw, lh);
        }
      }
    } else {
      // bbox fallback
      ctx.fillStyle = "#dbeafe"; ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1.5;
      ctx.fillRect(ox, oy, pw, ph); ctx.strokeRect(ox, oy, pw, ph);
      if (ledModel) {
        const { ledsX, ledsY } = calcLedsForBbox(g.width, g.height, ledModel, 0, letterHeight, ledRotation);
        const lw = Math.max(3, ledModel.width * S);
        const lh = Math.max(3, ledModel.height * S);
        for (let row = 0; row < ledsY; row++) {
          for (let col = 0; col < ledsX; col++) {
            const lx = ox + (col + 0.5) * (pw / Math.max(ledsX, 1));
            const ly = oy + (row + 0.5) * (ph / Math.max(ledsY, 1));
            ctx.fillStyle = "#fbbf24"; ctx.fillRect(lx - lw/2, ly - lh/2, lw, lh);
          }
        }
      }
    }

    // Dimension annotations on the drawing
    ctx.fillStyle = "#1e3a5f";
    ctx.font = "bold 9px 'Courier New', monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, CANVAS_W / 2, CANVAS_H - 3);

    ledCards.push({
      dataUrl: canvas.toDataURL("image/png"),
      partLabel: `${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`,
      ledName:   ledModel?.name ?? "–",
      ledDims:   ledModel ? `${ledModel.width} × ${ledModel.height} mm` : "–",
      ledsPerPiece,
      totalLeds: ledsPerPiece * g.quantity,
      pitchX, pitchY,
      quantity: g.quantity,
      power: ledModel ? ledsPerPiece * ledModel.power : 0,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const now = new Date().toLocaleString("pt-BR");
  const totalParts = result.sheets.reduce((s, sh) => s + sh.length, 0);
  const pitchLabel = letterHeight && globalLed
    ? (calcPitchFromLetterHeight(letterHeight, globalLed.width, globalLed.height) as {pitchX:number;pitchY:number}).pitchX.toFixed(1) + " mm"
    : "—";

  // ── CSS ───────────────────────────────────────────────────────────────────
  const css = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 10px; }
body {
  font-family: 'Courier New', Courier, monospace;
  color: #111;
  background: #fff;
  padding: 10mm 10mm 10mm 10mm;
  max-width: 210mm;
  margin: 0 auto;
}

/* ── header ── */
.doc-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  border-bottom: 2.5px solid #1e293b;
  padding-bottom: 5px;
  margin-bottom: 8px;
  gap: 12px;
}
.doc-title { font-size: 13px; font-weight: 700; letter-spacing: -.3px; }
.doc-sub   { font-size: 8px; color: #555; margin-top: 2px; line-height: 1.6; }
.doc-meta  { text-align: right; font-size: 8px; color: #555; line-height: 1.6; white-space: nowrap; }

/* ── section ── */
.sec { margin-bottom: 10px; }
.sec-title {
  font-size: 8px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 1px;
  color: #fff; background: #1e293b;
  padding: 2px 7px; margin-bottom: 6px;
  display: block;
}

/* ── summary ── */
.summary {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 5px;
  margin-bottom: 8px;
}
.kpi { border: 1px solid #d1d5db; padding: 4px 6px; }
.kpi-label { font-size: 7px; text-transform: uppercase; letter-spacing: .4px; color: #6b7280; }
.kpi-val   { font-size: 15px; font-weight: 700; line-height: 1.1; }
.green { color: #15803d; } .blue { color: #1d4ed8; } .amber { color: #b45309; }

/* ── sheet images ── */
.sheet-block { margin-bottom: 8px; page-break-inside: avoid; }
.sheet-label { font-size: 8px; font-weight: 700; margin-bottom: 3px; }
.sheet-img   { display: block; width: 100%; border: 1px solid #94a3b8; }

/* ── LED card grid ── */
/* 3 cards per row on A4 portrait — each ~60mm wide */
.card-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
}
.card {
  border: 1.5px solid #cbd5e1;
  page-break-inside: avoid;
  overflow: hidden;
  background: #fff;
}
.card-img  { display: block; width: 100%; border-bottom: 1px solid #e2e8f0; }
.card-body { padding: 5px 6px; background: #f8fafc; }
.card-name {
  font-size: 9px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-bottom: 4px;
  border-bottom: 1px solid #e2e8f0; padding-bottom: 3px;
}
.card-badge {
  display: inline-block;
  background: #1e293b; color: #fff;
  font-size: 7px; font-weight: 700;
  padding: 1px 5px; border-radius: 2px;
  margin-bottom: 4px;
}
.card-row { display: flex; justify-content: space-between; font-size: 8px; color: #374151; margin-top: 2px; }
.card-val { font-weight: 700; color: #111; }
/* highlight total leds row */
.card-row.hl { background:#fef9c3; margin: 2px -6px; padding: 2px 6px; border-top: 1px solid #fde047; border-bottom: 1px solid #fde047; }
.card-row.hl .card-val { color: #92400e; font-size: 9px; }

/* ── BOM table ── */
table { width: 100%; border-collapse: collapse; font-size: 8.5px; }
thead th {
  background: #1e293b; color: #fff;
  font-size: 7.5px; font-weight: 700;
  text-align: right; padding: 3px 5px;
  border: 1px solid #334155;
  white-space: nowrap;
}
thead th:first-child, thead th:nth-child(2) { text-align: left; }
tbody td {
  font-size: 8px; padding: 2.5px 5px;
  border: 1px solid #e5e7eb; text-align: right;
  white-space: nowrap;
}
tbody td:first-child, tbody td:nth-child(2) { text-align: left; }
tbody tr:nth-child(even) td { background: #f9fafb; }
tfoot td {
  font-size: 8.5px; font-weight: 700; padding: 3px 5px;
  border: 1px solid #cbd5e1; text-align: right;
  background: #f1f5f9; border-top: 2px solid #1e293b;
  white-space: nowrap;
}
tfoot td:first-child { text-align: left; }

/* ── highlight totals ── */
.total-leds { color: #92400e; font-size: 10px !important; }

/* ── print ── */
@media print {
  body { padding: 7mm; }
  .no-print { display: none !important; }
  @page { size: A4 portrait; margin: 7mm; }
  .page-break { page-break-before: always; break-before: page; }
  .card { break-inside: avoid; }
  .sheet-block { break-inside: avoid; }
}

/* ── no-print buttons ── */
.no-print {
  position: fixed; top: 10px; right: 10px; z-index: 9999;
  display: flex; gap: 8px;
}
.btn {
  border: none; padding: 8px 16px; font-size: 11px;
  cursor: pointer; font-family: monospace; font-weight: 700;
  border-radius: 3px;
}
.btn-print { background: #1e293b; color: #fff; }
.btn-print:hover { background: #0f172a; }
.btn-close { background: #64748b; color: #fff; }
`;

  // ── HTML assembly ─────────────────────────────────────────────────────────
  let html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plano LED — ${fileName}</title>
<style>${css}</style>
</head>
<body>

<!-- HEADER -->
<div class="doc-header">
  <div>
    <div class="doc-title">📐 Plano de Corte e Posicionamento LED</div>
    <div class="doc-sub">
      Arquivo: <b>${fileName}</b> &nbsp;·&nbsp;
      Chapa: <b>${opts.sheetWidth} × ${opts.sheetHeight} mm</b> &nbsp;·&nbsp;
      Folga: ${opts.gap} mm &nbsp;·&nbsp; Margem: ${opts.margin} mm<br>
      Motor LED: <b>${ledEngine === "ai" ? "IA (Claude API)" : "Grid colmeia"}</b>
      ${letterHeight ? ` &nbsp;·&nbsp; Altura da letra: <b>${letterHeight} mm</b> &nbsp;·&nbsp; Pitch: <b>${pitchLabel}</b>` : ""}
      ${globalLed ? ` &nbsp;·&nbsp; LED padrão: <b>${globalLed.name}</b> (${globalLed.width} × ${globalLed.height} mm)` : ""}
    </div>
  </div>
  <div class="doc-meta">
    Gerado: ${now}<br>
    NestCNC v12.1
  </div>
</div>

<!-- SUMMARY KPIs -->
<div class="summary">
  <div class="kpi"><div class="kpi-label">Chapas usadas</div><div class="kpi-val blue">${result.sheets.length}</div></div>
  <div class="kpi"><div class="kpi-label">Peças total</div><div class="kpi-val">${totalParts}</div></div>
  <div class="kpi"><div class="kpi-label">Modelos</div><div class="kpi-val">${groups.length}</div></div>
  <div class="kpi"><div class="kpi-label">Aproveitamento</div><div class="kpi-val green">${(result.utilization * 100).toFixed(1)}%</div></div>
  ${ledSummary ? `
  <div class="kpi"><div class="kpi-label">Total LEDs</div><div class="kpi-val amber">${ledSummary.totalLeds.toLocaleString("pt-BR")}</div></div>
  <div class="kpi"><div class="kpi-label">Potência</div><div class="kpi-val">${ledSummary.totalPower.toFixed(1)} W</div></div>
  ` : `<div class="kpi"></div><div class="kpi"></div>`}
</div>`;

  // ── SHEET PAGES ───────────────────────────────────────────────────────────
  html += `<div class="sec"><span class="sec-title">Chapas de Corte</span>`;
  for (let si = 0; si < result.sheets.length; si++) {
    const sh = result.sheets[si];
    if (si > 0) html += `<div class="page-break"></div>`;
    html += `<div class="sheet-block">
  <div class="sheet-label">Chapa ${si + 1} / ${result.sheets.length} — ${sh.length} peça(s) posicionada(s)</div>
  <img class="sheet-img" src="${sheetDataUrls[si]}" />
</div>`;
  }
  html += `</div>`;

  // ── LED CARDS — one page per group of 6 ───────────────────────────────────
  if (ledCards.length > 0) {
    html += `<div class="page-break"></div>`;
    html += `<div class="sec"><span class="sec-title">Posicionamento de LEDs — Detalhamento por Modelo de Peça</span>`;
    html += `<div class="card-grid">`;

    for (let ci = 0; ci < ledCards.length; ci++) {
      const card = ledCards[ci];
      // page break every 6 cards (2 rows of 3)
      if (ci > 0 && ci % 6 === 0) {
        html += `</div><div class="page-break"></div><div class="card-grid">`;
      }
      html += `
<div class="card">
  <img class="card-img" src="${card.dataUrl}" alt="Peça ${ci + 1}" />
  <div class="card-body">
    <div class="card-badge">×${card.quantity} peça${card.quantity !== 1 ? "s" : ""}</div>
    <div class="card-name" title="${card.ledName}">${card.ledName}</div>
    <div class="card-row"><span>Peça (mm)</span><span class="card-val">${card.partLabel}</span></div>
    <div class="card-row"><span>Módulo LED</span><span class="card-val">${card.ledDims}</span></div>
    <div class="card-row"><span>Pitch X / Y</span><span class="card-val">${card.pitchX.toFixed(1)} / ${card.pitchY.toFixed(1)} mm</span></div>
    <div class="card-row hl"><span>LEDs / peça</span><span class="card-val">${card.ledsPerPiece} un</span></div>
    <div class="card-row hl"><span>Total módulos</span><span class="card-val">${card.totalLeds.toLocaleString("pt-BR")} un</span></div>
    <div class="card-row"><span>Potência/peça</span><span class="card-val">${card.power.toFixed(1)} W</span></div>
  </div>
</div>`;
    }
    html += `</div></div>`;
  }

  // ── BOM TABLE ─────────────────────────────────────────────────────────────
  if (ledSummary && ledSummary.rows.length > 0) {
    html += `<div class="page-break"></div>`;
    html += `<div class="sec">
<span class="sec-title">Lista de Materiais — LEDs (BOM)</span>
<table>
<thead><tr>
  <th>Peça (mm)</th>
  <th>Módulo LED</th>
  <th>Dim. módulo</th>
  <th>Qtd peças</th>
  <th>LEDs/peça</th>
  <th>Pitch X</th>
  <th>Pitch Y</th>
  <th>Total módulos</th>
  <th>Pot/peça (W)</th>
  <th>Pot total (W)</th>
</tr></thead>
<tbody>`;

    for (const row of ledSummary.rows) {
      const lm = ledModels.find(l => l.name === row.ledName);
      const dimStr = lm ? `${lm.width} × ${lm.height}` : "–";
      const powerPerPiece = lm ? (row.ledsPerPiece * lm.power).toFixed(2) : "–";
      html += `<tr>
  <td>${row.width.toFixed(0)} × ${row.height.toFixed(0)}</td>
  <td>${row.ledName}</td>
  <td>${dimStr} mm</td>
  <td>${row.qty}</td>
  <td><b>${row.ledsPerPiece}</b></td>
  <td>${row.pitchX.toFixed(1)} mm</td>
  <td>${row.pitchY.toFixed(1)} mm</td>
  <td><b class="total-leds">${row.totalLeds.toLocaleString("pt-BR")}</b></td>
  <td>${powerPerPiece}</td>
  <td><b>${row.totalPower.toFixed(2)}</b></td>
</tr>`;
    }

    html += `</tbody>
<tfoot><tr>
  <td colspan="7">TOTAL GERAL</td>
  <td class="total-leds"><b>${ledSummary.totalLeds.toLocaleString("pt-BR")}</b></td>
  <td>—</td>
  <td><b>${ledSummary.totalPower.toFixed(2)} W</b></td>
</tr></tfoot>
</table>
</div>`;
  }

  // ── PRINT BUTTON ──────────────────────────────────────────────────────────
  html += `
<div class="no-print">
  <button class="btn btn-print" onclick="window.print()">🖨️ Imprimir A4</button>
  <button class="btn btn-close" onclick="window.close()">✕ Fechar</button>
</div>
</body>
</html>`;

  win.document.write(html);
  win.document.close();
  setTimeout(() => { win.focus(); }, 300);
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
  const [opts, setOpts] = useState<NestingOptions>({ sheetWidth: 1210, sheetHeight: 2420, gap: 5, margin: 10, allowRotation: true, allowMirror: false, priority: "yield" });

  // LED state — persisted in localStorage
  const [ledModels, setLedModels] = useState<LedModel[]>(() => {
    try {
      const saved = localStorage.getItem("nestcnc_led_models");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [selectedLedId, setSelectedLedId] = useState<string | null>(() => {
    try { return localStorage.getItem("nestcnc_led_selected"); } catch { return null; }
  });
  // Per-group LED assignments (group key -> led id)
  const [ledAssignments, setLedAssignments] = useState<LedAssignment>({});
  // LED rotation is always automatic (no manual control)
  const ledRotation: 0 | 90 = 0; // kept for function signatures, auto-rotation happens inside calcLedsForPart
  // Letter height for pitch calculation
  const [letterHeight, setLetterHeight] = useState<number | null>(null);
  const [letterHeightInput, setLetterHeightInput] = useState("");
  // LED calculation engine
  const [ledEngine, setLedEngine] = useState<LedEngine>("grid");
  // AI Training examples (PDFs for learning)
  const [trainingExamples, setTrainingExamples] = useState<AiTrainingExample[]>(() => {
    try {
      const saved = localStorage.getItem("nestcnc_ai_training");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const [showLeds, setShowLeds] = useState(true);
  const borderMargin = 0; // no border margin
  const [renderedLedId, setRenderedLedId] = useState<string | null>(null);
  const [ledKey, setLedKey] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) => setOpts((p) => ({ ...p, [key]: val }));

  const selectedLed = ledModels.find((l) => l.id === selectedLedId) ?? null;
  const ledNeedsUpdate = selectedLedId !== renderedLedId;

  // Assign a specific LED to a group — clears AI cache for that group so recalculation happens
  const assignLedToGroup = useCallback((groupKey: string, ledId: string) => {
    aiLedCache.clear(); // force full recalc for AI engine
    setLedAssignments((prev) => ({ ...prev, [groupKey]: ledId }));
    setRenderedLedId(ledId); // ensure canvas resolves immediately
    setLedKey((k) => k + 1);
  }, []);

  // Clear assignment (revert to global)
  const clearGroupAssignment = useCallback((groupKey: string) => {
    aiLedCache.clear();
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

  // Auto-recalculate when LED model, module selection, letter height, engine, or per-group assignment changes
  const ledModelsKey = JSON.stringify(ledModels.map(l => `${l.id}:${l.width}x${l.height}`));
  const ledAssignmentsKey = JSON.stringify(ledAssignments);
  useEffect(() => {
    // always bump key when anything LED-related changes — covers per-group swap
    setRenderedLedId(selectedLedId);
    setLedKey((k) => k + 1);
    // clear AI cache so re-assignment triggers fresh AI calculation
    aiLedCache.clear();
  }, [selectedLedId, letterHeight, ledEngine, ledAssignmentsKey, ledModelsKey]);

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

  useEffect(() => {
    try { localStorage.setItem("nestcnc_led_models", JSON.stringify(ledModels)); } catch {}
  }, [ledModels]);

  useEffect(() => {
    try {
      if (selectedLedId) localStorage.setItem("nestcnc_led_selected", selectedLedId);
      else localStorage.removeItem("nestcnc_led_selected");
    } catch {}
  }, [selectedLedId]);

  useEffect(() => {
    try { localStorage.setItem("nestcnc_ai_training", JSON.stringify(trainingExamples)); } catch {}
  }, [trainingExamples]);

  const redraw = useCallback(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    renderSheet(
      canvasRef.current,
      result.sheets[activeSheet] ?? [],
      opts.sheetWidth, opts.sheetHeight, opts.margin,
      selectedLed, showLeds, 0, letterHeight, 0
    );
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin, selectedLed, showLeds, letterHeight]);

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

  // LED summary using shape-aware calc, respecting per-group assignments
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
        const r = calcLedsForPart(poly, holes, ledModel, 0, letterHeight, ledRotation, ledEngine);
        totalLeds = r.totalLeds; pitch = r.pitch; pitchX = r.pitchX; pitchY = r.pitchY;
      } else {
        const r = calcLedsForBbox(g.width, g.height, ledModel, 0, letterHeight, ledRotation);
        totalLeds = r.totalLeds; pitch = r.pitch; pitchX = r.pitchX; pitchY = r.pitchY;
      }
      const { ledsX, ledsY } = calcLedsForBbox(g.width, g.height, ledModel, 0, letterHeight, ledRotation);
      const totalPower = totalLeds * ledModel.power * g.quantity;
      return { width: g.width, height: g.height, qty: g.quantity, ledsPerPiece: totalLeds, ledsX, ledsY, totalLeds: totalLeds * g.quantity, pitch, pitchX, pitchY, totalPower, ledName: ledModel.name };
    });
    const totalLeds = rows.reduce((s, r) => s + r.totalLeds, 0);
    const totalPower = rows.reduce((s, r) => s + r.totalPower, 0);
    return { rows, totalLeds, totalPower };
  }, [groups, ledModels, selectedLedId, ledAssignments, letterHeight, ledKey, ledEngine]);

  const colorLegend = useMemo(() => {
    if (!result) return [];
    const m = new Map<string, string>(); let idx = 0;
    for (const sh of result.sheets) for (const p of sh) if (!m.has(p.groupSig)) m.set(p.groupSig, getColor(p.groupSig, idx++));
    return groups.map((g) => ({ label: `${g.width.toFixed(0)}×${g.height.toFixed(0)} mm`, qty: g.quantity, color: m.get(g.key) ?? "#888" }));
  }, [result, groups]);

  const currentSheetParts = result?.sheets[activeSheet] ?? [];
  const activeLedForDisplay = ledModels.find((l) => l.id === renderedLedId) ?? null;

  // Computed pitch display
  const computedPitch = letterHeight && letterHeight > 0 && selectedLed
    ? (calcPitchFromLetterHeight(letterHeight, selectedLed.width, selectedLed.height) as { pitchX: number; pitchY: number }).pitchX
    : null;

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
          <p className="text-[10px] text-muted-foreground/60 leading-none mt-0.5">vers 12.1</p>
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
              <NumericField label="Largura" unit="mm" value={opts.sheetWidth} onChange={(v) => setOpt("sheetWidth", v)} min={1} />
              <NumericField label="Altura" unit="mm" value={opts.sheetHeight} onChange={(v) => setOpt("sheetHeight", v)} min={1} />
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

          {result && (
            <Button
              variant="outline"
              className="w-full border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={() => printPlan(result, opts, ledModels, selectedLedId, ledAssignments, showLeds, 0, letterHeight, 0, groups, ledSummary, fileName || "sem-nome.pdf", ledEngine)}
            >
              <Printer className="mr-2 h-4 w-4" /> Imprimir Plano de Corte
            </Button>
          )}

          {/* LED overlay toggle */}
          {result && ledModels.length > 0 && (
            <section className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-yellow-400/80">Visualização LED</h2>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs">Mostrar LEDs no nesting</Label>
                <Switch checked={showLeds} onCheckedChange={setShowLeds} />
              </div>
              {showLeds && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Modelo ativo</Label>
                    <Select value={selectedLedId ?? ""} onValueChange={(v) => { setSelectedLedId(v); setRenderedLedId(v); setLedKey((k) => k + 1); }}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                      <SelectContent>
                        {ledModels.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name} ({l.width}×{l.height}mm)</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedLedId && (
                    <Button
                      onClick={handleUpdateLed}
                      variant="outline"
                      className="w-full h-8 text-xs border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                    >
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
                          <span className="text-muted-foreground">{g.width.toFixed(0)} × {g.height.toFixed(0)} mm</span>
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
              {/* ── LEFT: Controls panel ── */}
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

                {/* ── Motor selector ── */}
                <div className="rounded-lg border border-border bg-background p-3 flex flex-col gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Motor de Cálculo</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => { setLedEngine("grid"); setLedKey((k) => k + 1); }}
                      className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[10px] font-medium transition-all ${ledEngine === "grid" ? "border-blue-500/60 bg-blue-500/10 text-blue-300" : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"}`}
                    >
                      <span className="text-base">⊞</span>
                      <span>Grid</span>
                      <span className="text-[9px] opacity-60">grade filtrada</span>
                    </button>
                    <button
                      onClick={() => { setLedEngine("ai"); setLedKey((k) => k + 1); }}
                      className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[10px] font-medium transition-all ${ledEngine === "ai" ? "border-green-500/60 bg-green-500/10 text-green-300" : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"}`}
                    >
                      <span className="text-base">🤖</span>
                      <span>Motor IA</span>
                      <span className="text-[9px] opacity-60">Claude API</span>
                    </button>
                  </div>
                  <p className="text-[9px] text-muted-foreground/60 italic">
                    {ledEngine === "grid"
                      ? "Grade uniforme · pitch = dimensão do módulo LED · mínimo 1 LED por peça"
                      : "Claude API aprende com exemplos · analisa forma real · posicionamento inteligente"}
                  </p>
                </div>

                {/* ── AI Training Examples (só aparece quando Motor IA está ativo) ── */}
                {ledEngine === "ai" && (
                  <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <Brain className="h-3.5 w-3.5 text-green-400" />
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-green-300">Exemplos de Aprendizagem</p>
                    </div>

                    {trainingExamples.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        {trainingExamples.map((ex) => (
                          <div key={ex.id} className="flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/10 px-2 py-1.5">
                            <BookOpen className="h-3 w-3 text-green-400 shrink-0" />
                            <span className="text-[10px] text-green-300 flex-1 truncate">{ex.fileName}</span>
                            <button
                              onClick={() => {
                                setTrainingExamples(p => p.filter(e => e.id !== ex.id));
                                aiLedCache.clear();
                                setLedKey(k => k + 1);
                              }}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-green-500/30 bg-background p-3 text-center transition-colors hover:border-green-500/60">
                      <FileUp className="h-4 w-4 text-green-400" />
                      <span className="text-[10px] text-green-300 font-medium">Carregar PDF de exemplo</span>
                      <span className="text-[9px] text-muted-foreground">PDFs com posicionamento LED correto</span>
                      <input
                        type="file"
                        accept="application/pdf"
                        multiple
                        className="hidden"
                        onChange={async (e) => {
                          const files = Array.from(e.target.files ?? []);
                          for (const file of files) {
                            if (file.type !== "application/pdf") continue;
                            const reader = new FileReader();
                            await new Promise<void>((res) => {
                              reader.onload = (ev) => {
                                const pdfDataUrl = ev.target?.result as string;
                                setTrainingExamples(prev => [
                                  ...prev,
                                  { id: `ex-${Date.now()}-${Math.random()}`, fileName: file.name, pdfDataUrl, uploadedAt: Date.now() }
                                ]);
                                aiLedCache.clear();
                                setLedKey(k => k + 1);
                                res();
                              };
                              reader.readAsDataURL(file);
                            });
                          }
                          e.target.value = "";
                        }}
                      />
                    </label>

                    {trainingExamples.length === 0 && (
                      <p className="text-[9px] text-muted-foreground/70 text-center italic">
                        Sem exemplos: IA usa conhecimento geral de luminosos.<br />
                        Adicione PDFs para treino específico.
                      </p>
                    )}

                    {trainingExamples.length > 0 && (
                      <div className="flex items-center gap-1.5 rounded-md bg-green-500/10 px-2 py-1.5">
                        <Sparkles className="h-3 w-3 text-green-400 shrink-0" />
                        <p className="text-[9px] text-green-300">
                          {trainingExamples.length} exemplo(s) · IA usa como referência para novos cálculos
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Letter height / espessura ── */}
                <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 flex flex-col gap-2">
                  <Label className="text-[10px] font-semibold text-yellow-300 uppercase tracking-wider">Altura da letra (mm)</Label>
                  <div className="flex gap-2 items-center">
                    <Input
                      type="number" min={1} step={1} placeholder={`Ex: 100`}
                      value={letterHeightInput}
                      onChange={(e) => {
                        setLetterHeightInput(e.target.value);
                        const v = parseFloat(e.target.value);
                        setLetterHeight(!isNaN(v) && v > 0 ? v : null);
                      }}
                      className="h-7 text-xs flex-1"
                    />
                    {letterHeight && letterHeight > 0 && selectedLed && (
                      <div className="text-[10px] text-yellow-300 font-mono whitespace-nowrap">
                        → <strong>{(calcPitchFromLetterHeight(letterHeight, selectedLed.width, selectedLed.height) as { pitchX: number; pitchY: number }).pitchX.toFixed(1)} mm</strong>
                      </div>
                    )}
                  </div>
                  <p className="text-[9px] text-yellow-400/70">
                    Com altura: pitch = max(modW, altura×0,70) · Sem altura: pitch = dimensão do módulo LED
                  </p>
                </div>

                {/* ── Global LED selector ── */}
                <div className="flex flex-col gap-1.5">
                  <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">LED padrão</Label>
                  {ledModels.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">Cadastre um LED na aba "Cadastro LED"</p>
                  ) : (
                    <div className="flex gap-2">
                      <Select value={selectedLedId ?? ""} onValueChange={(v) => { setSelectedLedId(v); setRenderedLedId(v); setLedKey((k) => k + 1); }}>
                        <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                        <SelectContent>
                          {ledModels.map((l) => (
                            <SelectItem key={l.id} value={l.id}>{l.name} ({l.width}×{l.height}mm)</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* ── Per-group assignments ── */}
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

                {/* ── Summary cards ── */}
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
                        <p className="text-[10px] text-muted-foreground mb-0.5">Pitch</p>
                        <p className="text-base font-bold text-blue-400">
                          {letterHeight ? `${computedPitch?.toFixed(1)} mm` : `auto`}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Detail table ── */}
                {ledSummary && (
                  <div className="rounded-lg border border-border bg-background overflow-hidden">
                    <div className="px-3 py-2 border-b border-border">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Por Modelo</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Dim (mm)</th>
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

              {/* ── RIGHT: Canvas ── */}
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
                    {/* Canvas header */}
                    <div className="flex items-center justify-between border-b border-border px-4 py-2 bg-card shrink-0">
                      <div className="flex items-center gap-2">
                        <Zap className="h-3.5 w-3.5 text-yellow-400" />
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Desenho de Posicionamento
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${ledEngine === "ai" ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"}`}>
                          {ledEngine === "ai" ? "Motor IA" : "Grid"}
                        </span>
                      </div>
                      <Button onClick={handleUpdateLed} variant="outline" size="sm" className="h-6 text-[10px] border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10">
                        <RefreshCw className="h-3 w-3 mr-1" /> Atualizar
                      </Button>
                    </div>
                    {/* Scrollable canvas area */}
                    <div className="flex-1 overflow-auto p-4">
                      <LedDrawingCanvas
                        key={ledKey}
                        groups={groups}
                        ledModels={ledModels}
                        selectedLedId={activeLedForDisplay?.id ?? selectedLedId}
                        ledAssignments={ledAssignments}
                        borderMargin={0}
                        letterHeight={letterHeight}
                        ledRotation={0}
                        engine={ledEngine}
                        trainingExamples={trainingExamples}
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
                  <p className="text-xs text-muted-foreground">Registre os modelos de LED com foto e dimensões para uso nos cálculos</p>
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
