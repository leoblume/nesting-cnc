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

// ─── LED Calculation (shape-aware) ────────────────────────────────────────
// Instead of using bbox, we use the actual polygon to filter LED positions.
// - Generate a grid over the bounding box with pitch spacing
// - Keep only positions that are INSIDE the outer polygon AND NOT inside any hole
// - Respect border margin by shrinking the polygon inward (approximate)

function shrinkPolygon(poly: Point[], margin: number): Point[] {
  // Approximate inward shrink: move each vertex toward centroid by margin
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p.x; cy += p.y; }
  cx /= poly.length; cy /= poly.length;
  return poly.map((p) => {
    const dx = cx - p.x, dy = cy - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const ratio = Math.min(1, margin / len);
    return { x: p.x + dx * ratio, y: p.y + dy * ratio };
  });
}

function calcLedsForPart(
  polygon: Point[],
  holes: Point[][],
  ledModel: LedModel,
  borderMargin = 4
): { totalLeds: number; pitch: number; positions: Array<{ x: number; y: number }> } {
  if (!polygon.length) return { totalLeds: 0, pitch: 0, positions: [] };

  // Bounding box of outer polygon
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  // Thickness = minimum dimension minus border margins
  const innerW = bboxW - 2 * borderMargin;
  const innerH = bboxH - 2 * borderMargin;
  if (innerW <= 0 || innerH <= 0) return { totalLeds: 0, pitch: 0, positions: [] };

  const thickness = Math.min(innerW, innerH);
  const maxPitch = thickness * 0.9;
  const ledRef = Math.max(ledModel.width, ledModel.height);
  const pitch = Math.min(ledRef, maxPitch);
  if (pitch <= 0) return { totalLeds: 0, pitch: 0, positions: [] };

  // Shrink polygon inward by borderMargin to get valid placement area
  const inner = shrinkPolygon(polygon, borderMargin);

  // Grid scan: place LED centers on pitch grid, filtered by shape
  const positions: Array<{ x: number; y: number }> = [];

  const cols = Math.max(1, Math.floor(bboxW / pitch));
  const rows = Math.max(1, Math.floor(bboxH / pitch));
  const offsetX = (bboxW - cols * pitch) / 2;
  const offsetY = (bboxH - rows * pitch) / 2;

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const x = minX + offsetX + col * pitch;
      const y = minY + offsetY + row * pitch;
      const pt = { x, y };

      // Must be inside the (shrunk) outer polygon
      if (!pointInPoly(pt, inner)) continue;

      // Must NOT be inside any hole
      let inHole = false;
      for (const hole of holes) {
        if (pointInPoly(pt, hole)) { inHole = true; break; }
      }
      if (inHole) continue;

      positions.push({ x, y });
    }
  }

  return { totalLeds: positions.length, pitch, positions };
}

// Legacy bbox-based calc for the summary table (quick approximation)
function calcLedsForBbox(
  partWidth: number,
  partHeight: number,
  ledModel: LedModel,
  borderMargin = 4
): { ledsX: number; ledsY: number; totalLeds: number; pitch: number } {
  const innerW = partWidth - 2 * borderMargin;
  const innerH = partHeight - 2 * borderMargin;
  if (innerW <= 0 || innerH <= 0) return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0 };
  const thickness = Math.min(innerW, innerH);
  const maxPitch = thickness * 0.9;
  const ledRef = Math.max(ledModel.width, ledModel.height);
  const pitch = Math.min(ledRef, maxPitch);
  if (pitch <= 0) return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0 };
  const ledsX = Math.max(1, Math.floor(innerW / pitch) + 1);
  const ledsY = Math.max(1, Math.floor(innerH / pitch) + 1);
  return { ledsX, ledsY, totalLeds: ledsX * ledsY, pitch };
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

    // Draw LEDs following actual polygon shape
    if (showLeds && ledModel) {
      const { positions, totalLeds } = calcLedsForPart(part.polygon, part.holes, ledModel, borderMargin);

      // LED physical size in screen pixels
      const ledW = Math.max(2, ledModel.width * scale);
      const ledH = Math.max(2, ledModel.height * scale);

      for (const pos of positions) {
        const lx = pos.x * scale;
        const ly = pos.y * scale;

        // Draw LED as a rectangle at its real size
        ctx.fillStyle = "#fde68a";
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 0.5;
        ctx.fillRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
        ctx.strokeRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
      }

      // Draw LED count below the part
      const labelX = (part.bbox.minX + part.bbox.maxX) / 2 * scale;
      const labelY = part.bbox.maxY * scale + 4;
      const labelSz = Math.max(7, Math.min(10, (part.bbox.maxX - part.bbox.minX) * scale / 6));
      ctx.font = `bold ${labelSz}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#fde68a";
      ctx.fillText(`${totalLeds} LEDs`, labelX, labelY);
    }
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

// ─── LED Visualization Canvas (shape-aware) ───────────────────────────────
function LedDrawingCanvas({
  groups,
  ledModel,
  borderMargin = 4,
}: {
  groups: ReturnType<typeof groupParts>;
  ledModel: LedModel;
  borderMargin?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || groups.length === 0) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;

    const COLS = Math.min(4, groups.length);
    const ROWS = Math.ceil(groups.length / COLS);
    const CELL_PAD = 24;
    const LABEL_TOP = 16;
    const LABEL_BOTTOM = 40;
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
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, totalW, totalH);

    groups.forEach((g, gi) => {
      const col = gi % COLS;
      const row = Math.floor(gi / COLS);

      const scaleX = Math.min(1, (cellW - 2 * CELL_PAD) / g.width);
      const scaleY = Math.min(1, (cellH - 2 * CELL_PAD - LABEL_TOP - LABEL_BOTTOM) / g.height);
      const s = Math.min(scaleX, scaleY);

      const pw = g.width * s;
      const ph = g.height * s;

      const ox = col * cellW + CELL_PAD + (cellW - 2 * CELL_PAD - pw) / 2;
      const oy = row * cellH + CELL_PAD + LABEL_TOP;

      // Draw the actual polygon if available, else rectangle
      const poly = g.parts[0]?.outer ?? null;
      const holes = g.parts[0]?.holes ?? [];

      if (poly && poly.length > 0) {
        // Find polygon bounding box for normalization
        let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
        for (const p of poly) {
          if (p.x < pminX) pminX = p.x; if (p.x > pmaxX) pmaxX = p.x;
          if (p.y < pminY) pminY = p.y; if (p.y > pmaxY) pmaxY = p.y;
        }

        const toScreen = (p: Point) => ({
          x: ox + (p.x - pminX) * s,
          y: oy + (p.y - pminY) * s,
        });

        // Draw outer polygon
        ctx.beginPath();
        const sp0 = toScreen(poly[0]);
        ctx.moveTo(sp0.x, sp0.y);
        for (let i = 1; i < poly.length; i++) {
          const sp = toScreen(poly[i]);
          ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();
        ctx.fillStyle = "#1e3a5f";
        ctx.fill();
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Draw holes (miolos)
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
          ctx.fillStyle = "#0f172a";
          ctx.fill();
          ctx.strokeStyle = "#60a5fa88";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Border margin visual indicator (shrunk polygon)
        const shrunk = shrinkPolygon(poly, borderMargin);
        ctx.beginPath();
        const sshr0 = toScreen(shrunk[0]);
        ctx.moveTo(sshr0.x, sshr0.y);
        for (let i = 1; i < shrunk.length; i++) {
          const ssp = toScreen(shrunk[i]);
          ctx.lineTo(ssp.x, ssp.y);
        }
        ctx.closePath();
        ctx.strokeStyle = "#60a5fa55";
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Shape-aware LED positions
        const { positions, totalLeds, pitch } = calcLedsForPart(poly, holes, ledModel, borderMargin);

        // LED physical size in screen pixels
        const ledW = Math.max(1.5, ledModel.width * s);
        const ledH = Math.max(1.5, ledModel.height * s);

        for (const pos of positions) {
          const lx = ox + (pos.x - pminX) * s;
          const ly = oy + (pos.y - pminY) * s;

          // Glow
          const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(ledW, ledH));
          grd.addColorStop(0, "#fde68aaa");
          grd.addColorStop(1, "#f59e0b00");
          ctx.beginPath();
          ctx.arc(lx, ly, Math.max(ledW, ledH), 0, Math.PI * 2);
          ctx.fillStyle = grd;
          ctx.fill();

          // LED rectangle at real size
          ctx.fillStyle = "#fde68a";
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 0.5;
          ctx.fillRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
          ctx.strokeRect(lx - ledW / 2, ly - ledH / 2, ledW, ledH);
        }

        // Dimensions above
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);

        // LED count below
        ctx.fillStyle = "#fde68a";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`${totalLeds} LEDs · pitch ${pitch.toFixed(1)} mm`, ox + pw / 2, oy + ph + 8);

        const { totalLeds: bboxTotal } = calcLedsForBbox(g.width, g.height, ledModel, borderMargin);
        const coverage = bboxTotal > 0 ? Math.round((totalLeds / bboxTotal) * 100) : 0;
        ctx.fillStyle = "#10b981";
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`aproveit. ${coverage}%`, ox + pw / 2, oy + ph + 20);

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
        // Fallback: draw rectangle
        ctx.fillStyle = "#1e3a5f";
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1.5;
        ctx.fillRect(ox, oy, pw, ph);
        ctx.strokeRect(ox, oy, pw, ph);

        const { totalLeds, pitch } = calcLedsForBbox(g.width, g.height, ledModel, borderMargin);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);
        ctx.fillStyle = "#fde68a";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`${totalLeds} LEDs · pitch ${pitch.toFixed(1)} mm`, ox + pw / 2, oy + ph + 8);
      }
    });
  }, [groups, ledModel, borderMargin]);

  return (
    <div className="overflow-auto rounded-lg border border-border bg-[#0f172a] p-2">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}


// ─── Print Plan ───────────────────────────────────────────────────────────────
function printPlan(
  result: NestResult,
  opts: NestingOptions,
  ledModel: LedModel | null,
  showLeds: boolean,
  borderMargin: number,
  groups: ReturnType<typeof groupParts>,
  ledSummary: { rows: any[]; totalLeds: number; totalPower: number } | null,
  fileName: string,
) {
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) { alert("Permita popups para imprimir."); return; }

  // Build all sheet canvases as data-URLs
  const sheetDataUrls: string[] = [];
  for (let si = 0; si < result.sheets.length; si++) {
    const canvas = document.createElement("canvas");
    const scale = Math.min(900 / opts.sheetWidth, 600 / opts.sheetHeight);
    const w = opts.sheetWidth * scale;
    const h = opts.sheetHeight * scale;
    canvas.width = w; canvas.height = h;
    renderSheet(canvas, result.sheets[si], opts.sheetWidth, opts.sheetHeight, opts.margin, ledModel, showLeds, borderMargin);
    sheetDataUrls.push(canvas.toDataURL("image/png"));
  }

  // Build LED drawing canvases per group
  const ledUrls: string[] = [];
  if (ledModel && groups.length) {
    for (const g of groups) {
      const poly = g.parts[0]?.outer ?? [];
      const holes = g.parts[0]?.holes ?? [];
      const { totalLeds, pitch } = poly.length
        ? calcLedsForPart(poly, holes, ledModel, borderMargin)
        : calcLedsForBbox(g.width, g.height, ledModel, borderMargin);

      const S = Math.min(3, 300 / Math.max(g.width, g.height));
      const cw = Math.round(g.width * S + 48);
      const ch = Math.round(g.height * S + 80);
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);

      const ox = 24, oy = 24;
      const pw = g.width * S, ph = g.height * S;

      if (poly.length > 0) {
        let pminX = Infinity, pminY = Infinity;
        for (const p of poly) { if (p.x < pminX) pminX = p.x; if (p.y < pminY) pminY = p.y; }
        const toS = (p: {x:number;y:number}) => ({ x: ox + (p.x - pminX) * S, y: oy + (p.y - pminY) * S });

        ctx.beginPath();
        const sp0 = toS(poly[0]); ctx.moveTo(sp0.x, sp0.y);
        for (let i = 1; i < poly.length; i++) { const sp = toS(poly[i]); ctx.lineTo(sp.x, sp.y); }
        ctx.closePath();
        ctx.fillStyle = "#e8f4fd"; ctx.fill();
        ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5; ctx.stroke();

        for (const hole of holes) {
          if (!hole.length) continue;
          ctx.beginPath();
          const sh0 = toS(hole[0]); ctx.moveTo(sh0.x, sh0.y);
          for (let i = 1; i < hole.length; i++) { const sh = toS(hole[i]); ctx.lineTo(sh.x, sh.y); }
          ctx.closePath();
          ctx.fillStyle = "#fff"; ctx.fill();
          ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 1; ctx.stroke();
        }

        const { positions } = calcLedsForPart(poly, holes, ledModel, borderMargin);
        const ledW = Math.max(1.5, ledModel.width * S);
        const ledH = Math.max(1.5, ledModel.height * S);
        for (const pos of positions) {
          const lx = ox + (pos.x - pminX) * S;
          const ly = oy + (pos.y - pminY) * S;
          ctx.fillStyle = "#facc15"; ctx.strokeStyle = "#d97706"; ctx.lineWidth = 0.5;
          ctx.fillRect(lx - ledW/2, ly - ledH/2, ledW, ledH);
          ctx.strokeRect(lx - ledW/2, ly - ledH/2, ledW, ledH);
        }
      } else {
        ctx.fillStyle = "#e8f4fd"; ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 1.5;
        ctx.fillRect(ox, oy, pw, ph); ctx.strokeRect(ox, oy, pw, ph);
      }

      ctx.fillStyle = "#111"; ctx.font = "bold 10px monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(`${g.width.toFixed(0)}×${g.height.toFixed(0)}mm  |  ${totalLeds} LEDs  |  pitch ${pitch.toFixed(1)}mm  |  ×${g.quantity}pç`, cw/2, oy + ph + 6);
      ledUrls.push(canvas.toDataURL("image/png"));
    }
  }

  const now = new Date().toLocaleString("pt-BR");
  const totalParts = result.sheets.reduce((s, sh) => s + sh.length, 0);

  let html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Plano de Corte – ${fileName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: #fff; color: #111; padding: 24px; }
  h1 { font-size: 18px; font-weight: 700; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 4px; }
  .meta { font-size: 11px; color: #555; margin-bottom: 20px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 12px; color: #333; }
  .sheet-block { page-break-inside: avoid; margin-bottom: 24px; }
  .sheet-label { font-size: 11px; font-weight: 700; margin-bottom: 6px; }
  .sheet-img { border: 1px solid #bbb; display: block; max-width: 100%; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f3f4f6; text-align: right; padding: 5px 8px; border: 1px solid #ddd; font-weight: 700; }
  th:first-child { text-align: left; }
  td { padding: 4px 8px; border: 1px solid #eee; text-align: right; }
  td:first-child { text-align: left; }
  tr:nth-child(even) td { background: #f9fafb; }
  .total-row td { font-weight: 700; background: #f3f4f6 !important; border-top: 2px solid #bbb; }
  .led-grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .led-card { border: 1px solid #ddd; padding: 8px; page-break-inside: avoid; }
  .led-img { display: block; border: 1px solid #eee; }
  .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .stat-box { border: 1px solid #ddd; padding: 10px; }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  .stat-val { font-size: 20px; font-weight: 700; }
  @media print {
    body { padding: 12px; }
    .no-print { display: none; }
    @page { margin: 1cm; size: A4 landscape; }
  }
</style></head><body>`;

  html += `<h1>📐 Plano de Corte e LED</h1>
<div class="meta">Arquivo: <b>${fileName}</b> &nbsp;|&nbsp; Gerado: ${now} &nbsp;|&nbsp; Chapa: ${opts.sheetWidth}×${opts.sheetHeight}mm &nbsp;|&nbsp; Folga: ${opts.gap}mm &nbsp;|&nbsp; Margem: ${opts.margin}mm</div>`;

  // Summary stats
  html += `<div class="section"><div class="section-title">Resumo</div>
<div class="stats-grid">
  <div class="stat-box"><div class="stat-label">Chapas usadas</div><div class="stat-val">${result.sheets.length}</div></div>
  <div class="stat-box"><div class="stat-label">Peças posicionadas</div><div class="stat-val">${totalParts}</div></div>
  <div class="stat-box"><div class="stat-label">Aproveitamento</div><div class="stat-val">${(result.utilization * 100).toFixed(1)}%</div></div>
</div>`;

  if (ledSummary && ledModel) {
    html += `<div class="stats-grid">
  <div class="stat-box"><div class="stat-label">Total de LEDs</div><div class="stat-val">${ledSummary.totalLeds.toLocaleString("pt-BR")}</div></div>
  <div class="stat-box"><div class="stat-label">Potência total</div><div class="stat-val">${ledSummary.totalPower.toFixed(1)} W</div></div>
  <div class="stat-box"><div class="stat-label">LED: ${ledModel.name}</div><div class="stat-val">${ledModel.width}×${ledModel.height}mm</div></div>
</div>`;
  }
  html += `</div>`;

  // Sheets
  html += `<div class="section"><div class="section-title">Chapas de Corte</div>`;
  for (let si = 0; si < result.sheets.length; si++) {
    const sh = result.sheets[si];
    html += `<div class="sheet-block">
<div class="sheet-label">Chapa ${si + 1} — ${sh.length} peça(s)</div>
<img class="sheet-img" src="${sheetDataUrls[si]}" />
</div>`;
  }
  html += `</div>`;

  // LED drawing per model
  if (ledModel && ledUrls.length) {
    html += `<div class="section"><div class="section-title">Plano de Posicionamento LED — ${ledModel.name} (${ledModel.width}×${ledModel.height}mm, margem ${borderMargin}mm)</div>
<div class="led-grid">`;
    groups.forEach((g, gi) => {
      html += `<div class="led-card"><img class="led-img" src="${ledUrls[gi]}" /></div>`;
    });
    html += `</div></div>`;
  }

  // LED detail table
  if (ledSummary) {
    html += `<div class="section"><div class="section-title">Detalhamento de LEDs por Modelo</div>
<table><thead><tr>
<th>Dimensões (mm)</th><th>Qtd</th><th>Pitch (mm)</th><th>LEDs/peça</th><th>Total LEDs</th><th>Potência (W)</th>
</tr></thead><tbody>`;
    for (const row of ledSummary.rows) {
      html += `<tr><td>${row.width.toFixed(0)} × ${row.height.toFixed(0)}</td><td>${row.qty}</td><td>${row.pitch.toFixed(1)}</td><td>${row.ledsPerPiece}</td><td>${row.totalLeds}</td><td>${row.totalPower.toFixed(1)}</td></tr>`;
    }
    html += `</tbody><tfoot><tr class="total-row"><td colspan="4">TOTAL</td><td>${ledSummary.totalLeds.toLocaleString("pt-BR")}</td><td>${ledSummary.totalPower.toFixed(1)}</td></tr></tfoot></table></div>`;
  }

  html += `<div class="no-print" style="position:fixed;top:16px;right:16px;">
<button onclick="window.print()" style="background:#111;color:#fff;border:none;padding:10px 20px;font-size:14px;cursor:pointer;font-family:monospace;">🖨️ Imprimir</button>
</div>`;
  html += `</body></html>`;

  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 800);
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
      const saved = localStorage.getItem("nestcnc_led_models");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [selectedLedId, setSelectedLedId] = useState<string | null>(() => {
    try { return localStorage.getItem("nestcnc_led_selected"); } catch { return null; }
  });
  const [showLeds, setShowLeds] = useState(true);
  const [borderMargin, setBorderMargin] = useState(4);
  // Track the LED model that was last used to render — to show "update" button
  const [renderedLedId, setRenderedLedId] = useState<string | null>(null);
  const [renderedMargin, setRenderedMargin] = useState<number>(4);
  const [ledKey, setLedKey] = useState(0); // force canvas re-render

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) => setOpts((p) => ({ ...p, [key]: val }));

  const selectedLed = ledModels.find((l) => l.id === selectedLedId) ?? null;

  // Detect if LED selection or margin changed since last render
  const ledNeedsUpdate = selectedLedId !== renderedLedId || borderMargin !== renderedMargin;

  const handleUpdateLed = useCallback(() => {
    setLedKey((k) => k + 1);
    setRenderedLedId(selectedLedId);
    setRenderedMargin(borderMargin);
  }, [selectedLedId, borderMargin]);

  // Auto-apply on first selection
  useEffect(() => {
    if (selectedLedId && renderedLedId === null) {
      setRenderedLedId(selectedLedId);
      setRenderedMargin(borderMargin);
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

  // Persist LED models whenever they change
  useEffect(() => {
    try { localStorage.setItem("nestcnc_led_models", JSON.stringify(ledModels)); } catch {}
  }, [ledModels]);

  useEffect(() => {
    try {
      if (selectedLedId) localStorage.setItem("nestcnc_led_selected", selectedLedId);
      else localStorage.removeItem("nestcnc_led_selected");
    } catch {}
  }, [selectedLedId]);

  const redraw = useCallback(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    renderSheet(
      canvasRef.current,
      result.sheets[activeSheet] ?? [],
      opts.sheetWidth, opts.sheetHeight, opts.margin,
      selectedLed, showLeds, borderMargin
    );
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin, selectedLed, showLeds, borderMargin]);

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

  // LED summary using shape-aware calc when polygon data is available
  const ledSummary = useMemo(() => {
    if (!groups.length || !selectedLed) return null;
    const rows = groups.map((g) => {
      const poly = g.parts[0]?.outer ?? [];
      const holes = g.parts[0]?.holes ?? [];
      let totalLeds = 0;
      let pitch = 0;
      if (poly.length) {
        const r = calcLedsForPart(poly, holes, selectedLed, borderMargin);
        totalLeds = r.totalLeds; pitch = r.pitch;
      } else {
        const r = calcLedsForBbox(g.width, g.height, selectedLed, borderMargin);
        totalLeds = r.totalLeds; pitch = r.pitch;
      }
      const { ledsX, ledsY } = calcLedsForBbox(g.width, g.height, selectedLed, borderMargin);
      const totalPower = totalLeds * selectedLed.power * g.quantity;
      return { width: g.width, height: g.height, qty: g.quantity, ledsPerPiece: totalLeds, ledsX, ledsY, totalLeds: totalLeds * g.quantity, pitch, totalPower };
    });
    const totalLeds = rows.reduce((s, r) => s + r.totalLeds, 0);
    const totalPower = rows.reduce((s, r) => s + r.totalPower, 0);
    return { rows, totalLeds, totalPower };
  }, [groups, selectedLed, borderMargin, ledKey]);

  const colorLegend = useMemo(() => {
    if (!result) return [];
    const m = new Map<string, string>(); let idx = 0;
    for (const sh of result.sheets) for (const p of sh) if (!m.has(p.groupSig)) m.set(p.groupSig, getColor(p.groupSig, idx++));
    return groups.map((g) => ({ label: `${g.width.toFixed(0)}×${g.height.toFixed(0)} mm`, qty: g.quantity, color: m.get(g.key) ?? "#888" }));
  }, [result, groups]);

  const currentSheetParts = result?.sheets[activeSheet] ?? [];

  // Active LED for display (the one currently rendered, not just selected)
  const activeLedForDisplay = ledModels.find((l) => l.id === renderedLedId) ?? null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Layers className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-base font-semibold tracking-tight">NestCNC</h1>
          <p className="text-xs text-muted-foreground">Aproveitamento automático de chapas</p>
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
              onClick={() => printPlan(result, opts, selectedLed, showLeds, borderMargin, groups, ledSummary, fileName || "sem-nome.pdf")}
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
                    <Select value={selectedLedId ?? ""} onValueChange={(v) => { setSelectedLedId(v); }}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                      <SelectContent>
                        {ledModels.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name} ({l.width}×{l.height}mm)</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {ledNeedsUpdate && selectedLedId && (
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
                      <div className="border-t border-border pt-2">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">Áreas (cm²)</p>
                        <div className="flex justify-between"><span className="text-muted-foreground">Chapa</span><span>{(stats.sheetArea / 100).toFixed(0)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Ocupada (bbox)</span><span className="text-blue-400">{(stats.totalBboxArea / 100).toFixed(0)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Forma real (polígono)</span><span className="text-muted-foreground/60">{(stats.totalPartArea / 100).toFixed(0)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Sobra estimada</span><span className="text-red-400">{((stats.totalSheetArea - stats.totalBboxArea) / 100).toFixed(0)}</span></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ── LEDs TAB ── */}
          {activeTab === "leds" && (
            <div className="flex flex-1 flex-col overflow-y-auto p-6 gap-6">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-yellow-500/20">
                  <Lightbulb className="h-4 w-4 text-yellow-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Calculadora de LEDs</h2>
                  <p className="text-xs text-muted-foreground">Posicionamento automático respeitando a forma real da peça</p>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Parâmetros de Cálculo</h3>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Margem de borda (mm)</Label>
                  <Input type="number" min={0} step={0.5} value={borderMargin}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setBorderMargin(v); }}
                    className="h-8 text-sm" />
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">Área da letra respeita margem mínima da borda</p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">LED ativo para cálculo</Label>
                  {ledModels.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">Cadastre um LED na aba "Cadastro LED"</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Select value={selectedLedId ?? ""} onValueChange={(v) => { setSelectedLedId(v); }}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                        <SelectContent>
                          {ledModels.map((l) => (
                            <SelectItem key={l.id} value={l.id}>{l.name} ({l.width}×{l.height}mm)</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {/* Update button — shown when LED changed but canvas not yet refreshed */}
                      {ledNeedsUpdate && selectedLedId && (
                        <Button
                          onClick={handleUpdateLed}
                          variant="outline"
                          className="w-full h-8 text-xs border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                          Atualizar visualização do LED
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {selectedLed && (
                  <div className="col-span-2 rounded-md bg-background border border-border p-3">
                    <p className="text-xs font-mono text-muted-foreground leading-relaxed">
                      <span className="text-blue-400">espessura</span> = min(largura, altura) − 2 × {borderMargin}mm<br />
                      <span className="text-yellow-400">pitch_máx</span> = espessura × 0,9 {"<"} (espessura − 10%)<br />
                      <span className="text-green-400">LED_ref</span> = max({selectedLed.width}, {selectedLed.height}) = {Math.max(selectedLed.width, selectedLed.height)} mm<br />
                      <span className="text-orange-400">pitch_final</span> = min(LED_ref, pitch_máx)<br />
                      <span className="text-purple-400">posições</span> = filtradas pela forma real do polígono
                    </p>
                  </div>
                )}
              </div>

              {!groups.length ? (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-sm text-muted-foreground">Importe e interprete um PDF para visualizar os LEDs.</p>
                </div>
              ) : !selectedLed ? (
                <div className="flex flex-1 items-center justify-center flex-col gap-2">
                  <Zap className="h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">Selecione ou cadastre um LED para calcular o posicionamento.</p>
                  <Button variant="secondary" className="mt-2 text-xs h-8" onClick={() => setActiveTab("ledcad")}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Cadastrar LED
                  </Button>
                </div>
              ) : (
                <>
                  {ledSummary && (
                    <div className="grid grid-cols-3 gap-4">
                      <div className="rounded-lg border border-border bg-card p-4">
                        <p className="text-xs text-muted-foreground mb-1">Total de LEDs</p>
                        <p className="text-2xl font-bold text-yellow-400">{ledSummary.totalLeds.toLocaleString("pt-BR")}</p>
                        <p className="text-[10px] text-muted-foreground mt-1">contagem por forma real</p>
                      </div>
                      <div className="rounded-lg border border-border bg-card p-4">
                        <p className="text-xs text-muted-foreground mb-1">Potência total</p>
                        <p className="text-2xl font-bold text-orange-400">{ledSummary.totalPower.toFixed(1)} W</p>
                      </div>
                      <div className="rounded-lg border border-border bg-card p-4">
                        <p className="text-xs text-muted-foreground mb-1">Margem de borda</p>
                        <p className="text-2xl font-bold text-blue-400">{borderMargin} mm</p>
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-yellow-400" /> Desenho de Posicionamento para Produção
                      </h3>
                      {ledNeedsUpdate && (
                        <Button onClick={handleUpdateLed} variant="outline" size="sm" className="h-7 text-xs border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10">
                          <RefreshCw className="h-3 w-3 mr-1" /> Atualizar
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      Retângulos amarelos = LEDs em tamanho real · linha pontilhada = margem de {borderMargin}mm · posições filtradas pela forma da peça
                    </p>
                    <LedDrawingCanvas key={ledKey} groups={groups} ledModel={activeLedForDisplay ?? selectedLed} borderMargin={borderMargin} />
                  </div>

                  {ledSummary && (
                    <div className="rounded-lg border border-border bg-card overflow-hidden">
                      <div className="px-4 py-3 border-b border-border">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Detalhamento por Modelo</h3>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border bg-background">
                              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Dimensões (mm)</th>
                              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Qtd</th>
                              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Pitch (mm)</th>
                              <th className="px-4 py-2 text-right font-medium text-muted-foreground">LEDs/peça</th>
                              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Total LEDs</th>
                              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Potência (W)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ledSummary.rows.map((row, i) => (
                              <tr key={i} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                                <td className="px-4 py-2 font-mono">{row.width.toFixed(0)} × {row.height.toFixed(0)}</td>
                                <td className="px-4 py-2 text-right">{row.qty}</td>
                                <td className="px-4 py-2 text-right text-blue-400">{row.pitch.toFixed(1)}</td>
                                <td className="px-4 py-2 text-right text-yellow-400 font-medium">{row.ledsPerPiece}</td>
                                <td className="px-4 py-2 text-right font-bold">{row.totalLeds}</td>
                                <td className="px-4 py-2 text-right text-orange-400">{row.totalPower.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="bg-background font-semibold">
                              <td className="px-4 py-2 text-muted-foreground" colSpan={4}>TOTAL</td>
                              <td className="px-4 py-2 text-right text-yellow-400 text-sm">{ledSummary.totalLeds.toLocaleString("pt-BR")}</td>
                              <td className="px-4 py-2 text-right text-orange-400">{ledSummary.totalPower.toFixed(1)}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
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
