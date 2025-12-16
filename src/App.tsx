import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderMeta, MapMeta, MindNode } from './types';
import { createInitialState, exportData, useMindMap } from './hooks/useMindMap';

type PositionMap = Record<string, { x: number; y: number; depth: number }>;

const H_SPACING = 260;
const V_SPACING = 130;
const NODE_WIDTH = 220;
const NODE_HEIGHT = 56;

const computeLayout = (nodes: Record<string, MindNode>, rootId: string) => {
  const positions: PositionMap = {};

  const dfs = (id: string, depth: number, y: number): number => {
    const node = nodes[id];
    if (!node) return 0;
    const visibleChildren = node.collapsed ? [] : node.children;
    if (visibleChildren.length === 0) {
      positions[id] = { x: depth * H_SPACING, y, depth };
      return V_SPACING;
    }
    let currentY = y;
    let totalHeight = 0;
    visibleChildren.forEach((childId) => {
      const h = dfs(childId, depth + 1, currentY);
      currentY += h;
      totalHeight += h;
    });
    const firstY = positions[visibleChildren[0]].y;
    const lastY = positions[visibleChildren[visibleChildren.length - 1]].y;
    const centerY = (firstY + lastY) / 2;
    positions[id] = { x: depth * H_SPACING, y: centerY, depth };
    return Math.max(totalHeight, V_SPACING);
  };

  dfs(rootId, 0, 0);
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
  } = useMindMap();

  const layout = useMemo(() => computeLayout(nodes, rootId), [nodes, rootId]);

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
    isPanning.current = true;
    lastPoint.current = { x: e.clientX, y: e.clientY };
  };

  const movePan = (e: React.PointerEvent) => {
    if (!isPanning.current || !lastPoint.current) return;
    const dx = e.clientX - lastPoint.current.x;
    const dy = e.clientY - lastPoint.current.y;
    pan(dx, dy);
    lastPoint.current = { x: e.clientX, y: e.clientY };
  };

  const endPan = () => {
    isPanning.current = false;
    lastPoint.current = null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        addChild(selectedId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        addSibling(selectedId);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedId !== rootId) {
          e.preventDefault();
          removeNode(selectedId);
        }
      } else if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addChild, addSibling, removeNode, rootId, selectedId]);

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
          onClick={() => selectedId && selectedId !== rootId && removeNode(selectedId)}
          disabled={!selectedId || selectedId === rootId}
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

              // 从父节点右侧中点 -> 子节点左侧中点
              const startX = parentPos.x + NODE_WIDTH;
              const startY = parentPos.y + NODE_HEIGHT / 2;
              const endX = childPos.x;
              const endY = childPos.y + NODE_HEIGHT / 2;

              const dx = endX - startX;
              const c1x = startX + dx * 0.3;
              const c2x = startX + dx * 0.9;
              const d = `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;

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

          {visibleNodes.map((node) => {
            const pos = positions[node.id] ?? { x: 0, y: 0, depth: 0 };
            return (
              <div
                key={node.id}
                className={`node ${selectedId === node.id ? 'selected' : ''}`}
                style={{
                  transform: `translate(${offset.x + pos.x * scale}px, ${
                    offset.y + pos.y * scale
                  }px) scale(${scale})`,
                  transformOrigin: 'top left',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(node.id);
                }}
              >
                <div className="node-header">
                {node.children.length > 0 && (
                  <button
                    className="collapse-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(node.id);
                    }}
                  >
                    {node.collapsed ? '+' : '−'}
                  </button>
                )}
                <span className="node-dot" />
                  <textarea
                    value={node.title}
                    onChange={(e) => updateTitle(node.id, e.target.value)}
                    rows={1}
                  />
                {node.priority && (
                  <span className="priority-badge">{node.priority}</span>
                )}
                </div>
                {node.children.length > 0 && (
                  <div className="node-meta">
                    {node.collapsed ? '已折叠' : `${node.children.length} 个子节点`}
                  </div>
                )}
              </div>
            );
          })}

          <div className="minimap">
            <MiniMap positions={positions} nodes={nodes} />
          </div>
        </div>
      </div>
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

