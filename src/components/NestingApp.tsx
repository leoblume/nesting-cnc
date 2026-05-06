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
import { Loader2, Upload, Layers, Play, AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Lightbulb } from "lucide-react";

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

function renderSheet(
  canvas: HTMLCanvasElement,
  placed: PlacedPart[],
  sheetWidth: number,
  sheetHeight: number,
  margin: number,
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

type LedCalcMethod = "perimeter_minus5" | "half_plus10";
interface LedConfig { ledSize: number; method: LedCalcMethod; }

function calcLeds(groups: ReturnType<typeof groupParts>, cfg: LedConfig) {
  const { ledSize, method } = cfg;
  if (ledSize <= 0) return { totalLeds: 0, totalMeters: 0, rows: [] as any[] };
  const pitch = ledSize * 2;
  const rows = groups.map((g) => {
    const perim = g.parts[0]?.perimeter ?? 2 * (g.width + g.height);
    const ledBase = method === "perimeter_minus5" ? perim * 0.95 : (perim / 2) * 1.10;
    const ledsPerPiece = Math.ceil(ledBase / pitch);
    return { width: g.width, height: g.height, qty: g.quantity, perimeter: perim, ledBase, ledsPerPiece, totalLeds: ledsPerPiece * g.quantity };
  });
  const totalLeds = rows.reduce((s, r) => s + r.totalLeds, 0);
  return { totalLeds, totalMeters: (totalLeds * ledSize) / 1000, rows };
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
  const [activeTab, setActiveTab] = useState<"nesting" | "leds">("nesting");
  const [opts, setOpts] = useState<NestingOptions>({ sheetWidth: 2750, sheetHeight: 1830, gap: 5, margin: 10, allowRotation: true, allowMirror: false, priority: "yield" });
  const [ledCfg, setLedCfg] = useState<LedConfig>({ ledSize: 5, method: "perimeter_minus5" });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) => setOpts((p) => ({ ...p, [key]: val }));

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
    if (!result || !canvasRef.current || !containerRef.current) return;
    renderSheet(canvasRef.current, result.sheets[activeSheet] ?? [], opts.sheetWidth, opts.sheetHeight, opts.margin);
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin]);

  useEffect(() => {
    if (!result || !canvasRef.current || !containerRef.current) return;
    const obs = new ResizeObserver(() => {
      if (!result || !canvasRef.current) return;
      renderSheet(canvasRef.current, result.sheets[activeSheet] ?? [], opts.sheetWidth, opts.sheetHeight, opts.margin);
    });
    obs.observe(containerRef.current!);
    return () => obs.disconnect();
  }, [result, activeSheet, opts.sheetWidth, opts.sheetHeight, opts.margin]);

  const stats = useMemo(() => {
    if (!result) return null;
    const placed = result.sheets.reduce((s, sh) => s + sh.length, 0);
    return { placed, unplaced: result.unplaced.length, models: groups.length, total: parts.length, utilization: result.utilization, sheets: result.sheets.length };
  }, [result, parts, groups]);

  const ledResult = useMemo(() => groups.length ? calcLeds(groups, ledCfg) : null, [groups, ledCfg]);

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

          {stats && (
            <div className="rounded-md border border-border bg-background p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Peças total</span><span>{stats.total}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Modelos</span><span>{stats.models}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Posicionadas</span><span>{stats.placed}</span></div>
              {stats.unplaced > 0 && <div className="flex justify-between text-destructive"><span>Não posicionadas</span><span>{stats.unplaced}</span></div>}
              <div className="flex justify-between font-medium"><span className="text-muted-foreground">Aproveitamento</span><span>{(stats.utilization * 100).toFixed(1)}%</span></div>
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
          {activeTab === "nesting" ? (
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
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between"><span className="text-muted-foreground">Chapas usadas</span><span>{stats.sheets}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Peças posicionadas</span><span>{stats.placed}/{stats.total}</span></div>
                      <div className="flex justify-between font-semibold"><span className="text-muted-foreground">Aproveitamento médio</span><span>{(stats.utilization * 100).toFixed(1)}%</span></div>
                      {stats.unplaced > 0 && <div className="flex justify-between text-destructive"><span>Sem posição</span><span>{stats.unplaced}</span></div>}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col overflow-y-auto p-6 gap-6">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-yellow-500/20">
                  <Lightbulb className="h-4 w-4 text-yellow-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Calculadora de LEDs</h2>
                  <p className="text-xs text-muted-foreground">Quantidade de LEDs por peça baseada no contorno</p>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-5 grid grid-cols-2 gap-5">
                <div className="col-span-2">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Configuração dos LEDs</h3>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Tamanho do LED <span className="text-muted-foreground/60">(mm)</span></Label>
                  <Input type="number" min={0.1} step={0.1} value={ledCfg.ledSize}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) setLedCfg((c) => ({ ...c, ledSize: v })); }}
                    className="h-8 text-sm" />
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">Distância ao próximo LED = 1× tamanho → pitch = 2× tamanho</p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Método de cálculo</Label>
                  <Select value={ledCfg.method} onValueChange={(v) => setLedCfg((c) => ({ ...c, method: v as LedCalcMethod }))}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="perimeter_minus5">Perímetro − 5%</SelectItem>
                      <SelectItem value="half_plus10">Perímetro ÷ 2 + 10%</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                    {ledCfg.method === "perimeter_minus5" ? "Comprimento = Perímetro × 0,95" : "Comprimento = (Perímetro / 2) × 1,10"}
                  </p>
                </div>
                <div className="col-span-2 rounded-md bg-background border border-border p-3">
                  <p className="text-xs font-mono text-muted-foreground">
                    {ledCfg.method === "perimeter_minus5" ? (
                      <><span className="text-blue-400">comprimento</span> = perímetro × 0,95<br /><span className="text-yellow-400">LEDs/peça</span> = ⌈ comprimento ÷ ({ledCfg.ledSize} × 2) ⌉ = ⌈ comprimento ÷ {ledCfg.ledSize * 2} ⌉</>
                    ) : (
                      <><span className="text-blue-400">comprimento</span> = (perímetro ÷ 2) × 1,10<br /><span className="text-yellow-400">LEDs/peça</span> = ⌈ comprimento ÷ ({ledCfg.ledSize} × 2) ⌉ = ⌈ comprimento ÷ {ledCfg.ledSize * 2} ⌉</>
                    )}
                  </p>
                </div>
              </div>

              {!groups.length ? (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-sm text-muted-foreground">Importe e interprete um PDF para calcular os LEDs.</p>
                </div>
              ) : ledResult ? (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="rounded-lg border border-border bg-card p-4">
                      <p className="text-xs text-muted-foreground mb-1">Total de LEDs</p>
                      <p className="text-2xl font-bold text-yellow-400">{ledResult.totalLeds.toLocaleString("pt-BR")}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card p-4">
                      <p className="text-xs text-muted-foreground mb-1">Comprimento total</p>
                      <p className="text-2xl font-bold text-blue-400">{ledResult.totalMeters.toFixed(2)} m</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card p-4">
                      <p className="text-xs text-muted-foreground mb-1">Pitch (centro a centro)</p>
                      <p className="text-2xl font-bold text-green-400">{(ledCfg.ledSize * 2).toFixed(1)} mm</p>
                    </div>
                  </div>

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
                            <th className="px-4 py-2 text-right font-medium text-muted-foreground">Perímetro (mm)</th>
                            <th className="px-4 py-2 text-right font-medium text-muted-foreground">Comp. LEDs (mm)</th>
                            <th className="px-4 py-2 text-right font-medium text-muted-foreground">LEDs/peça</th>
                            <th className="px-4 py-2 text-right font-medium text-muted-foreground">Total LEDs</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledResult.rows.map((row: any, i: number) => (
                            <tr key={i} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-2 font-mono">{row.width.toFixed(0)} × {row.height.toFixed(0)}</td>
                              <td className="px-4 py-2 text-right">{row.qty}</td>
                              <td className="px-4 py-2 text-right text-muted-foreground">{row.perimeter.toFixed(1)}</td>
                              <td className="px-4 py-2 text-right text-blue-400">{row.ledBase.toFixed(1)}</td>
                              <td className="px-4 py-2 text-right text-yellow-400 font-medium">{row.ledsPerPiece}</td>
                              <td className="px-4 py-2 text-right font-bold">{row.totalLeds}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-background font-semibold">
                            <td className="px-4 py-2 text-muted-foreground" colSpan={5}>TOTAL</td>
                            <td className="px-4 py-2 text-right text-yellow-400 text-sm">{ledResult.totalLeds.toLocaleString("pt-BR")}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">* Perímetro real extraído do contorno vetorial da peça. Pitch = {(ledCfg.ledSize * 2).toFixed(1)} mm (LED + espaço).</p>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
