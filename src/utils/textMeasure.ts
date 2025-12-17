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

export const getTextWidth = (text: string): number => {
  const ctx = getCanvasContext();
  ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  const metrics = ctx.measureText(text);
  return metrics.width;
};

export const calculateNodeDimensions = (text: string): { width: number; height: number } => {
  const textWidth = getTextWidth(text);
  // Formula: node.width = calculated_text_width + 40
  const width = textWidth + 40;
  // Formula: node.height = 40 (fixed height)
  const height = 40;
  
  return { width, height };
};

export { FONT_SIZE, HORIZONTAL_PADDING };

