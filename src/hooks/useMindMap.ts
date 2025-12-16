import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { MindMapState } from '../types';

export const createInitialState = (): MindMapState => {
  const rootId = nanoid();
  return {
    rootId,
    selectedId: rootId,
    scale: 1,
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
};

export const useMindMap = create<MindMapState & Actions>((set, get) => ({
  ...createInitialState(),
  setSelected: (id) => set({ selectedId: id }),
  updateTitle: (id, title) =>
    set((state) => ({
      nodes: { ...state.nodes, [id]: { ...state.nodes[id], title } },
    })),
  addChild: (parentId) =>
    set((state) => {
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
      const parent = state.nodes[node.parentId];
      const newId = nanoid();
      const newNode = {
        id: newId,
        parentId: node.parentId,
        title: '同级节点',
        children: [],
        side: node.side,
      };
      return {
        nodes: {
          ...state.nodes,
          [node.parentId]: {
            ...parent,
            children: [...parent.children, newId],
          },
          [newId]: newNode,
        },
        selectedId: newId,
      };
    }),
  removeNode: (id) =>
    set((state) => {
      if (id === state.rootId) return state;
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
      return { nodes, selectedId: parent?.id ?? state.rootId };
    }),
  toggleCollapse: (id) =>
    set((state) => ({
      nodes: {
        ...state.nodes,
        [id]: { ...state.nodes[id], collapsed: !state.nodes[id].collapsed },
      },
    })),
  setScale: (scale) => set({ scale }),
  pan: (dx, dy) =>
    set((state) => ({ offset: { x: state.offset.x + dx, y: state.offset.y + dy } })),
  importData: (data) => set(() => data),
  reset: () => set(() => createInitialState()),
  setPriority: (id, value) =>
    set((state) => ({
      nodes: { ...state.nodes, [id]: { ...state.nodes[id], priority: value } },
    })),
  setProgress: (id, value) =>
    set((state) => ({
      nodes: { ...state.nodes, [id]: { ...state.nodes[id], progress: value } },
    })),
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

