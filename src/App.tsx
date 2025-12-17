import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderMeta, MapMeta, MindNode } from './types';
import { createInitialState, exportData, useMindMap } from './hooks/useMindMap';
import { calculateNodeDimensions } from './utils/textMeasure';

type PositionMap = Record<string, { x: number; y: number; depth: number; width: number; height: number }>;
type NodeInfo = {
  width: number;
  height: number;
  treeHeight: number; // Total height of the subtree including this node
};

const HORIZONTAL_GAP = 50;
const VERTICAL_GAP = 20;

const computeLayout = (nodes: Record<string, MindNode>, rootId: string) => {
  const positions: PositionMap = {};
  const nodeInfo: Record<string, NodeInfo> = {};

  // Step 1: Pre-calculation (Post-order traversal)
  // Calculate width, height, and treeHeight for every node
  const calculateNodeInfo = (id: string): number => {
    const node = nodes[id];
    if (!node) return 0;

    // Calculate dimensions based on text content
    const dims = calculateNodeDimensions(node.title);
    const width = dims.width;
    const height = dims.height; // Fixed 40px

    // Calculate treeHeight
    const visibleChildren = node.collapsed ? [] : node.children;
    let treeHeight: number;

    if (visibleChildren.length === 0) {
      // Leaf node: treeHeight = node.height
      treeHeight = height;
    } else {
      // Node with children: sum of child treeHeights + gaps
      let totalChildHeight = 0;
      visibleChildren.forEach((childId) => {
        totalChildHeight += calculateNodeInfo(childId);
      });
      // Add gaps between children: (children.length - 1) * VERTICAL_GAP
      treeHeight = totalChildHeight + (visibleChildren.length - 1) * VERTICAL_GAP;
      // Ensure treeHeight is at least the node's own height
      treeHeight = Math.max(treeHeight, height);
    }

    nodeInfo[id] = { width, height, treeHeight };
    return treeHeight;
  };

  // Start post-order traversal from root
  calculateNodeInfo(rootId);

  // Step 2: Main Layout (Pre-order traversal)
  // Set x and y coordinates for every node
  const setCoordinates = (
    id: string,
    parentX: number,
    parentWidth: number,
    parentCenterY: number,
  ): void => {
    const node = nodes[id];
    if (!node) return;

    const info = nodeInfo[id];
    if (!info) return;

    // Set X: node.x = parent.x + parent.width + HORIZONTAL_GAP
    // For root: parentX = 0, parentWidth = 0, so root.x = 0
    const x = parentX + parentWidth + (id === rootId ? 0 : HORIZONTAL_GAP);

    // Set Y: Parent should be vertically centered relative to its children
    const visibleChildren = node.collapsed ? [] : node.children;
    let y: number;

    if (visibleChildren.length === 0) {
      // Leaf node: use parent's center Y
      y = parentCenterY - info.height / 2;
    } else {
      // Parent node: calculate children positions first, then center parent
      // Start placing children from the top of the subtree
      let currentChildY = parentCenterY - info.treeHeight / 2;
      const childYPositions: number[] = [];

      visibleChildren.forEach((childId) => {
        const childInfo = nodeInfo[childId];
        if (!childInfo) return;

        // Place child so its center is at currentChildY + child.treeHeight / 2
        const childCenterY = currentChildY + childInfo.treeHeight / 2;
        const childY = childCenterY - childInfo.height / 2;
        childYPositions.push(childY);

        // Recurse for the child
        setCoordinates(childId, x, info.width, childCenterY);

        // Update currentChildY for next child
        currentChildY += childInfo.treeHeight + VERTICAL_GAP;
      });

      // Center parent vertically relative to its children
      if (childYPositions.length > 0) {
        const firstChildY = childYPositions[0];
        const lastChildY = childYPositions[childYPositions.length - 1];
        const lastChildInfo = nodeInfo[visibleChildren[visibleChildren.length - 1]];
        const childrenCenterY = (firstChildY + lastChildY + lastChildInfo.height) / 2;
        y = childrenCenterY - info.height / 2;
      } else {
        y = parentCenterY - info.height / 2;
      }
    }

    positions[id] = { x, y, depth: 0, width: info.width, height: info.height };
  };

  // Start pre-order traversal from root
  // Root starts at (0, 0), but we'll adjust Y based on its children
  const rootInfo = nodeInfo[rootId];
  if (rootInfo) {
    const rootNode = nodes[rootId];
    const visibleChildren = rootNode?.collapsed ? [] : rootNode?.children || [];
    
    if (visibleChildren.length === 0) {
      // Root has no children, place it at (0, 0)
      positions[rootId] = {
        x: 0,
        y: 0,
        depth: 0,
        width: rootInfo.width,
        height: rootInfo.height,
      };
    } else {
      // Root has children, center it vertically at y = 0
      setCoordinates(rootId, 0, 0, 0);
    }
  }

  return positions;
};

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [maps, setMaps] = useState<MapMeta[]>([
    { id: 'default', name: '默认导图', folderId: null, updatedAt: Date.now() },
  ]);
  const [mapStates, setMapStates] = useState<Record<string, ReturnType<typeof createInitialState>>>({
    default: createInitialState(),
  });
  const [currentMapId, setCurrentMapId] = useState('default');
  const isPanning = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const draggingNodeId = useRef<string | null>(null);
  const dragOverNodeId = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const isSelecting = useRef(false);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const canvasShellRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
    importData,
    reset,
    setPriority,
    setProgress,
    moveNode,
    moveUp,
    moveDown,
    copyNode,
    pasteNode,
  } = useMindMap();

  const layout = useMemo(() => computeLayout(nodes, rootId), [nodes, rootId]);

  // 同步 selectedId 和 selectedIds（当 selectedId 从外部改变时）
  useEffect(() => {
    if (selectedId) {
      setSelectedIds((prev) => {
        // 如果 selectedId 已经在 selectedIds 中，保持当前状态
        // 否则，如果 selectedIds 为空或者是单选，则更新为只包含 selectedId
        if (prev.has(selectedId)) {
          return prev;
        }
        // 如果是从外部设置（比如通过其他功能），则替换为单选
        return new Set([selectedId]);
      });
    } else {
      setSelectedIds(new Set());
    }
  }, [selectedId]);

  const handleWheel = (e: React.WheelEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const next = Math.min(2, Math.max(0.3, scale - e.deltaY * 0.001));
      setScale(next);
    } else {
      pan(-e.deltaX, -e.deltaY);
    }
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.node')) return; // 如果点在节点上，不触发平移或框选
    
    const canvasShell = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const startX = e.clientX - canvasShell.left;
    const startY = e.clientY - canvasShell.top;
    
    isSelecting.current = true;
    selectionStart.current = { x: startX, y: startY };
    setSelectionBox({ startX, startY, endX: startX, endY: startY });
    // 开始框选时不清空多选，等框选结束再更新
    isPanning.current = false;
    lastPoint.current = null;
  };

  const movePan = (e: React.PointerEvent) => {
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
      return;
    }
    
    if (!isPanning.current || !lastPoint.current) return;
    const dx = e.clientX - lastPoint.current.x;
    const dy = e.clientY - lastPoint.current.y;
    pan(dx, dy);
    lastPoint.current = { x: e.clientX, y: e.clientY };
  };

  const endPan = (e?: React.PointerEvent) => {
    if (isSelecting.current && selectionStart.current && selectionBox) {
      // 计算选择框内的节点
      const canvasShell = canvasShellRef.current?.getBoundingClientRect();
      
      if (canvasShell) {
        const minX = Math.min(selectionBox.startX, selectionBox.endX);
        const maxX = Math.max(selectionBox.startX, selectionBox.endX);
        const minY = Math.min(selectionBox.startY, selectionBox.endY);
        const maxY = Math.max(selectionBox.startY, selectionBox.endY);
        
        // 将屏幕坐标转换为画布坐标
        const boxLeft = (minX - offset.x) / scale;
        const boxRight = (maxX - offset.x) / scale;
        const boxTop = (minY - offset.y) / scale;
        const boxBottom = (maxY - offset.y) / scale;
        
        // 找到在选择框内的节点
        const selectedNodes: string[] = [];
        visibleNodes.forEach((node) => {
          const pos = positions[node.id];
          if (!pos) return;
          
          const nodeLeft = pos.x;
          const nodeRight = pos.x + pos.width;
          const nodeTop = pos.y;
          const nodeBottom = pos.y + pos.height;
          
          // 检查节点是否在选择框内（有重叠即可）
          if (
            nodeRight >= boxLeft &&
            nodeLeft <= boxRight &&
            nodeBottom >= boxTop &&
            nodeTop <= boxBottom
          ) {
            selectedNodes.push(node.id);
          }
        });
        
        // 选中框内的所有节点
        if (selectedNodes.length > 0) {
          setSelectedIds(new Set(selectedNodes));
          // 保持最后一个作为主选中项（用于兼容现有功能）
          setSelected(selectedNodes[selectedNodes.length - 1]);
        } else {
          // 如果没有选中任何节点，清空多选
          setSelectedIds(new Set());
          setSelected(null);
        }
      }
      
      isSelecting.current = false;
      selectionStart.current = null;
      setSelectionBox(null);
    }
    
    isPanning.current = false;
    lastPoint.current = null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 如果正在输入框中输入，只处理删除和 Ctrl/Cmd 快捷键
      const isInInput = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // 如果正在输入框中，且不是空内容，不处理删除节点
        if (isInInput && (e.target as HTMLTextAreaElement | HTMLInputElement).value.length > 0) {
          return;
        }
        // 批量删除选中的节点
        if (selectedIds.size > 1) {
          const idsToDelete = Array.from(selectedIds).filter(id => id !== rootId);
          if (idsToDelete.length > 0) {
            e.preventDefault();
            idsToDelete.forEach(id => removeNode(id));
            setSelectedIds(new Set());
            setSelected(null);
          }
        } else if (selectedId && selectedId !== rootId) {
          e.preventDefault();
          removeNode(selectedId);
        }
        return;
      }
      
      // 如果正在输入框中，只处理 Ctrl/Cmd 快捷键
      if (isInInput && !(e.metaKey || e.ctrlKey)) {
        return;
      }
      
      // 确定当前操作的目标节点ID
      const targetId = selectedIds.size > 1 
        ? Array.from(selectedIds)[selectedIds.size - 1] 
        : selectedId;
      
      if (!targetId) return;
      
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        copyNode(targetId);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        e.preventDefault();
        pasteNode(targetId);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        addChild(targetId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        addSibling(targetId);
      } else if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addChild, addSibling, removeNode, rootId, selectedId, selectedIds, copyNode, pasteNode]);

  const handleNodeDragStart = (e: React.DragEvent, nodeId: string) => {
    if (nodeId === rootId) return; // 不能拖拽根节点
    e.dataTransfer.effectAllowed = 'move';
    draggingNodeId.current = nodeId;
    // 如果当前节点在多选中，保持多选状态；否则单选
    if (!selectedIds.has(nodeId)) {
      setSelectedIds(new Set([nodeId]));
      setSelected(nodeId);
    }
  };

  const handleNodeDragOver = (e: React.DragEvent, nodeId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggingNodeId.current && draggingNodeId.current !== nodeId) {
      dragOverNodeId.current = nodeId;
    }
  };

  const handleNodeDragEnd = () => {
    if (draggingNodeId.current && dragOverNodeId.current) {
      const draggedId = draggingNodeId.current;
      const targetId = dragOverNodeId.current;
      
      // 如果拖拽的节点在多选中，批量移动所有选中的节点
      if (selectedIds.has(draggedId) && selectedIds.size > 1) {
        const idsToMove = Array.from(selectedIds).filter(id => id !== rootId && id !== targetId);
        idsToMove.forEach(id => {
          // 检查不能移动到自己的子节点
          const node = nodes[id];
          if (node) {
            const isDescendant = (checkId: string, ancestorId: string): boolean => {
              const n = nodes[checkId];
              if (!n || !n.parentId) return false;
              if (n.parentId === ancestorId) return true;
              return isDescendant(n.parentId, ancestorId);
            };
            if (!isDescendant(targetId, id)) {
              moveNode(id, targetId);
            }
          }
        });
      } else {
        moveNode(draggedId, targetId);
      }
    }
    draggingNodeId.current = null;
    dragOverNodeId.current = null;
  };

  const handleContextMenu = (e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
    setSelected(nodeId);
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        importData(data);
      } catch (err) {
        console.error('Invalid JSON', err);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  useEffect(() => {
    setMapStates((prev) => ({
      ...prev,
      [currentMapId]: { nodes, rootId, selectedId, scale, offset },
    }));
    setMaps((prev) =>
      prev.map((m) =>
        m.id === currentMapId
          ? {
              ...m,
              updatedAt: Date.now(),
            }
          : m,
      ),
    );
  }, [currentMapId, nodes, rootId, selectedId, scale, offset]);

  const handleCreateFolder = () => {
    const name = window.prompt('新建文件夹名称');
    if (!name) return;
    setFolders((prev) => [...prev, { id: crypto.randomUUID(), name, parentId: null }]);
  };

  const handleCreateMap = (folderId: string | null) => {
    const name = window.prompt('新建导图名称');
    if (!name) return;
    const id = crypto.randomUUID();
    const nextState = createInitialState();
    setMaps((prev) => [...prev, { id, name, folderId, updatedAt: Date.now() }]);
    setMapStates((prev) => ({ ...prev, [id]: nextState }));
    setCurrentMapId(id);
    importData(nextState);
  };

  const handleSwitchMap = (id: string) => {
    const next = mapStates[id];
    if (!next) return;
    setCurrentMapId(id);
    importData(next);
  };

  const positions = layout;
  const allNodes = Object.values(nodes);

  const isVisible = (id: string): boolean => {
    const node = nodes[id];
    if (!node) return false;
    if (!node.parentId) return true;
    const parent = nodes[node.parentId];
    if (parent?.collapsed) return false;
    return isVisible(parent.id);
  };

  const visibleNodes = allNodes.filter((n) => isVisible(n.id));

  return (
    <div className="app">
      <div className="toolbar">
        <div className="title">轻量思维导图</div>
        <span className="badge">MVP</span>
        <div style={{ flex: 1 }} />
        <button className="button" onClick={() => selectedId && addChild(selectedId)}>
          子节点 (Tab)
        </button>
        <button className="button" onClick={() => selectedId && addSibling(selectedId)}>
          同级 (Enter)
        </button>
        <button
          className="button"
          onClick={() => {
            if (selectedIds.size > 0) {
              const idsToDelete = Array.from(selectedIds).filter(id => id !== rootId);
              idsToDelete.forEach(id => removeNode(id));
              setSelectedIds(new Set());
              setSelected(null);
            } else if (selectedId && selectedId !== rootId) {
              removeNode(selectedId);
            }
          }}
          disabled={(selectedIds.size === 0 && (!selectedId || selectedId === rootId)) || (selectedIds.size > 0 && selectedIds.size === 1 && selectedIds.has(rootId))}
        >
          删除 (Del)
        </button>
        <button className="button" onClick={() => setScale(Math.min(2, scale + 0.1))}>
          放大
        </button>
        <button className="button" onClick={() => setScale(Math.max(0.3, scale - 0.1))}>
          缩小
        </button>
        <button className="button" onClick={reset}>
          复位
        </button>
        <button className="button" onClick={() => exportData({ nodes, rootId, selectedId, scale, offset })}>
          导出 JSON
        </button>
        <button className="button" onClick={() => fileInputRef.current?.click()}>
          导入 JSON
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
        {selectedId && (
          <div className="priority-group">
            <div className="priority-label">优先级</div>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                className={`pill ${nodes[selectedId]?.priority === n ? 'active' : ''}`}
                onClick={() => setPriority(selectedId, nodes[selectedId]?.priority === n ? null : n)}
              >
                {n}
              </button>
            ))}
            <button className="pill" onClick={() => setPriority(selectedId, null)}>
              ×
            </button>
            <div className="priority-label">进度</div>
            {(['none', 'q1', 'q2', 'q3', 'done'] as const).map((p) => (
              <button
                key={p}
                className={`progress ${p} ${nodes[selectedId]?.progress === p ? 'active' : ''}`}
                onClick={() => setProgress(selectedId, nodes[selectedId]?.progress === p ? 'none' : p)}
                title={p}
              />
            ))}
          </div>
        )}
      </div>

      <div className="main">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="sidebar-title">文件</div>
            <div className="sidebar-actions">
              <button className="icon-btn" onClick={handleCreateFolder} title="新建文件夹">
                📁+
              </button>
              <button className="icon-btn" onClick={() => handleCreateMap(null)} title="新建导图">
                🗺️+
              </button>
            </div>
          </div>
          <div className="folder-section">
            <div className="folder-row">
              <span>根目录</span>
              <button className="link-btn" onClick={() => handleCreateMap(null)}>
                新建导图
              </button>
            </div>
            {maps
              .filter((m) => m.folderId === null)
              .map((m) => (
                <div
                  key={m.id}
                  className={`map-row ${currentMapId === m.id ? 'active' : ''}`}
                  onClick={() => handleSwitchMap(m.id)}
                >
                  <div className="map-name">{m.name}</div>
                  <div className="map-meta">{new Date(m.updatedAt).toLocaleDateString()}</div>
                </div>
              ))}
          </div>
          {folders.map((folder) => (
            <div key={folder.id} className="folder-section">
              <div className="folder-row">
                <span>📁 {folder.name}</span>
                <div>
                  <button className="link-btn" onClick={() => handleCreateMap(folder.id)}>
                    新建导图
                  </button>
                </div>
              </div>
              {maps
                .filter((m) => m.folderId === folder.id)
                .map((m) => (
                  <div
                    key={m.id}
                    className={`map-row ${currentMapId === m.id ? 'active' : ''}`}
                    onClick={() => handleSwitchMap(m.id)}
                  >
                    <div className="map-name">{m.name}</div>
                    <div className="map-meta">{new Date(m.updatedAt).toLocaleDateString()}</div>
                  </div>
                ))}
            </div>
          ))}
        </aside>

        <div
          ref={canvasShellRef}
          className="canvas-shell"
          onWheel={handleWheel}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerLeave={endPan}
        >
          <svg
            className="canvas"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          >
            {visibleNodes.map((node) => {
              if (!node.parentId) return null;
              const parentPos = positions[node.parentId];
              const childPos = positions[node.id];
              if (!parentPos || !childPos) return null;

              // Start Point: parent.x + parent.width, parent.y + parent.height / 2
              const startX = parentPos.x + parentPos.width;
              const startY = parentPos.y + parentPos.height / 2;

              // End Point: child.x, child.y + child.height / 2
              const endX = childPos.x;
              const endY = childPos.y + childPos.height / 2;

              // Control Points:
              // CP1: start.x + horizontal_gap / 2, start.y
              // CP2: end.x - horizontal_gap / 2, end.y
              const cp1x = startX + HORIZONTAL_GAP / 2;
              const cp1y = startY;
              const cp2x = endX - HORIZONTAL_GAP / 2;
              const cp2y = endY;

              const d = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;

              return (
                <path
                  key={`${node.id}-line`}
                  d={d}
                  fill="none"
                  stroke="#c5d3ff"
                  strokeWidth={4}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>

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
              const isDragging = draggingNodeId.current === node.id;
              const isDragOver = dragOverNodeId.current === node.id;
              const nodeWidth = pos.width || 140;
              const nodeHeight = pos.height || 40;
              const hasChildren = node.children.length > 0;
              
              return (
                <React.Fragment key={node.id}>
                  <div
                    className={`node ${selectedIds.has(node.id) ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                    style={{
                      transform: `translate(${pos.x}px, ${pos.y}px)`,
                      transformOrigin: 'top left',
                      width: `${nodeWidth}px`,
                      height: `${nodeHeight}px`,
                    }}
                    draggable={node.id !== rootId}
                    onDragStart={(e) => handleNodeDragStart(e, node.id)}
                    onDragOver={(e) => handleNodeDragOver(e, node.id)}
                    onDragEnd={handleNodeDragEnd}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
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
                        setSelectedIds(new Set([node.id]));
                        setSelected(node.id);
                      }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, node.id)}
                  >
                    {node.priority && node.priority >= 1 && node.priority <= 4 && (
                      <span className={`priority-badge priority-${node.priority}`}>
                        {node.priority}
                      </span>
                    )}
                    <textarea
                      className="node-text"
                      value={node.title}
                      onChange={(e) => updateTitle(node.id, e.target.value)}
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
                          setSelectedIds(new Set([node.id]));
                          setSelected(node.id);
                        }
                      }}
                      onFocus={(e) => {
                        e.stopPropagation();
                        setSelectedIds(new Set([node.id]));
                        setSelected(node.id);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const target = e.target as HTMLTextAreaElement;
                        target.select();
                      }}
                      rows={1}
                      style={{
                        width: '100%',
                        height: '100%',
                        textAlign: 'center',
                        lineHeight: `${nodeHeight}px`,
                        paddingLeft: node.priority && node.priority >= 1 && node.priority <= 4 ? '28px' : '20px',
                        paddingRight: node.priority && node.priority >= 5 ? '28px' : '20px',
                      }}
                    />
                    {node.priority && node.priority >= 5 && (
                      <span className={`priority-badge priority-${node.priority}`}>
                        {node.priority}
                      </span>
                    )}
                  </div>
                  {hasChildren && (
                    <button
                      className="collapse-btn-external"
                      style={{
                        position: 'absolute',
                        left: `${pos.x + nodeWidth + 10}px`,
                        top: `${pos.y + nodeHeight / 2}px`,
                        transform: 'translate(-50%, -50%)',
                        transformOrigin: 'center',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapse(node.id);
                      }}
                    >
                      {node.collapsed ? '+' : '−'}
                    </button>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          <div className="minimap">
            <MiniMap positions={positions} nodes={nodes} />
          </div>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          onClose={closeContextMenu}
          onAddChild={() => {
            addChild(contextMenu.nodeId);
            closeContextMenu();
          }}
          onAddSibling={() => {
            addSibling(contextMenu.nodeId);
            closeContextMenu();
          }}
          onDelete={() => {
            if (contextMenu.nodeId !== rootId) {
              removeNode(contextMenu.nodeId);
            }
            closeContextMenu();
          }}
          onCopy={() => {
            copyNode(contextMenu.nodeId);
            closeContextMenu();
          }}
          onPaste={() => {
            pasteNode(contextMenu.nodeId);
            closeContextMenu();
          }}
          onMoveUp={() => {
            moveUp(contextMenu.nodeId);
            closeContextMenu();
          }}
          onMoveDown={() => {
            moveDown(contextMenu.nodeId);
            closeContextMenu();
          }}
          canDelete={contextMenu.nodeId !== rootId}
          hasClipboard={!!(window as any).__mindmapClipboard}
        />
      )}
    </div>
  );
}

function ContextMenu({
  x,
  y,
  nodeId,
  onClose,
  onAddChild,
  onAddSibling,
  onDelete,
  onCopy,
  onPaste,
  onMoveUp,
  onMoveDown,
  canDelete,
  hasClipboard,
}: {
  x: number;
  y: number;
  nodeId: string;
  onClose: () => void;
  onAddChild: () => void;
  onAddSibling: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canDelete: boolean;
  hasClipboard: boolean;
}) {
  useEffect(() => {
    const handleClick = () => onClose();
    const handleContextMenu = () => onClose();
    window.addEventListener('click', handleClick);
    window.addEventListener('contextmenu', handleContextMenu);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="context-menu-item" onClick={onAddChild}>
        <span>📝</span> 插入子主题
      </button>
      <button className="context-menu-item" onClick={onAddSibling}>
        <span>➕</span> 插入同级主题
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={onCopy}>
        <span>📋</span> 复制 (Ctrl+C)
      </button>
      <button className="context-menu-item" onClick={onPaste} disabled={!hasClipboard}>
        <span>📄</span> 粘贴 (Ctrl+V)
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={onMoveUp}>
        <span>⬆️</span> 上移
      </button>
      <button className="context-menu-item" onClick={onMoveDown}>
        <span>⬇️</span> 下移
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item danger" onClick={onDelete} disabled={!canDelete}>
        <span>🗑️</span> 删除
      </button>
    </div>
  );
}

function MiniMap({ positions, nodes }: { positions: PositionMap; nodes: Record<string, MindNode> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const xs = Object.values(positions).map((p) => p.x);
    const ys = Object.values(positions).map((p) => p.y);
    const minX = Math.min(...xs, 0);
    const maxX = Math.max(...xs, 1);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 1);
    const scaleX = canvas.width / (maxX - minX + 1);
    const scaleY = canvas.height / (maxY - minY + 1);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    Object.values(nodes).forEach((node) => {
      if (node.parentId) {
        const a = positions[node.parentId];
        const b = positions[node.id];
        if (a && b) {
          ctx.beginPath();
          ctx.moveTo((a.x - minX) * scaleX, (a.y - minY) * scaleY);
          ctx.lineTo((b.x - minX) * scaleX, (b.y - minY) * scaleY);
          ctx.stroke();
        }
      }
    });
    ctx.fillStyle = '#4f46e5';
    Object.values(positions).forEach((p) => {
      ctx.beginPath();
      ctx.arc((p.x - minX) * scaleX, (p.y - minY) * scaleY, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [nodes, positions]);

  return <canvas ref={canvasRef} width={180} height={120} />;
}

export default App;

