import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DocumentMeta,
  FlowchartMeta,
  FolderMeta,
  HandwritingDocumentData,
  MapMeta,
  MindNode,
  StoredUser,
  User,
  UserData,
} from './types';
import { createInitialState, exportData, useMindMap } from './hooks/useMindMap';
import { calculateNodeDimensions } from './utils/textMeasure';
import HandwritingEditor, { normalizeHandwritingData } from './components/HandwritingEditor';
import FlowchartEditor from './components/FlowchartEditor';
import { exportFlowchartAsPng, exportMindmapAsPng } from './utils/exportImage';
import { apiGetUserData, apiLogin, apiMe, apiPutUserData, apiRegister, setToken } from './utils/api';

type PositionMap = Record<string, { x: number; y: number; depth: number; width: number; height: number }>;
type NodeInfo = {
  width: number;
  height: number;
  treeHeight: number; // Total height of the subtree including this node
};

// Mindmap spacing (match dark UI reference)
const HORIZONTAL_GAP = 90;
const VERTICAL_GAP = 28;
const FLOWCHART_HORIZONTAL_GAP = 30;
const FLOWCHART_VERTICAL_GAP = 50;

const getNodeUiByDepth = (depth: number) => {
  if (depth <= 0) return { fontSize: 36, height: 82, paddingX: 44 };
  if (depth === 1) return { fontSize: 22, height: 56, paddingX: 32 };
  // 三级及以后：更像“注释文本”，尺寸更小（且无背景色在 CSS 中处理）
  return { fontSize: 21, height: 46, paddingX: 10 };
};

// 流程图布局算法（从上到下）
const computeFlowchartLayout = (nodes: Record<string, MindNode>, rootId: string) => {
  const positions: PositionMap = {};
  const nodeInfo: Record<string, NodeInfo> = {};

  // Step 1: Pre-calculation (Post-order traversal)
  const calculateNodeInfo = (id: string): number => {
    const node = nodes[id];
    if (!node) return 0;

    const dims = calculateNodeDimensions(node.title);
    const hasProgress = !!node.progress && node.progress !== 'none';
    const hasPriority = !!node.priority && node.priority >= 1 && node.priority <= 4;
    const badgeReserve =
      (hasProgress ? 18 : 0) +
      (hasPriority ? (hasProgress ? 6 : 0) + 22 : 0);
    const width = dims.width + (hasProgress || hasPriority ? badgeReserve : 0);
    const height = dims.height;

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

  // Step 2: Main Layout (Pre-order traversal) - 从上到下
  const setCoordinates = (
    id: string,
    parentY: number,
    parentHeight: number,
    parentCenterX: number,
  ): void => {
    const node = nodes[id];
    if (!node) return;

    const info = nodeInfo[id];
    if (!info) return;

    // Set Y: node.y = parent.y + parent.height + FLOWCHART_VERTICAL_GAP
    const y = parentY + parentHeight + (id === rootId ? 0 : FLOWCHART_VERTICAL_GAP);

    // Set X: 水平居中
    const visibleChildren = node.collapsed ? [] : node.children;
    let x: number;

    if (visibleChildren.length === 0) {
      // 叶子节点：使用父节点的中心X
      x = parentCenterX - info.width / 2;
    } else {
      // 父节点：先计算子节点位置，然后居中父节点
      let currentChildX = parentCenterX - info.treeHeight / 2;
      const childXPositions: number[] = [];

      visibleChildren.forEach((childId) => {
        const childInfo = nodeInfo[childId];
        if (!childInfo) return;

        const childCenterX = currentChildX + childInfo.treeHeight / 2;
        const childX = childCenterX - childInfo.width / 2;
        childXPositions.push(childX);

        setCoordinates(childId, y, info.height, childCenterX);

        currentChildX += childInfo.treeHeight + FLOWCHART_HORIZONTAL_GAP;
      });

      // 居中父节点
      if (childXPositions.length > 0) {
        const firstChildX = childXPositions[0];
        const lastChildX = childXPositions[childXPositions.length - 1];
        const lastChildInfo = nodeInfo[visibleChildren[visibleChildren.length - 1]];
        const childrenCenterX = (firstChildX + lastChildX + lastChildInfo.width) / 2;
        x = childrenCenterX - info.width / 2;
      } else {
        x = parentCenterX - info.width / 2;
      }
    }

    positions[id] = { x, y, depth: 0, width: info.width, height: info.height };
  };

  // 从根节点开始布局
  const rootInfo = nodeInfo[rootId];
  if (rootInfo) {
    const rootNode = nodes[rootId];
    const visibleChildren = rootNode?.collapsed ? [] : rootNode?.children || [];
    
    if (visibleChildren.length === 0) {
      positions[rootId] = {
        x: 0,
        y: 0,
        depth: 0,
        width: rootInfo.width,
        height: rootInfo.height,
      };
    } else {
      setCoordinates(rootId, 0, 0, 0);
    }
  }

  return positions;
};

const computeLayout = (nodes: Record<string, MindNode>, rootId: string) => {
  const positions: PositionMap = {};
  const nodeInfo: Record<string, NodeInfo> = {};

  // Step 1: Pre-calculation (Post-order traversal)
  // Calculate width, height, and treeHeight for every node
  const calculateNodeInfo = (id: string, depth: number): number => {
    const node = nodes[id];
    if (!node) return 0;

    // Calculate dimensions based on depth style
    const ui = getNodeUiByDepth(depth);
    const dims = calculateNodeDimensions(node.title, ui);
    // Reserve extra space for left badges (progress + priority) to avoid truncation
    const hasProgress = !!node.progress && node.progress !== 'none';
    const hasPriority = !!node.priority && node.priority >= 1 && node.priority <= 4;
    // Reserve minimal space for left badges so text doesn't get clipped
    const badgeReserve =
      (hasProgress ? 18 : 0) + // 16px dot + small gap
      (hasPriority ? (hasProgress ? 6 : 0) + 22 : 0); // pill + optional gap
    const width = dims.width + (hasProgress || hasPriority ? badgeReserve : 0);
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
        totalChildHeight += calculateNodeInfo(childId, depth + 1);
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
  calculateNodeInfo(rootId, 0);

  // Step 2: Main Layout (Pre-order traversal)
  // Set x and y coordinates for every node
  const setCoordinates = (
    id: string,
    parentX: number,
    parentWidth: number,
    parentCenterY: number,
    depth: number,
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
      setCoordinates(childId, x, info.width, childCenterY, depth + 1);

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

    positions[id] = { x, y, depth, width: info.width, height: info.height };
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
      setCoordinates(rootId, 0, 0, 0, 0);
    }
  }

  return positions;
};

// 账号管理工具函数
const STORAGE_KEY_USERS = 'mindmap_users';
const STORAGE_KEY_CURRENT_USER = 'mindmap_current_user'; // legacy
const STORAGE_KEY_CURRENT_USER_ID = 'mindmap_current_user_id';

const textToHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const hashPassword = async (password: string, salt: string): Promise<string> => {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return textToHex(digest);
};

const isValidUsername = (username: string): boolean => /^[a-zA-Z0-9_-]{3,20}$/.test(username);
const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPassword = (password: string): boolean => password.length >= 6;

const saveUsers = (users: StoredUser[]) => {
  localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
};

const getUsers = (): StoredUser[] => {
  const data = localStorage.getItem(STORAGE_KEY_USERS);
  return data ? JSON.parse(data) : [];
};

const saveUserData = (userId: string, data: UserData) => {
  localStorage.setItem(`mindmap_user_data_${userId}`, JSON.stringify(data));
};

const getUserData = (userId: string): UserData | null => {
  const data = localStorage.getItem(`mindmap_user_data_${userId}`);
  return data ? JSON.parse(data) : null;
};

const toPublicUser = (u: StoredUser): User => ({
  id: u.id,
  username: u.username,
  email: u.email,
  createdAt: u.createdAt,
});

const getCurrentUser = (): User | null => {
  // Prefer current user id (new format)
  const id = localStorage.getItem(STORAGE_KEY_CURRENT_USER_ID);
  if (id) {
    const u = getUsers().find((x) => x.id === id);
    return u ? toPublicUser(u) : null;
  }

  // Legacy format: full user object stored
  const legacy = localStorage.getItem(STORAGE_KEY_CURRENT_USER);
  if (!legacy) return null;
  try {
    const u = JSON.parse(legacy) as User;
    if (u?.id) {
      localStorage.setItem(STORAGE_KEY_CURRENT_USER_ID, u.id);
      localStorage.removeItem(STORAGE_KEY_CURRENT_USER);
      return u;
    }
  } catch {
    // ignore
  }
  return null;
};

const setCurrentUser = (user: User | null) => {
  if (user) {
    localStorage.setItem(STORAGE_KEY_CURRENT_USER_ID, user.id);
    localStorage.removeItem(STORAGE_KEY_CURRENT_USER);
  } else {
    localStorage.removeItem(STORAGE_KEY_CURRENT_USER_ID);
    localStorage.removeItem(STORAGE_KEY_CURRENT_USER);
  }
};

function App() {
  // JSON 导入/导出已移除（账号系统下自动保存）
  const [currentUser, setCurrentUserState] = useState<User | null>(null);
  const [authBooting, setAuthBooting] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authUsername, setAuthUsername] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [isUserDataLoaded, setIsUserDataLoaded] = useState(false);
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(false);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [maps, setMaps] = useState<MapMeta[]>([
    { id: 'default', name: '默认导图', folderId: null, updatedAt: Date.now() },
  ]);
  const [mapStates, setMapStates] = useState<Record<string, ReturnType<typeof createInitialState>>>({
    default: createInitialState(),
  });
  const [currentMapId, setCurrentMapId] = useState('default');
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [flowcharts, setFlowcharts] = useState<FlowchartMeta[]>([]);
  const [flowchartStates, setFlowchartStates] = useState<Record<string, ReturnType<typeof createInitialState>>>({});
  const [currentFlowchartId, setCurrentFlowchartId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'mindmap' | 'document' | 'flowchart'>('mindmap');
  const [fileMenu, setFileMenu] = useState<
    | null
    | {
        x: number;
        y: number;
        type: 'map' | 'document' | 'flowchart';
        id: string;
      }
  >(null);
  // folderId: null 表示“默认/根”文件夹
  const [folderContextMenu, setFolderContextMenu] = useState<null | { x: number; y: number; folderId: string | null }>(
    null,
  );
  const [collapsedFolderKeys, setCollapsedFolderKeys] = useState<Set<string>>(() => new Set());
  const [moveDialog, setMoveDialog] = useState<null | { type: 'map' | 'document' | 'flowchart'; id: string }>(null);
  const [moveDialogTarget, setMoveDialogTarget] = useState<string>('root');
  const [defaultFolderName, setDefaultFolderName] = useState<string>('默认');
  const [defaultFolderDeleted, setDefaultFolderDeleted] = useState<boolean>(false);
  const isPanning = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const draggingNodeId = useRef<string | null>(null);
  const dragOverNodeId = useRef<null | { id: string; mode: 'child' | 'after' }>(null);
  const pointerDragStart = useRef<null | { x: number; y: number; nodeId: string }>(null);
  const pointerDragging = useRef(false);
  const suppressClickRef = useRef(false);
  const positionsRef = useRef<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const visibleNodesRef = useRef<MindNode[]>([]);
  const offsetRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const isSelecting = useRef(false);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const canvasShellRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const mindmapClickMetaRef = useRef<Record<string, { lastAt: number; stage: 'idle' | 'focused' | 'selectedAll' }>>(
    {},
  );
  const mindmapArmedEditClickRef = useRef<Record<string, boolean>>({});
  const mindmapPendingNewNodeEditRef = useRef(false);
  const mindmapSuppressBlurClearRef = useRef(false);
  const [mindmapEditingId, setMindmapEditingId] = useState<string | null>(null);
  const saveCloudTimerRef = useRef<number | null>(null);

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
    setFlowchartChildType,
    undo,
    redo,
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

      // Live selection while dragging: select nodes whose CENTER is within the box
      const boxMinX = Math.min(selectionStart.current.x, endX);
      const boxMaxX = Math.max(selectionStart.current.x, endX);
      const boxMinY = Math.min(selectionStart.current.y, endY);
      const boxMaxY = Math.max(selectionStart.current.y, endY);

      const picked: string[] = [];
      // Compare in canvas-shell coordinates directly to avoid transform math bugs
      visibleNodes.forEach((n) => {
        const pos = positions[n.id];
        if (!pos) return;
        const cx = offset.x + (pos.x + pos.width / 2) * scale;
        const cy = offset.y + (pos.y + pos.height / 2) * scale;
        if (cx >= boxMinX && cx <= boxMaxX && cy >= boxMinY && cy <= boxMaxY) picked.push(n.id);
      });
      setSelectedIds(new Set(picked));
      setSelected(picked.length > 0 ? picked[picked.length - 1] : null);
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
        
        // 找到在选择框内的节点
        const selectedNodes: string[] = [];
        visibleNodes.forEach((node) => {
          const pos = positions[node.id];
          if (!pos) return;

          // Use center-point containment to avoid selecting whole horizontal rows
          const cx = offset.x + (pos.x + pos.width / 2) * scale;
          const cy = offset.y + (pos.y + pos.height / 2) * scale;
          if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) selectedNodes.push(node.id);
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
      const inputEl = isInInput ? (e.target as HTMLTextAreaElement | HTMLInputElement) : null;
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
        // 如果正在输入框中
        if (isInInput) {
          const target = e.target as HTMLTextAreaElement;
          // 如果文本框是只读的，删除整个节点
          if (target.readOnly) {
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
          // 否则，让浏览器处理删除键
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
      
      // 如果正在“真正编辑文字”(readOnly=false)：让输入框自己处理（包括复制/粘贴）
      if (isActuallyEditing) return;

      // 如果正在输入框中（但只读状态）：只处理 Ctrl/Cmd 快捷键、Tab 和 Enter 键
      if (isInInput && !(e.metaKey || e.ctrlKey) && e.key !== 'Tab' && e.key !== 'Enter') {
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
        // 导图：Tab 新建子节点后，新节点自动进入编辑并全选
        if (viewMode === 'mindmap') mindmapPendingNewNodeEditRef.current = true;
        addChild(targetId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // 导图：Enter 新建同级后，新节点自动进入编辑并全选
        if (viewMode === 'mindmap') mindmapPendingNewNodeEditRef.current = true;
        addSibling(targetId);
      } else if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addChild, addSibling, removeNode, rootId, selectedId, selectedIds, copyNode, pasteNode, viewMode]);

  // 导图：Tab/Enter 新建节点后，新节点自动 focus + 全选 + 进入编辑态
  useEffect(() => {
    if (viewMode !== 'mindmap') return;
    if (!mindmapPendingNewNodeEditRef.current) return;
    if (!selectedId) return;
    const n = nodes[selectedId];
    if (!n) return;
    if (!(n.title === '新节点' || n.title === '同级节点')) return;

    mindmapPendingNewNodeEditRef.current = false;
    mindmapSuppressBlurClearRef.current = true;
    setMindmapEditingId(selectedId);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>(`textarea.node-text[data-node-id="${selectedId}"]`);
        if (!el) return;
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(0, len);
        // focus 完成后，允许 blur 清空（但仅清当前节点）
        setTimeout(() => {
          mindmapSuppressBlurClearRef.current = false;
        }, 50);
      });
    });
  }, [viewMode, selectedId, nodes]);

  // 关闭文件右键菜单
  useEffect(() => {
    const onClick = () => {
      closeFileMenu();
      setFolderContextMenu(null);
    };
    const onContext = () => {
      closeFileMenu();
      setFolderContextMenu(null);
    };
    window.addEventListener('click', onClick);
    window.addEventListener('contextmenu', onContext);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('contextmenu', onContext);
    };
  }, []);

  const handleNodeDragStart = (e: React.DragEvent, nodeId: string) => {
    if (nodeId === rootId) {
      e.preventDefault();
      return; // 不能拖拽根节点
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // 某些浏览器需要这个
    draggingNodeId.current = nodeId;
    // 如果当前节点在多选中，保持多选状态；否则单选
    if (!selectedIds.has(nodeId)) {
      setSelectedIds(new Set([nodeId]));
    setSelected(nodeId);
    }
    // 清除之前的高亮
    dragOverNodeId.current = null;
  };

  const handleNodeDragOver = (e: React.DragEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (draggingNodeId.current && draggingNodeId.current !== nodeId && nodeId !== rootId) {
      dragOverNodeId.current = { id: nodeId, mode: 'child' };
      // 强制重新渲染以显示高亮
      setSelectedIds((prev) => new Set(prev));
    }
  };

  const handleCanvasDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // 在 canvas 上拖动时，通过鼠标位置查找目标节点
    if (draggingNodeId.current && canvasShellRef.current) {
      const rect = canvasShellRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - offset.x) / scale;
      const y = (e.clientY - rect.top - offset.y) / scale;
      
      // 查找鼠标位置下的节点
      let target: null | { id: string; mode: 'child' | 'after' } = null;
      for (const node of visibleNodes) {
        const pos = positions[node.id];
        if (!pos) continue;
        if (x >= pos.x && x <= pos.x + (pos.width || 140) &&
            y >= pos.y && y <= pos.y + (pos.height || 40)) {
          if (node.id !== draggingNodeId.current && node.id !== rootId) {
            target = { id: node.id, mode: 'child' };
            break;
          }
        }
      }
      
      if (target?.id !== dragOverNodeId.current?.id || target?.mode !== dragOverNodeId.current?.mode) {
        dragOverNodeId.current = target;
        setSelectedIds((prev) => new Set(prev));
      }
    }
  };

  const findDragTarget = (clientX: number, clientY: number): null | { id: string; mode: 'child' | 'after' } => {
    if (!canvasShellRef.current) return null;
    const rect = canvasShellRef.current.getBoundingClientRect();
    const x = (clientX - rect.left - offsetRef.current.x) / scaleRef.current;
    const y = (clientY - rect.top - offsetRef.current.y) / scaleRef.current;
    for (const node of visibleNodesRef.current) {
      const pos = positionsRef.current[node.id];
      if (!pos) continue;
      if (x >= pos.x && x <= pos.x + (pos.width || 140) && y >= pos.y && y <= pos.y + (pos.height || 40)) {
        if (node.id !== draggingNodeId.current && node.id !== rootId) {
          return { id: node.id, mode: 'child' };
        }
      }
    }
    return null;
  };

  const handleNodePointerDown = (e: React.PointerEvent, nodeId: string) => {
    if (nodeId === rootId) return;
    if (mindmapEditingId === nodeId) return;
    pointerDragStart.current = { x: e.clientX, y: e.clientY, nodeId };
    pointerDragging.current = false;
    suppressClickRef.current = false;
    const el = e.currentTarget as HTMLElement;
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
  };

  const handleNodePointerMove = (e: React.PointerEvent) => {
    if (!pointerDragStart.current) return;
    const { x, y, nodeId } = pointerDragStart.current;
    const dx = e.clientX - x;
    const dy = e.clientY - y;
    if (!pointerDragging.current && Math.hypot(dx, dy) < 4) return;
    if (!pointerDragging.current) {
      pointerDragging.current = true;
      draggingNodeId.current = nodeId;
      if (!selectedIds.has(nodeId)) {
        setSelectedIds(new Set([nodeId]));
        setSelected(nodeId);
      }
    }
    const target = findDragTarget(e.clientX, e.clientY);
    if (target?.id !== dragOverNodeId.current?.id || target?.mode !== dragOverNodeId.current?.mode) {
      dragOverNodeId.current = target;
      setSelectedIds((prev) => new Set(prev));
    }
    e.preventDefault();
  };

  const handleNodePointerUp = (e: React.PointerEvent) => {
    if (!pointerDragStart.current) return;
    if (pointerDragging.current) {
      suppressClickRef.current = true;
      handleNodeDragEnd();
    }
    pointerDragStart.current = null;
    pointerDragging.current = false;
    const el = e.currentTarget as HTMLElement;
    if (el.releasePointerCapture) el.releasePointerCapture(e.pointerId);
  };

  const resolveDropTarget = (): null | { targetId: string; mode: 'child' | 'after' } => {
    if (!dragOverNodeId.current) return null;
    return { targetId: dragOverNodeId.current.id, mode: dragOverNodeId.current.mode };
  };

  const handleNodeDragEnd = (e?: React.DragEvent) => {
    const dropTarget = resolveDropTarget();
    const targetId = dropTarget?.targetId ?? null;
    const dropMode = dropTarget?.mode ?? null;
      const draggedId = draggingNodeId.current;
    
    if (draggedId && targetId && dropMode && draggedId !== targetId) {
      const targetNode = nodes[targetId];
      const newParentIdForAfter = targetNode?.parentId ?? null;

      // 如果拖拽的节点在多选中，批量移动所有选中的节点
      if (selectedIds.has(draggedId) && selectedIds.size > 1) {
        const idsToMove = Array.from(selectedIds).filter((id) => id !== rootId && id !== targetId);
        let insertAfterId = targetId;
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
              if (dropMode === 'after') {
                if (!newParentIdForAfter) return;
                moveNode(id, newParentIdForAfter, insertAfterId);
                insertAfterId = id;
              } else {
                moveNode(id, targetId);
              }
            }
          }
        });
      } else {
        // 检查不能移动到自己的子节点
        const isDescendant = (checkId: string, ancestorId: string): boolean => {
          const n = nodes[checkId];
          if (!n || !n.parentId) return false;
          if (n.parentId === ancestorId) return true;
          return isDescendant(n.parentId, ancestorId);
        };
        if (!isDescendant(targetId, draggedId)) {
          if (dropMode === 'after') {
            if (newParentIdForAfter) moveNode(draggedId, newParentIdForAfter, targetId);
          } else {
            moveNode(draggedId, targetId);
          }
    }
      }
    }
    
    draggingNodeId.current = null;
    dragOverNodeId.current = null;
    // 强制重新渲染以清除高亮
    setSelectedIds((prev) => new Set(prev));
  };

  const handleContextMenu = (e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
    setSelected(nodeId);
  };

  const closeContextMenu = () => setContextMenu(null);

  // handleImport 已移除

  // 加载用户数据（云端：从服务端拉取；未完成加载前不允许保存，避免覆盖）
  useEffect(() => {
    let cancelled = false;
    setIsUserDataLoaded(false);
    setCloudSyncEnabled(false);
    if (!currentUser) {
      setIsUserDataLoaded(false);
      setCloudSyncEnabled(false);
      return;
    }

    (async () => {
      try {
        const remote = await apiGetUserData();
        const userData = remote.data;

        if (cancelled) return;

        if (userData) {
          setDefaultFolderName(userData.ui?.defaultFolderName || '默认');
          setDefaultFolderDeleted(!!userData.ui?.defaultFolderDeleted);
          setFolders(userData.folders || []);
          setMaps(userData.maps || []);
          setMapStates(userData.mapStates || {});
          // 兼容旧数据：没有 kind 的文档默认为 text
          const normalizedDocs = (userData.documents || []).map((d: any) => {
            const kind = d.kind ?? (d.handwritingData ? 'handwriting' : 'text');
            const content = typeof d.content === 'string' ? d.content : '';
            const handwritingData = normalizeHandwritingData(d.handwritingData as HandwritingDocumentData | undefined);
            return {
              ...d,
              kind,
              content,
              handwritingData: kind === 'handwriting' ? handwritingData : undefined,
            } as DocumentMeta;
          });
          setDocuments(normalizedDocs);
          setFlowcharts(userData.flowcharts || []);
          setFlowchartStates(userData.flowchartStates || {});

          // 默认打开第一个导图
          if (userData.maps && userData.maps.length > 0) {
            const defaultMap = userData.maps[0];
            setCurrentMapId(defaultMap.id);
            setViewMode('mindmap');
            if (userData.mapStates && userData.mapStates[defaultMap.id]) {
              importData(userData.mapStates[defaultMap.id]);
            }
          } else {
            const defaultState = createInitialState();
            const defaultMap: MapMeta = {
              id: 'default',
              name: '默认导图',
              folderId: null,
              updatedAt: Date.now(),
            };
            setMaps([defaultMap]);
            setMapStates({ default: defaultState });
            setCurrentMapId('default');
            setViewMode('mindmap');
            importData(defaultState);
          }
        } else {
          // 新用户：初始化一份默认数据（并在保存 effect 中写回云端）
          const defaultState = createInitialState();
          const defaultMap: MapMeta = {
            id: 'default',
            name: '默认导图',
            folderId: null,
            updatedAt: Date.now(),
          };
          setFolders([]);
          setMaps([defaultMap]);
          setMapStates({ default: defaultState });
          setDocuments([]);
          setFlowcharts([]);
          setFlowchartStates({});
          setCurrentMapId('default');
          setCurrentDocumentId(null);
          setCurrentFlowchartId(null);
          setViewMode('mindmap');
          importData(defaultState);
          setDefaultFolderName('默认');
          setDefaultFolderDeleted(false);
        }

        if (!cancelled) {
          setCloudSyncEnabled(true);
          setIsUserDataLoaded(true);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          alert('云端数据加载失败，请检查网络或稍后重试');
          setCloudSyncEnabled(false);
          setIsUserDataLoaded(true); // 允许继续使用（但不会同步）
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentUser, importData]);

  // 保存用户数据（云端自动同步：debounce，避免每次小改动都打请求）
  useEffect(() => {
    if (!currentUser || !isUserDataLoaded || !cloudSyncEnabled) return;

    const userData: UserData = {
      folders,
      maps,
      mapStates,
      documents,
      flowcharts,
      flowchartStates,
      ui: { defaultFolderName, defaultFolderDeleted },
    };

    if (saveCloudTimerRef.current) window.clearTimeout(saveCloudTimerRef.current);
    saveCloudTimerRef.current = window.setTimeout(() => {
      apiPutUserData(userData).catch((e) => {
        console.error(e);
        // 不打断使用体验：仅在控制台提示
      });
    }, 600);

    return () => {
      if (saveCloudTimerRef.current) window.clearTimeout(saveCloudTimerRef.current);
    };
  }, [currentUser, isUserDataLoaded, cloudSyncEnabled, folders, maps, mapStates, documents, flowcharts, flowchartStates]);

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

  const renameFolder = (id: string) => {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    const name = window.prompt('重命名文件夹', f.name);
    if (!name) return;
    const nextName = name.trim();
    if (!nextName) return;
    setFolders((prev) => prev.map((x) => (x.id === id ? { ...x, name: nextName } : x)));
  };

  const renameDefaultFolder = () => {
    const name = window.prompt('重命名文件夹', defaultFolderName);
    if (!name) return;
    const next = name.trim();
    if (!next) return;
    setDefaultFolderName(next);
    setDefaultFolderDeleted(false);
  };
  const deleteDefaultFolder = () => {
    const ok = window.confirm('确定删除「默认」文件夹？\n不会删除文件内容，文件仍保留在根目录。');
    if (!ok) return;
    setDefaultFolderDeleted(true);
  };

  const deleteFolder = (id: string) => {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    const ok = window.confirm(`确定删除文件夹「${f.name}」？\n文件不会丢失，都会移动到「默认」文件夹（根目录）。`);
    if (!ok) return;
    // Move all items to root to avoid orphaned folderId
    setMaps((prev) => prev.map((m) => (m.folderId === id ? { ...m, folderId: null, updatedAt: Date.now() } : m)));
    setDocuments((prev) =>
      prev.map((d) => (d.folderId === id ? { ...d, folderId: null, updatedAt: Date.now() } : d)),
    );
    setFlowcharts((prev) =>
      prev.map((c) => (c.folderId === id ? { ...c, folderId: null, updatedAt: Date.now() } : c)),
    );
    setFolders((prev) => prev.filter((x) => x.id !== id));
  };

  const handleCreateMap = (folderId: string | null) => {
    const name = window.prompt('新建导图名称');
    if (!name) return;
    const id = crypto.randomUUID();
    const nextState = createInitialState();
    setMaps((prev) => [...prev, { id, name, folderId, updatedAt: Date.now() }]);
    setMapStates((prev) => ({ ...prev, [id]: nextState }));
    setCurrentMapId(id);
    setViewMode('mindmap');
    importData(nextState);
  };

  const handleSwitchMap = (id: string) => {
    const next = mapStates[id];
    if (!next) return;
    setCurrentMapId(id);
    setViewMode('mindmap');
    setCurrentDocumentId(null);
    importData(next);
  };

  const handleCreateDocument = (folderId: string | null) => {
    const name = window.prompt('新建文档名称');
    if (!name) return;
    const id = crypto.randomUUID();
    const newDoc: DocumentMeta = {
      id,
      name,
      folderId,
      updatedAt: Date.now(),
      kind: 'text',
      content: '',
    };
    setDocuments((prev) => [...prev, newDoc]);
    setCurrentDocumentId(id);
    setViewMode('document');
  };

  const handleCreateFlowchart = (folderId: string | null) => {
    const name = window.prompt('新建流程图名称');
    if (!name) return;
    const id = crypto.randomUUID();
    const newFlowchart: FlowchartMeta = {
      id,
      name,
      folderId,
      updatedAt: Date.now(),
    };
    setFlowcharts([...flowcharts, newFlowchart]);
    setFlowchartStates({ ...flowchartStates, [id]: createInitialState() });
    setCurrentFlowchartId(id);
    setViewMode('flowchart');
  };

  const handleCreateHandwritingDocument = (folderId: string | null) => {
    const name = window.prompt('新建手写文档名称');
    if (!name) return;
    const id = crypto.randomUUID();
    const baseHw = normalizeHandwritingData(undefined);
    const newDoc: DocumentMeta = {
      id,
      name,
      folderId,
      updatedAt: Date.now(),
      kind: 'handwriting',
      content: '',
      handwritingData: {
        ...baseHw,
        mode: 'paged',
        pageCount: 1,
        height: baseHw.height,
      },
    };
    setDocuments((prev) => [...prev, newDoc]);
    setCurrentDocumentId(id);
    setViewMode('document');
  };

  const handleSwitchDocument = (id: string) => {
    setCurrentDocumentId(id);
    setViewMode('document');
  };

  const handleSwitchFlowchart = (id: string) => {
    const next = flowchartStates[id];
    if (!next) {
      // 如果没有状态，创建一个新的
      setFlowchartStates((prev) => ({ ...prev, [id]: createInitialState() }));
    }
    setCurrentFlowchartId(id);
    setViewMode('flowchart');
    setCurrentDocumentId(null);
    setCurrentMapId('default');
  };

  const handleUpdateFlowchartState = (state: ReturnType<typeof createInitialState>) => {
    if (!currentFlowchartId) return;
    setFlowchartStates((prev) => ({
      ...prev,
      [currentFlowchartId]: { nodes: state.nodes, rootId: state.rootId, selectedId: state.selectedId, scale: state.scale, offset: state.offset },
    }));
    setFlowcharts((prev) =>
      prev.map((f) =>
        f.id === currentFlowchartId
          ? { ...f, updatedAt: Date.now() }
          : f,
      ),
    );
  };

  const closeFileMenu = () => setFileMenu(null);
  const folderKeyOf = (folderId: string | null) => folderId ?? '__root__';
  const isFolderCollapsed = (folderId: string | null) => collapsedFolderKeys.has(folderKeyOf(folderId));
  const toggleFolderCollapsed = (folderId: string | null) => {
    setCollapsedFolderKeys((prev) => {
      const next = new Set(prev);
      const key = folderKeyOf(folderId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    if (!moveDialog) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoveDialog(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveDialog]);

  const exportFileAsImage = async (type: 'map' | 'flowchart', id: string) => {
    try {
      if (type === 'map') {
        const m = maps.find((x) => x.id === id);
        const state = mapStates[id] ?? createInitialState();
        await exportMindmapAsPng(state as any, (m?.name ?? '导图').trim() || '导图');
      } else {
        const f = flowcharts.find((x) => x.id === id);
        const state = flowchartStates[id] ?? createInitialState();
        await exportFlowchartAsPng(state as any, (f?.name ?? '流程图').trim() || '流程图');
      }
    } catch (e) {
      console.error(e);
      alert('导出失败，请重试');
    }
  };

  const moveMapTo = (id: string, folderId: string | null) => {
    setMaps((prev) => prev.map((x) => (x.id === id ? { ...x, folderId, updatedAt: Date.now() } : x)));
  };

  const moveDocumentTo = (id: string, folderId: string | null) => {
    setDocuments((prev) => prev.map((x) => (x.id === id ? { ...x, folderId, updatedAt: Date.now() } : x)));
  };

  const moveFlowchartTo = (id: string, folderId: string | null) => {
    setFlowcharts((prev) => prev.map((x) => (x.id === id ? { ...x, folderId, updatedAt: Date.now() } : x)));
  };

  const openMoveDialog = (type: 'map' | 'document' | 'flowchart', id: string) => {
    let currentFolderId: string | null = null;
    if (type === 'map') currentFolderId = maps.find((x) => x.id === id)?.folderId ?? null;
    else if (type === 'document') currentFolderId = documents.find((x) => x.id === id)?.folderId ?? null;
    else if (type === 'flowchart') currentFolderId = flowcharts.find((x) => x.id === id)?.folderId ?? null;

    setMoveDialog({ type, id });
    setMoveDialogTarget(currentFolderId ?? 'root');
    closeFileMenu();
  };

  const cancelMoveDialog = () => setMoveDialog(null);

  const confirmMoveDialog = () => {
    if (!moveDialog) return;
    const folderId = moveDialogTarget === 'root' ? null : moveDialogTarget;
    if (folderId !== null && !folders.some((f) => f.id === folderId)) {
      alert('无效的目标文件夹');
      return;
    }
    if (moveDialog.type === 'map') moveMapTo(moveDialog.id, folderId);
    else if (moveDialog.type === 'document') moveDocumentTo(moveDialog.id, folderId);
    else if (moveDialog.type === 'flowchart') moveFlowchartTo(moveDialog.id, folderId);
    setMoveDialog(null);
  };

  const renameMap = (id: string) => {
    const m = maps.find((x) => x.id === id);
    if (!m) return;
    const name = window.prompt('重命名导图', m.name);
    if (!name) return;
    setMaps((prev) => prev.map((x) => (x.id === id ? { ...x, name, updatedAt: Date.now() } : x)));
  };

  const deleteMapById = (id: string) => {
    if (!window.confirm('确定删除该导图？')) return;
    setMaps((prev) => prev.filter((x) => x.id !== id));
    setMapStates((prev) => {
      const next = { ...prev };
      delete (next as any)[id];
      return next;
    });
    if (currentMapId === id) {
      const remaining = maps.filter((x) => x.id !== id);
      if (remaining.length > 0) handleSwitchMap(remaining[0].id);
    }
  };

  const moveMap = (id: string) => openMoveDialog('map', id);

  const renameDocument = (id: string) => {
    const d = documents.find((x) => x.id === id);
    if (!d) return;
    const name = window.prompt('重命名文档', d.name);
    if (!name) return;
    setDocuments((prev) => prev.map((x) => (x.id === id ? { ...x, name, updatedAt: Date.now() } : x)));
  };

  const renameFlowchart = (id: string) => {
    const f = flowcharts.find((x) => x.id === id);
    if (!f) return;
    const name = window.prompt('重命名流程图', f.name);
    if (!name) return;
    setFlowcharts((prev) => prev.map((x) => (x.id === id ? { ...x, name, updatedAt: Date.now() } : x)));
  };

  const deleteFlowchartById = (id: string) => {
    if (!window.confirm('确定删除该流程图？')) return;
    setFlowcharts((prev) => prev.filter((x) => x.id !== id));
    setFlowchartStates((prev) => {
      const next = { ...prev };
      delete (next as any)[id];
      return next;
    });
    if (currentFlowchartId === id) {
      const remaining = flowcharts.filter((x) => x.id !== id);
      if (remaining.length > 0) handleSwitchFlowchart(remaining[0].id);
      else {
        setCurrentFlowchartId(null);
        setViewMode('mindmap');
      }
    }
  };

  const moveFlowchart = (id: string) => openMoveDialog('flowchart', id);

  const deleteDocumentById = (id: string) => {
    if (!window.confirm('确定删除该文档？')) return;
    setDocuments((prev) => prev.filter((x) => x.id !== id));
    if (currentDocumentId === id) {
      setCurrentDocumentId(null);
    }
  };

  const moveDocument = (id: string) => openMoveDialog('document', id);

  const handleUpdateDocumentContent = (id: string, content: string) => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === id
          ? {
              ...doc,
              content,
              updatedAt: Date.now(),
            }
          : doc,
      ),
    );
  };

  const handleUpdateHandwritingData = (id: string, handwritingData: HandwritingDocumentData) => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === id
          ? {
              ...doc,
              kind: 'handwriting',
              handwritingData,
              updatedAt: Date.now(),
            }
          : doc,
      ),
    );
  };

  const currentDocument = documents.find((d) => d.id === currentDocumentId);

  // 云端登录态恢复：如果本地有 auth_token，就向后端查询当前用户
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await apiMe();
        if (cancelled) return;
        setCurrentUserState(me.user);
      } catch {
        // token 失效/不存在
        setToken(null);
        if (!cancelled) setCurrentUserState(null);
      } finally {
        if (!cancelled) setAuthBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 登录/注册处理（云端版本：账号密码在服务端校验；文件数据存到 Postgres）
  const handleLogin = async () => {
    if (!authUsername || !authPassword) {
      alert('请输入用户名/邮箱和密码');
      return;
    }
    if (!(isValidUsername(authUsername) || isValidEmail(authUsername))) {
      alert('请输入正确的用户名（3-20 位，字母/数字/_/-）或邮箱');
      return;
    }
    if (!isValidPassword(authPassword)) {
      alert('密码至少 6 位');
      return;
    }

    try {
      const { token, user } = await apiLogin({ usernameOrEmail: authUsername, password: authPassword });
      setToken(token);
      setIsUserDataLoaded(false);
      setCurrentUserState(user);
      setShowAuthModal(false);
      setAuthUsername('');
      setAuthPassword('');
      setAuthEmail('');
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg === 'invalid_credentials') {
        const host = typeof window !== 'undefined' ? window.location?.hostname : '';
        if (host === 'localhost' || host === '127.0.0.1') {
          alert(
            '用户名/邮箱或密码错误。\n\n提示：本地开发如果后端用了 USE_MEMORY_DB=1（内存模式），重启 API 会清空账号，需要重新注册一次。',
          );
        } else {
          alert('用户名/邮箱或密码错误');
        }
        return;
      }
      if (msg === 'missing_api_url') {
        alert('未配置云端 API 地址：请在 Render 的 Static Site 环境变量设置 VITE_API_URL=https://mindmap-api-qcew.onrender.com 并重新部署。');
        return;
      }
      if (msg === 'bad_response') {
        alert('云端 API 返回异常（可能是 API 未启动/502）。请打开 mindmap-api 的 Logs 查看错误并重启部署。');
        return;
      }
      if (msg.includes('Failed to fetch')) {
        const origin =
          typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://thoughtnotes.onrender.com';
        alert(`无法连接云端 API（网络/CORS）。请确认 mindmap-api 正常运行，并且 FRONTEND_ORIGIN= ${origin} 。`);
        return;
      }
      alert('登录失败，请重试（可打开浏览器控制台查看错误）');
    }
  };

  const handleRegister = async () => {
    if (!authUsername || !authEmail || !authPassword) {
      alert('请填写所有字段');
      return;
    }
    if (!isValidUsername(authUsername)) {
      alert('用户名格式不正确：3-20 位，只能包含字母/数字/_/-');
      return;
    }
    if (!isValidEmail(authEmail)) {
      alert('邮箱格式不正确');
      return;
    }
    if (!isValidPassword(authPassword)) {
      alert('密码至少 6 位');
      return;
    }

    try {
      const { token, user } = await apiRegister({ username: authUsername, email: authEmail, password: authPassword });
      setToken(token);
      setIsUserDataLoaded(false);
      setCurrentUserState(user);
      setShowAuthModal(false);
      setAuthUsername('');
      setAuthPassword('');
      setAuthEmail('');
    } catch (e: any) {
      const msg = String(e?.message);
      if (msg === 'username_taken') alert('用户名已存在');
      else if (msg === 'email_taken') alert('邮箱已被注册');
      else if (msg === 'missing_api_url')
        alert('未配置云端 API 地址：请在 Render 的 Static Site 环境变量设置 VITE_API_URL=https://mindmap-api-qcew.onrender.com 并重新部署。');
      else if (msg === 'bad_response')
        alert('云端 API 返回异常（可能是 API 未启动/502）。请打开 mindmap-api 的 Logs 查看错误并重启部署。');
      else if (msg.includes('Failed to fetch'))
        alert(
          `无法连接云端 API（网络/CORS）。请确认 mindmap-api 正常运行，并且 FRONTEND_ORIGIN= ${
            typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://thoughtnotes.onrender.com'
          } 。`,
        );
      else alert('注册失败，请重试（可打开浏览器控制台查看错误）');
    }
  };

  const handleLogout = () => {
    setToken(null);
    setCurrentUserState(null);
    setIsUserDataLoaded(false);
    setCloudSyncEnabled(false);
    setFolders([]);
    setMaps([]);
    setMapStates({});
    setDocuments([]);
    setFlowcharts([]);
    setFlowchartStates({});
    setCurrentMapId('');
    setCurrentDocumentId(null);
    setCurrentFlowchartId(null);
    setViewMode('mindmap');
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
  const rootCollapsed = !defaultFolderDeleted && isFolderCollapsed(null);
  positionsRef.current = positions;
  visibleNodesRef.current = visibleNodes;
  offsetRef.current = offset;
  scaleRef.current = scale;

  // 启动时先恢复云端登录态（避免闪一下登录页）
  if (authBooting) {
    return (
      <div className="app">
        <div className="auth-container">
          <div className="auth-card">
            <h1 className="auth-title">轻量思维导图</h1>
            <div style={{ textAlign: 'center', color: '#6b7280' }}>正在连接云端...</div>
          </div>
        </div>
      </div>
    );
  }

  // 如果未登录，显示登录界面
  if (!currentUser) {
    return (
      <div className="app">
        <div className="auth-container">
          <div className="auth-card">
            <h1 className="auth-title">轻量思维导图</h1>
            <div className="auth-tabs">
              <button
                className={`auth-tab ${authMode === 'login' ? 'active' : ''}`}
                onClick={() => setAuthMode('login')}
              >
                登录
              </button>
              <button
                className={`auth-tab ${authMode === 'register' ? 'active' : ''}`}
                onClick={() => setAuthMode('register')}
              >
                注册
              </button>
            </div>
            <div className="auth-form">
              <input
                type="text"
                className="auth-input"
                placeholder="用户名"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    authMode === 'login' ? handleLogin() : handleRegister();
                  }
                }}
              />
              {authMode === 'register' && (
                <input
                  type="email"
                  className="auth-input"
                  placeholder="邮箱"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleRegister();
                    }
                  }}
                />
              )}
              <input
                type="password"
                className="auth-input"
                placeholder="密码"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    authMode === 'login' ? handleLogin() : handleRegister();
                  }
                }}
              />
              <button
                className="auth-button"
                onClick={authMode === 'login' ? handleLogin : handleRegister}
              >
                {authMode === 'login' ? '登录' : '注册'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="toolbar">
        <div className="title">轻量思维导图</div>
        <span className="badge">MVP</span>
        <div style={{ flex: 1 }} />
        <div className="user-info">
          <span className="username">{currentUser.username}</span>
          <button className="button" onClick={handleLogout}>
            退出登录
          </button>
        </div>
        {viewMode === 'flowchart' ? (
          <>
            <button className="button" onClick={() => selectedId && addSibling(selectedId)}>
              同级 (Tab)
            </button>
            <button className="button" onClick={() => selectedId && addChild(selectedId)}>
              合并子节点 (Enter)
            </button>
            <button
              className="button"
              onClick={() => {
                if (!selectedId) return;
                // 先用现有逻辑创建子节点
                addChild(selectedId);
                // addChild 会把 selectedId 指向新节点；用 store 的 getState() 读取最新 id
                const newId = useMindMap.getState().selectedId;
                if (newId) setFlowchartChildType(newId, 'single');
              }}
            >
              单独子节点
            </button>
          </>
        ) : (
          <>
        <button className="button" onClick={() => selectedId && addChild(selectedId)}>
          子节点 (Tab)
        </button>
        <button className="button" onClick={() => selectedId && addSibling(selectedId)}>
          同级 (Enter)
        </button>
          </>
        )}
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
        {/* 导入/导出 JSON 按钮已移除（账号系统下自动保存） */}
        {selectedId && (
          <div className="priority-group">
            <div className="priority-label">优先级</div>
            {[1, 2, 3, 4].map((n) => (
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
            <button className="icon-btn" onClick={handleCreateFolder} title="新建文件夹">
              📁+
            </button>
          </div>
          <div className="folder-section">
            <div className="folder-row">
              <div className="folder-row-title">
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!defaultFolderDeleted) renameDefaultFolder();
                  }}
                  title={defaultFolderDeleted ? '已删除默认文件夹' : '双击改名'}
                  style={{ cursor: 'default', opacity: defaultFolderDeleted ? 0.7 : 1 }}
                >
                  {defaultFolderDeleted ? '📂 根目录' : `📁 ${defaultFolderName}`}
                </span>
                {!defaultFolderDeleted && (
                  <button
                    className="icon-btn"
                    title="文件夹菜单"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId: null });
                    }}
                    style={{ padding: '2px 6px', fontSize: 12 }}
                  >
                    ≡
                  </button>
                )}
              </div>
              {!defaultFolderDeleted && !rootCollapsed && (
                <div className="folder-row-actions">
                  <button className="link-btn" onClick={() => handleCreateMap(null)}>
                    新建导图
                  </button>
                  <button className="link-btn" onClick={() => handleCreateDocument(null)}>
                    新建文档
                  </button>
                  <button className="link-btn" onClick={() => handleCreateHandwritingDocument(null)}>
                    新建手写
                  </button>
                  <button className="link-btn" onClick={() => handleCreateFlowchart(null)}>
                    新建流程图
                  </button>
                </div>
              )}
            </div>
            {!rootCollapsed && (
              <>
                {maps
                  .filter((m) => m.folderId === null)
                  .map((m) => (
                    <div
                      key={m.id}
                      className={`map-row ${currentMapId === m.id && viewMode === 'mindmap' ? 'active' : ''}`}
                      onClick={() => handleSwitchMap(m.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setFileMenu({ x: e.clientX, y: e.clientY, type: 'map', id: m.id });
                      }}
                    >
                      <div className="map-name">🗺️ {m.name}</div>
                      <div className="map-meta">{new Date(m.updatedAt).toLocaleDateString()}</div>
                    </div>
                  ))}
                {documents
                  .filter((d) => d.folderId === null)
                  .map((d) => (
                    <div
                      key={d.id}
                      className={`map-row ${currentDocumentId === d.id && viewMode === 'document' ? 'active' : ''}`}
                      onClick={() => handleSwitchDocument(d.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setFileMenu({ x: e.clientX, y: e.clientY, type: 'document', id: d.id });
                      }}
                    >
                      <div className="map-name">
                        {d.kind === 'handwriting' ? '✍️' : '📄'} {d.name}
                      </div>
                      <div className="map-meta">{new Date(d.updatedAt).toLocaleDateString()}</div>
                    </div>
                  ))}
                {flowcharts
                  .filter((f) => f.folderId === null)
                  .map((f) => (
                    <div
                      key={f.id}
                      className={`map-row ${currentFlowchartId === f.id && viewMode === 'flowchart' ? 'active' : ''}`}
                      onClick={() => handleSwitchFlowchart(f.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setFileMenu({ x: e.clientX, y: e.clientY, type: 'flowchart', id: f.id });
                      }}
                    >
                      <div className="map-name">🔀 {f.name}</div>
                      <div className="map-meta">{new Date(f.updatedAt).toLocaleDateString()}</div>
                    </div>
                  ))}
              </>
            )}
          </div>
          {folders.map((folder) => (
            <div key={folder.id} className="folder-section">
              <div className="folder-row">
                <div className="folder-row-title">
                  <span
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      renameFolder(folder.id);
                    }}
                    title="双击改名"
                    style={{ cursor: 'default' }}
                  >
                    📁 {folder.name}
                  </span>
                  <button
                    className="icon-btn"
                    title="文件夹菜单"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setFolderContextMenu({ x: e.clientX, y: e.clientY, folderId: folder.id });
                    }}
                    style={{ padding: '2px 6px', fontSize: 12 }}
                  >
                    ≡
                  </button>
                </div>
                {!isFolderCollapsed(folder.id) && (
                  <div className="folder-row-actions">
                    <button className="link-btn" onClick={() => handleCreateMap(folder.id)}>
                      新建导图
                    </button>
                    <button className="link-btn" onClick={() => handleCreateDocument(folder.id)}>
                      新建文档
                    </button>
                    <button className="link-btn" onClick={() => handleCreateHandwritingDocument(folder.id)}>
                      新建手写
                    </button>
                    <button className="link-btn" onClick={() => handleCreateFlowchart(folder.id)}>
                      新建流程图
                    </button>
                  </div>
                )}
              </div>
              {!isFolderCollapsed(folder.id) && (
                <>
                  {maps
                    .filter((m) => m.folderId === folder.id)
                    .map((m) => (
                      <div
                        key={m.id}
                        className={`map-row ${currentMapId === m.id && viewMode === 'mindmap' ? 'active' : ''}`}
                        onClick={() => handleSwitchMap(m.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setFileMenu({ x: e.clientX, y: e.clientY, type: 'map', id: m.id });
                        }}
                      >
                        <div className="map-name">🗺️ {m.name}</div>
                        <div className="map-meta">{new Date(m.updatedAt).toLocaleDateString()}</div>
                      </div>
                    ))}
                  {documents
                    .filter((d) => d.folderId === folder.id)
                    .map((d) => (
                      <div
                        key={d.id}
                        className={`map-row ${currentDocumentId === d.id && viewMode === 'document' ? 'active' : ''}`}
                        onClick={() => handleSwitchDocument(d.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setFileMenu({ x: e.clientX, y: e.clientY, type: 'document', id: d.id });
                        }}
                      >
                        <div className="map-name">
                          {d.kind === 'handwriting' ? '✍️' : '📄'} {d.name}
                        </div>
                        <div className="map-meta">{new Date(d.updatedAt).toLocaleDateString()}</div>
                      </div>
                    ))}
                  {flowcharts
                    .filter((f) => f.folderId === folder.id)
                    .map((f) => (
                      <div
                        key={f.id}
                        className={`map-row ${currentFlowchartId === f.id && viewMode === 'flowchart' ? 'active' : ''}`}
                        onClick={() => handleSwitchFlowchart(f.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setFileMenu({ x: e.clientX, y: e.clientY, type: 'flowchart', id: f.id });
                        }}
                      >
                        <div className="map-name">🔀 {f.name}</div>
                        <div className="map-meta">{new Date(f.updatedAt).toLocaleDateString()}</div>
                      </div>
                    ))}
                </>
              )}
            </div>
          ))}
        </aside>

        {fileMenu && (
          <div
            className="context-menu"
            style={{ left: `${fileMenu.x}px`, top: `${fileMenu.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {(fileMenu.type === 'map' || fileMenu.type === 'flowchart') && (
              <>
                <button
                  className="context-menu-item"
                  onClick={async () => {
                    await exportFileAsImage(fileMenu.type as 'map' | 'flowchart', fileMenu.id);
                    closeFileMenu();
                  }}
                >
                  导出为图片
                </button>
                <div className="context-menu-divider" />
              </>
            )}
            <button
              className="context-menu-item"
              onClick={() => {
                if (fileMenu.type === 'map') renameMap(fileMenu.id);
                else if (fileMenu.type === 'document') renameDocument(fileMenu.id);
                else if (fileMenu.type === 'flowchart') renameFlowchart(fileMenu.id);
                closeFileMenu();
              }}
            >
              重命名
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                if (fileMenu.type === 'map') moveMap(fileMenu.id);
                else if (fileMenu.type === 'document') moveDocument(fileMenu.id);
                else if (fileMenu.type === 'flowchart') moveFlowchart(fileMenu.id);
              }}
            >
              移动
            </button>
            <div className="context-menu-divider" />
            <button
              className="context-menu-item danger"
              onClick={() => {
                if (fileMenu.type === 'map') deleteMapById(fileMenu.id);
                else if (fileMenu.type === 'document') deleteDocumentById(fileMenu.id);
                else if (fileMenu.type === 'flowchart') deleteFlowchartById(fileMenu.id);
                closeFileMenu();
              }}
            >
              删除
            </button>
          </div>
        )}

        {folderContextMenu && (
          <div
            className="context-menu"
            style={{ left: `${folderContextMenu.x}px`, top: `${folderContextMenu.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {folderContextMenu.folderId === null ? (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    toggleFolderCollapsed(null);
                    setFolderContextMenu(null);
                  }}
                >
                  {isFolderCollapsed(null) ? '展开' : '收起'}
                </button>
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item"
                  onClick={() => {
                    renameDefaultFolder();
                    setFolderContextMenu(null);
                  }}
                >
                  改名
                </button>
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    deleteDefaultFolder();
                    setFolderContextMenu(null);
                  }}
                >
                  删除文件夹
                </button>
              </>
            ) : (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    if (folderContextMenu.folderId) toggleFolderCollapsed(folderContextMenu.folderId);
                    setFolderContextMenu(null);
                  }}
                >
                  {folderContextMenu.folderId && isFolderCollapsed(folderContextMenu.folderId) ? '展开' : '收起'}
                </button>
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item"
                  onClick={() => {
                    if (folderContextMenu.folderId) renameFolder(folderContextMenu.folderId);
                    setFolderContextMenu(null);
                  }}
                >
                  改名
                </button>
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    if (folderContextMenu.folderId) deleteFolder(folderContextMenu.folderId);
                    setFolderContextMenu(null);
                  }}
                >
                  删除文件夹
                </button>
              </>
            )}
          </div>
        )}

        {moveDialog && (
          <div className="modal-overlay" onClick={cancelMoveDialog}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">移动到</div>
              <div className="modal-row">
                <select
                  className="modal-select"
                  value={moveDialogTarget}
                  onChange={(e) => setMoveDialogTarget(e.target.value)}
                >
                  <option value="root">根目录</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      📁 {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="modal-actions">
                <button className="button" onClick={cancelMoveDialog}>
                  取消
                </button>
                <button className="button primary" onClick={confirmMoveDialog}>
                  移动
                </button>
              </div>
            </div>
          </div>
        )}

        {viewMode === 'mindmap' ? (
        <div
          ref={canvasShellRef}
          className={`canvas-shell ${viewMode === 'mindmap' ? 'mindmap-dark' : ''}`}
          onWheel={handleWheel}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerLeave={endPan}
          onDragOver={handleCanvasDragOver}
          onDrop={(e) => {
            e.preventDefault();
            handleNodeDragEnd();
          }}
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

              // Connector (match reference): line -> circle -> short capsule -> node (ONLY on child side)
              const dotR = 7;
              const stubLen = 12;
              const stubH = 10;
              const endDotX = endX - dotR - stubLen;

              // Control Points for the main curve between dots
              const cp1x = startX + HORIZONTAL_GAP / 2;
              const cp1y = startY;
              const cp2x = endDotX - HORIZONTAL_GAP / 2;
              const cp2y = endY;

              const d = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endDotX} ${endY}`;

              return (
                <React.Fragment key={`${node.id}-edge`}>
                  {/* End stub: circle -> node */}
                  {endX > endDotX + dotR && (
                    <rect
                      x={endDotX + dotR}
                      y={endY - stubH / 2}
                      width={Math.max(1, endX - (endDotX + dotR))}
                      height={stubH}
                      rx={stubH / 2}
                      fill="rgba(255,255,255,0.9)"
                    />
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke="rgba(255,255,255,0.88)"
                    strokeWidth={5}
                    strokeLinecap="round"
                  />
                  {/* Dot on child side only */}
                  <circle
                    cx={endDotX}
                    cy={endY}
                    r={dotR}
                    fill="rgba(60,66,70,0.9)"
                    stroke="rgba(255,255,255,0.9)"
                    strokeWidth={2}
                  />
                </React.Fragment>
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
              const isDragging = !!draggingNodeId.current && selectedIds.has(node.id);
            const isDragOver = dragOverNodeId.current?.id === node.id;
            const nodeWidth = pos.width || 140;
            const nodeHeight = pos.height || 40;
            const hasChildren = node.children.length > 0;
              const hasProgress = !!node.progress && node.progress !== 'none';
              const hasPriority = !!node.priority && node.priority >= 1 && node.priority <= 4;
              const leftPad = hasProgress && hasPriority ? 58 : hasProgress ? 42 : hasPriority ? 38 : 20;
            
            return (
              <React.Fragment key={node.id}>
                <div
                    className={`node depth-${pos.depth} ${selectedIds.has(node.id) ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                  style={{
                      transform: `translate(${pos.x}px, ${pos.y}px)`,
                    transformOrigin: 'top left',
                    width: `${nodeWidth}px`,
                    height: `${nodeHeight}px`,
                  }}
                  draggable={node.id !== rootId}
                  onDragStart={(e) => handleNodeDragStart(e, node.id)}
                  onDragOver={(e) => handleNodeDragOver(e, node.id)}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (draggingNodeId.current && draggingNodeId.current !== node.id && node.id !== rootId) {
                        dragOverNodeId.current = { id: node.id, mode: 'child' };
                      }
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // 只有当真正离开节点区域时才清除高亮
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const x = e.clientX;
                      const y = e.clientY;
                      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                        if (dragOverNodeId.current?.id === node.id) {
                          dragOverNodeId.current = null;
                        }
                      }
                    }}
                  onDragEnd={handleNodeDragEnd}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    handleNodePointerDown(e, node.id);
                  }}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  onPointerCancel={handleNodePointerUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
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
                    readOnly={mindmapEditingId !== node.id}
                    onChange={(e) => {
                      if (mindmapEditingId !== node.id) return;
                      updateTitle(node.id, e.target.value);
                    }}
                      draggable={node.id !== rootId}
                      onDragStart={(e) => {
                        // 如果正在编辑文本，不触发拖动
                        const textarea = e.target as HTMLTextAreaElement;
                        if (document.activeElement === textarea && textarea.selectionStart !== textarea.selectionEnd) {
                          e.preventDefault();
                          e.stopPropagation();
                          return;
                        }
                        // 允许拖动事件冒泡，但确保调用 handleNodeDragStart
                        if (node.id !== rootId) {
                          handleNodeDragStart(e, node.id);
                        }
                      }}
                      onDragOver={(e) => {
                        // 阻止 textarea 的默认行为，让父节点的拖动处理生效
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDragEnd={(e) => {
                        e.stopPropagation();
                        handleNodeDragEnd(e);
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const textarea = e.target as HTMLTextAreaElement;
                        const nodeId = node.id;

                        const now = Date.now();
                        const meta = mindmapClickMetaRef.current[nodeId] ?? { lastAt: 0, stage: 'idle' as const };
                        const DOUBLE_CLICK_MS = 250;
                        const SECOND_CLICK_TO_EDIT_MS = 1200;

                        // 切换到其它节点时：清掉上一个节点的“全选/待编辑”状态，避免回点又自动全选
                        if (selectedId && selectedId !== nodeId) {
                          const prev = selectedId;
                          const prevMeta = mindmapClickMetaRef.current[prev];
                          if (prevMeta) mindmapClickMetaRef.current[prev] = { ...prevMeta, stage: 'idle', lastAt: 0 };
                          mindmapArmedEditClickRef.current[prev] = false;
                        }

                        // 双击（detail===2）优先：全选 + 直接进入编辑态（打字可直接替换）
                        if (e.detail === 2) {
                          e.preventDefault();
                          meta.stage = 'selectedAll';
                          meta.lastAt = 0;
                          mindmapClickMetaRef.current[nodeId] = meta;
                          textarea.focus();
                          setTimeout(() => {
                            textarea.setSelectionRange(0, textarea.value.length);
                          }, 0);
                          mindmapArmedEditClickRef.current[nodeId] = false;
                          mindmapSuppressBlurClearRef.current = true;
                          setMindmapEditingId(nodeId);
                          setTimeout(() => {
                            mindmapSuppressBlurClearRef.current = false;
                          }, 50);
                          return;
                        }

                        // 编辑态下：允许正常落光标/输入，不要强制退出编辑态
                        if (mindmapEditingId === nodeId) {
                          setSelectedIds(new Set([nodeId]));
                          setSelected(nodeId);
                          return;
                        }

                        // 选中节点
                        setSelectedIds(new Set([nodeId]));
                        setSelected(nodeId);

                        // 全选后再次单击：进入编辑态
                        if (meta.stage === 'selectedAll' || mindmapArmedEditClickRef.current[nodeId]) {
                          meta.stage = 'idle';
                          meta.lastAt = 0;
                          mindmapClickMetaRef.current[nodeId] = meta;
                          mindmapArmedEditClickRef.current[nodeId] = false;

                          // 这里不要 preventDefault：让浏览器把光标落到你点击的位置
                          mindmapSuppressBlurClearRef.current = true;
                          setMindmapEditingId(nodeId);
                          setTimeout(() => {
                            mindmapSuppressBlurClearRef.current = false;
                          }, 50);
                          return;
                        }

                        // 阻止默认 focus，我们自己控制 focus/selection
                        e.preventDefault();

                        // 快速双击：全选文本（仍不进入输入状态）
                        if (meta.stage === 'focused' && now - meta.lastAt <= DOUBLE_CLICK_MS) {
                          meta.stage = 'selectedAll';
                          meta.lastAt = 0;
                          mindmapClickMetaRef.current[nodeId] = meta;
                          textarea.focus();
                          setTimeout(() => {
                            textarea.setSelectionRange(0, textarea.value.length);
                          }, 0);
                          mindmapArmedEditClickRef.current[nodeId] = true;
                          setMindmapEditingId(null);
                          return;
                        }

                        // 第二次单击（非双击速度）：进入编辑态（不全选）
                        if (
                          meta.stage === 'focused' &&
                          now - meta.lastAt > DOUBLE_CLICK_MS &&
                          now - meta.lastAt < SECOND_CLICK_TO_EDIT_MS
                        ) {
                          meta.stage = 'idle';
                          meta.lastAt = 0;
                          mindmapClickMetaRef.current[nodeId] = meta;
                          setMindmapEditingId(nodeId);
                          requestAnimationFrame(() => {
                            const el = document.querySelector<HTMLTextAreaElement>(
                              `textarea.node-text[data-node-id="${nodeId}"]`,
                            );
                            if (!el) return;
                            el.focus();
                            const len = el.value.length;
                            el.setSelectionRange(len, len);
                          });
                          return;
                        }

                        // 第一次单击：只聚焦（不进入输入态）
                        meta.stage = 'focused';
                        meta.lastAt = now;
                        mindmapClickMetaRef.current[nodeId] = meta;
                        setMindmapEditingId(null);
                        textarea.focus();
                        {
                          const len = textarea.value.length;
                          textarea.setSelectionRange(len, len);
                        }
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
                        }
                      }}
                      onFocus={(e) => {
                        e.stopPropagation();
                        setSelectedIds(new Set([node.id]));
                        setSelected(node.id);
                      }}
                      onBlur={() => {
                        // 只在“当前编辑节点”失焦时退出编辑态
                        // 避免 Tab/Enter 新建节点时：旧节点 blur 把 mindmapEditingId 清空，导致新节点又变回只读
                        if (mindmapSuppressBlurClearRef.current) return;
                        setMindmapEditingId((cur) => (cur === node.id ? null : cur));
                      }}
                      onKeyDown={(e) => {
                        // 只有在编辑状态下才处理Enter键
                        if (mindmapEditingId === node.id) {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            e.stopPropagation();
                            // 结束输入并选中当前输入框
                            const textarea = e.target as HTMLTextAreaElement;
                            textarea.blur();
                            setMindmapEditingId(null);
                            setSelectedIds(new Set([node.id]));
                            setSelected(node.id);
                          }
                        }
                        // 对于只读状态，不做任何处理，让键盘事件传递给窗口监听器
                      }}
                    rows={1}
                    style={{
                      width: '100%',
                      height: '100%',
                        textAlign: pos.depth >= 2 ? 'left' : hasProgress || hasPriority ? 'left' : 'center',
                      lineHeight: `${nodeHeight}px`,
                        paddingLeft: `${pos.depth >= 2 && !(hasProgress || hasPriority) ? 6 : leftPad}px`,
                        paddingRight: '20px',
                        fontSize: pos.depth >= 2 ? 22 : pos.depth === 1 ? 22 : pos.depth === 0 ? 36 : undefined,
                        fontWeight: pos.depth >= 2 ? 600 : pos.depth === 1 ? 700 : pos.depth === 0 ? 800 : undefined,
                        color: pos.depth >= 2 ? 'rgba(255,255,255,.92)' : undefined,
                    }}
                  />
                </div>
                {/* 展开/收起按钮：放在“圆点”上（线连到圆点，圆点再连到节点） */}
                {hasChildren && node.id !== rootId && (
                  <button
                    className="collapse-dot"
                    type="button"
                    title={node.collapsed ? '展开' : '收起'}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleCollapse(node.id);
                    }}
                    style={{
                      position: 'absolute',
                      // 与 SVG 的 endDotX/endY 保持一致：x = nodeLeft - (dotR + stubLen), y = nodeMidY
                      transform: `translate(${pos.x - (7 + 12)}px, ${pos.y + nodeHeight / 2}px) translate(-50%, -50%)`,
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      border: '2px solid rgba(255,255,255,.9)',
                      background: 'rgba(255,255,255,.06)',
                      color: 'rgba(255,255,255,.95)',
                      fontWeight: 900,
                      fontSize: 12,
                      lineHeight: 1,
                      display: 'grid',
                      placeItems: 'center',
                      zIndex: 100,
                      pointerEvents: 'auto',
                    }}
                  >
                    {node.collapsed ? '+' : '−'}
                  </button>
                )}
              </React.Fragment>
            );
          })}
          </div>

          {/* MiniMap 已移除 */}
          </div>
        ) : viewMode === 'flowchart' ? (
          currentFlowchartId && flowchartStates[currentFlowchartId] ? (
            <FlowchartEditor
              initialState={flowchartStates[currentFlowchartId]}
              onUpdate={handleUpdateFlowchartState}
            />
          ) : (
            <div className="document-empty">
              <p>请从左侧选择一个流程图，或创建一个新流程图</p>
        </div>
          )
        ) : (
        <div className="document-editor">
          {currentDocument ? (
            <>
              <div className="document-header">
                <h2 className="document-title">{currentDocument.name}</h2>
                <div className="document-meta">
                  最后更新: {new Date(currentDocument.updatedAt).toLocaleString()}
        </div>
              </div>
              {currentDocument.kind === 'handwriting' ? (
                <HandwritingEditor
                  value={normalizeHandwritingData(currentDocument.handwritingData)}
                  onChange={(next) => handleUpdateHandwritingData(currentDocument.id, next)}
                />
              ) : (
                <textarea
                  className="document-content"
                  value={currentDocument.content}
                  onChange={(e) => handleUpdateDocumentContent(currentDocument.id, e.target.value)}
                  placeholder="开始输入文档内容..."
                />
              )}
            </>
          ) : (
            <div className="document-empty">
              <p>请从左侧选择一个文档，或创建一个新文档</p>
            </div>
          )}
        </div>
        )}
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

export default App;
