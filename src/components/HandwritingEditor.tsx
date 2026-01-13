import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HandwritingBackground,
  HandwritingCanvasMode,
  HandwritingDocumentData,
  HandwritingPoint,
  HandwritingStroke,
} from '../types';

type Props = {
  value: HandwritingDocumentData;
  onChange: (next: HandwritingDocumentData) => void;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const LOGICAL_WIDTH = 1000;
const PAGE_HEIGHT = 1400;
const INFINITE_GROW_THRESHOLD = 220;

const getDefaultData = (): HandwritingDocumentData => ({
  mode: 'infinite',
  background: 'lined',
  color: '#111827',
  baseSize: 4,
  palmRejection: true,
  pageCount: 1,
  height: PAGE_HEIGHT,
  strokes: [],
});

export function normalizeHandwritingData(data: HandwritingDocumentData | undefined): HandwritingDocumentData {
  const base = getDefaultData();
  if (!data) return base;
  const mode: HandwritingCanvasMode = data.mode ?? base.mode;
  const background: HandwritingBackground = data.background ?? base.background;
  const color = data.color ?? base.color;
  const baseSize = typeof data.baseSize === 'number' ? data.baseSize : base.baseSize;
  const palmRejection = typeof data.palmRejection === 'boolean' ? data.palmRejection : base.palmRejection;
  const pageCount = typeof data.pageCount === 'number' && data.pageCount >= 1 ? Math.floor(data.pageCount) : base.pageCount;
  const height = typeof data.height === 'number' && data.height >= PAGE_HEIGHT ? data.height : base.height;
  const strokes = Array.isArray(data.strokes) ? data.strokes : [];

  // Migration: if points look like normalized 0..1 from older version, convert to logical px
  const maxXY = strokes.reduce(
    (acc, s) => {
      s.points?.forEach((p: any) => {
        if (typeof p?.x === 'number') acc.maxX = Math.max(acc.maxX, p.x);
        if (typeof p?.y === 'number') acc.maxY = Math.max(acc.maxY, p.y);
      });
      return acc;
    },
    { maxX: 0, maxY: 0 },
  );
  const looksNormalized = maxXY.maxX <= 1.5 && maxXY.maxY <= 1.5;
  const migratedStrokes: HandwritingStroke[] = looksNormalized
    ? strokes.map((s: any) => ({
        ...s,
        points: (s.points || []).map((p: any) => ({
          x: (p.x ?? 0) * LOGICAL_WIDTH,
          y: (p.y ?? 0) * PAGE_HEIGHT,
          p: typeof p.p === 'number' ? p.p : 0.5,
        })),
      }))
    : strokes;

  return {
    mode,
    background: data.background ?? base.background,
    color,
    baseSize,
    palmRejection,
    pageCount,
    height,
    strokes: migratedStrokes,
  };
}

function getCanvasPointLogical(
  e: PointerEvent | React.PointerEvent,
  rect: DOMRect,
  logicalHeight: number,
): { x: number; y: number } {
  const scale = rect.width / LOGICAL_WIDTH;
  const x = (e.clientX - rect.left) / scale;
  const y = (e.clientY - rect.top) / scale;
  return {
    x: clamp(x, 0, LOGICAL_WIDTH),
    y: clamp(y, 0, logicalHeight),
  };
}

function isPen(e: PointerEvent | React.PointerEvent): boolean {
  // PointerEvent.pointerType is 'pen' | 'mouse' | 'touch'
  return (e as PointerEvent).pointerType === 'pen';
}

export default function HandwritingEditor({ value, onChange }: Props) {
  const data = useMemo(() => normalizeHandwritingData(value), [value]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const drawingPointerId = useRef<number | null>(null);
  const currentStrokeRef = useRef<HandwritingStroke | null>(null);
  const redoStackRef = useRef<HandwritingStroke[]>([]);

  const [baseSize, setBaseSize] = useState<number>(data.baseSize);
  const [background, setBackground] = useState<HandwritingBackground>(data.background);
  const [mode, setMode] = useState<HandwritingCanvasMode>(data.mode);
  const [palmRejection, setPalmRejection] = useState<boolean>(data.palmRejection ?? true);
  const [pageCount, setPageCount] = useState<number>(data.pageCount);
  const [height, setHeight] = useState<number>(data.height);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [scrollY, setScrollY] = useState<number>(0);
  const [scrollYMax, setScrollYMax] = useState<number>(0);

  useEffect(() => {
    setBaseSize(data.baseSize);
    setBackground(data.background);
    setMode(data.mode);
    setPalmRejection(data.palmRejection ?? true);
    setPageCount(data.pageCount);
    setHeight(data.height);
  }, [data.baseSize, data.background, data.mode, data.palmRejection, data.pageCount, data.height]);

  const zoom = useMemo(() => clamp(zoomPct / 100, 0.5, 2), [zoomPct]);

  const getCtx = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    if (ctxRef.current) return ctxRef.current;
    const ctx = canvas.getContext('2d');
    ctxRef.current = ctx;
    return ctx;
  }, []);

  const logicalHeight = useMemo(() => {
    if (mode === 'paged') return Math.max(1, pageCount) * PAGE_HEIGHT;
    return Math.max(PAGE_HEIGHT, height);
  }, [height, mode, pageCount]);

  const resizeCanvas = useCallback(() => {
    const container = paperRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    const scale = rect.width / LOGICAL_WIDTH;
    const cssHeight = logicalHeight * scale;
    container.style.height = `${cssHeight}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = getCtx();
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [getCtx, logicalHeight]);

  const drawStroke = useCallback(
    (stroke: HandwritingStroke) => {
      const ctx = getCtx();
      const container = paperRef.current;
      if (!ctx || !container) return;
      const rect = container.getBoundingClientRect();
      const scale = rect.width / LOGICAL_WIDTH;

      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const pts = stroke.points;
      if (pts.length < 2) return;

      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const ax = a.x * scale;
        const ay = a.y * scale;
        const bx = b.x * scale;
        const by = b.y * scale;
        const pressure = (a.p + b.p) / 2;
        const w = stroke.baseSize * (0.3 + 0.7 * pressure);
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    },
    [getCtx],
  );

  const redraw = useCallback(() => {
    const ctx = getCtx();
    const container = paperRef.current;
    if (!ctx || !container) return;
    const rect = container.getBoundingClientRect();
    // canvas height is controlled via resizeCanvas; clear by canvas css size
    ctx.clearRect(0, 0, rect.width, (canvasRef.current?.height ?? rect.height) / (window.devicePixelRatio || 1));
    data.strokes.forEach(drawStroke);
    if (currentStrokeRef.current) drawStroke(currentStrokeRef.current);
  }, [data.strokes, drawStroke, getCtx]);

  useEffect(() => {
    resizeCanvas();
    redraw();
    const ro = new ResizeObserver(() => {
      resizeCanvas();
      redraw();
    });
    if (paperRef.current) ro.observe(paperRef.current);
    return () => ro.disconnect();
  }, [redraw, resizeCanvas]);

  // When logical height/page count changes, we must resize the canvas too (not only on element resize)
  useEffect(() => {
    resizeCanvas();
    redraw();
  }, [logicalHeight, resizeCanvas, redraw]);

  const syncScrollMetrics = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    setScrollYMax(max);
    setScrollY((cur) => clamp(cur, 0, max));
  }, []);

  // Keep scroll slider in sync with actual scroll position and content size
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      setScrollY(el.scrollTop);
      setScrollYMax(Math.max(0, el.scrollHeight - el.clientHeight));
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    const ro = new ResizeObserver(() => {
      onScroll();
    });
    ro.observe(el);
    if (paperRef.current) ro.observe(paperRef.current);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  // When zoom / logicalHeight changes, the scrollHeight will change after resizeCanvas runs
  useEffect(() => {
    // next frame to let DOM/ResizeObserver settle
    const id = window.requestAnimationFrame(() => syncScrollMetrics());
    return () => window.cancelAnimationFrame(id);
  }, [logicalHeight, syncScrollMetrics, zoom]);

  // Persist setting changes
  useEffect(() => {
    if (
      baseSize !== data.baseSize ||
      background !== data.background ||
      mode !== data.mode ||
      palmRejection !== (data.palmRejection ?? true) ||
      pageCount !== data.pageCount ||
      height !== data.height
    ) {
      onChange({ ...data, baseSize, background, mode, palmRejection, pageCount, height });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSize, background, mode, palmRejection, pageCount, height]);

  const addPointToCurrent = useCallback((pt: HandwritingPoint) => {
    const cur = currentStrokeRef.current;
    if (!cur) return;
    cur.points.push(pt);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 防误触：开启后 touch（手指/手掌）不允许落笔，避免缩放/滚动/翻页时误写
      if (palmRejection && (e as PointerEvent).pointerType === 'touch') return;
      const container = paperRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;
      const rect = container.getBoundingClientRect();
      const { x, y } = getCanvasPointLogical(e, rect, logicalHeight);
      const p = isPen(e) ? clamp(e.pressure || 0.5, 0, 1) : 0.5;

      drawingPointerId.current = e.pointerId;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      const stroke: HandwritingStroke = {
        id: crypto.randomUUID(),
        color: data.color,
        baseSize,
        points: [{ x, y, p }],
      };
      currentStrokeRef.current = stroke;
      redraw();
    },
    [baseSize, data.color, logicalHeight, palmRejection, redraw],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (drawingPointerId.current !== e.pointerId) return;
      const container = paperRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const { x, y } = getCanvasPointLogical(e, rect, logicalHeight);
      const p = isPen(e) ? clamp(e.pressure || 0.5, 0, 1) : 0.5;
      // Infinite mode: auto-grow when approaching bottom
      if (mode === 'infinite' && y > height - INFINITE_GROW_THRESHOLD) {
        const nextHeight = height + PAGE_HEIGHT;
        setHeight(nextHeight);
      }
      addPointToCurrent({ x, y, p });
      redraw();
    },
    [addPointToCurrent, height, logicalHeight, mode, redraw],
  );

  const endStroke = useCallback(() => {
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    drawingPointerId.current = null;
    if (!stroke || stroke.points.length < 2) {
      redraw();
      return;
    }
    redoStackRef.current = [];
    const next = { ...data, strokes: [...data.strokes, stroke] };
    onChange(next);
  }, [data, onChange, redraw]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (drawingPointerId.current !== e.pointerId) return;
      endStroke();
    },
    [endStroke],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (drawingPointerId.current !== e.pointerId) return;
      currentStrokeRef.current = null;
      drawingPointerId.current = null;
      redraw();
    },
    [redraw],
  );

  const undo = useCallback(() => {
    if (data.strokes.length === 0) return;
    const last = data.strokes[data.strokes.length - 1];
    redoStackRef.current = [last, ...redoStackRef.current];
    onChange({ ...data, strokes: data.strokes.slice(0, -1) });
  }, [data, onChange]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const [first, ...rest] = stack;
    redoStackRef.current = rest;
    onChange({ ...data, strokes: [...data.strokes, first] });
  }, [data, onChange]);

  const clear = useCallback(() => {
    redoStackRef.current = [];
    onChange({ ...data, strokes: [] });
  }, [data, onChange]);

  return (
    <div className="hw-editor">
      <div className="hw-toolbar">
        <div className="hw-toolbar-group">
          <label className="hw-label">
            笔粗细
            <input
              className="hw-slider"
              type="range"
              min={1}
              max={24}
              value={baseSize}
              onChange={(e) => setBaseSize(Number(e.target.value))}
            />
            <span className="hw-value">{baseSize}px</span>
          </label>
        </div>
        <div className="hw-toolbar-group">
          <label className="hw-label">
            防误触
            <input
              type="checkbox"
              checked={palmRejection}
              onChange={(e) => setPalmRejection(e.target.checked)}
              style={{ marginLeft: 8 }}
              title="开启后仅手写笔(pen)可书写，手指/手掌(touch)只用于滚动/缩放/翻页"
            />
          </label>
        </div>
        <div className="hw-toolbar-group">
          <label className="hw-label">
            画布
            <select
              className="hw-select"
              value={mode}
              onChange={(e) => {
                const next = e.target.value as HandwritingCanvasMode;
                setMode(next);
                if (next === 'paged') {
                  setPageCount((c) => Math.max(1, c));
                } else {
                  setHeight((h) => Math.max(PAGE_HEIGHT, h));
                }
              }}
            >
              <option value="infinite">无限扩展</option>
              <option value="paged">分页向下</option>
            </select>
          </label>
        </div>
        <div className="hw-toolbar-group">
          <label className="hw-label">
            背景
            <select
              className="hw-select"
              value={background}
              onChange={(e) => setBackground(e.target.value as HandwritingBackground)}
            >
              <option value="lined">横条草纸</option>
              <option value="blank">空白草纸</option>
            </select>
          </label>
          <button
            className="button"
            onClick={() => setPageCount((c) => c + 1)}
            title={mode === 'paged' ? '增加页面' : '仅分页模式可用'}
            disabled={mode !== 'paged'}
          >
            增加页面
          </button>
        </div>
        <div className="hw-toolbar-group hw-toolbar-actions">
          <button className="button" onClick={undo} disabled={data.strokes.length === 0}>
            撤销
          </button>
          <button className="button" onClick={redo} disabled={redoStackRef.current.length === 0}>
            重做
          </button>
          <button className="button" onClick={clear} disabled={data.strokes.length === 0}>
            清空
          </button>
        </div>
      </div>

      <div className="hw-stage">
        <div className="hw-zoom-bar">
          <label className="hw-label">
            缩放
            <input
              className="hw-slider hw-zoom-slider"
              type="range"
              min={50}
              max={200}
              value={zoomPct}
              onChange={(e) => setZoomPct(Number(e.target.value))}
            />
            <span className="hw-value">{zoomPct}%</span>
          </label>
          <button className="button" onClick={() => setZoomPct(100)} title="缩放重置为 100%">
            复位
          </button>
        </div>

        <div className="hw-pan-y" aria-label="上下移动画布">
          <input
            className="hw-slider hw-slider-vertical"
            type="range"
            min={0}
            max={scrollYMax}
            // 反向映射：UI 往下拖 => 数值变大 => 画布往下滚（scrollTop 变大）
            value={scrollYMax - scrollY}
            onChange={(e) => {
              const uiValue = Number(e.target.value);
              const next = scrollYMax - uiValue;
              const el = scrollRef.current;
              if (el) el.scrollTop = next;
              setScrollY(next);
            }}
          />
        </div>

        <div ref={scrollRef} className="hw-paper-scroll">
          <div
            ref={paperRef}
            className={`hw-paper ${background === 'lined' ? 'lined' : 'blank'}`}
            style={{ width: `${zoom * 100}%`, ['--hw-zoom' as any]: zoom } as React.CSSProperties}
          >
            <canvas
              ref={canvasRef}
              className="hw-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}


