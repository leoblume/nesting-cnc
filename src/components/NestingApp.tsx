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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { parsePdf, groupParts, type ParsedPart, type PartGroup } from "@/lib/nesting/parser";
import { runNesting, type NestResult, type NestingOptions } from "@/lib/nesting/nesting";
import { Loader2, Upload, Layers, Play } from "lucide-react";

export default function NestingApp() {
  const [fileName, setFileName] = useState<string>("");
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);

  const [parts, setParts] = useState<ParsedPart[]>([]);
  const [groups, setGroups] = useState<PartGroup[]>([]);
  const [parsing, setParsing] = useState(false);
  const [nesting, setNesting] = useState(false);
  const [result, setResult] = useState<NestResult | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);

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

    try {
      const p = await parsePdf(pdfBuffer);

      if (!p.length) {
        alert("Nenhuma geometria vetorial válida foi encontrada neste PDF.");
      }

      setParts(p);
      setGroups(groupParts(p));
    } catch (e) {
      console.error(e);
      alert("Erro ao interpretar PDF: " + (e as Error).message);
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
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Layers className="h-5 w-5" />
          </div>

          <div>
            <h1 className="text-base font-semibold tracking-tight">NestCNC</h1>
            <p className="text-xs text-muted-foreground">Aproveitamento automático de chapas</p>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-80 flex-col gap-4 overflow-y-auto border-r border-border bg-card p-4">
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              PDF Vetorial
            </h2>

            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-background p-4 text-center">
              <Upload className="h-5 w-5 text-muted-foreground" />

              <span className="text-xs text-muted-foreground">
                {fileName || "Clique para selecionar um PDF"}
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
          </section>

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

          {stats && (
            <div className="rounded-md border border-border bg-background p-3 text-xs">
              <div>Total: {stats.total}</div>
              <div>Modelos: {stats.models}</div>
              <div>Posicionadas: {stats.placed}</div>
              <div>Não posicionadas: {stats.unplaced}</div>
              <div>Aproveitamento: {(stats.utilization * 100).toFixed(1)}%</div>
              <div>Chapas: {stats.sheets}</div>
            </div>
          )}
        </aside>

        <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Área gráfica de nesting
        </main>
      </div>
    </div>
  );
}