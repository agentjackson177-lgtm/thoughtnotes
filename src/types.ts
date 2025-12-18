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
  kind?: 'text' | 'handwriting';
  content: string; // text document content (handwriting can keep empty string)
  handwritingData?: HandwritingDocumentData;
};

export type HandwritingBackground = 'blank' | 'lined';

export type HandwritingCanvasMode = 'infinite' | 'paged';

export type HandwritingPoint = {
  x: number; // logical px (relative to a fixed logical width)
  y: number; // logical px (grows as pages/height increase)
  p: number; // pressure 0..1
};

export type HandwritingStroke = {
  id: string;
  color: string;
  baseSize: number; // px
  points: HandwritingPoint[];
};

export type HandwritingDocumentData = {
  mode: HandwritingCanvasMode;
  background: HandwritingBackground;
  color: string;
  baseSize: number; // default pen size
  pageCount: number; // for paged mode
  height: number; // logical px, for infinite mode (and as fallback)
  strokes: HandwritingStroke[];
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

export type FlowchartMeta = {
  id: string;
  name: string;
  folderId: string | null;
  updatedAt: number;
};

export type UserData = {
  folders: FolderMeta[];
  maps: MapMeta[];
  mapStates: Record<string, MindMapState>;
  documents: DocumentMeta[];
  flowcharts: FlowchartMeta[];
  flowchartStates: Record<string, MindMapState>;
};

