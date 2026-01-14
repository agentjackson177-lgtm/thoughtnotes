import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { MindMapState, MindNode } from '../types';

export const createInitialState = (): MindMapState => {
  const rootId = nanoid();
  return {
    rootId,
    selectedId: rootId,
    // 默认缩放更小（约等于手动点 4 次“缩小”的观感）
    scale: 0.6,
    offset: { x: 200, y: 120 },
    nodes: {
      [rootId]: {
        id: rootId,
        parentId: null,
        title: '中心主题',
        children: [],
      },
    },
  };
};

type Actions = {
  setSelected: (id: string | null) => void;
  updateTitle: (id: string, title: string) => void;
  addChild: (parentId: string) => void;
  addSibling: (id: string) => void;
  removeNode: (id: string) => void;
  toggleCollapse: (id: string) => void;
  setScale: (scale: number) => void;
  pan: (dx: number, dy: number) => void;
  importData: (state: MindMapState) => void;
  reset: () => void;
  setPriority: (id: string, value: number | null) => void;
  setProgress: (id: string, value: MindNode['progress']) => void;
  setFlowchartChildType: (id: string, value: 'single' | null) => void;
  moveNode: (nodeId: string, newParentId: string | null, insertAfterId?: string) => void;
  moveUp: (id: string) => void;
  moveDown: (id: string) => void;
  copyNode: (id: string) => void;
  pasteNode: (parentId: string) => void;
  undo: () => void;
  redo: () => void;
};

type HistoryState = {
  _past: MindMapState[];
  _future: MindMapState[];
};

const MAX_HISTORY = 80;

const cloneState = (s: MindMapState): MindMapState => ({
  rootId: s.rootId,
  selectedId: s.selectedId,
  scale: s.scale,
  offset: { x: s.offset.x, y: s.offset.y },
  nodes: Object.fromEntries(
    Object.entries(s.nodes).map(([id, n]) => [
      id,
      {
        ...(n as any),
        children: [...(n.children || [])],
      },
    ]),
  ) as any,
});

export const useMindMap = create<MindMapState & Actions & HistoryState>((set, get) => ({
  ...createInitialState(),
  _past: [],
  _future: [],
  undo: () =>
    set((state) => {
      if (state._past.length === 0) return state;
      const prev = state._past[state._past.length - 1];
      const current = cloneState(state);
      return {
        ...cloneState(prev),
        _past: state._past.slice(0, -1),
        _future: [current, ...state._future].slice(0, MAX_HISTORY),
      };
    }),
  redo: () =>
    set((state) => {
      if (state._future.length === 0) return state;
      const next = state._future[0];
      const current = cloneState(state);
      return {
        ...cloneState(next),
        _past: [...state._past, current].slice(-MAX_HISTORY),
        _future: state._future.slice(1),
      };
    }),
  setSelected: (id) => set({ selectedId: id }),
  updateTitle: (id, title) =>
    set((state) => ({
      nodes: { ...state.nodes, [id]: { ...state.nodes[id], title } },
    })),
  addChild: (parentId) =>
    set((state) => {
      const snapshot = cloneState(state);
      const newId = nanoid();
      const parent = state.nodes[parentId];
      const isRoot = parent.parentId === null;
      const side: 'left' | 'right' | undefined = isRoot
        ? (parent.children.length % 2 === 0 ? 'left' : 'right')
        : parent.side;
      const newChild = {
        id: newId,
        parentId,
        title: '新节点',
        children: [],
        side,
      };
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: {
          ...state.nodes,
          [parentId]: {
            ...parent,
            children: [...parent.children, newId],
          },
          [newId]: newChild,
        },
        selectedId: newId,
      };
    }),
  addSibling: (id) =>
    set((state) => {
      const node = state.nodes[id];
      if (!node.parentId) return state;
      const snapshot = cloneState(state);
      const parent = state.nodes[node.parentId];
      const newId = nanoid();
      const newNode = {
        id: newId,
        parentId: node.parentId,
        title: '同级节点',
        children: [],
        side: node.side,
      };
      
      // 在当前节点后面添加新节点
      const currentIndex = parent.children.indexOf(id);
      const newChildren = [...parent.children];
      newChildren.splice(currentIndex + 1, 0, newId);
      
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: {
          ...state.nodes,
          [node.parentId]: {
            ...parent,
            children: newChildren,
          },
          [newId]: newNode,
        },
        selectedId: newId,
      };
    }),
  removeNode: (id) =>
    set((state) => {
      if (id === state.rootId) return state;
      const snapshot = cloneState(state);
      const node = state.nodes[id];
      const parent = node.parentId ? state.nodes[node.parentId] : null;
      const nodes = { ...state.nodes };
      const removeRecursive = (nodeId: string) => {
        const current = nodes[nodeId];
        current.children.forEach(removeRecursive);
        delete nodes[nodeId];
      };
      removeRecursive(id);
      if (parent) {
        nodes[parent.id] = {
          ...parent,
          children: parent.children.filter((cid) => cid !== id),
        };
      }
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes,
        selectedId: parent?.id ?? state.rootId,
      };
    }),
  toggleCollapse: (id) =>
    set((state) => {
      const snapshot = cloneState(state);
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: {
          ...state.nodes,
          [id]: { ...state.nodes[id], collapsed: !state.nodes[id].collapsed },
        },
      };
    }),
  setScale: (scale) => set({ scale }),
  pan: (dx, dy) =>
    set((state) => ({ offset: { x: state.offset.x + dx, y: state.offset.y + dy } })),
  importData: (data) => set(() => ({ ...data, _past: [], _future: [] })),
  reset: () => set(() => ({ ...createInitialState(), _past: [], _future: [] })),
  setPriority: (id, value) =>
    set((state) => {
      const snapshot = cloneState(state);
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: { ...state.nodes, [id]: { ...state.nodes[id], priority: value } },
      };
    }),
  setProgress: (id, value) =>
    set((state) => {
      const snapshot = cloneState(state);
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: { ...state.nodes, [id]: { ...state.nodes[id], progress: value } },
      };
    }),
  setFlowchartChildType: (id, value) =>
    set((state) => {
      const node = state.nodes[id];
      if (!node) return state;
      const snapshot = cloneState(state);
      const next = { ...node } as any;
      if (value === null) {
        delete next.flowchartChildType;
      } else {
        next.flowchartChildType = value;
      }
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: { ...state.nodes, [id]: next },
      };
    }),
  moveNode: (nodeId, newParentId, insertAfterId) =>
    set((state) => {
      const node = state.nodes[nodeId];
      if (!node) return state;
      if (nodeId === state.rootId) return state; // 不能移动根节点
      const snapshot = cloneState(state);

      // 检查不能移动到自己的子节点
      const isDescendant = (id: string, ancestorId: string): boolean => {
        const n = state.nodes[id];
        if (!n || !n.parentId) return false;
        if (n.parentId === ancestorId) return true;
        return isDescendant(n.parentId, ancestorId);
      };
      if (newParentId && isDescendant(newParentId, nodeId)) return state;

      const nodes = { ...state.nodes };
      const oldParent = node.parentId ? nodes[node.parentId] : null;

      // 从旧父节点移除
      if (oldParent) {
        nodes[oldParent.id] = {
          ...oldParent,
          children: oldParent.children.filter((cid) => cid !== nodeId),
        };
      }

      // 添加到新父节点
      if (newParentId) {
        const newParent = nodes[newParentId];
        if (newParent) {
          if (insertAfterId) {
            const index = newParent.children.indexOf(insertAfterId);
            const newChildren = [...newParent.children];
            newChildren.splice(index + 1, 0, nodeId);
            nodes[newParentId] = { ...newParent, children: newChildren };
          } else {
            nodes[newParentId] = {
              ...newParent,
              children: [...newParent.children, nodeId],
            };
          }
        }
        nodes[nodeId] = {
          ...node,
          parentId: newParentId,
          side: newParent?.side,
        };
      }

      return { _past: [...state._past, snapshot].slice(-MAX_HISTORY), _future: [], nodes };
    }),
  moveUp: (id) =>
    set((state) => {
      const node = state.nodes[id];
      if (!node || !node.parentId) return state;
      const snapshot = cloneState(state);
      const parent = state.nodes[node.parentId];
      const index = parent.children.indexOf(id);
      if (index <= 0) return state;
      const newChildren = [...parent.children];
      [newChildren[index - 1], newChildren[index]] = [newChildren[index], newChildren[index - 1]];
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: { ...state.nodes, [node.parentId]: { ...parent, children: newChildren } },
      };
    }),
  moveDown: (id) =>
    set((state) => {
      const node = state.nodes[id];
      if (!node || !node.parentId) return state;
      const snapshot = cloneState(state);
      const parent = state.nodes[node.parentId];
      const index = parent.children.indexOf(id);
      if (index >= parent.children.length - 1) return state;
      const newChildren = [...parent.children];
      [newChildren[index], newChildren[index + 1]] = [newChildren[index + 1], newChildren[index]];
      return {
        _past: [...state._past, snapshot].slice(-MAX_HISTORY),
        _future: [],
        nodes: { ...state.nodes, [node.parentId]: { ...parent, children: newChildren } },
      };
    }),
  copyNode: (id) => {
    const state = get();
    const node = state.nodes[id];
    if (!node) return;
    const copyNodeRecursive = (nodeId: string): any => {
      const n = state.nodes[nodeId];
      return {
        ...n,
        id: nanoid(),
        children: n.children.map(copyNodeRecursive),
      };
    };
    const copied = copyNodeRecursive(id);
    (window as any).__mindmapClipboard = copied;
  },
  pasteNode: (parentId) =>
    set((state) => {
      const clipboard = (window as any).__mindmapClipboard;
      if (!clipboard) return state;
      const parent = state.nodes[parentId];
      if (!parent) return state;

      const pasteRecursive = (node: any, newParentId: string): any => {
        const newId = nanoid();
        const newNode = {
          ...node,
          id: newId,
          parentId: newParentId,
          children: [],
        };
        const children = node.children.map((child: any) => pasteRecursive(child, newId));
        return { node: newNode, children };
      };

      const { node: newRoot, children } = pasteRecursive(clipboard, parentId);
      const nodes: Record<string, MindNode> = { ...state.nodes, [newRoot.id]: newRoot as MindNode };
      children.forEach(({ node: n }: any) => {
        nodes[(n as MindNode).id] = n as MindNode;
      });
      nodes[parentId] = {
        ...parent,
        children: [...parent.children, newRoot.id],
      };

      return { nodes, selectedId: newRoot.id };
    }),
}));

export const exportData = (state: MindMapState) => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mindmap.json';
  a.click();
  URL.revokeObjectURL(url);
};
