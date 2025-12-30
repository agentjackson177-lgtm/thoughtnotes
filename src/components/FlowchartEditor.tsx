import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MindNode } from '../types';
import { createInitialState, useMindMap } from '../hooks/useMindMap';
import { calculateNodeDimensions, getTextWidth } from '../utils/textMeasure';

type PositionMap = Record<string, { x: number; y: number; depth: number; width: number; height: number }>;
type LayoutResult = {
  positions: PositionMap;
  levelNodes: Record<number, string[]>;
  nodeLevel: Record<string, number>;
};
type NodeInfo = {
  width: number;
  height: number;
  treeHeight: number;
};

const FLOWCHART_HORIZONTAL_GAP = 30;
const FLOWCHART_VERTICAL_GAP = 50;
const FLOWCHART_MULTI_LINE_PAD_Y = 20; // 10px top + 10px bottom（与 textarea 样式保持一致）
const FLOWCHART_LINE_HEIGHT_PX = 18; // 约等于 14px 字号 * 1.3

// 流程图布局算法（从上到下）
export const computeFlowchartLayout = (nodes: Record<string, MindNode>, rootId: string) => {
  const positions: PositionMap = {};
  const nodeInfo: Record<string, NodeInfo> = {};

  // Step 1: Pre-calculation (Post-order traversal)
  const calculateNodeInfo = (id: string): number => {
    const node = nodes[id];
    if (!node) return 0;

    // 多行：宽度取最长行；高度按行数增长（保证 3 行以上也能完整显示）
    const lines = (node.title ?? '').split(/\r?\n/);
    const maxLineWidth = Math.max(0, ...lines.map((l) => getTextWidth(l)));
    const baseDims = calculateNodeDimensions(lines[0] ?? '');
    const hasProgress = !!node.progress && node.progress !== 'none';
    const hasPriority = !!node.priority && node.priority >= 1 && node.priority <= 4;
    const badgeReserve =
      (hasProgress ? 18 : 0) +
      (hasPriority ? (hasProgress ? 6 : 0) + 22 : 0);
    const width = (maxLineWidth + 40) + (hasProgress || hasPriority ? badgeReserve : 0);
    const height = Math.max(
      baseDims.height, // 至少 40
      lines.length <= 1 ? baseDims.height : (lines.length * FLOWCHART_LINE_HEIGHT_PX + FLOWCHART_MULTI_LINE_PAD_Y)
    );

    const visibleChildren = node.collapsed ? [] : node.children;
    let treeWidth: number;

    if (visibleChildren.length === 0) {
      treeWidth = width;
    } else {
      let totalChildWidth = 0;
      visibleChildren.forEach((childId) => {
        totalChildWidth += calculateNodeInfo(childId);
      });
      treeWidth = totalChildWidth + (visibleChildren.length - 1) * FLOWCHART_HORIZONTAL_GAP;
      treeWidth = Math.max(treeWidth, width);
    }

    nodeInfo[id] = { width, height, treeHeight: treeWidth };
    return treeWidth;
  };

  calculateNodeInfo(rootId);

  // Step 2: Main Layout - 流程图布局：同级节点横向排列，所有子节点汇集到下一级
  // 按层级布局：每一层的节点横向排列，下一层汇集到一个节点
  const levelNodes: Record<number, string[]> = {};
  const nodeLevel: Record<string, number> = {};

  // 计算每个节点的层级
  const calculateLevels = (id: string, level: number) => {
    nodeLevel[id] = level;
    if (!levelNodes[level]) levelNodes[level] = [];
    levelNodes[level].push(id);
    
    const node = nodes[id];
    if (node && !node.collapsed) {
      node.children.forEach((childId) => {
        calculateLevels(childId, level + 1);
      });
    }
  };
  calculateLevels(rootId, 0);

  // 按层级设置坐标
  const levelKeys = Object.keys(levelNodes).map(Number).filter(n => !isNaN(n));
  if (levelKeys.length === 0) {
    // 只有根节点
    const rootInfo = nodeInfo[rootId];
    if (rootInfo) {
      positions[rootId] = {
        x: 0,
        y: 0,
        depth: 0,
        width: rootInfo.width,
        height: rootInfo.height,
      };
    }
    return { positions, levelNodes, nodeLevel };
  }
  
  const maxLevel = Math.max(...levelKeys);
  let currentY = 0;

  for (let level = 0; level <= maxLevel; level++) {
    const levelNodeIds = levelNodes[level] || [];
    if (levelNodeIds.length === 0) continue;

    // 计算这一层所有节点的总宽度
    let totalWidth = 0;
    const levelNodeInfos: Array<{ id: string; info: NodeInfo }> = [];
    levelNodeIds.forEach((id) => {
      const info = nodeInfo[id];
      if (info) {
        levelNodeInfos.push({ id, info });
        totalWidth += info.width;
      }
    });
    
    if (levelNodeInfos.length === 0) continue;
    
    totalWidth += (levelNodeInfos.length - 1) * FLOWCHART_HORIZONTAL_GAP;

    // 水平排列这一层的节点
    let currentX = -totalWidth / 2;
    levelNodeInfos.forEach(({ id, info }) => {
      positions[id] = {
        x: currentX,
        y: currentY,
        depth: level,
        width: info.width,
        height: info.height,
      };
      currentX += info.width + FLOWCHART_HORIZONTAL_GAP;
    });

    // 单独子节点：强制与其父节点中心对齐（只在父节点已布局的情况下）
    if (level > 0) {
      const singleIds = levelNodeInfos
        .map(({ id }) => id)
        .filter((id) => nodes[id]?.flowchartChildType === 'single' && nodes[id]?.parentId);
      singleIds.forEach((id) => {
        const parentId = nodes[id]?.parentId;
        if (!parentId) return;
        const parentPos = positions[parentId];
        const info = nodeInfo[id];
        if (!parentPos || !info) return;
        positions[id] = {
          ...positions[id],
          x: parentPos.x + parentPos.width / 2 - info.width / 2,
        };
      });

      // 简单避让：按 x 排序，避免同层节点重叠
      const sorted = levelNodeInfos
        .map(({ id }) => id)
        .filter((id) => positions[id])
        .sort((a, b) => (positions[a].x ?? 0) - (positions[b].x ?? 0));
      for (let i = 1; i < sorted.length; i++) {
        const prev = positions[sorted[i - 1]];
        const cur = positions[sorted[i]];
        const minX = prev.x + prev.width + FLOWCHART_HORIZONTAL_GAP;
        if (cur.x < minX) {
          positions[sorted[i]] = { ...cur, x: minX };
        }
      }
    }

    // 移动到下一层
    if (level < maxLevel) {
      const maxHeight = Math.max(...levelNodeInfos.map(({ info }) => info.height));
      currentY += maxHeight + FLOWCHART_VERTICAL_GAP;
    }
  }

  return { positions, levelNodes, nodeLevel };
};

type Props = {
  initialState: ReturnType<typeof createInitialState>;
  onUpdate: (state: ReturnType<typeof createInitialState>) => void;
};

export default function FlowchartEditor({ initialState, onUpdate }: Props) {
  const {
    nodes,
    rootId,
    selectedId,
    scale,
    offset,
    setSelected,
    updateTitle,
    addChild,
    addSibling,
    removeNode,
    toggleCollapse,
    setScale,
    pan,
    setPriority,
    setProgress,
    moveNode,
    importData,
    undo,
    redo,
  } = useMindMap();

  // 初始化状态
  useEffect(() => {
    importData(initialState);
  }, [initialState.rootId, importData]);

  const layout = useMemo(() => computeFlowchartLayout(nodes, rootId), [nodes, rootId]);
  const { positions, levelNodes, nodeLevel } = layout;

  // 3px 线宽下让线更“对齐/清晰”：把坐标吸附到 0.5 像素网格
  const snap = (v: number) => Math.round(v * 2) / 2;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const isSelecting = useRef(false);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const canvasShellRef = useRef<HTMLDivElement>(null);
  const draggingNodeId = useRef<string | null>(null);
  const dragOverNodeId = useRef<string | null>(null);
  const clickMetaRef = useRef<Record<string, { lastAt: number; stage: 'idle' | 'focused' | 'selectedAll' }>>({});
  const pendingNewNodeEditRef = useRef(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const suppressBlurClearRef = useRef(false);
  const armedEditClickRef = useRef<Record<string, boolean>>({});
  const didAutoCenterRef = useRef<Record<string, boolean>>({});

  const setSelectedIdsSafe = (next: Set<string>) => {
    selectedIdsRef.current = next;
    setSelectedIds(next);
  };

  // 注意：不要把 selectedIds 强制同步成 selectedId（会破坏框选/多选）

  const visibleNodes = useMemo(() => {
    const result: MindNode[] = [];
    const visit = (id: string) => {
      const node = nodes[id];
      if (!node) return;
      result.push(node);
      if (!node.collapsed) {
        node.children.forEach(visit);
      }
    };
    visit(rootId);
    return result;
  }, [nodes, rootId]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const next = Math.min(2, Math.max(0.3, scale - e.deltaY * 0.001));
      setScale(next);
    } else {
      pan(-e.deltaX, -e.deltaY);
    }
  };

  const handleNodeDragStart = (e: React.DragEvent, nodeId: string) => {
    if (nodeId === rootId) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    draggingNodeId.current = nodeId;
    if (!selectedIdsRef.current.has(nodeId)) {
      setSelectedIdsSafe(new Set([nodeId]));
      setSelected(nodeId);
    }
    dragOverNodeId.current = null;
  };

  const handleNodeDragOver = (e: React.DragEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (draggingNodeId.current && draggingNodeId.current !== nodeId && nodeId !== rootId) {
      dragOverNodeId.current = nodeId;
      setSelectedIds((prev) => new Set(prev));
    }
  };

  const handleNodeDragEnd = (e?: React.DragEvent) => {
    const targetId = dragOverNodeId.current;
    const draggedId = draggingNodeId.current;
    
    if (draggedId && targetId && draggedId !== targetId) {
      const isDescendant = (checkId: string, ancestorId: string): boolean => {
        const n = nodes[checkId];
        if (!n || !n.parentId) return false;
        if (n.parentId === ancestorId) return true;
        return isDescendant(n.parentId, ancestorId);
      };
      if (!isDescendant(targetId, draggedId)) {
        moveNode(draggedId, targetId);
      }
    }
    
    draggingNodeId.current = null;
    dragOverNodeId.current = null;
    setSelectedIds((prev) => new Set(prev));
  };

  const startSelection = (e: React.PointerEvent) => {
    // 如果点击在节点上，不开始框选
    if ((e.target as HTMLElement).closest('.node')) {
      return;
    }
    if (e.button !== 0) return; // 只处理左键
    const canvasShell = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const startX = e.clientX - canvasShell.left;
    const startY = e.clientY - canvasShell.top;
    isSelecting.current = true;
    selectionStart.current = { x: startX, y: startY };
    setSelectionBox({ startX, startY, endX: startX, endY: startY });
    e.preventDefault();
  };

  const moveSelection = (e: React.PointerEvent) => {
    if (isSelecting.current && selectionStart.current) {
      const canvasShell = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const endX = e.clientX - canvasShell.left;
      const endY = e.clientY - canvasShell.top;
      setSelectionBox({
        startX: selectionStart.current.x,
        startY: selectionStart.current.y,
        endX,
        endY,
      });

      // 实时选择：选择中心点在框内的节点
      const boxMinX = Math.min(selectionStart.current.x, endX);
      const boxMaxX = Math.max(selectionStart.current.x, endX);
      const boxMinY = Math.min(selectionStart.current.y, endY);
      const boxMaxY = Math.max(selectionStart.current.y, endY);

      const picked: string[] = [];
      visibleNodes.forEach((n) => {
        const pos = positions[n.id];
        if (!pos) return;
        const cx = offset.x + (pos.x + pos.width / 2) * scale;
        const cy = offset.y + (pos.y + pos.height / 2) * scale;
        if (cx >= boxMinX && cx <= boxMaxX && cy >= boxMinY && cy <= boxMaxY) {
          picked.push(n.id);
        }
      });
      setSelectedIdsSafe(new Set(picked));
      setSelected(picked.length > 0 ? picked[picked.length - 1] : null);
    }
  };

  const endSelection = (_e?: React.PointerEvent) => {
    if (isSelecting.current) {
      isSelecting.current = false;
      selectionStart.current = null;
      // 松手后隐藏选择框（但保留已选中的节点集合）
      setSelectionBox(null);
    }
  };

  // 流程图快捷键：Tab生成同级，Enter生成下级
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isInInput = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      const inputEl = isInInput ? (e.target as HTMLTextAreaElement | HTMLInputElement) : null;
      // 只有在“真正可编辑”时，才把 Delete/Backspace 交给文本处理。
      // 当 textarea 处于只读（未进入编辑态）时，Delete 应该删除节点。
      const isActuallyEditing = !!inputEl && !(inputEl as HTMLTextAreaElement).readOnly;

      // Undo / Redo（不在编辑文本时拦截）
      if ((e.metaKey || e.ctrlKey) && !isActuallyEditing) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
          return;
        }
        if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault();
          redo();
          return;
        }
      }
      
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // 正在编辑文本时：不删除节点
        if (isActuallyEditing) {
          return;
        }
        // 批量删除选中的节点（用 ref 避免闭包拿到旧的 selectedIds）
        const currentSelected = selectedIdsRef.current;
        if (currentSelected.size > 1) {
          const idsToDelete = Array.from(currentSelected).filter((id) => id !== rootId);
          if (idsToDelete.length > 0) {
            e.preventDefault();
            idsToDelete.forEach(id => removeNode(id));
            setSelectedIdsSafe(new Set());
            setSelected(null);
          }
        } else if (selectedId && selectedId !== rootId) {
          e.preventDefault();
          removeNode(selectedId);
        }
        return;
      }
      
      if (isActuallyEditing && !(e.metaKey || e.ctrlKey)) {
        return;
      }
      
      if (!selectedId) return;
      
      if (e.key === 'Tab') {
        e.preventDefault();
        // 流程图：Tab生成同级
        pendingNewNodeEditRef.current = true;
        addSibling(selectedId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // 流程图：Enter生成下级
        pendingNewNodeEditRef.current = true;
        addChild(selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addChild, addSibling, removeNode, rootId, selectedId]);

  // Tab/Enter 新建节点后：新节点自动进入编辑态，并全选文字（可直接输入替换）
  useEffect(() => {
    if (!pendingNewNodeEditRef.current) return;
    if (!selectedId) return;
    const n = nodes[selectedId];
    if (!n) return;

    // 只对"刚创建的默认标题"自动进入编辑
    if (!(n.title === '新节点' || n.title === '同级节点')) return;

    pendingNewNodeEditRef.current = false;
    
    // 短暂抑制 blur 清空编辑态，避免旧节点 blur 时误清
    suppressBlurClearRef.current = true;
    setEditingId(selectedId);

    // 等待本次 render 使 textarea 变为可编辑后，再 focus + 全选
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(
          `textarea.node-text[data-node-id="${selectedId}"]`,
        );
        if (!el) return;
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(0, len);
        // focus 完成后，允许 blur 清空（但仅清当前节点）
        setTimeout(() => {
          suppressBlurClearRef.current = false;
        }, 50);
      });
    });
  }, [selectedId, nodes]);

  // 新建流程图时：把根节点自动放到“居中偏上”（仅在只有根节点时执行一次）
  useEffect(() => {
    const nodeCount = Object.keys(nodes).length;
    if (nodeCount !== 1) return;
    if (didAutoCenterRef.current[rootId]) return;
    const shell = canvasShellRef.current;
    const rootPos = positions[rootId];
    if (!shell || !rootPos) return;

    didAutoCenterRef.current[rootId] = true;

    // 让根节点中心出现在画布宽度中间，画布高度的 22% 处（偏上）
    const rect = shell.getBoundingClientRect();
    const desiredScreenX = rect.width / 2;
    const desiredScreenY = rect.height * 0.22;
    const rootCenterX = (rootPos.x + rootPos.width / 2) * scale;
    const rootCenterY = (rootPos.y + rootPos.height / 2) * scale;
    const targetOffsetX = desiredScreenX - rootCenterX;
    const targetOffsetY = desiredScreenY - rootCenterY;
    const dx = targetOffsetX - offset.x;
    const dy = targetOffsetY - offset.y;
    pan(dx, dy);
  }, [nodes, rootId, positions, scale, offset.x, offset.y, pan]);

  // 保存状态变化
  useEffect(() => {
    onUpdate({ nodes, rootId, selectedId, scale, offset });
  }, [nodes, rootId, selectedId, scale, offset, onUpdate]);

  return (
      <div
        ref={canvasShellRef}
        className="canvas-shell"
        onWheel={handleWheel}
        onPointerDown={(e) => {
          // 如果点击在节点上，不开始框选
          if (!(e.target as HTMLElement).closest('.node')) {
            startSelection(e);
          }
        }}
        onPointerMove={moveSelection}
        onPointerUp={endSelection}
        onPointerLeave={endSelection}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          handleNodeDragEnd();
        }}
      >
      <svg
        className="canvas"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
      >
        <defs>
          <marker
            id="flowchart-arrowhead"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <polygon points="0,0 6,3 0,6" fill="#3b82f6" />
          </marker>
        </defs>
        {visibleNodes.map((node) => {
          if (!node.parentId) return null;
          const parentPos = positions[node.parentId];
          const childPos = positions[node.id];
          if (!parentPos || !childPos) return null;

          // 流程图：从上到下的折线连接（蓝色）
          const startX0 = parentPos.x + parentPos.width / 2;
          const startY0 = parentPos.y + parentPos.height;
          const endX0 = childPos.x + childPos.width / 2;
          const endY0 = childPos.y;

          const startX = snap(startX0);
          const startY = snap(startY0);
          const endX = snap(endX0);
          const endY = snap(endY0);
          
          // 折线：向下 -> 水平 -> 向下
          let d: string;
          if (Math.abs(endX - startX) < 0.25) {
            // 垂直对齐时避免 0 长度拐角造成的“看起来没对齐”
            d = `M ${startX} ${startY} L ${endX} ${endY}`;
          } else {
            const midY = snap(startY + (endY - startY) / 2);
            d = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
          }

          return (
            <path
              key={`${node.id}-line`}
              d={d}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd="url(#flowchart-arrowhead)"
            />
          );
        })}
        {/* 自动生成蓝色连接线：同一层的兄弟节点汇聚到下一层的单个节点（即使数据结构里只有一个父节点） */}
        {Object.keys(levelNodes).map((levelStr) => {
          const level = Number(levelStr);
          const levelNodeIds = levelNodes[level] || [];
          if (levelNodeIds.length < 2) return null; // 至少需要两个节点才谈“汇聚”

          const nextLevel = level + 1;
          const nextLevelNodeIds = levelNodes[nextLevel] || [];
          // 只有当下一层恰好只有 1 个节点时，才绘制“所有兄弟都连到它”的汇聚线
          if (nextLevelNodeIds.length !== 1) return null;

          const mergeChildId = nextLevelNodeIds[0];
          // 单独子节点：不参与汇聚连线（只保留真实父子线）
          if (nodes[mergeChildId]?.flowchartChildType === 'single') return null;
          const mergeChildPos = positions[mergeChildId];
          if (!mergeChildPos) return null;

          return levelNodeIds
            .map((parentId) => {
              const parentPos = positions[parentId];
              if (!parentPos) return null;

              // 跳过真实父子线（它已经在上面的 visibleNodes.map 里画过了）
              const parentNode = nodes[parentId];
              if (parentNode?.children?.includes(mergeChildId)) return null;

              const startX0 = parentPos.x + parentPos.width / 2;
              const startY0 = parentPos.y + parentPos.height;
              const endX0 = mergeChildPos.x + mergeChildPos.width / 2;
              const endY0 = mergeChildPos.y;

              const startX = snap(startX0);
              const startY = snap(startY0);
              const endX = snap(endX0);
              const endY = snap(endY0);

              let d: string;
              if (Math.abs(endX - startX) < 0.25) {
                d = `M ${startX} ${startY} L ${endX} ${endY}`;
              } else {
                const midY = snap(startY + (endY - startY) / 2);
                d = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
              }

              return (
                <path
                  key={`auto-merge-${parentId}-${mergeChildId}`}
                  d={d}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd="url(#flowchart-arrowhead)"
                />
              );
            })
            .filter(Boolean);
        })}
      </svg>

      {/* 选择框 */}
      {selectionBox && (
        <div
          className="selection-box"
          style={{
            position: 'absolute',
            left: `${Math.min(selectionBox.startX, selectionBox.endX)}px`,
            top: `${Math.min(selectionBox.startY, selectionBox.endY)}px`,
            width: `${Math.abs(selectionBox.endX - selectionBox.startX)}px`,
            height: `${Math.abs(selectionBox.endY - selectionBox.startY)}px`,
          }}
        />
      )}

      <div
        className="nodes-layer"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {visibleNodes.map((node) => {
          const pos = positions[node.id] ?? { x: 0, y: 0, depth: 0, width: 140, height: 40 };
          const isDragging = !!draggingNodeId.current && selectedIds.has(node.id);
          const isDragOver = dragOverNodeId.current === node.id;
          const nodeWidth = pos.width || 140;
          const nodeHeight = pos.height || 40;
          const hasProgress = !!node.progress && node.progress !== 'none';
          const hasPriority = !!node.priority && node.priority >= 1 && node.priority <= 4;
          const leftPad = hasProgress && hasPriority ? 58 : hasProgress ? 42 : hasPriority ? 38 : 20;
          const isMultiline = /[\r\n]/.test(node.title);
          
          return (
            <div
              key={node.id}
              className={`node ${selectedIds.has(node.id) ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                transformOrigin: 'top left',
                width: `${nodeWidth}px`,
                height: `${nodeHeight}px`,
              }}
              draggable={false}
              onDragStart={(e) => {
                if (node.id !== rootId) {
                  handleNodeDragStart(e, node.id);
                } else {
                  e.preventDefault();
                }
              }}
              onDragOver={(e) => handleNodeDragOver(e, node.id)}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (draggingNodeId.current && draggingNodeId.current !== node.id && node.id !== rootId) {
                  dragOverNodeId.current = node.id;
                }
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const x = e.clientX;
                const y = e.clientY;
                if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                  if (dragOverNodeId.current === node.id) {
                    dragOverNodeId.current = null;
                  }
                }
              }}
              onDragEnd={handleNodeDragEnd}
              onClick={(e) => {
                e.stopPropagation();
                if (e.metaKey || e.ctrlKey) {
                  // Ctrl/Cmd + 点击：切换选中状态
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.id)) {
                      next.delete(node.id);
                      if (next.size === 0) {
                        setSelected(null);
                      } else {
                        setSelected(Array.from(next)[next.size - 1]);
                      }
                    } else {
                      next.add(node.id);
                      setSelected(node.id);
                    }
                    return next;
                  });
                } else {
                  // 普通点击：单选
                  setSelectedIdsSafe(new Set([node.id]));
                  setSelected(node.id);
                }
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                // 阻止框选
                isSelecting.current = false;
                selectionStart.current = null;
                setSelectionBox(null);
              }}
            >
              {hasProgress || hasPriority ? (
                <div className="node-left-badges">
                  {hasProgress && (
                    <span className={`node-progress progress ${node.progress}`} title={`进度: ${node.progress}`} />
                  )}
                  {hasPriority && (
                    <span className={`priority-badge priority-${node.priority}`}>{node.priority}</span>
                  )}
                </div>
              ) : null}
              <textarea
                className="node-text"
                data-node-id={node.id}
                value={node.title}
                readOnly={editingId !== node.id}
                wrap="off"
                onChange={(e) => {
                  // 只有进入编辑态才允许修改
                  if (editingId !== node.id) return;
                  updateTitle(node.id, e.target.value);
                }}
                style={{
                  ...(editingId === node.id
                    ? {
                        // 编辑态：支持换行、显示完整内容（不省略），必要时可滚动
                        // 只按用户输入的换行符换行（禁用软换行，避免“第三个字掉到下一行”）
                        whiteSpace: 'pre',
                        overflow: 'auto',
                        textOverflow: 'clip',
                        lineHeight: '1.4',
                        paddingTop: '10px',
                        paddingBottom: '10px',
                        // 有左侧徽标时，给文字留出空间
                        paddingLeft: `${leftPad}px`,
                        paddingRight: `${leftPad}px`,
                        textAlign: 'left',
                        cursor: 'text',
                      }
                    : isMultiline
                      ? {
                          // 非编辑态（多行）：保留换行显示（避免 \n 被渲染成空格）
                          // 只按 \n 换行，避免软换行
                          whiteSpace: 'pre',
                          overflow: 'hidden',
                          textOverflow: 'clip',
                          lineHeight: '1.4',
                          paddingTop: '10px',
                          paddingBottom: '10px',
                          paddingLeft: `${leftPad}px`,
                          paddingRight: `${leftPad}px`,
                          textAlign: 'center',
                          cursor: 'move',
                        }
                      : {
                          // 非编辑态（单行）：上下左右居中显示
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          lineHeight: `${nodeHeight}px`,
                          paddingTop: 0,
                          paddingBottom: 0,
                          // 为了在有左侧徽标时也保持视觉居中：左右 padding 对称
                          paddingLeft: `${leftPad}px`,
                          paddingRight: `${leftPad}px`,
                          textAlign: 'center',
                          cursor: 'move',
                        }),
                }}
                draggable={node.id !== rootId}
                onPointerDown={(e) => {
                  const textarea = e.target as HTMLTextAreaElement;
                  e.stopPropagation();

                  const meta = clickMetaRef.current[node.id] ?? { lastAt: 0, stage: 'idle' as const };

                  // 切换到其它节点时：清掉上一个节点的“全选/待编辑”状态，避免回点又自动全选
                  if (selectedId && selectedId !== node.id) {
                    const prev = selectedId;
                    const prevMeta = clickMetaRef.current[prev];
                    if (prevMeta) clickMetaRef.current[prev] = { ...prevMeta, stage: 'idle', lastAt: 0 };
                    armedEditClickRef.current[prev] = false;
                  }

                  // 双击（detail===2）优先：全选 + 直接进入编辑态（打字可直接替换）
                  if (e.detail === 2) {
                    e.preventDefault();
                    meta.stage = 'selectedAll';
                    meta.lastAt = 0;
                    clickMetaRef.current[node.id] = meta;
                    textarea.focus();
                    setTimeout(() => {
                      textarea.setSelectionRange(0, textarea.value.length);
                    }, 0);
                    armedEditClickRef.current[node.id] = false;
                    suppressBlurClearRef.current = true;
                    setEditingId(node.id);
                    setTimeout(() => {
                      suppressBlurClearRef.current = false;
                    }, 50);
                    return;
                  }

                  // 编辑态下：允许正常落光标/输入，不要强制退出编辑态
                  if (editingId === node.id) {
                    setSelectedIdsSafe(new Set([node.id]));
                    setSelected(node.id);
                    return;
                  }

                  const now = Date.now();

                  // 选中节点（所有模式都需要）
                  setSelectedIdsSafe(new Set([node.id]));
                  setSelected(node.id);

                  // 双击全选后的再次单击：进入编辑态（允许直接输入）
                  if (meta.stage === 'selectedAll' || armedEditClickRef.current[node.id]) {
                    meta.stage = 'idle';
                    meta.lastAt = 0;
                    clickMetaRef.current[node.id] = meta;
                    armedEditClickRef.current[node.id] = false;

                    // 这里不要 preventDefault：让浏览器把光标落到你点击的位置
                    suppressBlurClearRef.current = true;
                    setEditingId(node.id);
                    setTimeout(() => {
                      suppressBlurClearRef.current = false;
                    }, 50);
                    return;
                  }

                  // 阻止默认 focus，我们来控制 focus/selection
                  e.preventDefault();

                  const DOUBLE_CLICK_MS = 250;
                  const SECOND_CLICK_TO_EDIT_MS = 1200;

                  // 快速双击：全选文本（但仍不进入输入状态）
                  if (meta.stage === 'focused' && now - meta.lastAt <= DOUBLE_CLICK_MS) {
                    meta.stage = 'selectedAll';
                    meta.lastAt = 0;
                    clickMetaRef.current[node.id] = meta;
                    textarea.focus();
                    setTimeout(() => {
                      textarea.setSelectionRange(0, textarea.value.length);
                    }, 0);
                    armedEditClickRef.current[node.id] = true;
                    setEditingId(null);
                    return;
                  }

                  // 第二次单击（非双击速度）：进入编辑态（不全选）
                  if (meta.stage === 'focused' && now - meta.lastAt > DOUBLE_CLICK_MS && now - meta.lastAt < SECOND_CLICK_TO_EDIT_MS) {
                    meta.stage = 'idle';
                    meta.lastAt = 0;
                    clickMetaRef.current[node.id] = meta;
                    setEditingId(node.id);
                    requestAnimationFrame(() => {
                      const el = document.querySelector<HTMLTextAreaElement>(
                        `textarea.node-text[data-node-id="${node.id}"]`,
                      );
                      if (!el) return;
                      el.focus();
                      const len = el.value.length;
                      el.setSelectionRange(len, len);
                    });
                    return;
                  }

                  // 第一次单击：只聚焦输入框，不全选，不进入输入状态
                  meta.stage = 'focused';
                  meta.lastAt = now;
                  clickMetaRef.current[node.id] = meta;
                  setEditingId(null);
                  textarea.focus();
                  {
                    const len = textarea.value.length;
                    textarea.setSelectionRange(len, len);
                  }
                }}
                onClick={(e) => {
                  // 防止触发外层 node/canvas 的点击逻辑
                  e.stopPropagation();
                }}
                onDragStart={(e) => {
                  const textarea = e.target as HTMLTextAreaElement;
                  if (document.activeElement === textarea && textarea.selectionStart !== textarea.selectionEnd) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  if (node.id !== rootId) {
                    handleNodeDragStart(e, node.id);
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDragEnd={(e) => {
                  e.stopPropagation();
                  handleNodeDragEnd(e);
                }}
                onFocus={(e) => {
                  e.stopPropagation();
                  setSelectedIdsSafe(new Set([node.id]));
                  setSelected(node.id);
                }}
                onBlur={() => {
                  // 只在“当前编辑节点”失焦时退出编辑态
                  // 避免 Tab/Enter 新建节点时：旧节点 blur 把 editingId 清空，导致新节点又变回只读
                  if (suppressBlurClearRef.current) return;
                  setEditingId((cur) => (cur === node.id ? null : cur));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    // Ctrl/Cmd + Enter：在文本中换行（仅编辑态生效）
                    if (editingId !== node.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const textarea = e.target as HTMLTextAreaElement;
                    const start = textarea.selectionStart ?? node.title.length;
                    const end = textarea.selectionEnd ?? node.title.length;
                    const nextValue = `${node.title.slice(0, start)}\n${node.title.slice(end)}`;
                    updateTitle(node.id, nextValue);
                    // 恢复光标位置到换行后
                    setTimeout(() => {
                      textarea.focus();
                      textarea.selectionStart = textarea.selectionEnd = start + 1;
                    }, 0);
                    return;
                  }

                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    const textarea = e.target as HTMLTextAreaElement;
                    textarea.blur();
                    setSelectedIdsSafe(new Set([node.id]));
                    setSelected(node.id);
                    setEditingId(null);
                  }
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

