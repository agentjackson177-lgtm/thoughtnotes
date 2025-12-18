import { MindMapState, MindNode } from '../types';
import { calculateNodeDimensions, getTextWidth } from './textMeasure';
import { computeFlowchartLayout } from '../components/FlowchartEditor';

const FONT_FAMILY =
  'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const visibleNodeIds = (nodes: Record<string, MindNode>, rootId: string): string[] => {
  const out: string[] = [];
  const visit = (id: string) => {
    const n = nodes[id];
    if (!n) return;
    out.push(id);
    if (!n.collapsed) n.children.forEach(visit);
  };
  visit(rootId);
  return out;
};

const boundsFromPositions = (
  ids: string[],
  positions: Record<string, { x: number; y: number; width: number; height: number }>,
) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  ids.forEach((id) => {
    const p = positions[id];
    if (!p) return;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.width);
    maxY = Math.max(maxY, p.y + p.height);
  });
  if (!isFinite(minX)) minX = 0;
  if (!isFinite(minY)) minY = 0;
  if (!isFinite(maxX)) maxX = 0;
  if (!isFinite(maxY)) maxY = 0;
  return { minX, minY, maxX, maxY };
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const svgToPngBlob = (svg: string, width: number, height: number, scale = 2): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No canvas context');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((png) => {
          if (!png) return reject(new Error('Failed to encode PNG'));
          URL.revokeObjectURL(url);
          resolve(png);
        }, 'image/png');
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });

// ---- Mindmap layout (copied for export only) ----
type Position = { x: number; y: number; depth: number; width: number; height: number };
type PositionMap = Record<string, Position>;
type NodeInfo = { width: number; height: number; treeHeight: number };

const HORIZONTAL_GAP = 50;
const VERTICAL_GAP = 20;

const computeMindmapLayoutForExport = (nodes: Record<string, MindNode>, rootId: string): PositionMap => {
  const positions: PositionMap = {};
  const nodeInfo: Record<string, NodeInfo> = {};

  // Post-order: compute subtree heights
  const calc = (id: string): number => {
    const node = nodes[id];
    if (!node) return 0;
    const dims = calculateNodeDimensions(node.title);
    const width = dims.width;
    const height = dims.height;
    const visibleChildren = node.collapsed ? [] : node.children;
    let treeHeight: number;
    if (visibleChildren.length === 0) {
      treeHeight = height;
    } else {
      let totalChildHeight = 0;
      visibleChildren.forEach((cid) => (totalChildHeight += calc(cid)));
      treeHeight = totalChildHeight + (visibleChildren.length - 1) * VERTICAL_GAP;
      treeHeight = Math.max(treeHeight, height);
    }
    nodeInfo[id] = { width, height, treeHeight };
    return treeHeight;
  };

  calc(rootId);

  const setCoordinates = (id: string, parentX: number, parentY: number, parentHeight: number, parentCenterY: number) => {
    const node = nodes[id];
    if (!node) return;
    const info = nodeInfo[id];
    if (!info) return;

    const isRoot = id === rootId;
    const x = parentX + (isRoot ? 0 : (node.parentId ? nodeInfo[node.parentId]?.width ?? 0 : 0) + HORIZONTAL_GAP);

    const visibleChildren = node.collapsed ? [] : node.children;
    let y = parentCenterY - info.height / 2;

    if (visibleChildren.length > 0) {
      let currentChildY = parentCenterY - info.treeHeight / 2;
      const childYPositions: number[] = [];
      visibleChildren.forEach((childId) => {
        const childInfo = nodeInfo[childId];
        if (!childInfo) return;
        const childCenterY = currentChildY + childInfo.treeHeight / 2;
        const childY = childCenterY - childInfo.height / 2;
        childYPositions.push(childY);
        setCoordinates(childId, x, childY, info.height, childCenterY);
        currentChildY += childInfo.treeHeight + VERTICAL_GAP;
      });

      const firstChildY = childYPositions[0];
      const lastChildY = childYPositions[childYPositions.length - 1];
      const lastChildInfo = nodeInfo[visibleChildren[visibleChildren.length - 1]];
      const childrenCenterY = (firstChildY + lastChildY + (lastChildInfo?.height ?? 0)) / 2;
      y = childrenCenterY - info.height / 2;
    }

    positions[id] = { x, y, depth: 0, width: info.width, height: info.height };
  };

  const rootInfo = nodeInfo[rootId];
  if (!rootInfo) return positions;
  // Root anchor at (0,0)
  positions[rootId] = { x: 0, y: 0, depth: 0, width: rootInfo.width, height: rootInfo.height };
  const rootNode = nodes[rootId];
  const visibleChildren = rootNode?.collapsed ? [] : rootNode?.children || [];
  if (visibleChildren.length > 0) {
    // place children relative to root centerY
    const rootCenterY = 0 + rootInfo.height / 2;
    let currentChildY = rootCenterY - (rootInfo.treeHeight ?? rootInfo.height) / 2;
    visibleChildren.forEach((childId) => {
      const childInfo = nodeInfo[childId];
      if (!childInfo) return;
      const childCenterY = currentChildY + childInfo.treeHeight / 2;
      setCoordinates(childId, positions[rootId].x, positions[rootId].y, rootInfo.height, childCenterY);
      currentChildY += childInfo.treeHeight + VERTICAL_GAP;
    });
  }

  return positions;
};

export async function exportMindmapAsPng(state: MindMapState, filenameBase: string) {
  const ids = visibleNodeIds(state.nodes, state.rootId);
  const positions = computeMindmapLayoutForExport(state.nodes, state.rootId);
  const { minX, minY, maxX, maxY } = boundsFromPositions(ids, positions);
  const pad = 80;
  const width = Math.max(1, Math.ceil(maxX - minX + pad * 2));
  const height = Math.max(1, Math.ceil(maxY - minY + pad * 2));
  const dx = -minX + pad;
  const dy = -minY + pad;

  const lineEls: string[] = [];
  ids.forEach((id) => {
    const node = state.nodes[id];
    if (!node?.parentId) return;
    const parentPos = positions[node.parentId];
    const childPos = positions[id];
    if (!parentPos || !childPos) return;
    const startX = parentPos.x + parentPos.width;
    const startY = parentPos.y + parentPos.height / 2;
    const endX = childPos.x;
    const endY = childPos.y + childPos.height / 2;
    const cp1x = startX + HORIZONTAL_GAP / 2;
    const cp1y = startY;
    const cp2x = endX - HORIZONTAL_GAP / 2;
    const cp2y = endY;
    const d = `M ${startX + dx} ${startY + dy} C ${cp1x + dx} ${cp1y + dy}, ${cp2x + dx} ${cp2y + dy}, ${endX + dx} ${endY + dy}`;
    lineEls.push(
      `<path d="${d}" fill="none" stroke="#c5d3ff" stroke-width="4" stroke-linecap="round" />`,
    );
  });

  const nodeEls: string[] = [];
  ids.forEach((id) => {
    const node = state.nodes[id];
    const p = positions[id];
    if (!node || !p) return;
    const x = p.x + dx;
    const y = p.y + dy;
    const rx = 22;
    nodeEls.push(
      `<rect x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="${rx}" ry="${rx}" fill="#ffffff" stroke="#d7def0" stroke-width="2" />`,
    );
    const lines = (node.title ?? '').split(/\r?\n/);
    const cx = x + p.width / 2;
    const cy = y + p.height / 2;
    const lineHeight = 18;
    const totalTextHeight = (lines.length - 1) * lineHeight;
    const startY = cy - totalTextHeight / 2;
    const tspans = lines
      .map((t, i) => `<tspan x="${cx}" y="${startY + i * lineHeight}">${escapeXml(t)}</tspan>`)
      .join('');
    nodeEls.push(
      `<text font-family="${escapeXml(FONT_FAMILY)}" font-size="14" fill="#111827" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`,
    );
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${lineEls.join('\n  ')}
  ${nodeEls.join('\n  ')}
</svg>`;

  const png = await svgToPngBlob(svg, width, height, 2);
  downloadBlob(png, `${filenameBase}.png`);
}

export async function exportFlowchartAsPng(state: MindMapState, filenameBase: string) {
  const ids = visibleNodeIds(state.nodes, state.rootId);
  const layout = computeFlowchartLayout(state.nodes, state.rootId);
  const positions = layout.positions;
  const levelNodes = layout.levelNodes;

  const { minX, minY, maxX, maxY } = boundsFromPositions(ids, positions as any);
  const pad = 80;
  const width = Math.max(1, Math.ceil(maxX - minX + pad * 2));
  const height = Math.max(1, Math.ceil(maxY - minY + pad * 2));
  const dx = -minX + pad;
  const dy = -minY + pad;

  const snap = (v: number) => Math.round(v * 2) / 2;

  const defs = `<defs>
    <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <polygon points="0,0 6,3 0,6" fill="#3b82f6" />
    </marker>
  </defs>`;

  const lineEls: string[] = [];

  // real parent-child lines
  ids.forEach((id) => {
    const node = state.nodes[id];
    if (!node?.parentId) return;
    const parentPos = positions[node.parentId];
    const childPos = positions[id];
    if (!parentPos || !childPos) return;
    const startX = snap(parentPos.x + parentPos.width / 2 + dx);
    const startY = snap(parentPos.y + parentPos.height + dy);
    const endX = snap(childPos.x + childPos.width / 2 + dx);
    const endY = snap(childPos.y + dy);
    let d: string;
    if (Math.abs(endX - startX) < 0.25) {
      d = `M ${startX} ${startY} L ${endX} ${endY}`;
    } else {
      const midY = snap(startY + (endY - startY) / 2);
      d = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
    }
    lineEls.push(
      `<path d="${d}" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)" />`,
    );
  });

  // auto-merge lines (same as editor): when next level has exactly one node (and not single)
  Object.keys(levelNodes).forEach((levelStr) => {
    const level = Number(levelStr);
    const parents = levelNodes[level] || [];
    if (parents.length < 2) return;
    const childLevel = level + 1;
    const nextIds = levelNodes[childLevel] || [];
    if (nextIds.length !== 1) return;
    const mergeChildId = nextIds[0];
    if (state.nodes[mergeChildId]?.flowchartChildType === 'single') return;
    const childPos = positions[mergeChildId];
    if (!childPos) return;
    parents.forEach((parentId) => {
      const parentNode = state.nodes[parentId];
      if (parentNode?.children?.includes(mergeChildId)) return; // skip real line
      const parentPos = positions[parentId];
      if (!parentPos) return;
      const startX = snap(parentPos.x + parentPos.width / 2 + dx);
      const startY = snap(parentPos.y + parentPos.height + dy);
      const endX = snap(childPos.x + childPos.width / 2 + dx);
      const endY = snap(childPos.y + dy);
      let d: string;
      if (Math.abs(endX - startX) < 0.25) {
        d = `M ${startX} ${startY} L ${endX} ${endY}`;
      } else {
        const midY = snap(startY + (endY - startY) / 2);
        d = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
      }
      lineEls.push(
        `<path d="${d}" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)" />`,
      );
    });
  });

  const nodeEls: string[] = [];
  ids.forEach((id) => {
    const node = state.nodes[id];
    const p = positions[id];
    if (!node || !p) return;
    const x = p.x + dx;
    const y = p.y + dy;
    const rx = 22;
    nodeEls.push(
      `<rect x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="${rx}" ry="${rx}" fill="#ffffff" stroke="#d7def0" stroke-width="2" />`,
    );
    const lines = (node.title ?? '').split(/\r?\n/);
    const cx = x + p.width / 2;
    const cy = y + p.height / 2;
    const lineHeight = 18;
    const totalTextHeight = (lines.length - 1) * lineHeight;
    const startY = cy - totalTextHeight / 2;
    const tspans = lines
      .map((t, i) => `<tspan x="${cx}" y="${startY + i * lineHeight}">${escapeXml(t)}</tspan>`)
      .join('');
    nodeEls.push(
      `<text font-family="${escapeXml(FONT_FAMILY)}" font-size="14" fill="#111827" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`,
    );
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${defs}
  ${lineEls.join('\n  ')}
  ${nodeEls.join('\n  ')}
</svg>`;

  const png = await svgToPngBlob(svg, width, height, 2);
  downloadBlob(png, `${filenameBase}.png`);
}


