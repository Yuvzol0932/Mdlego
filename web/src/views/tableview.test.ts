// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTableView } from './tableview';

function buildSampleTable(): HTMLTableElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <table data-bid="tbl-1" data-kind="table">
      <thead>
        <tr>
          <th data-bid="th-1" data-kind="th">单词</th>
          <th data-bid="th-2" data-kind="th">词性</th>
          <th data-bid="th-3" data-kind="th">核心释义</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td data-bid="td-1" data-kind="td">inspect</td>
          <td data-bid="td-2" data-kind="td">v.</td>
          <td data-bid="td-3" data-kind="td">检查，审视</td>
        </tr>
        <tr>
          <td data-bid="td-4" data-kind="td">prospect</td>
          <td data-bid="td-5" data-kind="td">n.</td>
          <td data-bid="td-6" data-kind="td">前景，展望</td>
        </tr>
      </tbody>
    </table>
  `;
  return wrap.querySelector('table') as HTMLTableElement;
}

function buildHeadlessTable(): HTMLTableElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <table data-bid="tbl-2" data-kind="table">
      <tbody>
        <tr>
          <td data-bid="td-10" data-kind="td">Alpha</td>
          <td data-bid="td-11" data-kind="td">Beta</td>
        </tr>
      </tbody>
    </table>
  `;
  return wrap.querySelector('table') as HTMLTableElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('表格全屏横屏查看浮层', () => {
  it('克隆表格与冻结表头均彻底剥离 data-bid / data-kind，移除顶部通栏并在 aria-label 保留行列统计', () => {
    const source = buildSampleTable();
    document.body.append(source);

    const view = createTableView(source, () => undefined);
    document.body.append(view.el);

    expect(source.querySelectorAll('[data-bid]').length).toBe(9);
    expect(view.el.querySelectorAll('[data-bid]').length).toBe(0);
    expect(view.el.querySelectorAll('[data-kind]').length).toBe(0);

    expect(view.el.querySelector('.tableview__bar')).toBeNull();
    expect(view.el.querySelector('[data-testid="table-view-head"]')).not.toBeNull();
    expect(view.el.querySelector('[data-testid="table-view-hud"]')).not.toBeNull();
    expect(view.el.classList.contains('tableview--no-head')).toBe(false);

    const ariaLabel = view.el.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('3 行');
    expect(ariaLabel).toContain('3 列');

    view.destroy();
  });

  it('无 thead 的表格不渲染冻结表头并附带 tableview--no-head 类', () => {
    const source = buildHeadlessTable();
    const view = createTableView(source, () => undefined);
    document.body.append(view.el);

    expect(view.el.querySelector('[data-testid="table-view-head"]')).toBeNull();
    expect(view.el.classList.contains('tableview--no-head')).toBe(true);

    view.destroy();
  });

  it('支持 A− / 100% / A+ 缩放与极限边界禁用状态（--tv-scale 写入根浮层）', () => {
    const source = buildSampleTable();
    const view = createTableView(source, () => undefined);
    document.body.append(view.el);

    const outBtn = view.el.querySelector<HTMLButtonElement>('[data-testid="table-zoom-out"]')!;
    const resetBtn = view.el.querySelector<HTMLButtonElement>('[data-testid="table-zoom-reset"]')!;
    const inBtn = view.el.querySelector<HTMLButtonElement>('[data-testid="table-zoom-in"]')!;

    expect(resetBtn.textContent).toBe('100%');
    expect(view.el.style.getPropertyValue('--tv-scale')).toBe('1');

    outBtn.click();
    expect(resetBtn.textContent).toBe('85%');
    expect(view.el.style.getPropertyValue('--tv-scale')).toBe('0.85');
    outBtn.click();
    expect(resetBtn.textContent).toBe('75%');
    expect(outBtn.disabled).toBe(true);

    resetBtn.click();
    expect(resetBtn.textContent).toBe('100%');
    expect(view.el.style.getPropertyValue('--tv-scale')).toBe('1');
    expect(outBtn.disabled).toBe(false);

    inBtn.click();
    inBtn.click();
    inBtn.click();
    expect(resetBtn.textContent).toBe('150%');
    expect(view.el.style.getPropertyValue('--tv-scale')).toBe('1.5');
    expect(inBtn.disabled).toBe(true);

    view.destroy();
  });

  it('点击关闭按钮与 Escape 键均可退出，destroy 后注销键盘监听', () => {
    const onClose = vi.fn();
    const view = createTableView(buildSampleTable(), onClose);
    document.body.append(view.el);

    view.el.querySelector<HTMLButtonElement>('[data-testid="table-view-close"]')?.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    view.destroy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
