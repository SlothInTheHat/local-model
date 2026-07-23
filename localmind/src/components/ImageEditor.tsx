import { useRef, useState, useEffect, useCallback } from "react";
import {
  Upload, Download, Undo2, Redo2, Trash2,
  Paintbrush, Eraser, Wand2, Sparkles, Send,
  RotateCcw, Image as ImageIcon, Square, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { streamChatForModel } from "../lib/chatProvider";
import type { ChatMessage } from "../lib/ollama";
import { isVisionModel } from "../lib/modelCapabilities";

type Tool = "brush" | "eraser" | "rect";

interface Filters {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
}

interface AiMsg { role: "user" | "assistant"; content: string; }

interface Props { selectedModel: string; }

const DEFAULT_FILTERS: Filters = { brightness: 100, contrast: 100, saturation: 100, blur: 0 };

export function ImageEditor({ selectedModel }: Props) {
  const baseCanvasRef    = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef     = useRef<HTMLInputElement>(null);

  // Original image — kept so filters can be re-applied non-destructively
  const origImgRef = useRef<HTMLImageElement | null>(null);
  const [hasImage, setHasImage] = useState(false);
  const [imgDims, setImgDims]   = useState({ w: 0, h: 0 });

  const [tool, setTool]           = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(12);
  const [brushColor, setBrushColor] = useState("#e11d48");
  const [filters, setFilters]     = useState<Filters>(DEFAULT_FILTERS);

  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);

  const isDrawingRef    = useRef(false);
  const lastPosRef      = useRef<{ x: number; y: number } | null>(null);
  const rectAnchorRef   = useRef<{ x: number; y: number } | null>(null);
  const rectSnapshotRef = useRef<string | null>(null);

  const [isBgRemoving, setIsBgRemoving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genPrompt, setGenPrompt]       = useState("");
  const [genNeg, setGenNeg]             = useState("blurry, low quality, watermark");
  const [sdOnline, setSdOnline]         = useState<boolean | null>(null);

  const [aiMessages, setAiMessages]   = useState<AiMsg[]>([]);
  const [chatPrompt, setChatPrompt]   = useState("");
  const [isChatStreaming, setStreaming] = useState(false);
  const abortRef  = useRef<AbortController | null>(null);
  const aiBottom  = useRef<HTMLDivElement>(null);

  // ── SD availability check ───────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("http://127.0.0.1:7860/internal/ping", { signal: ctrl.signal })
      .then(() => setSdOnline(true))
      .catch(() => setSdOnline(false));
    return () => ctrl.abort();
  }, []);

  // ── Redraw base canvas (image + filters) ───────────────────────────────────
  // Runs whenever filters change OR when a new image finishes loading.
  const redrawBase = useCallback(() => {
    const img    = origImgRef.current;
    const canvas = baseCanvasRef.current;
    if (!img || !canvas || canvas.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.filter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%) blur(${filters.blur}px)`;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    ctx.filter = "none";
  }, [filters]);

  // Re-run on filter changes.
  useEffect(() => { redrawBase(); }, [redrawBase]);

  // ── Load image from any URL (file blob, data:, http:) ──────────────────────
  // The canvases are ALWAYS in the DOM (hidden when no image) so refs are
  // always valid here — that's why this works correctly.
  function loadUrl(url: string) {
    const img = new Image();
    // Allow loading cross-origin data URIs and blob URLs
    img.onload = () => {
      const base = baseCanvasRef.current;
      const over  = overlayCanvasRef.current;
      if (!base || !over) {
        toast.error("Canvas not ready — please try again.");
        return;
      }

      // Size both canvas buffers to the actual image dimensions
      base.width  = img.naturalWidth;
      base.height = img.naturalHeight;
      over.width  = img.naturalWidth;
      over.height = img.naturalHeight;

      // Store original so filter changes can redraw without re-loading
      origImgRef.current = img;

      // Draw immediately with current filters
      const ctx = base.getContext("2d");
      if (ctx) {
        ctx.filter = `brightness(${filters.brightness}%) contrast(${filters.contrast}%) saturate(${filters.saturation}%) blur(${filters.blur}px)`;
        ctx.drawImage(img, 0, 0);
        ctx.filter = "none";
      }

      // Clear any previous drawing layer
      over.getContext("2d")?.clearRect(0, 0, over.width, over.height);

      setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
      setHasImage(true);
      setUndoStack([]);
      setRedoStack([]);
    };
    img.onerror = () => toast.error("Failed to load image.");
    img.src = url;
  }

  // ── File open / drag-drop ──────────────────────────────────────────────────
  function openFile(file: File) {
    if (!file.type.startsWith("image/")) { toast.error("Not an image file"); return; }
    const url = URL.createObjectURL(file);
    loadUrl(url);
    toast.success(`Opened ${file.name}`);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) openFile(f);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) openFile(f);
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────
  function snapshotOverlay(): string {
    return overlayCanvasRef.current?.toDataURL() ?? "";
  }

  function pushUndo() {
    setUndoStack((prev) => [...prev.slice(-29), snapshotOverlay()]);
    setRedoStack([]);
  }

  function restoreOverlay(dataUrl: string) {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  }

  function undo() {
    if (!undoStack.length) return;
    const cur  = snapshotOverlay();
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, cur]);
    restoreOverlay(prev);
  }

  function redo() {
    if (!redoStack.length) return;
    const cur  = snapshotOverlay();
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, cur]);
    restoreOverlay(next);
  }

  function clearDrawing() {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    pushUndo();
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ── Mouse coordinate mapping (CSS px → canvas buffer px) ─────────────────
  function canvasXY(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = overlayCanvasRef.current!;
    const rect   = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width)  * canvas.width,
      y: ((e.clientY - rect.top)  / rect.height) * canvas.height,
    };
  }

  // ── Drawing handlers ──────────────────────────────────────────────────────
  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!hasImage) return;
    pushUndo();
    isDrawingRef.current = true;
    const pos = canvasXY(e);
    lastPosRef.current = pos;
    if (tool === "rect") {
      rectAnchorRef.current   = pos;
      rectSnapshotRef.current = snapshotOverlay();
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current || !overlayCanvasRef.current) return;
    const ctx = overlayCanvasRef.current.getContext("2d");
    if (!ctx) return;
    const pos = canvasXY(e);

    if (tool === "rect") {
      const snap   = rectSnapshotRef.current;
      const anchor = rectAnchorRef.current;
      if (!anchor) return;
      // Restore the pre-drag snapshot then draw the current rect
      const restoreAndDraw = () => {
        ctx.clearRect(0, 0, overlayCanvasRef.current!.width, overlayCanvasRef.current!.height);
        ctx.strokeStyle = brushColor;
        ctx.lineWidth   = brushSize;
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeRect(anchor.x, anchor.y, pos.x - anchor.x, pos.y - anchor.y);
      };
      if (snap) {
        const img = new Image();
        img.onload = restoreAndDraw;
        img.src = snap;
      } else {
        restoreAndDraw();
      }
      return;
    }

    const from = lastPosRef.current ?? pos;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.lineWidth = brushSize;
    ctx.lineCap   = "round";
    ctx.lineJoin  = "round";
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = brushColor;
    }
    ctx.stroke();
    lastPosRef.current = pos;
  }

  function onMouseUp() {
    isDrawingRef.current    = false;
    lastPosRef.current      = null;
    rectAnchorRef.current   = null;
    rectSnapshotRef.current = null;
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function handleExport() {
    const base = baseCanvasRef.current;
    if (!base || !hasImage) return;
    const out = document.createElement("canvas");
    out.width  = base.width;
    out.height = base.height;
    const ctx  = out.getContext("2d")!;
    ctx.drawImage(base, 0, 0);
    const over = overlayCanvasRef.current;
    if (over) ctx.drawImage(over, 0, 0);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "localmind-image.png"; a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
    toast.success("Exported as PNG");
  }

  // ── Background removal ────────────────────────────────────────────────────
  async function handleRemoveBg() {
    const base = baseCanvasRef.current;
    if (!base || !hasImage) return;
    setIsBgRemoving(true);
    try {
      const merged = document.createElement("canvas");
      merged.width  = base.width;
      merged.height = base.height;
      const ctx = merged.getContext("2d")!;
      ctx.drawImage(base, 0, 0);
      const over = overlayCanvasRef.current;
      if (over) ctx.drawImage(over, 0, 0);

      const { removeBackground } = await import("@imgly/background-removal");
      const srcBlob: Blob = await new Promise((res, rej) =>
        merged.toBlob((b) => b ? res(b) : rej(new Error("toBlob failed")), "image/png")
      );
      const resultBlob = await removeBackground(srcBlob);
      loadUrl(URL.createObjectURL(resultBlob));
      toast.success("Background removed");
    } catch (err) {
      toast.error(`Background removal failed: ${(err as Error).message}`);
    } finally {
      setIsBgRemoving(false);
    }
  }

  // ── Image generation (AUTOMATIC1111 / ComfyUI) ────────────────────────────
  async function handleGenerate() {
    if (!genPrompt.trim() || isGenerating) return;
    setIsGenerating(true);
    try {
      const res = await fetch("http://127.0.0.1:7860/sdapi/v1/txt2img", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: genPrompt, negative_prompt: genNeg,
          width: 512, height: 512, steps: 20, cfg_scale: 7,
          sampler_name: "Euler a",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { images: string[] };
      loadUrl(`data:image/png;base64,${data.images[0]}`);
      toast.success("Image generated");
    } catch (err) {
      toast.error(`Generation failed: ${(err as Error).message}`);
    } finally {
      setIsGenerating(false);
    }
  }

  // ── Vision chat ───────────────────────────────────────────────────────────
  function captureCanvas(): string | null {
    const base = baseCanvasRef.current;
    if (!base || !hasImage) return null;
    const out = document.createElement("canvas");
    out.width  = base.width;
    out.height = base.height;
    const ctx  = out.getContext("2d")!;
    ctx.drawImage(base, 0, 0);
    const over = overlayCanvasRef.current;
    if (over) ctx.drawImage(over, 0, 0);
    return out.toDataURL("image/jpeg", 0.8).split(",")[1];
  }

  async function handleChatSend() {
    if (!chatPrompt.trim() || isChatStreaming || !selectedModel) return;
    const prompt = chatPrompt.trim();
    setChatPrompt("");
    const b64 = isVisionModel(selectedModel) && hasImage ? captureCanvas() : null;

    setAiMessages((prev) => [...prev, { role: "user", content: prompt }, { role: "assistant", content: "" }]);
    setTimeout(() => aiBottom.current?.scrollIntoView({ behavior: "smooth" }), 50);

    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      const history: ChatMessage[] = [
        { role: "system", content: "You are an image editing assistant. Help the user edit, enhance, and understand their images." } as ChatMessage,
        ...aiMessages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
        { role: "user", content: prompt, ...(b64 ? { images: [b64] } : {}) } as ChatMessage,
      ];
      for await (const chunk of streamChatForModel(selectedModel, history, abortRef.current.signal)) {
        setAiMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
          return msgs;
        });
        setTimeout(() => aiBottom.current?.scrollIntoView({ behavior: "smooth" }), 0);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") {
        setAiMessages((prev) => {
          const msgs = [...prev];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, content: `Error: ${e.message}` };
          return msgs;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleExport(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const TOOL_BTNS: { id: Tool; icon: React.ReactNode; label: string }[] = [
    { id: "brush",  icon: <Paintbrush className="size-4" />, label: "Brush"     },
    { id: "eraser", icon: <Eraser     className="size-4" />, label: "Eraser"    },
    { id: "rect",   icon: <Square     className="size-4" />, label: "Rectangle" },
  ];

  return (
    <div className="flex h-full w-full overflow-hidden">

      {/* ── Left tools panel ─────────────────────────────────────────────── */}
      <div className="w-[196px] shrink-0 border-r bg-card flex flex-col overflow-y-auto">
        <div className="p-3 space-y-4">

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">Tools</p>
            <div className="grid grid-cols-3 gap-1">
              {TOOL_BTNS.map(({ id, icon, label }) => (
                <button key={id} onClick={() => setTool(id)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border text-[10px] transition-colors ${
                    tool === id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  {icon}{label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-muted-foreground w-10 shrink-0">Color</label>
              <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)}
                disabled={tool === "eraser"} className="flex-1 h-7 rounded border border-border cursor-pointer" />
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                <span>Size</span><span>{brushSize}px</span>
              </div>
              <input type="range" min={1} max={80} value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))} className="w-full accent-primary" />
            </div>
          </div>

          <div className="border-t pt-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Adjustments</p>
            {(["brightness", "contrast", "saturation"] as const).map((key) => (
              <div key={key}>
                <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                  <span className="capitalize">{key}</span><span>{filters[key]}%</span>
                </div>
                <input type="range" min={0} max={200} value={filters[key]}
                  onChange={(e) => setFilters((f) => ({ ...f, [key]: Number(e.target.value) }))}
                  disabled={!hasImage} className="w-full accent-primary" />
              </div>
            ))}
            <div>
              <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                <span>Blur</span><span>{filters.blur}px</span>
              </div>
              <input type="range" min={0} max={20} value={filters.blur}
                onChange={(e) => setFilters((f) => ({ ...f, blur: Number(e.target.value) }))}
                disabled={!hasImage} className="w-full accent-primary" />
            </div>
            <Button size="sm" variant="outline" className="w-full text-xs h-7 gap-1"
              onClick={() => setFilters(DEFAULT_FILTERS)} disabled={!hasImage}>
              <RotateCcw className="size-3" /> Reset filters
            </Button>
          </div>

          <div className="border-t pt-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">History</p>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="flex-1 text-xs h-7 gap-1"
                onClick={undo} disabled={!undoStack.length}>
                <Undo2 className="size-3" /> Undo
              </Button>
              <Button size="sm" variant="outline" className="flex-1 text-xs h-7 gap-1"
                onClick={redo} disabled={!redoStack.length}>
                <Redo2 className="size-3" /> Redo
              </Button>
            </div>
            <Button size="sm" variant="outline"
              className="w-full text-xs h-7 gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={clearDrawing} disabled={!hasImage}>
              <Trash2 className="size-3" /> Clear drawing
            </Button>
          </div>
        </div>
      </div>

      {/* ── Centre: canvas ─────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top bar */}
        <div className="h-10 border-b bg-card px-3 flex items-center gap-2 shrink-0">
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5"
            onClick={() => fileInputRef.current?.click()}>
            <Upload className="size-3" /> Open image
          </Button>
          <Button size="sm" variant="outline" className="text-xs h-7 gap-1.5"
            onClick={handleExport} disabled={!hasImage}>
            <Download className="size-3" /> Export PNG
          </Button>
          <span className="text-[10px] text-muted-foreground">Ctrl+S export · Ctrl+Z undo</span>
          {hasImage && (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {imgDims.w} × {imgDims.h}
            </span>
          )}
        </div>

        {/* Canvas area — drop zone always active */}
        <div
          className="flex-1 min-h-0 overflow-auto bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#f9fafb_0%_50%)] bg-[length:20px_20px] flex items-center justify-center p-4"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {/* Empty-state shown on top of the (invisible) canvases */}
          {!hasImage && (
            <div className="text-center space-y-4 select-none pointer-events-none absolute">
              <div className="w-24 h-24 rounded-2xl bg-white border-2 border-dashed border-border flex items-center justify-center mx-auto">
                <ImageIcon className="size-10 text-muted-foreground/40" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">Drop an image here</p>
                <p className="text-xs text-muted-foreground mt-1">or click Open image · PNG, JPG, WebP</p>
              </div>
            </div>
          )}

          {/*
            IMPORTANT: Both canvases are ALWAYS in the DOM — never conditionally
            rendered.  loadUrl() sets their width/height and draws the image in
            the img.onload callback, which only works when the elements exist.
            We just hide them visually until an image is loaded.
          */}
          <div
            className="relative shadow-xl"
            style={{ lineHeight: 0, display: hasImage ? "block" : "none" }}
          >
            <canvas
              ref={baseCanvasRef}
              style={{ maxWidth: "100%", maxHeight: "calc(100vh - 160px)", display: "block" }}
            />
            <canvas
              ref={overlayCanvasRef}
              style={{
                position: "absolute", top: 0, left: 0,
                width: "100%", height: "100%",
                cursor: "crosshair",
                touchAction: "none",
              }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            />
          </div>
        </div>
      </div>

      {/* ── Right AI panel ─────────────────────────────────────────────────── */}
      <div className="w-[280px] shrink-0 border-l bg-card flex flex-col overflow-hidden">

        <div className="px-3 py-2 border-b text-xs font-medium flex items-center justify-between shrink-0">
          <span>AI Assistant</span>
          {selectedModel && (
            isVisionModel(selectedModel)
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30">vision on</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">no vision</span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
          {aiMessages.length === 0 && (
            <p className="text-xs text-muted-foreground italic leading-relaxed">
              {hasImage && isVisionModel(selectedModel)
                ? "Ask about the image or describe edits…"
                : hasImage
                ? "Switch to a vision model (llava, minicpm, etc.) to analyze images."
                : "Open an image, then ask the AI to describe or suggest edits."}
            </p>
          )}
          {aiMessages.map((msg, i) => (
            <div key={i} className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div className={`max-w-full rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground whitespace-pre-wrap"
              }`}>
                {msg.content || <span className="animate-pulse">▌</span>}
              </div>
            </div>
          ))}
          <div ref={aiBottom} />
        </div>

        <div className="p-3 border-t space-y-2 shrink-0">
          <Textarea value={chatPrompt} onChange={(e) => setChatPrompt(e.target.value)}
            placeholder={selectedModel ? "Describe the image or ask for edits…" : "No model selected"}
            rows={2} className="text-xs min-h-[48px]"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleChatSend(); } }}
          />
          <div className="flex gap-2">
            <Button size="sm" className="flex-1 text-xs h-7"
              onClick={() => void handleChatSend()}
              disabled={!chatPrompt.trim() || isChatStreaming || !selectedModel}>
              <Send className="size-3 mr-1" />{isChatStreaming ? "…" : "Ask"}
            </Button>
            {(isChatStreaming || aiMessages.length > 0) && (
              <Button size="sm" variant="outline" className="text-xs h-7 px-2"
                onClick={() => { abortRef.current?.abort(); if (!isChatStreaming) setAiMessages([]); }}>
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Background removal */}
        <div className="p-3 border-t space-y-2 shrink-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">AI Tools</p>
          <Button size="sm" variant="outline" className="w-full text-xs h-8 gap-1.5"
            onClick={() => void handleRemoveBg()} disabled={!hasImage || isBgRemoving}>
            <Wand2 className="size-3" />
            {isBgRemoving ? "Removing background…" : "Remove background"}
          </Button>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Downloads a ~50 MB AI model on first use — fully offline after that.
          </p>
        </div>

        {/* Image generation */}
        <div className="p-3 border-t space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Generate</p>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              sdOnline === true ? "bg-success/10 text-success border-success/30" : "bg-muted text-muted-foreground border-border"
            }`}>
              {sdOnline === true ? "SD online" : sdOnline === false ? "SD offline" : "…"}
            </span>
          </div>
          {sdOnline === false ? (
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Start <strong>AUTOMATIC1111</strong> or <strong>ComfyUI</strong> locally to enable generation.
              <br />Default: <code className="font-mono">localhost:7860</code>
            </p>
          ) : (
            <div className="space-y-1.5">
              <Textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)}
                placeholder="a cinematic photo of a red fox in snow…" rows={2} className="text-xs min-h-[48px]"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleGenerate(); } }}
              />
              <input value={genNeg} onChange={(e) => setGenNeg(e.target.value)}
                placeholder="negative prompt…"
                className="w-full text-xs h-7 px-2 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground" />
              <Button size="sm" className="w-full text-xs h-7 gap-1"
                onClick={() => void handleGenerate()}
                disabled={!genPrompt.trim() || isGenerating || !sdOnline}>
                <Sparkles className="size-3" />
                {isGenerating ? "Generating…" : "Generate (512×512)"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
