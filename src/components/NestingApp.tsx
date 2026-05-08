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
import {
  Loader2, Upload, Layers, Play, AlertCircle, CheckCircle2,
  ChevronLeft, ChevronRight, Lightbulb, Plus, Trash2, Zap,
  Package, RefreshCw, Printer, RotateCw, CheckSquare, Square,
} from "lucide-react";

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

export interface LedModel {
  id: string;
  name: string;
  width: number;
  height: number;
  power: number;
  photoUrl?: string;
}

export interface GroupLedConfig {
  groupKey: string;
  ledIds: string[];
  letterHeight: number;
  allowRotation: boolean;
}

function pointInPoly(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function shrinkPolygon(poly: Point[], margin: number): Point[] {
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

// Pitch = letterHeight * 0.85  (altura da letra - 15%)
function calcPitch(letterHeight: number): number {
  return letterHeight * 0.85;
}

interface LedPlacement {
  x: number;
  y: number;
  rotated: boolean;
  ledId: string;
}

function calcLedsForPart(
  polygon: Point[],
  holes: Point[][],
  ledModels: LedModel[],
  letterHeight: number,
  allowRotation: boolean,
): { totalLeds: number; pitch: number; positions: LedPlacement[] } {
  if (!polygon.length || !ledModels.length) return { totalLeds: 0, pitch: 0, positions: [] };
  const pitch = calcPitch(letterHeight);
  if (pitch <= 0) return { totalLeds: 0, pitch: 0, positions: [] };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  const safeMargin = pitch * 0.1;
  const inner = shrinkPolygon(polygon, safeMargin);
  const positions: LedPlacement[] = [];
  const cols = Math.max(1, Math.floor(bboxW / pitch));
  const rows = Math.max(1, Math.floor(bboxH / pitch));
  const offsetX = (bboxW - cols * pitch) / 2;
  const offsetY = (bboxH - rows * pitch) / 2;
  const sortedModels = [...ledModels].sort((a, b) => (b.width * b.height) - (a.width * a.height));

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const x = minX + offsetX + col * pitch;
      const y = minY + offsetY + row * pitch;
      const pt = { x, y };
      if (!pointInPoly(pt, inner)) continue;
      let inHole = false;
      for (const hole of holes) { if (pointInPoly(pt, hole)) { inHole = true; break; } }
      if (inHole) continue;

      let placed = false;
      for (const led of sortedModels) {
        if (led.width <= pitch && led.height <= pitch) {
          positions.push({ x, y, rotated: false, ledId: led.id }); placed = true; break;
        }
        if (allowRotation && led.height <= pitch && led.width <= pitch) {
          positions.push({ x, y, rotated: true, ledId: led.id }); placed = true; break;
        }
      }
      if (!placed && sortedModels.length > 0) {
        const s = sortedModels[sortedModels.length - 1];
        positions.push({ x, y, rotated: allowRotation && s.height < s.width, ledId: s.id });
      }
    }
  }
  return { totalLeds: positions.length, pitch, positions };
}

// ─── Render Sheet to any canvas ────────────────────────────────────────────
function drawSheetToCanvas(
  canvas: HTMLCanvasElement,
  placed: PlacedPart[],
  sheetWidth: number,
  sheetHeight: number,
  margin: number,
  canvasW: number,
  canvasH: number,
  ledModelsMap: Map<string, LedModel>,
  groupLedConfigs: Map<string, GroupLedConfig>,
  showLeds: boolean,
  groupSigToKey: Map<string, string>,
  dpr = 1,
) {
  const scale = Math.min(canvasW / sheetWidth, canvasH / sheetHeight) * 0.96;
  const drawW = sheetWidth * scale;
  const drawH = sheetHeight * scale;
  canvas.width = drawW * dpr;
  canvas.height = drawH * dpr;
  canvas.style.width = `${drawW}px`;
  canvas.style.height = `${drawH}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#1e293b"; ctx.fillRect(0, 0, drawW, drawH);
  ctx.strokeStyle = "#475569"; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, drawW - 1, drawH - 1);
  if (margin > 0) {
    ctx.strokeStyle = "#334155"; ctx.setLineDash([4, 4]);
    ctx.strokeRect(margin * scale, margin * scale, (sheetWidth - 2 * margin) * scale, (sheetHeight - 2 * margin) * scale);
    ctx.setLineDash([]);
  }

  const sigColorMap = new Map<string, string>();
  let ci = 0;
  let maxX = margin;
  for (const part of placed) { if (part.bbox.maxX > maxX) maxX = part.bbox.maxX; }

  for (const part of placed) {
    if (!sigColorMap.has(part.groupSig)) sigColorMap.set(part.groupSig, getColor(part.groupSig, ci++));
    const color = sigColorMap.get(part.groupSig)!;
    const poly = part.polygon;
    if (!poly.length) continue;

    ctx.beginPath(); ctx.moveTo(poly[0].x * scale, poly[0].y * scale);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x * scale, poly[i].y * scale);
    ctx.closePath(); ctx.fillStyle = color + "40"; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();

    for (const hole of part.holes) {
      if (!hole.length) continue;
      ctx.beginPath(); ctx.moveTo(hole[0].x * scale, hole[0].y * scale);
      for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x * scale, hole[i].y * scale);
      ctx.closePath(); ctx.fillStyle = "#1e293b"; ctx.fill();
      ctx.strokeStyle = color + "99"; ctx.lineWidth = 1; ctx.stroke();
    }

    if (part.rotation !== 0 || part.mirrored) {
      const cx = (part.bbox.minX + part.bbox.maxX) / 2 * scale;
      const cy = (part.bbox.minY + part.bbox.maxY) / 2 * scale;
      const sz = Math.max(8, Math.min(11, (part.bbox.maxX - part.bbox.minX) * scale / 5));
      ctx.fillStyle = color; ctx.font = `${sz}px monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(part.mirrored ? `M${part.rotation}°` : `${part.rotation}°`, cx, cy);
    }

    if (showLeds) {
      const gKey = groupSigToKey.get(part.groupSig);
      const cfg = gKey ? groupLedConfigs.get(gKey) : null;
      if (cfg && cfg.ledIds.length) {
        const models = cfg.ledIds.map((id) => ledModelsMap.get(id)).filter(Boolean) as LedModel[];
        if (models.length) {
          const { positions } = calcLedsForPart(part.polygon, part.holes, models, cfg.letterHeight, cfg.allowRotation);
          for (const pos of positions) {
            const led = ledModelsMap.get(pos.ledId); if (!led) continue;
            const lW = Math.max(1.5, (pos.rotated ? led.height : led.width) * scale);
            const lH = Math.max(1.5, (pos.rotated ? led.width : led.height) * scale);
            ctx.fillStyle = "#fde68a"; ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 0.5;
            ctx.fillRect(pos.x * scale - lW / 2, pos.y * scale - lH / 2, lW, lH);
            ctx.strokeRect(pos.x * scale - lW / 2, pos.y * scale - lH / 2, lW, lH);
          }
          const labelX = (part.bbox.minX + part.bbox.maxX) / 2 * scale;
          const labelY = part.bbox.maxY * scale + 4;
          const sz = Math.max(7, Math.min(10, (part.bbox.maxX - part.bbox.minX) * scale / 6));
          ctx.font = `bold ${sz}px monospace`; ctx.textAlign = "center";
          ctx.textBaseline = "top"; ctx.fillStyle = "#fde68a";
          ctx.fillText(`${positions.length} LEDs`, labelX, labelY);
        }
      }
    }
  }

  if (placed.length > 0) {
    const leftW = sheetWidth - maxX - margin;
    const leftH = sheetHeight - 2 * margin;
    if (leftW > 10) {
      ctx.fillStyle = "rgba(16,185,129,0.08)";
      ctx.fillRect(maxX * scale, margin * scale, leftW * scale, leftH * scale);
      ctx.strokeStyle = "#10b98166"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.strokeRect(maxX * scale, margin * scale, leftW * scale, leftH * scale);
      ctx.setLineDash([]);
      ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#10b981";
      ctx.fillText(`Sobra: ${leftW.toFixed(0)}×${leftH.toFixed(0)} mm`, (maxX + leftW / 2) * scale, (margin + leftH / 2) * scale);
    }
  }
}

function renderSheet(
  canvas: HTMLCanvasElement,
  placed: PlacedPart[],
  sheetWidth: number,
  sheetHeight: number,
  margin: number,
  ledModelsMap: Map<string, LedModel>,
  groupLedConfigs: Map<string, GroupLedConfig>,
  showLeds: boolean,
  groupSigToKey: Map<string, string>,
) {
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement;
  if (!container) return;
  const cw = container.clientWidth - 2;
  const ch = container.clientHeight - 2;
  drawSheetToCanvas(canvas, placed, sheetWidth, sheetHeight, margin, cw, ch, ledModelsMap, groupLedConfigs, showLeds, groupSigToKey, dpr);
}

// ─── Print Plan ────────────────────────────────────────────────────────────
function printPlan(
  result: NestResult,
  opts: NestingOptions,
  ledModelsMap: Map<string, LedModel>,
  groupLedConfigs: Map<string, GroupLedConfig>,
  groupSigToKey: Map<string, string>,
  showLeds: boolean,
  groups: ReturnType<typeof groupParts>,
  ledSummary: { rows: any[]; totalLeds: number; totalPower: number } | null,
  fileName: string,
) {
  const sheetDataUrls: string[] = [];
  for (let si = 0; si < result.sheets.length; si++) {
    const W = 1600, H = 900;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    document.body.appendChild(canvas);
    drawSheetToCanvas(canvas, result.sheets[si], opts.sheetWidth, opts.sheetHeight, opts.margin, W, H,
      ledModelsMap, groupLedConfigs, showLeds, groupSigToKey, 1);
    sheetDataUrls.push(canvas.toDataURL("image/png", 0.92));
    document.body.removeChild(canvas);
  }

  const ledDetailUrls: string[] = [];
  for (const g of groups) {
    const cfg = groupLedConfigs.get(g.key);
    if (!cfg || !cfg.ledIds.length) { ledDetailUrls.push(""); continue; }
    const models = cfg.ledIds.map((id) => ledModelsMap.get(id)).filter(Boolean) as LedModel[];
    if (!models.length) { ledDetailUrls.push(""); continue; }
    const poly = g.parts[0]?.outer ?? [];
    const holes = g.parts[0]?.holes ?? [];
    const { positions, pitch } = calcLedsForPart(poly, holes, models, cfg.letterHeight, cfg.allowRotation);
    const S = Math.min(4, 360 / Math.max(g.width, g.height, 1));
    const PAD = 32;
    const cw2 = Math.round(g.width * S + PAD * 2);
    const ch2 = Math.round(g.height * S + PAD * 2 + 30);
    const canvas = document.createElement("canvas");
    canvas.width = cw2; canvas.height = ch2;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cw2, ch2);
    const ox = PAD, oy = PAD;
    if (poly.length) {
      let pminX = Infinity, pminY = Infinity;
      for (const p of poly) { if (p.x < pminX) pminX = p.x; if (p.y < pminY) pminY = p.y; }
      const toS = (p: Point) => ({ x: ox + (p.x - pminX) * S, y: oy + (p.y - pminY) * S });
      ctx.beginPath(); const s0 = toS(poly[0]); ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < poly.length; i++) { const s = toS(poly[i]); ctx.lineTo(s.x, s.y); }
      ctx.closePath(); ctx.fillStyle = "#dbeafe"; ctx.fill();
      ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1.5; ctx.stroke();
      for (const hole of holes) {
        if (!hole.length) continue;
        ctx.beginPath(); const h0 = toS(hole[0]); ctx.moveTo(h0.x, h0.y);
        for (let i = 1; i < hole.length; i++) { const h = toS(hole[i]); ctx.lineTo(h.x, h.y); }
        ctx.closePath(); ctx.fillStyle = "#ffffff"; ctx.fill();
        ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 1; ctx.stroke();
      }
      for (const pos of positions) {
        const led = ledModelsMap.get(pos.ledId); if (!led) continue;
        const lW = Math.max(2, (pos.rotated ? led.height : led.width) * S);
        const lH = Math.max(2, (pos.rotated ? led.width : led.height) * S);
        const lx = ox + (pos.x - pminX) * S, ly = oy + (pos.y - pminY) * S;
        ctx.fillStyle = pos.rotated ? "#fb923c" : "#fbbf24";
        ctx.strokeStyle = "#d97706"; ctx.lineWidth = 0.5;
        ctx.fillRect(lx - lW / 2, ly - lH / 2, lW, lH);
        ctx.strokeRect(lx - lW / 2, ly - lH / 2, lW, lH);
      }
    } else {
      ctx.fillStyle = "#dbeafe"; ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1.5;
      ctx.fillRect(ox, oy, g.width * S, g.height * S); ctx.strokeRect(ox, oy, g.width * S, g.height * S);
    }
    const modelNames = models.map((m) => m.name).join(" + ");
    ctx.fillStyle = "#111"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(`${g.width.toFixed(0)}×${g.height.toFixed(0)}mm | ${positions.length} LEDs | pitch ${pitch.toFixed(1)}mm | ×${g.quantity}pç | ${modelNames}`, cw2 / 2, oy + g.height * S + 6);
    ledDetailUrls.push(canvas.toDataURL("image/png", 0.92));
    document.body.removeChild(canvas);
  }

  const now = new Date().toLocaleString("pt-BR");
  const totalParts = result.sheets.reduce((s, sh) => s + sh.length, 0);

  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<title>Plano de Corte – ${fileName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#fff;color:#111;padding:20px;font-size:11px}
h1{font-size:16px;font-weight:700;border-bottom:3px solid #111;padding-bottom:6px;margin-bottom:4px}
.meta{font-size:10px;color:#555;margin-bottom:16px}
.section{margin-bottom:24px}
.st{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #bbb;padding-bottom:3px;margin-bottom:10px;color:#333}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.stat{border:1px solid #ddd;padding:8px}
.slabel{font-size:9px;text-transform:uppercase;color:#777}
.sval{font-size:20px;font-weight:700}
.sheet-block{page-break-inside:avoid;margin-bottom:16px}
.sheet-label{font-size:10px;font-weight:700;margin-bottom:4px}
img{border:1px solid #bbb;display:block;max-width:100%;height:auto}
table{width:100%;border-collapse:collapse;font-size:10px}
th{background:#f3f4f6;text-align:right;padding:4px 8px;border:1px solid #ddd;font-weight:700}
th:first-child{text-align:left}
td{padding:3px 8px;border:1px solid #eee;text-align:right}
td:first-child{text-align:left}
tr:nth-child(even) td{background:#f9fafb}
.tf td{font-weight:700;background:#f3f4f6!important;border-top:2px solid #bbb}
.led-grid{display:flex;flex-wrap:wrap;gap:12px}
.led-card{border:1px solid #ddd;padding:6px;page-break-inside:avoid}
.pbtn{position:fixed;top:12px;right:12px;background:#111;color:#fff;border:none;padding:8px 18px;font-size:13px;cursor:pointer;border-radius:4px}
@media print{.pbtn{display:none}@page{margin:1cm;size:A4 landscape}}
</style></head><body>
<button class="pbtn" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
<h1>📐 Plano de Corte e Posicionamento LED</h1>
<div class="meta">Arquivo: <b>${fileName}</b> &nbsp;|&nbsp; ${now} &nbsp;|&nbsp; Chapa: ${opts.sheetWidth}×${opts.sheetHeight}mm &nbsp;|&nbsp; Folga: ${opts.gap}mm &nbsp;|&nbsp; Margem: ${opts.margin}mm</div>
<div class="section"><div class="st">Resumo</div>
<div class="stats">
<div class="stat"><div class="slabel">Chapas</div><div class="sval">${result.sheets.length}</div></div>
<div class="stat"><div class="slabel">Peças</div><div class="sval">${totalParts}</div></div>
<div class="stat"><div class="slabel">Aproveitamento</div><div class="sval">${(result.utilization * 100).toFixed(1)}%</div></div>
${ledSummary ? `<div class="stat"><div class="slabel">Total LEDs</div><div class="sval">${ledSummary.totalLeds.toLocaleString("pt-BR")}</div></div><div class="stat"><div class="slabel">Potência</div><div class="sval">${ledSummary.totalPower.toFixed(1)} W</div></div>` : ""}
</div></div>
<div class="section"><div class="st">Chapas de Corte ${showLeds ? "(com LEDs)" : ""}</div>
${sheetDataUrls.map((url, i) => `<div class="sheet-block"><div class="sheet-label">Chapa ${i + 1} — ${result.sheets[i].length} peça(s)</div><img src="${url}" /></div>`).join("")}
</div>
${ledDetailUrls.some((u) => u) ? `<div class="section"><div class="st">Plano LED por Modelo</div><div class="led-grid">${ledDetailUrls.map((url) => url ? `<div class="led-card"><img src="${url}" /></div>` : "").join("")}</div></div>` : ""}
${ledSummary ? `<div class="section"><div class="st">Detalhamento LEDs</div>
<table><thead><tr>
<th>Dimensões (mm)</th><th>Letra (mm)</th><th>Pitch (mm)</th><th>Modelos LED</th><th>LEDs/pç</th><th>Qtd</th><th>Total</th><th>Potência (W)</th>
</tr></thead><tbody>
${ledSummary.rows.map((r: any) => `<tr><td>${r.width.toFixed(0)}×${r.height.toFixed(0)}</td><td>${r.letterHeight.toFixed(0)}</td><td>${r.pitch.toFixed(1)}</td><td>${r.modelNames}</td><td>${r.ledsPerPiece}</td><td>${r.qty}</td><td>${r.totalLeds}</td><td>${r.totalPower.toFixed(1)}</td></tr>`).join("")}
</tbody><tfoot><tr class="tf"><td colspan="6">TOTAL</td><td>${ledSummary.totalLeds.toLocaleString("pt-BR")}</td><td>${ledSummary.totalPower.toFixed(1)}</td></tr></tfoot></table></div>` : ""}
</body></html>`;

  const win = window.open("", "_blank");
  if (!win) { alert("Permita popups para imprimir."); return; }
  win.document.write(html);
  win.document.close();
}

function NumericField({ label, unit, value, onChange, min = 0, step = 1 }: {
  label: string; unit: string; value: number; onChange: (v: number) => void; min?: number; step?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label} <span className="text-muted-foreground/60">({unit})</span></Label>
      <Input type="number" min={min} step={step} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= min) onChange(v); }}
        className="h-8 text-sm" />
    </div>
  );
}

function LedCadastroPanel({ leds, onAdd, onRemove }: { leds: LedModel[]; onAdd: (m: LedModel) => void; onRemove: (id: string) => void; }) {
  const [form, setForm] = useState({ name: "", width: 48, height: 20, power: 0.5 });
  const [photoUrl, setPhotoUrl] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);
  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPhotoUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  };
  const handleAdd = () => {
    if (!form.name.trim()) return;
    onAdd({ id: `led-${Date.now()}`, name: form.name.trim(), width: form.width, height: form.height, power: form.power, photoUrl });
    setForm({ name: "", width: 48, height: 20, power: 0.5 }); setPhotoUrl(undefined);
    if (fileRef.current) fileRef.current.value = "";
  };
  return (
    <div className="flex flex-col gap-4">
      {leds.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Módulos cadastrados</p>
          {leds.map((led) => (
            <div key={led.id} className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
              {led.photoUrl ? <img src={led.photoUrl} alt={led.name} className="h-10 w-10 rounded object-cover flex-shrink-0" />
                : <div className="h-10 w-10 rounded bg-muted flex items-center justify-center flex-shrink-0"><Zap className="h-4 w-4 text-muted-foreground" /></div>}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{led.name}</p>
                <p className="text-xs text-muted-foreground">{led.width}×{led.height} mm · {led.power} W/un</p>
              </div>
              <button onClick={() => onRemove(led.id)} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Plus className="h-3.5 w-3.5" /> Cadastrar módulo LED</p>
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Foto (opcional)</Label>
          <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed border-border bg-background p-3 hover:border-primary/50 transition-colors">
            {photoUrl ? <img src={photoUrl} alt="preview" className="h-12 w-12 rounded object-cover flex-shrink-0" />
              : <div className="h-12 w-12 rounded bg-muted flex items-center justify-center flex-shrink-0"><Upload className="h-5 w-5 text-muted-foreground" /></div>}
            <span className="text-xs text-muted-foreground">{photoUrl ? "Alterar" : "Foto"}</span>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Nome / Referência</Label>
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Ex: LED SMD 5050" className="h-8 text-sm" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Comprimento (mm)</Label>
            <Input type="number" min={0.1} step={0.1} value={form.width} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setForm((f) => ({ ...f, width: v })); }} className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Largura (mm)</Label>
            <Input type="number" min={0.1} step={0.1} value={form.height} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setForm((f) => ({ ...f, height: v })); }} className="h-8 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Potência (W)</Label>
            <Input type="number" min={0} step={0.01} value={form.power} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setForm((f) => ({ ...f, power: v })); }} className="h-8 text-sm" />
          </div>
        </div>
        <Button onClick={handleAdd} disabled={!form.name.trim()} variant="secondary" className="w-full h-8 text-sm">
          <Plus className="h-3.5 w-3.5 mr-1" /> Adicionar
        </Button>
      </div>
    </div>
  );
}

function GroupLedConfigPanel({ groups, allLeds, configs, onConfigChange }: {
  groups: ReturnType<typeof groupParts>; allLeds: LedModel[];
  configs: Map<string, GroupLedConfig>; onConfigChange: (key: string, cfg: GroupLedConfig) => void;
}) {
  if (!groups.length) return <p className="text-xs text-muted-foreground">Importe um PDF para configurar.</p>;
  if (!allLeds.length) return <p className="text-xs text-muted-foreground">Cadastre ao menos um módulo LED primeiro.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Defina a <b>altura da letra</b> para cada grupo — o pitch será <code>altura × 85%</code>. Selecione os módulos LED e se pode girar.
      </p>
      {groups.map((g) => {
        const cfg = configs.get(g.key) ?? { groupKey: g.key, ledIds: [], letterHeight: g.height, allowRotation: true };
        const pitch = calcPitch(cfg.letterHeight);
        const poly = g.parts[0]?.outer ?? [];
        const holes = g.parts[0]?.holes ?? [];
        const models = cfg.ledIds.map((id) => allLeds.find((l) => l.id === id)).filter(Boolean) as LedModel[];
        const { totalLeds } = models.length ? calcLedsForPart(poly, holes, models, cfg.letterHeight, cfg.allowRotation) : { totalLeds: 0 };
        return (
          <div key={g.key} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">{g.width.toFixed(0)} × {g.height.toFixed(0)} mm</p>
                <p className="text-xs text-muted-foreground">×{g.quantity} peça{g.quantity > 1 ? "s" : ""}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-mono text-yellow-400">{totalLeds} LEDs/peça</p>
                <p className="text-xs text-muted-foreground">pitch {pitch.toFixed(1)} mm</p>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Altura da letra (mm)</Label>
              <Input type="number" min={1} step={1} value={cfg.letterHeight}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) onConfigChange(g.key, { ...cfg, letterHeight: v }); }}
                className="h-8 text-sm" />
              <p className="text-[10px] text-muted-foreground/60">Pitch = {calcPitch(cfg.letterHeight).toFixed(1)} mm (×85%)</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Módulos LED (selecione 1 ou mais)</Label>
              <div className="flex flex-col gap-1.5">
                {allLeds.map((led) => {
                  const isSel = cfg.ledIds.includes(led.id);
                  return (
                    <button key={led.id}
                      onClick={() => onConfigChange(g.key, { ...cfg, ledIds: isSel ? cfg.ledIds.filter((id) => id !== led.id) : [...cfg.ledIds, led.id] })}
                      className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left text-xs transition-colors ${isSel ? "border-yellow-500/60 bg-yellow-500/10 text-yellow-300" : "border-border bg-background text-muted-foreground hover:border-border/80"}`}>
                      {isSel ? <CheckSquare className="h-3.5 w-3.5 flex-shrink-0 text-yellow-400" /> : <Square className="h-3.5 w-3.5 flex-shrink-0" />}
                      {led.photoUrl && <img src={led.photoUrl} alt="" className="h-6 w-6 rounded object-cover flex-shrink-0" />}
                      <span className="flex-1 font-medium">{led.name}</span>
                      <span className="text-muted-foreground">{led.width}×{led.height}mm</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2"><RotateCw className="h-3.5 w-3.5 text-muted-foreground" /><Label className="text-xs">Permitir giro do módulo LED</Label></div>
              <Switch checked={cfg.allowRotation} onCheckedChange={(v) => onConfigChange(g.key, { ...cfg, allowRotation: v })} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LedDrawingCanvas({ groups, allLeds, configs }: {
  groups: ReturnType<typeof groupParts>; allLeds: LedModel[]; configs: Map<string, GroupLedConfig>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !groups.length) return;
    const dpr = window.devicePixelRatio || 1;
    const COLS = Math.min(3, groups.length), ROWS = Math.ceil(groups.length / COLS);
    const CELL_PAD = 28, LABEL_TOP = 18, LABEL_BOT = 46, MAX_CELL = 180;
    const maxW = Math.max(...groups.map((g) => g.width), 1);
    const maxH = Math.max(...groups.map((g) => g.height), 1);
    const cellW = Math.min(MAX_CELL, maxW) + 2 * CELL_PAD;
    const cellH = Math.min(MAX_CELL, maxH) + 2 * CELL_PAD + LABEL_TOP + LABEL_BOT;
    const totalW = COLS * cellW, totalH = ROWS * cellH;
    canvas.width = totalW * dpr; canvas.height = totalH * dpr;
    canvas.style.width = `${totalW}px`; canvas.style.height = `${totalH}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, totalW, totalH);

    groups.forEach((g, gi) => {
      const col = gi % COLS, row = Math.floor(gi / COLS);
      const scaleX = Math.min(1, (cellW - 2 * CELL_PAD) / g.width);
      const scaleY = Math.min(1, (cellH - 2 * CELL_PAD - LABEL_TOP - LABEL_BOT) / g.height);
      const S = Math.min(scaleX, scaleY);
      const pw = g.width * S, ph = g.height * S;
      const ox = col * cellW + CELL_PAD + (cellW - 2 * CELL_PAD - pw) / 2;
      const oy = row * cellH + CELL_PAD + LABEL_TOP;
      const poly = g.parts[0]?.outer ?? [];
      const holes = g.parts[0]?.holes ?? [];
      const cfg = configs.get(g.key) ?? null;
      const models = cfg ? (cfg.ledIds.map((id) => allLeds.find((l) => l.id === id)).filter(Boolean) as LedModel[]) : [];
      const hasPoly = poly.length > 0;
      let pminX = 0, pminY = 0;
      if (hasPoly) { pminX = Infinity; pminY = Infinity; for (const p of poly) { if (p.x < pminX) pminX = p.x; if (p.y < pminY) pminY = p.y; } }
      const toScreen = (p: Point) => ({ x: ox + (p.x - pminX) * S, y: oy + (p.y - pminY) * S });

      if (hasPoly) {
        ctx.beginPath(); const sp0 = toScreen(poly[0]); ctx.moveTo(sp0.x, sp0.y);
        for (let i = 1; i < poly.length; i++) { const sp = toScreen(poly[i]); ctx.lineTo(sp.x, sp.y); }
        ctx.closePath(); ctx.fillStyle = "#1e3a5f"; ctx.fill(); ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5; ctx.stroke();
        for (const hole of holes) {
          if (!hole.length) continue;
          ctx.beginPath(); const sh0 = toScreen(hole[0]); ctx.moveTo(sh0.x, sh0.y);
          for (let i = 1; i < hole.length; i++) { const sh = toScreen(hole[i]); ctx.lineTo(sh.x, sh.y); }
          ctx.closePath(); ctx.fillStyle = "#0f172a"; ctx.fill(); ctx.strokeStyle = "#60a5fa55"; ctx.lineWidth = 1; ctx.stroke();
        }
      } else {
        ctx.fillStyle = "#1e3a5f"; ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5;
        ctx.fillRect(ox, oy, pw, ph); ctx.strokeRect(ox, oy, pw, ph);
      }

      if (cfg && models.length) {
        const { positions, pitch, totalLeds } = calcLedsForPart(hasPoly ? poly : [], holes, models, cfg.letterHeight, cfg.allowRotation);
        const lh = pitch;
        ctx.strokeStyle = "#1e3a8a55"; ctx.lineWidth = 0.5; ctx.setLineDash([2, 3]);
        for (let yy = oy; yy <= oy + ph; yy += lh * S) { ctx.beginPath(); ctx.moveTo(ox, yy); ctx.lineTo(ox + pw, yy); ctx.stroke(); }
        for (let xx = ox; xx <= ox + pw; xx += lh * S) { ctx.beginPath(); ctx.moveTo(xx, oy); ctx.lineTo(xx, oy + ph); ctx.stroke(); }
        ctx.setLineDash([]);

        for (const pos of positions) {
          const led = allLeds.find((l) => l.id === pos.ledId); if (!led) continue;
          const lW = Math.max(2, (pos.rotated ? led.height : led.width) * S);
          const lH = Math.max(2, (pos.rotated ? led.width : led.height) * S);
          const lx = ox + (pos.x - pminX) * S, ly = oy + (pos.y - pminY) * S;
          const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(lW, lH) * 1.3);
          grd.addColorStop(0, "#fde68a66"); grd.addColorStop(1, "#f59e0b00");
          ctx.beginPath(); ctx.arc(lx, ly, Math.max(lW, lH) * 1.3, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
          ctx.fillStyle = pos.rotated ? "#fb923c" : "#fde68a"; ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = 0.5;
          ctx.fillRect(lx - lW / 2, ly - lH / 2, lW, lH); ctx.strokeRect(lx - lW / 2, ly - lH / 2, lW, lH);
        }

        ctx.fillStyle = "#94a3b8"; ctx.font = "9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${g.width.toFixed(0)}×${g.height.toFixed(0)} mm | letra ${cfg.letterHeight.toFixed(0)} mm`, ox + pw / 2, oy - 2);
        ctx.fillStyle = "#fde68a"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(`${totalLeds} LEDs · pitch ${pitch.toFixed(1)} mm`, ox + pw / 2, oy + ph + 6);
        const names = models.map((m) => m.name).join(" + ");
        ctx.fillStyle = "#64748b"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(names, ox + pw / 2, oy + ph + 18);
      } else {
        ctx.fillStyle = "#94a3b8"; ctx.font = "9px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${g.width.toFixed(0)}×${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);
        ctx.fillStyle = "#475569"; ctx.font = "italic 8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText("sem LED configurado", ox + pw / 2, oy + ph + 6);
      }

      const bW = 24, bH = 14;
      ctx.fillStyle = "#1e40af"; ctx.beginPath(); ctx.roundRect(ox + pw - bW - 2, oy + 2, bW, bH, 3); ctx.fill();
      ctx.fillStyle = "#93c5fd"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`×${g.quantity}`, ox + pw - bW / 2 - 2, oy + 2 + bH / 2);
    });
  }, [groups, allLeds, configs]);
  return (
    <div className="overflow-auto rounded-lg border border-border bg-[#0f172a] p-2">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

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
  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) => setOpts((p) => ({ ...p, [key]: val }));

  const [ledModels, setLedModels] = useState<LedModel[]>(() => {
    try { const s = localStorage.getItem("nestcnc_leds_v2"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [groupLedConfigs, setGroupLedConfigs] = useState<Map<string, GroupLedConfig>>(() => {
    try { const s = localStorage.getItem("nestcnc_gcfg_v2"); if (s) return new Map(JSON.parse(s)); } catch {}
    return new Map();
  });
  const [showLeds, setShowLeds] = useState(true);

  useEffect(() => { try { localStorage.setItem("nestcnc_leds_v2", JSON.stringify(ledModels)); } catch {} }, [ledModels]);
  useEffect(() => { try { localStorage.setItem("nestcnc_gcfg_v2", JSON.stringify([...groupLedConfigs.entries()])); } catch {} }, [groupLedConfigs]);

  const handleConfigChange = useCallback((key: string, cfg: GroupLedConfig) => {
    setGroupLedConfigs((prev) => new Map(prev).set(key, cfg));
  }, []);

  const ledModelsMap = useMemo(() => new Map(ledModels.map((l) => [l.id, l])), [ledModels]);

  const groupSigToKey = useMemo(() => {
    const map = new Map<string, string>();
    if (!result) return map;
    for (const sh of result.sheets) {
      for (const p of sh) {
        const g = groups.find((g) => g.parts.some((pt) => pt.signature === p.groupSig));
        if (g) map.set(p.groupSig, g.key);
      }
    }
    return map;
  }, [result, groups]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null; if (!file) return;
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
      else {
        const gs = groupParts(p); setParts(p); setGroups(gs);
        setGroupLedConfigs((prev) => {
          const next = new Map(prev);
          for (const g of gs) { if (!next.has(g.key)) next.set(g.key, { groupKey: g.key, ledIds: [], letterHeight: g.height, allowRotation: true }); }
          return next;
        });
      }
    } catch (e) { setParseError((e as Error).message); } finally { setParsing(false); }
  };

  const onNest = useCallback(async () => {
    if (!parts.length) return; setNesting(true);
    try { const r = runNesting(parts, opts); setResult(r); setActiveSheet(0); } finally { setNesting(false); }
  }, [parts, opts]);

  const redraw = useCallback(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    renderSheet(canvasRef.current, result.sheets[activeSheet] ?? [], opts.sheetWidth, opts.sheetHeight, opts.margin, ledModelsMap, groupLedConfigs, showLeds, groupSigToKey);
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin, ledModelsMap, groupLedConfigs, showLeds, groupSigToKey]);

  useEffect(() => { redraw(); }, [redraw]);
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(redraw); obs.observe(containerRef.current); return () => obs.disconnect();
  }, [redraw]);

  const stats = useMemo(() => {
    if (!result) return null;
    const placed = result.sheets.reduce((s, sh) => s + sh.length, 0);
    const sheetArea = opts.sheetWidth * opts.sheetHeight;
    const perSheet = result.sheets.map((sh, i) => {
      const bboxUsed = sh.reduce((s, p) => s + p.bboxArea, 0);
      let maxX = opts.margin; for (const p of sh) { if (p.bbox.maxX > maxX) maxX = p.bbox.maxX; }
      return { index: i + 1, count: sh.length, bboxUtil: sheetArea > 0 ? bboxUsed / sheetArea : 0, leftoverW: Math.max(0, opts.sheetWidth - maxX - opts.margin), leftoverH: Math.max(0, opts.sheetHeight - 2 * opts.margin) };
    });
    return { placed, unplaced: result.unplaced.length, models: groups.length, total: parts.length, utilization: result.utilization, sheets: result.sheets.length, totalBboxArea: result.totalBboxArea, totalPartArea: result.totalPartArea, totalSheetArea: result.totalSheetArea, sheetArea, perSheet };
  }, [result, parts, groups, opts.sheetWidth, opts.sheetHeight, opts.margin]);

  const ledSummary = useMemo(() => {
    if (!groups.length) return null;
    const rows = groups.map((g) => {
      const cfg = groupLedConfigs.get(g.key);
      if (!cfg || !cfg.ledIds.length) return null;
      const models = cfg.ledIds.map((id) => ledModelsMap.get(id)).filter(Boolean) as LedModel[];
      if (!models.length) return null;
      const poly = g.parts[0]?.outer ?? [], holes = g.parts[0]?.holes ?? [];
      const { totalLeds, pitch } = calcLedsForPart(poly, holes, models, cfg.letterHeight, cfg.allowRotation);
      const avgPower = models.reduce((s, m) => s + m.power, 0) / models.length;
      return { width: g.width, height: g.height, qty: g.quantity, letterHeight: cfg.letterHeight, pitch, ledsPerPiece: totalLeds, totalLeds: totalLeds * g.quantity, totalPower: totalLeds * g.quantity * avgPower, modelNames: models.map((m) => m.name).join(" + ") };
    }).filter(Boolean) as any[];
    if (!rows.length) return null;
    return { rows, totalLeds: rows.reduce((s: number, r: any) => s + r.totalLeds, 0), totalPower: rows.reduce((s: number, r: any) => s + r.totalPower, 0) };
  }, [groups, groupLedConfigs, ledModelsMap]);

  const colorLegend = useMemo(() => {
    if (!result) return [];
    const m = new Map<string, string>(); let idx = 0;
    for (const sh of result.sheets) for (const p of sh) if (!m.has(p.groupSig)) m.set(p.groupSig, getColor(p.groupSig, idx++));
    return groups.map((g) => ({ label: `${g.width.toFixed(0)}×${g.height.toFixed(0)} mm`, qty: g.quantity, color: m.get(g.parts[0]?.signature ?? "") ?? "#888" }));
  }, [result, groups]);

  const currentSheetParts = result?.sheets[activeSheet] ?? [];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground"><Layers className="h-5 w-5" /></div>
        <div><h1 className="text-base font-semibold tracking-tight">NestCNC</h1><p className="text-xs text-muted-foreground">Aproveitamento automático de chapas</p></div>
        <div className="ml-auto flex gap-1 rounded-lg border border-border p-1">
          {(["nesting","leds","ledcad"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${activeTab === tab ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {tab === "nesting" && <><Layers className="h-3.5 w-3.5" /> Nesting</>}
              {tab === "leds" && <><Lightbulb className="h-3.5 w-3.5" /> LEDs</>}
              {tab === "ledcad" && <><Package className="h-3.5 w-3.5" /> Cadastro LED</>}
            </button>
          ))}
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
              {parsing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Interpretar PDF
            </Button>
            {parseError && <div className="mt-2 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><div><p className="font-medium">Erro</p>{parseError.split("\n").map((l, i) => <p key={i}>{l}</p>)}</div></div>}
            {parts.length > 0 && !parseError && <div className="mt-2 flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-xs text-green-400"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /><span>{parts.length} peça{parts.length !== 1 ? "s" : ""} ({groups.length} modelo{groups.length !== 1 ? "s" : ""})</span></div>}
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
            <Button variant="outline" className="w-full border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-white"
              onClick={() => printPlan(result, opts, ledModelsMap, groupLedConfigs, groupSigToKey, showLeds, groups, ledSummary, fileName || "sem-nome.pdf")}>
              <Printer className="mr-2 h-4 w-4" /> Imprimir Plano de Corte
            </Button>
          )}
          {result && (
            <section className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-yellow-400/80">LEDs na visualização</h2>
                <Switch checked={showLeds} onCheckedChange={setShowLeds} />
              </div>
              {ledSummary && showLeds && <p className="text-xs text-yellow-300/80">{ledSummary.totalLeds.toLocaleString("pt-BR")} LEDs · {ledSummary.totalPower.toFixed(1)} W</p>}
            </section>
          )}
          {stats && (
            <div className="rounded-md border border-border bg-background p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Peças</span><span>{stats.placed}/{stats.total}</span></div>
              {stats.unplaced > 0 && <div className="flex justify-between text-destructive"><span>Não posicionadas</span><span>{stats.unplaced}</span></div>}
              <div className="flex justify-between font-medium"><span className="text-muted-foreground">Aproveitamento</span><span className="text-green-400">{(stats.utilization * 100).toFixed(1)}%</span></div>
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
                    <span className="flex-1">{c.label}</span><span className="text-muted-foreground">×{c.qty}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
        <div className="flex flex-1 flex-col overflow-hidden">
          {activeTab === "nesting" && (
            <>
              <main ref={containerRef} className="relative flex flex-1 items-center justify-center bg-background overflow-hidden">
                {result ? <canvas ref={canvasRef} className="block" /> : (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="rounded-full border border-border p-4"><Layers className="h-8 w-8 text-muted-foreground/40" /></div>
                    <p className="text-sm text-muted-foreground max-w-xs">{parts.length > 0 ? "Clique em Calcular Nesting" : "Importe um PDF e clique em Interpretar PDF"}</p>
                  </div>
                )}
                {result && result.sheets.length > 1 && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
                    <button onClick={() => setActiveSheet((s) => Math.max(0, s - 1))} disabled={activeSheet === 0} className="disabled:opacity-30 hover:text-primary"><ChevronLeft className="h-4 w-4" /></button>
                    <span className="text-xs font-medium">Chapa {activeSheet + 1}/{result.sheets.length} <span className="text-muted-foreground">({currentSheetParts.length} pç)</span></span>
                    <button onClick={() => setActiveSheet((s) => Math.min(result.sheets.length - 1, s + 1))} disabled={activeSheet === result.sheets.length - 1} className="disabled:opacity-30 hover:text-primary"><ChevronRight className="h-4 w-4" /></button>
                  </div>
                )}
              </main>
              <div className="grid grid-cols-2 border-t border-border">
                <div className="border-r border-border p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Peças Detectadas</h3>
                  {!groups.length ? <p className="text-xs text-muted-foreground">Nenhuma peça.</p> : (
                    <div className="space-y-1 text-xs max-h-28 overflow-y-auto pr-1">
                      {groups.map((g, i) => <div key={i} className="flex justify-between gap-4"><span className="text-muted-foreground">{g.width.toFixed(0)}×{g.height.toFixed(0)} mm</span><span>×{g.quantity}</span></div>)}
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Relatório</h3>
                  {!stats ? <p className="text-xs text-muted-foreground">Execute o nesting.</p> : (
                    <div className="space-y-1.5 text-xs">
                      {stats.perSheet.map((s) => (
                        <div key={s.index} className="flex justify-between">
                          <span className="text-muted-foreground">Chapa {s.index} ({s.count} pç)</span>
                          <span className={s.bboxUtil >= 0.7 ? "text-green-400" : s.bboxUtil >= 0.5 ? "text-yellow-400" : "text-red-400"}>{(s.bboxUtil * 100).toFixed(1)}% · sobra {s.leftoverW.toFixed(0)}×{s.leftoverH.toFixed(0)}mm</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          {activeTab === "leds" && (
            <div className="flex flex-1 flex-col overflow-y-auto p-6 gap-6">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-yellow-500/20"><Lightbulb className="h-4 w-4 text-yellow-400" /></div>
                <div><h2 className="text-sm font-semibold">Calculadora de LEDs</h2><p className="text-xs text-muted-foreground">Configure por grupo: módulos, altura da letra (pitch = altura × 85%), giro</p></div>
              </div>
              {ledSummary && (
                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-muted-foreground mb-1">Total de LEDs</p><p className="text-2xl font-bold text-yellow-400">{ledSummary.totalLeds.toLocaleString("pt-BR")}</p></div>
                  <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-muted-foreground mb-1">Potência total</p><p className="text-2xl font-bold text-orange-400">{ledSummary.totalPower.toFixed(1)} W</p></div>
                  <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-muted-foreground mb-1">Grupos configurados</p><p className="text-2xl font-bold text-blue-400">{ledSummary.rows.length}/{groups.length}</p></div>
                </div>
              )}
              <GroupLedConfigPanel groups={groups} allLeds={ledModels} configs={groupLedConfigs} onConfigChange={handleConfigChange} />
              {groups.length > 0 && ledModels.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-yellow-400" /> Desenho de Posicionamento</h3>
                  <p className="text-xs text-muted-foreground mb-3">Amarelo claro = LED normal · Laranja = LED girado 90° · Grade tracejada = pitch calculado</p>
                  <LedDrawingCanvas groups={groups} allLeds={ledModels} configs={groupLedConfigs} />
                </div>
              )}
              {ledSummary && (
                <div className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="px-4 py-3 border-b border-border"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Detalhamento</h3></div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-border bg-background">
                        <th className="px-3 py-2 text-left text-muted-foreground">Dimensões</th>
                        <th className="px-3 py-2 text-right text-muted-foreground">Letra (mm)</th>
                        <th className="px-3 py-2 text-right text-muted-foreground">Pitch</th>
                        <th className="px-3 py-2 text-left text-muted-foreground">Modelos</th>
                        <th className="px-3 py-2 text-right text-muted-foreground">LEDs/pç</th>
                        <th className="px-3 py-2 text-right text-muted-foreground">Qtd</th>
                        <th className="px-3 py-2 text-right text-muted-foreground">Total</th>
                        <th className="px-3 py-2 text-right text-muted-foreground">Pot.(W)</th>
                      </tr></thead>
                      <tbody>
                        {ledSummary.rows.map((r: any, i: number) => (
                          <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                            <td className="px-3 py-2 font-mono">{r.width.toFixed(0)}×{r.height.toFixed(0)}</td>
                            <td className="px-3 py-2 text-right">{r.letterHeight.toFixed(0)}</td>
                            <td className="px-3 py-2 text-right text-blue-400">{r.pitch.toFixed(1)}</td>
                            <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px]">{r.modelNames}</td>
                            <td className="px-3 py-2 text-right text-yellow-400 font-medium">{r.ledsPerPiece}</td>
                            <td className="px-3 py-2 text-right">{r.qty}</td>
                            <td className="px-3 py-2 text-right font-bold">{r.totalLeds}</td>
                            <td className="px-3 py-2 text-right text-orange-400">{r.totalPower.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr className="bg-background font-semibold">
                        <td className="px-3 py-2 text-muted-foreground" colSpan={6}>TOTAL</td>
                        <td className="px-3 py-2 text-right text-yellow-400">{ledSummary.totalLeds.toLocaleString("pt-BR")}</td>
                        <td className="px-3 py-2 text-right text-orange-400">{ledSummary.totalPower.toFixed(1)}</td>
                      </tr></tfoot>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {activeTab === "ledcad" && (
            <div className="flex flex-1 flex-col overflow-y-auto p-6 gap-6">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/20"><Package className="h-4 w-4 text-blue-400" /></div>
                <div><h2 className="text-sm font-semibold">Cadastro de Módulos LED</h2><p className="text-xs text-muted-foreground">Dimensões físicas reais do módulo (comprimento × largura em mm)</p></div>
              </div>
              <LedCadastroPanel
                leds={ledModels}
                onAdd={(m) => setLedModels((p) => [...p, m])}
                onRemove={(id) => {
                  setLedModels((p) => p.filter((l) => l.id !== id));
                  setGroupLedConfigs((prev) => { const next = new Map(prev); for (const [k, v] of next) next.set(k, { ...v, ledIds: v.ledIds.filter((i) => i !== id) }); return next; });
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
