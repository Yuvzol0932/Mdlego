/**
 * 状态树 —— 单一不可变状态 + reducer。
 *
 * 规则（docs/CONVENTIONS.md §3）：
 *   - 视图只读 state，变更只能 dispatch(action)
 *   - reducer 是纯函数：不读 localStorage、不读时间、不碰 DOM
 *   - 副作用（持久化、DOM 写入）由订阅者负责
 *
 * 这样测试可以直接对 reducer 断言，无需模拟任何环境。
 */

import { normalizeTypePrefs } from '../core/typography';
import type {
  Doc,
  Mark,
  OverlayKind,
  RenderResult,
  SearchHit,
  Settings,
  State,
  StateAction,
  TaskState,
} from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';

/** 初始状态。 */
export function createInitialState(settings: Settings = DEFAULT_SETTINGS): State {
  return {
    docs: [],
    currentDocId: null,
    marks: [],
    tasks: [],
    settings,
    readerStatus: 'idle',
    readerError: null,
    render: null,
    searchQuery: '',
    searchResults: [],
    overlay: 'none',
  };
}

/**
 * 纯 reducer。禁止任何副作用。
 *
 * 未识别的 action 原样返回旧 state（而不是抛错），
 * 避免因为某个视图发了旧 action 就整页崩溃。
 */
export function reduce(state: State, action: StateAction): State {
  switch (action.type) {
    case 'docs/loaded':
      return { ...state, docs: action.docs };

    case 'doc/imported':
      return { ...state, docs: [...state.docs, action.doc] };

    case 'doc/updated':
      return {
        ...state,
        docs: state.docs.map((d) => (d.id === action.doc.id ? action.doc : d)),
      };

    case 'doc/deleted':
      return {
        ...state,
        docs: state.docs.filter((d) => d.id !== action.docId),
        currentDocId: state.currentDocId === action.docId ? null : state.currentDocId,
        marks: state.marks.filter((m) => m.docId !== action.docId),
        tasks: state.tasks.filter((t) => t.docId !== action.docId),
      };

    case 'doc/opened':
      return {
        ...state,
        currentDocId: action.docId,
        readerStatus: 'loading',
        readerError: null,
        render: null,
        overlay: 'none',
      };

    case 'doc/closed':
      return {
        ...state,
        currentDocId: null,
        readerStatus: 'idle',
        render: null,
        overlay: 'none',
      };

    case 'reader/loading':
      return { ...state, readerStatus: 'loading', readerError: null };

    case 'reader/ready':
      return { ...state, readerStatus: 'ready', render: action.render, readerError: null };

    case 'reader/error':
      return { ...state, readerStatus: 'error', readerError: action.message, render: null };

    case 'marks/loaded':
      return { ...state, marks: action.marks };

    case 'mark/added':
      return { ...state, marks: [...state.marks, action.mark] };

    case 'mark/removed':
      return { ...state, marks: state.marks.filter((m) => m.id !== action.markId) };

    case 'tasks/loaded':
      return { ...state, tasks: action.tasks };

    case 'task/toggled': {
      const exists = state.tasks.some(
        (t) =>
          t.docId === action.task.docId &&
          t.bid === action.task.bid &&
          t.index === action.task.index,
      );
      const tasks = exists
        ? state.tasks.map((t) =>
            t.docId === action.task.docId && t.bid === action.task.bid && t.index === action.task.index
              ? action.task
              : t,
          )
        : [...state.tasks, action.task];
      return { ...state, tasks };
    }

    case 'settings/changed': {
      const next: Settings = { ...state.settings, ...action.patch };
      // 档位在这里再夹一次，保证任何来源的改动都不会产生非法状态
      const prefs = normalizeTypePrefs({
        typeScale: next.typeScale,
        lineScale: next.lineScale,
        paraScale: next.paraScale,
        fontFamily: next.fontFamily,
      });
      return { ...state, settings: { ...next, ...prefs } };
    }

    case 'search/queried':
      return { ...state, searchQuery: action.query, searchResults: action.results };

    case 'overlay/opened':
      return {
        ...state,
        overlay: state.overlay === action.overlay ? 'none' : action.overlay,
      };

    default:
      return state;
  }
}

/** 极简状态容器：持有状态、通知订阅者。 */
export interface Store {
  getState(): State;
  dispatch(action: StateAction): void;
  subscribe(listener: (state: State) => void): () => void;
}

/** 创建 store。onChange 在每次状态变化后同步调用。 */
export function createStore(initial: State, onChange?: (state: State) => void): Store {
  let current = initial;
  const listeners = new Set<(state: State) => void>();

  return {
    getState: () => current,
    dispatch(action) {
      const next = reduce(current, action);
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener(current);
      onChange?.(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 便捷选择器：当前文档。 */
export function selectCurrentDoc(state: State): Doc | null {
  if (state.currentDocId === null) return null;
  return state.docs.find((d) => d.id === state.currentDocId) ?? null;
}

/** 便捷选择器：当前文档的标注。 */
export function selectCurrentMarks(state: State): readonly Mark[] {
  if (state.currentDocId === null) return [];
  return state.marks.filter((m) => m.docId === state.currentDocId);
}

/** 便捷选择器：当前文档的任务状态。 */
export function selectCurrentTasks(state: State): readonly TaskState[] {
  if (state.currentDocId === null) return [];
  return state.tasks.filter((t) => t.docId === state.currentDocId);
}

/** 取某篇文档的渲染结果（当前只有一篇处于渲染态）。 */
export function selectRender(state: State): RenderResult | null {
  return state.render;
}

/** 当前搜索结果。 */
export function selectSearchHits(state: State): readonly SearchHit[] {
  return state.searchResults;
}

/** 当前打开的面板。 */
export function selectOverlay(state: State): OverlayKind {
  return state.overlay;
}
