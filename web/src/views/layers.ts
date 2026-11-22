/**
 * 浮层宿主：让 DOM 里的浮层与 state.nav.layers 保持一致。
 *
 * 浮层栈是唯一事实：谁在栈里谁就挂着，不在栈里就摘掉。
 * 打开/关闭浮层只需要 dispatch layer/opened、layer/closed（或 nav/back），
 * 不再有「手写优先级链」与「重渲染后手动重新挂浮层」。
 */

import type { LayerKind, Mark, SearchHit, State, StateAction } from '../core/types';
import { allowsTransform, sheetDuration, type MotionLevel } from '../core/motion';
import { closeLookupCard, isLookupCardOpen } from './lookup';
import { createCollectionSheet, type CollectionSheet, type CollectionSpec } from './collection';
import { createCoverEditorSheet, type CoverEditorSheet } from './cover-editor';
import { createMarksSheet, type MarksInput, type MarksSheet } from './marks';
import type { DocCover } from '../core/types';
import { createNoteSheet, type NoteDraft, type NoteSheet } from './note';
import { createImageView } from './imageview';
import { createTableView } from './tableview';
import { renderMenu, type MenuItem, type MenuSpec } from './menu';
import { createSearchOverlay, renderTocDrawer } from './overlays';
import { enableSheetDrag, type SheetDragControl } from './sheet-drag';
import { createTypesetSheet, sheetLayer, type SheetView } from './typeset';
import { createWordbookSheet, type WordbookSheet, type WordbookTab } from './wordbook';

export interface LayerHandlers {
  /** 目录里点了某一项。 */
  pickToc: (bid: string) => void;
  /** 当前正在读的块（目录里高亮用）。 */
  activeBid: () => string | null;
  /** 搜索框输入了新关键词（已防抖）。 */
  query: (query: string) => void;
  /** 搜索结果里点了某一条。 */
  pickHit: (hit: SearchHit) => void;
  /** 当前菜单规格（main.ts 持有；不在栈里时返回 null）。 */
  menuSpec: () => MenuSpec | null;
  /** 当前要全屏查看的图片地址（main.ts 持有）。 */
  imageSrc: () => string | null;
  /** 当前要全屏横屏查看的表格节点（main.ts 持有）。 */
  tableElement: () => HTMLTableElement | null;
  /** 当前要编辑的标签/文件夹集合（main.ts 持有）。 */
  collectionSpec: () => CollectionSpec | null;
  /** 当前要编辑封面的文档 id（main.ts 持有）。 */
  coverDocId: () => string | null;
  pickCoverImage: () => Promise<string | null>;
  saveCover: (docId: string, cover: DocCover | null) => void;
  /** 备注面板草稿（main.ts 持有；null 表示没开）。 */
  noteDraft: () => NoteDraft | null;
  noteSave: (text: string) => void;
  noteCancel: () => void;
  /** 批注列表面板数据（列表按块顺序、失效项由 main 计算）。 */
  marksInput: () => MarksInput | null;
  marksRemove: (markId: string) => void;
  marksJump: (mark: Mark) => void;
  marksReanchor: (markId: string) => void;
  marksExport: () => void;
  /** 生词本 / 查词历史面板。 */
  wordbookInput: () => { words: ReadonlyArray<{ word: string; phonetic: string; translation: string; addedAt: number }>; history: ReadonlyArray<{ word: string; at: number }>; tab: WordbookTab } | null;
  wordbookRemove: (word: string) => void;
  wordbookClearWords: () => void;
  wordbookClearHistory: () => void;
  wordbookSwitchTab: (tab: WordbookTab) => void;
  /** 标签/文件夹面板的三个写操作（面板每次点击立即生效）。 */
  addTag: (docIds: readonly string[], tag: string) => void;
  removeTag: (docIds: readonly string[], tag: string) => void;
  setFolder: (docIds: readonly string[], folder: string | null) => void;
  /** 排版面板里改设置要派发的 action（面板自身只改 state，不做 IO）。 */
  dispatch: (action: StateAction) => void;
  /** 当前生效的动效强度（决定是否挂下拉手势）。 */
  motionLevel: () => MotionLevel;
  /** 用户点遮罩/关闭按钮。 */
  close: (layer: LayerKind) => void;
}

export interface LayerHost {
  sync(state: State): void;
}

export function createLayerHost(root: HTMLElement, handlers: LayerHandlers): LayerHost {
  let tocEl: HTMLElement | null = null;
  let search: { el: HTMLElement; update: (state: State) => void } | null = null;
  let menuEl: HTMLElement | null = null;
  let menuSpecRef: MenuSpec | null = null;
  let menuDrag: SheetDragControl | null = null;
  let typeset: { readonly sheet: SheetView; readonly layer: HTMLElement; readonly drag: SheetDragControl } | null = null;
  let collection: { readonly sheet: CollectionSheet; readonly layer: HTMLElement; readonly drag: SheetDragControl } | null = null;
  let coverEditor: { readonly sheet: CoverEditorSheet; readonly layer: HTMLElement; readonly drag: SheetDragControl; readonly docId: string } | null = null;
  let marksSheet: { readonly sheet: MarksSheet; readonly layer: HTMLElement; readonly drag: SheetDragControl } | null = null;
  let noteSheet: { readonly sheet: NoteSheet; readonly layer: HTMLElement; readonly drag: SheetDragControl } | null = null;
  let wordbookSheet: { readonly sheet: WordbookSheet; readonly layer: HTMLElement; readonly drag: SheetDragControl } | null = null;
  let image: { readonly el: HTMLElement; readonly destroy: () => void } | null = null;
  let table: { readonly el: HTMLElement; readonly destroy: () => void } | null = null;

  /** 当前是否允许「完整」动效（只有 full 才挂下拉手势，simple/off 用按钮关闭）。 */
  const dragEnabled = (): boolean => allowsTransform(handlers.motionLevel());

  return {
    sync(state) {
      const layers = state.nav.layers;

      // 目录
      if (layers.includes('toc') && state.render !== null) {
        if (tocEl === null) {
          tocEl = renderTocDrawer(
            state.render.toc,
            handlers.activeBid(),
            handlers.pickToc,
            () => handlers.close('toc'),
          );
          root.append(tocEl);
        }
      } else if (tocEl !== null) {
        tocEl.remove();
        tocEl = null;
      }

      // 搜索
      if (layers.includes('search')) {
        if (search === null) {
          search = createSearchOverlay(
            state,
            handlers.query,
            handlers.pickHit,
            () => handlers.close('search'),
          );
          root.append(search.el);
          const input = search.el.querySelector<HTMLInputElement>('[data-testid="search-input"]');
          window.setTimeout(() => input?.focus(), 60);
        } else {
          search.update(state);
        }
      } else if (search !== null) {
        search.el.remove();
        search = null;
      }

      // 查词卡片：节点由 lookup.ts 自己管，这里只负责「栈里没有了就关掉」
      if (!layers.includes('lookup') && isLookupCardOpen()) closeLookupCard();

      // 菜单 / 底部面板 / 确认框：规格变了就换一个，栈里没有就拆掉
      if (layers.includes('menu')) {
        const spec = handlers.menuSpec();
        if (spec !== null && (menuEl === null || spec !== menuSpecRef)) {
          menuEl?.remove();
          menuDrag?.destroy();
          menuDrag = null;
          menuSpecRef = spec;
          menuEl = renderMenu(
            spec,
            (item: MenuItem) => {
              // 先关浮层再执行回调：回调里可能打开另一个菜单（删除确认），
              // 关在前才能让新菜单拿到干净的栈。
              handlers.close('menu');
              item.onSelect();
            },
            () => handlers.close('menu'),
          );
          root.append(menuEl);
          // sheet 变体的菜单支持下拉关闭（任务书 §4.2）
          if (spec.variant === 'sheet') {
            const panel = menuEl.querySelector<HTMLElement>('.menu-panel');
            const scrim = menuEl.querySelector<HTMLElement>('.menu-layer__scrim');
            const handle = menuEl.querySelector<HTMLElement>('.menu-panel__handle');
            if (panel !== null) {
              menuDrag = enableSheetDrag({
                panel,
                scrim,
                handle,
                enabled: dragEnabled(),
                durationMs: sheetDuration(handlers.motionLevel()),
                onDismiss: () => handlers.close('menu'),
              });
            }
          }
        }
      } else if (menuEl !== null) {
        menuDrag?.destroy();
        menuDrag = null;
        menuEl.remove();
        menuEl = null;
        menuSpecRef = null;
      }

      // 排版面板（Aa）：开着时随设置变化同步控件值，不重建面板（拖动中的滑块不能被换掉）
      if (layers.includes('typeset')) {
        if (typeset === null) {
          const sheet = createTypesetSheet(state, handlers.dispatch);
          const layer = sheetLayer(sheet.el, () => handlers.close('typeset'));
          const drag = enableSheetDrag({
            panel: sheet.el,
            scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
            handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
            enabled: dragEnabled(),
            durationMs: sheetDuration(handlers.motionLevel()),
            onDismiss: () => handlers.close('typeset'),
          });
          typeset = { sheet, layer, drag };
          root.append(layer);
        }
        typeset.sheet.update(state);
      } else if (typeset !== null) {
        typeset.drag.destroy();
        typeset.layer.remove();
        typeset = null;
      }

      // 标签 / 文件夹面板（阶段 E1）：变更立即生效，面板在 state 变化时重建选中态
      if (layers.includes('collection')) {
        const spec = handlers.collectionSpec();
        if (spec !== null) {
          if (collection === null) {
            const sheet = createCollectionSheet(spec, state, {
              addTag: (tag) => handlers.addTag(spec.docIds, tag),
              removeTag: (tag) => handlers.removeTag(spec.docIds, tag),
              setFolder: (folder) => handlers.setFolder(spec.docIds, folder),
              close: () => handlers.close('collection'),
            });
            const layer = sheetLayer(sheet.el, () => handlers.close('collection'), {
              testId: 'collection-layer',
              closeTestId: 'collection-close',
              closeLabel: '关闭面板',
            });
            const drag = enableSheetDrag({
              panel: sheet.el,
              scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
              handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
              enabled: dragEnabled(),
              durationMs: sheetDuration(handlers.motionLevel()),
              onDismiss: () => handlers.close('collection'),
            });
            collection = { sheet, layer, drag };
            root.append(layer);
          }
          collection.sheet.update(state);
        }
      } else if (collection !== null) {
        collection.drag.destroy();
        collection.layer.remove();
        collection = null;
      }

      // 封面编辑面板
      if (layers.includes('cover')) {
        const docId = handlers.coverDocId();
        const doc = docId !== null ? (state.docs.find((d) => d.id === docId) ?? null) : null;
        if (doc !== null) {
          if (coverEditor === null || coverEditor.docId !== doc.id) {
            if (coverEditor !== null) {
              coverEditor.drag.destroy();
              coverEditor.layer.remove();
            }
            const sheet = createCoverEditorSheet(doc, {
              pickImage: handlers.pickCoverImage,
              save: handlers.saveCover,
              close: () => handlers.close('cover'),
            });
            const layer = sheetLayer(sheet.el, () => handlers.close('cover'), {
              testId: 'cover-editor-layer',
              closeTestId: 'cover-editor-close',
              closeLabel: '关闭封面编辑',
            });
            const drag = enableSheetDrag({
              panel: sheet.el,
              scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
              handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
              enabled: dragEnabled(),
              durationMs: sheetDuration(handlers.motionLevel()),
              onDismiss: () => handlers.close('cover'),
            });
            coverEditor = { sheet, layer, drag, docId: doc.id };
            root.append(layer);
          }
        }
      } else if (coverEditor !== null) {
        coverEditor.drag.destroy();
        coverEditor.layer.remove();
        coverEditor = null;
      }

      // 批注列表（阶段 E2）
      if (layers.includes('marks')) {
        const input = handlers.marksInput();
        if (input !== null) {
          if (marksSheet === null) {
            const sheet = createMarksSheet(input, {
              jump: (mark) => handlers.marksJump(mark),
              remove: (markId) => handlers.marksRemove(markId),
              reanchor: (markId) => handlers.marksReanchor(markId),
              exportMarkdown: () => handlers.marksExport(),
            });
            const layer = sheetLayer(sheet.el, () => handlers.close('marks'), {
              testId: 'marks-layer',
              closeTestId: 'marks-close',
              closeLabel: '关闭批注',
            });
            const drag = enableSheetDrag({
              panel: sheet.el,
              scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
              handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
              enabled: dragEnabled(),
              durationMs: sheetDuration(handlers.motionLevel()),
              onDismiss: () => handlers.close('marks'),
            });
            marksSheet = { sheet, layer, drag };
            root.append(layer);
          }
          marksSheet.sheet.update(input);
        }
      } else if (marksSheet !== null) {
        marksSheet.drag.destroy();
        marksSheet.layer.remove();
        marksSheet = null;
      }

      // 备注面板（阶段 E2）
      if (layers.includes('note')) {
        const draft = handlers.noteDraft();
        if (draft !== null) {
          if (noteSheet === null) {
            const sheet = createNoteSheet(draft, {
              save: (text) => handlers.noteSave(text),
              cancel: () => handlers.noteCancel(),
            });
            const layer = sheetLayer(sheet.el, () => handlers.noteCancel(), {
              testId: 'note-layer',
              closeTestId: 'note-close',
              closeLabel: '关闭备注',
            });
            const drag = enableSheetDrag({
              panel: sheet.el,
              scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
              handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
              enabled: dragEnabled(),
              durationMs: sheetDuration(handlers.motionLevel()),
              onDismiss: () => handlers.noteCancel(),
            });
            noteSheet = { sheet, layer, drag };
            root.append(layer);
          }
        }
      } else if (noteSheet !== null) {
        noteSheet.drag.destroy();
        noteSheet.layer.remove();
        noteSheet = null;
      }

      // 生词本 / 查词历史（阶段 E4）
      if (layers.includes('wordbook')) {
        const input = handlers.wordbookInput();
        if (input !== null) {
          if (wordbookSheet === null) {
            const sheet = createWordbookSheet(input, {
              removeWord: (word) => handlers.wordbookRemove(word),
              clearWords: () => handlers.wordbookClearWords(),
              clearHistory: () => handlers.wordbookClearHistory(),
              switchTab: (tab) => handlers.wordbookSwitchTab(tab),
            });
            const layer = sheetLayer(sheet.el, () => handlers.close('wordbook'), {
              testId: 'wordbook-layer',
              closeTestId: 'wordbook-close',
              closeLabel: '关闭生词本',
            });
            const drag = enableSheetDrag({
              panel: sheet.el,
              scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
              handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
              enabled: dragEnabled(),
              durationMs: sheetDuration(handlers.motionLevel()),
              onDismiss: () => handlers.close('wordbook'),
            });
            wordbookSheet = { sheet, layer, drag };
            root.append(layer);
          }
          wordbookSheet.sheet.update(input);
        }
      } else if (wordbookSheet !== null) {
        wordbookSheet.drag.destroy();
        wordbookSheet.layer.remove();
        wordbookSheet = null;
      }

      // 全屏图片：地址变了就换一张（通常只会打开一次）
      if (layers.includes('image')) {
        const src = handlers.imageSrc();
        if (src !== null && image === null) {
          image = createImageView(src, () => handlers.close('image'));
          root.append(image.el);
        }
      } else if (image !== null) {
        image.destroy();
        image.el.remove();
        image = null;
      }

      // 全屏表格：打开时自动切横屏（由 main 订阅 layers 同步屏幕方向）
      if (layers.includes('table')) {
        const sourceTable = handlers.tableElement();
        if (sourceTable !== null && table === null) {
          table = createTableView(sourceTable, () => handlers.close('table'));
          root.append(table.el);
        }
      } else if (table !== null) {
        table.destroy();
        table.el.remove();
        table = null;
      }
    },
  };
}
