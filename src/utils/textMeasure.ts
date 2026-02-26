// Text measurement helper using canvas
const FONT_SIZE = 14;
const FONT_FAMILY = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const HORIZONTAL_PADDING = 20; // 40px total (20px on each side)

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;

const getCanvasContext = (): CanvasRenderingContext2D => {
  if (!canvas) {
    canvas = document.createElement('canvas');
    context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Failed to get canvas context');
    }
  }
  if (!context) {
    context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Failed to get canvas context');
    }
  }
  return context;
};

export const getTextWidth = (text: string, fontSize: number = FONT_SIZE): number => {
  const ctx = getCanvasContext();
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  const metrics = ctx.measureText(text);
  return metrics.width;
};

export const calculateNodeDimensions = (
  text: string,
  opts?: { fontSize?: number; height?: number },
): { width: number; height: number } => {
  const fontSize = opts?.fontSize ?? FONT_SIZE;
  const paddingX = HORIZONTAL_PADDING;
  const height = opts?.height ?? 40;
  const textWidth = getTextWidth(text, fontSize);
  const width = textWidth;
  return { width, height };
};

export { FONT_SIZE, HORIZONTAL_PADDING };

