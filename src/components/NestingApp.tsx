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
import { Loader2, Upload, Layers, Play, AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb, Plus, Trash2, Zap, Package } from "lucide-react";

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

// ─── LED Calculation ───────────────────────────────────────────────────────
// Rule: letter area needs 4mm border margin
// LED pitch: distance between LEDs < (letter_thickness - 10%)
// letter_thickness = min(width, height) - 8mm (subtracting 2*4mm border)
// pitch = (thickness * 0.9) which is < (thickness - 10%)

function calcLedsForPart(
  partWidth: number,
  partHeight: number,
  ledModel: LedModel,
  borderMargin = 4
): { ledsX: number; ledsY: number; totalLeds: number; pitch: number; positions: Array<{ x: number; y: number }> } {
  const innerW = partWidth - 2 * borderMargin;
  const innerH = partHeight - 2 * borderMargin;

  if (innerW <= 0 || innerH <= 0) {
    return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0, positions: [] };
  }

  // Thickness = minimum inner dimension (espessura da letra)
  const thickness = Math.min(innerW, innerH);
  // Pitch must be < (thickness - 10%) = thickness * 0.9
  const maxPitch = thickness * 0.9;
  // Use LED max dimension as reference
  const ledRef = Math.max(ledModel.width, ledModel.height);
  // Pitch = ledRef if ledRef < maxPitch, otherwise use maxPitch
  const pitch = Math.min(ledRef, maxPitch);

  if (pitch <= 0) return { ledsX: 0, ledsY: 0, totalLeds: 0, pitch: 0, positions: [] };

  const ledsX = Math.max(1, Math.floor(innerW / pitch) + 1);
  const ledsY = Math.max(1, Math.floor(innerH / pitch) + 1);
  const totalLeds = ledsX * ledsY;

  // Generate positions (relative to part origin, with border margin)
  const positions: Array<{ x: number; y: number }> = [];
  const stepX = ledsX > 1 ? innerW / (ledsX - 1) : 0;
  const stepY = ledsY > 1 ? innerH / (ledsY - 1) : 0;
  for (let yi = 0; yi < ledsY; yi++) {
    for (let xi = 0; xi < ledsX; xi++) {
      positions.push({
        x: borderMargin + xi * stepX,
        y: borderMargin + yi * stepY,
      });
    }
  }

  return { ledsX, ledsY, totalLeds, pitch, positions };
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

  // Track rightmost/bottommost extent for leftover calc
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

    // Draw LEDs if a model is selected
    if (showLeds && ledModel) {
      const partW = part.bbox.maxX - part.bbox.minX;
      const partH = part.bbox.maxY - part.bbox.minY;
      const { positions, totalLeds } = calcLedsForPart(partW, partH, ledModel);

      for (const pos of positions) {
        const lx = (part.bbox.minX + pos.x) * scale;
        const ly = (part.bbox.minY + pos.y) * scale;
        const r = Math.max(1.5, Math.min(3, scale * 0.8));
        ctx.beginPath();
        ctx.arc(lx, ly, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fde68a";
        ctx.fill();
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 0.5;
        ctx.stroke();
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

  // Draw leftover area annotation
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

// ─── LED Visualization Canvas ─────────────────────────────────────────────
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
    const LABEL_BOTTOM = 32;
    const MAX_PART = 130;

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

      // Part rectangle
      ctx.fillStyle = "#1e3a5f";
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.fillRect(ox, oy, pw, ph);
      ctx.strokeRect(ox, oy, pw, ph);

      // Border margin indicator
      const bm = borderMargin * s;
      if (bm > 0 && pw > bm * 2 && ph > bm * 2) {
        ctx.strokeStyle = "#60a5fa55";
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(ox + bm, oy + bm, pw - 2 * bm, ph - 2 * bm);
        ctx.setLineDash([]);
      }

      // LEDs
      const { positions, totalLeds, pitch } = calcLedsForPart(g.width, g.height, ledModel, borderMargin);
      for (const pos of positions) {
        const lx = ox + pos.x * s;
        const ly = oy + pos.y * s;
        const r = Math.max(1.5, Math.min(4, s * 1.5));
        // Glow effect
        const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 3);
        grd.addColorStop(0, "#fde68aaa");
        grd.addColorStop(1, "#f59e0b00");
        ctx.beginPath();
        ctx.arc(lx, ly, r * 3, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        // LED dot
        ctx.beginPath();
        ctx.arc(lx, ly, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fde68a";
        ctx.fill();
      }

      // Dimensions label above
      ctx.fillStyle = "#94a3b8";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${g.width.toFixed(0)} × ${g.height.toFixed(0)} mm`, ox + pw / 2, oy - 2);

      // LED count label below
      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(`${totalLeds} LEDs · pitch ${pitch.toFixed(1)} mm`, ox + pw / 2, oy + ph + 6);

      // Qty badge (top-right corner of part)
      const badgeW = 24;
      const badgeH = 14;
      ctx.fillStyle = "#1e40af";
      ctx.beginPath();
      ctx.roundRect(ox + pw - badgeW - 2, oy + 2, badgeW, badgeH, 3);
      ctx.fill();
      ctx.fillStyle = "#93c5fd";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`×${g.quantity}`, ox + pw - badgeW / 2 - 2, oy + 2 + badgeH / 2);
    });
  }, [groups, ledModel, borderMargin]);

  return (
    <div className="overflow-auto rounded-lg border border-border bg-[#0f172a] p-2">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
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

  // LED state
  const [ledModels, setLedModels] = useState<LedModel[]>([]);
  const [selectedLedId, setSelectedLedId] = useState<string | null>(null);
  const [showLeds, setShowLeds] = useState(true);
  const [borderMargin, setBorderMargin] = useState(4);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) => setOpts((p) => ({ ...p, [key]: val }));

  const selectedLed = ledModels.find((l) => l.id === selectedLedId) ?? null;

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

  const redraw = useCallback(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    renderSheet(canvasRef.current, result.sheets[activeSheet] ?? [], opts.sheetWidth, opts.sheetHeight, opts.margin, selectedLed, showLeds);
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin, selectedLed, showLeds]);

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

  // LED summary
  const ledSummary = useMemo(() => {
    if (!groups.length || !selectedLed) return null;
    const rows = groups.map((g) => {
      const { totalLeds, ledsX, ledsY, pitch } = calcLedsForPart(g.width, g.height, selectedLed, borderMargin);
      const totalPower = totalLeds * selectedLed.power * g.quantity;
      return { width: g.width, height: g.height, qty: g.quantity, ledsPerPiece: totalLeds, ledsX, ledsY, totalLeds: totalLeds * g.quantity, pitch, totalPower };
    });
    const totalLeds = rows.reduce((s, r) => s + r.totalLeds, 0);
    const totalPower = rows.reduce((s, r) => s + r.totalPower, 0);
    return { rows, totalLeds, totalPower };
  }, [groups, selectedLed, borderMargin]);

  const colorLegend = useMemo(() => {
    if (!result) return [];
    const m = new Map<string, string>(); let idx = 0;
    for (const sh of result.sheets) for (const p of sh) if (!m.has(p.groupSig)) m.set(p.groupSig, getColor(p.groupSig, idx++));
    return groups.map((g) => ({ label: `${g.width.toFixed(0)}×${g.height.toFixed(0)} mm`, qty: g.quantity, color: m.get(g.key) ?? "#888" }));
  }, [result, groups]);

  const currentSheetParts = result?.sheets[activeSheet] ?? [];

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

          {/* LED overlay toggle */}
          {result && ledModels.length > 0 && (
            <section className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-yellow-400/80">Visualização LED</h2>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs">Mostrar LEDs no nesting</Label>
                <Switch checked={showLeds} onCheckedChange={setShowLeds} />
              </div>
              {showLeds && (
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Modelo ativo</Label>
                  <Select value={selectedLedId ?? ""} onValueChange={setSelectedLedId}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                    <SelectContent>
                      {ledModels.map((l) => (
                        <SelectItem key={l.id} value={l.id}>{l.name} ({l.width}×{l.height}mm)</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                      {/* ── Leftover dimensions ── */}
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
                  <p className="text-xs text-muted-foreground">Posicionamento automático com base na espessura da letra</p>
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
                    <Select value={selectedLedId ?? ""} onValueChange={setSelectedLedId}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Selecionar LED" /></SelectTrigger>
                      <SelectContent>
                        {ledModels.map((l) => (
                          <SelectItem key={l.id} value={l.id}>{l.name} ({l.width}×{l.height}mm)</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {selectedLed && (
                  <div className="col-span-2 rounded-md bg-background border border-border p-3">
                    <p className="text-xs font-mono text-muted-foreground leading-relaxed">
                      <span className="text-blue-400">espessura</span> = min(largura, altura) − 2 × {borderMargin}mm<br />
                      <span className="text-yellow-400">pitch_máx</span> = espessura × 0,9 {"<"} (espessura − 10%)<br />
                      <span className="text-green-400">LED_ref</span> = max({selectedLed.width}, {selectedLed.height}) = {Math.max(selectedLed.width, selectedLed.height)} mm<br />
                      <span className="text-orange-400">pitch_final</span> = min(LED_ref, pitch_máx)
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
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-yellow-400" /> Desenho de Posicionamento para Produção
                    </h3>
                    <p className="text-xs text-muted-foreground mb-3">
                      Pontos amarelos = LEDs · linha pontilhada azul = margem de {borderMargin}mm · badge azul = quantidade de peças
                    </p>
                    <LedDrawingCanvas groups={groups} ledModel={selectedLed} borderMargin={borderMargin} />
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
                              <th className="px-4 py-2 text-right font-medium text-muted-foreground">Grid L×A</th>
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
                                <td className="px-4 py-2 text-right text-muted-foreground">{row.ledsX}×{row.ledsY}</td>
                                <td className="px-4 py-2 text-right text-yellow-400 font-medium">{row.ledsPerPiece}</td>
                                <td className="px-4 py-2 text-right font-bold">{row.totalLeds}</td>
                                <td className="px-4 py-2 text-right text-orange-400">{row.totalPower.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="bg-background font-semibold">
                              <td className="px-4 py-2 text-muted-foreground" colSpan={5}>TOTAL</td>
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
