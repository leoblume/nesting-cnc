import { useCallback, useMemo, useRef, useState } from "react";
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
import { runNesting, type NestResult, type NestingOptions } from "@/lib/nesting/nesting";
import { Loader2, Upload, Layers, Play, AlertCircle, CheckCircle2 } from "lucide-react";

function NumericField({
  label,
  unit,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">
        {label} <span className="text-muted-foreground/60">({unit})</span>
      </Label>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v) && v >= min) onChange(v);
        }}
        className="h-8 text-sm"
      />
    </div>
  );
}

export default function NestingApp() {
  const [fileName, setFileName] = useState<string>("");
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [parts, setParts] = useState<ParsedPart[]>([]);
  const [groups, setGroups] = useState<ReturnType<typeof groupParts>>([]);
  const [parsing, setParsing] = useState(false);
  const [nesting, setNesting] = useState(false);
  const [result, setResult] = useState<NestResult | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  const [opts, setOpts] = useState<NestingOptions>({
    sheetWidth: 2750,
    sheetHeight: 1830,
    gap: 5,
    margin: 10,
    allowRotation: true,
    allowMirror: false,
    priority: "yield",
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const setOpt = <K extends keyof NestingOptions>(key: K, val: NestingOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: val }));

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    if (file.type !== "application/pdf") {
      alert("Arquivo inválido. Selecione um PDF.");
      e.target.value = "";
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      setPdfBuffer(buffer);
      setFileName(file.name);
      setParts([]);
      setGroups([]);
      setResult(null);
      setParseError(null);
    } catch (err) {
      console.error(err);
      alert("Não foi possível ler o arquivo PDF.");
    } finally {
      e.target.value = "";
    }
  };

  const onParse = async () => {
    if (!pdfBuffer || parsing) return;
    setParsing(true);
    setResult(null);
    setParseError(null);

    try {
      const p = await parsePdf(pdfBuffer);
      if (!p.length) {
        setParseError("Nenhuma geometria vetorial válida foi encontrada neste PDF.");
      } else {
        setParts(p);
        setGroups(groupParts(p));
      }
    } catch (e) {
      setParseError((e as Error).message);
      console.error(e);
    } finally {
      setParsing(false);
    }
  };

  const onNest = useCallback(async () => {
    if (!parts.length) return;
    setNesting(true);
    try {
      const r = runNesting(parts, opts);
      setResult(r);
      setActiveSheet(0);
    } finally {
      setNesting(false);
    }
  }, [parts, opts]);

  const stats = useMemo(() => {
    if (!result) return null;
    const placed = result.sheets.reduce((s, sh) => s + sh.length, 0);
    return {
      placed,
      unplaced: result.unplaced.length,
      models: groups.length,
      total: parts.length,
      utilization: result.utilization,
      sheets: result.sheets.length,
    };
  }, [result, parts, groups]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Layers className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-base font-semibold tracking-tight">NestCNC</h1>
          <p className="text-xs text-muted-foreground">Aproveitamento automático de chapas</p>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="flex w-72 flex-col gap-5 overflow-y-auto border-r border-border bg-card p-4">

          {/* PDF Vetorial */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              PDF Vetorial
            </h2>

            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-background p-4 text-center transition-colors hover:border-primary/50">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {fileName || "Clique ou arraste um PDF"}
              </span>
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={onFileChange}
              />
            </label>

            <Button
              onClick={onParse}
              disabled={!pdfBuffer || parsing}
              className="mt-3 w-full"
              variant="secondary"
            >
              {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Interpretar PDF
            </Button>

            {/* Parse feedback */}
            {parseError && (
              <div className="mt-2 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <p className="font-medium">Erro ao interpretar</p>
                  {parseError.split("\n").map((line, i) => (
                    <p key={i} className="mt-0.5 leading-relaxed">{line}</p>
                  ))}
                  <p className="mt-1 text-muted-foreground">
                    ✔ Compatível com: CorelDRAW, Illustrator, Inkscape, AutoCAD (DXF→PDF)
                  </p>
                </div>
              </div>
            )}

            {parts.length > 0 && !parseError && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-2 text-xs text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{parts.length} peça{parts.length !== 1 ? "s" : ""} detectada{parts.length !== 1 ? "s" : ""} ({groups.length} modelo{groups.length !== 1 ? "s" : ""})</span>
              </div>
            )}
          </section>

          {/* Chapa */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Chapa
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <NumericField
                label="Largura"
                unit="mm"
                value={opts.sheetWidth}
                onChange={(v) => setOpt("sheetWidth", v)}
                min={1}
              />
              <NumericField
                label="Altura"
                unit="mm"
                value={opts.sheetHeight}
                onChange={(v) => setOpt("sheetHeight", v)}
                min={1}
              />
            </div>
          </section>

          {/* Processo */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Processo
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <NumericField
                label="Folga"
                unit="mm"
                value={opts.gap}
                onChange={(v) => setOpt("gap", v)}
              />
              <NumericField
                label="Margem"
                unit="mm"
                value={opts.margin}
                onChange={(v) => setOpt("margin", v)}
              />
            </div>

            <div className="mt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Permitir rotação</Label>
                <Switch
                  checked={opts.allowRotation}
                  onCheckedChange={(v) => setOpt("allowRotation", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Permitir espelhamento</Label>
                <Switch
                  checked={opts.allowMirror}
                  onCheckedChange={(v) => setOpt("allowMirror", v)}
                />
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">Prioridade</Label>
              <Select
                value={opts.priority}
                onValueChange={(v) => setOpt("priority", v as NestingOptions["priority"])}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yield">Maior aproveitamento</SelectItem>
                  <SelectItem value="speed">Menor tempo de corte</SelectItem>
                  <SelectItem value="sheets">Menor número de chapas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          {/* Calcular */}
          <Button
            onClick={onNest}
            disabled={!parts.length || nesting}
            className="w-full"
          >
            {nesting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Calcular Nesting
          </Button>

          {/* Stats */}
          {stats && (
            <div className="rounded-md border border-border bg-background p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Peças total</span><span>{stats.total}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Modelos</span><span>{stats.models}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Posicionadas</span><span>{stats.placed}</span></div>
              {stats.unplaced > 0 && (
                <div className="flex justify-between text-destructive"><span>Não posicionadas</span><span>{stats.unplaced}</span></div>
              )}
              <div className="flex justify-between font-medium"><span className="text-muted-foreground">Aproveitamento</span><span>{(stats.utilization * 100).toFixed(1)}%</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Chapas</span><span>{stats.sheets}</span></div>
            </div>
          )}
        </aside>

        {/* Main area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <main ref={containerRef} className="relative flex flex-1 items-center justify-center bg-background">
            {result ? (
              <canvas
                ref={canvasRef}
                className="max-h-full max-w-full"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {parts.length > 0
                  ? "Clique em Calcular Nesting para visualizar"
                  : "Importe um PDF vetorial e clique em Interpretar PDF"}
              </p>
            )}
          </main>

          {/* Peças detectadas + Relatório */}
          <div className="grid grid-cols-2 border-t border-border">
            <div className="border-r border-border p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Peças Detectadas
              </h3>
              {groups.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nenhuma peça detectada ainda.</p>
              ) : (
                <div className="space-y-1 text-xs">
                  {groups.map((g, i) => (
                    <div key={i} className="flex justify-between gap-4 text-foreground">
                      <span className="text-muted-foreground">
                        {g.width.toFixed(0)} × {g.height.toFixed(0)} mm
                      </span>
                      <span className="font-medium">× {g.quantity}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Relatório Técnico
              </h3>
              {!stats ? (
                <p className="text-xs text-muted-foreground">Execute o nesting para gerar o relatório.</p>
              ) : (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Chapas usadas</span><span>{stats.sheets}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Peças posicionadas</span><span>{stats.placed}/{stats.total}</span></div>
                  <div className="flex justify-between font-semibold"><span className="text-muted-foreground">Aproveitamento médio</span><span>{(stats.utilization * 100).toFixed(1)}%</span></div>
                  {stats.unplaced > 0 && (
                    <div className="flex justify-between text-destructive"><span>Sem posição</span><span>{stats.unplaced}</span></div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
