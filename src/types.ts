export type MindNode = {
  id: string;
  parentId: string | null;
  title: string;
  children: string[];
  collapsed?: boolean;
  side?: 'left' | 'right';
  priority?: number | null; // 1-9
  progress?: 'none' | 'q1' | 'q2' | 'q3' | 'done';
  width?: number; // Dynamic width based on text
  height?: number; // Dynamic height based on text
};

export type MindMapState = {
  nodes: Record<string, MindNode>;
  rootId: string;
  selectedId: string | null;
  scale: number;
  offset: { x: number; y: number };
};

export type MapMeta = {
  id: string;
  name: string;
  folderId: string | null;
  updatedAt: number;
};

export type FolderMeta = {
  id: string;
  name: string;
  parentId: string | null;
};

export type DocumentMeta = {
  id: string;
  name: string;
  folderId: string | null;
  updatedAt: number;
  content: string;
};

export type User = {
  id: string;
  username: string;
  email: string;
  createdAt: number;
};

export type StoredUser = User & {
  salt: string;
  passwordHash: string;
};

export type UserData = {
  folders: FolderMeta[];
  maps: MapMeta[];
  mapStates: Record<string, MindMapState>;
  documents: DocumentMeta[];
};

