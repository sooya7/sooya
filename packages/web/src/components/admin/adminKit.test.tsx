// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataList } from './DataList.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ModalSheet } from './ModalSheet.js';
import { AdminState, adminStateFromError } from './AdminState.js';
import { ApiError } from '../../lib/api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(node); });
}

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Row { id: string; name: string; detail: string; }

const rows: Row[] = [
  { id: 'a', name: '家', detail: '多行详情' },
  { id: 'b', name: '咖啡馆', detail: '另一个详情' }
];

describe('DataList responsive structure', () => {
  it('renders a table whose cells carry data-label attributes for the mobile card transform', async () => {
    await render(
      <DataList<Row>
        rows={rows}
        rowKey={(r) => r.id}
        columns={[
          { key: 'name', label: '名称', render: (r) => r.name },
          { key: 'detail', label: '细节', mobileCollapsed: true, render: (r) => r.detail }
        ]}
      />
    );
    const cells = container!.querySelectorAll('td');
    expect(container!.querySelector('thead th')?.textContent).toBe('名称');
    expect(cells[0]?.getAttribute('data-label')).toBe('名称');
    // The mobile transform hides this cell until expanded (CSS gate, attr is the hook).
    expect(cells[1]?.getAttribute('data-collapse-on-mobile')).toBe('true');
    expect(container!.textContent).toContain('家');
  });

  it('toggles expansion: aria-expanded flips and the detail row appears', async () => {
    await render(
      <DataList<Row>
        rows={rows}
        rowKey={(r) => r.id}
        expandable
        columns={[{ key: 'name', label: '名称', render: (r) => r.name }]}
        expandedRow={(r) => <div data-testid={`detail-${r.id}`}>{r.detail}</div>}
      />
    );
    expect(container!.querySelector('[data-testid="detail-a"]')).toBeNull();
    const toggle = container!.querySelector<HTMLButtonElement>('button.data-list-expand')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container!.querySelector('[data-testid="detail-a"]')?.textContent).toContain('多行详情');
    expect(container!.querySelector('[data-testid="detail-b"]')).toBeNull();
  });

  it('renders actions cell with a danger separator between groups', async () => {
    await render(
      <DataList<Row>
        rows={rows}
        rowKey={(r) => r.id}
        columns={[{ key: 'name', label: '名称', render: (r) => r.name }]}
        actions={() => (
          <>
            <button type="button" onClick={() => undefined}>主操作</button>
            <span className="danger-sep" aria-hidden="true" />
            <button type="button" className="admin-danger" onClick={() => undefined}>危险操作</button>
          </>
        )}
      />
    );
    const actionsCell = container!.querySelector('td.data-list-actions')!;
    expect(actionsCell.querySelector('.danger-sep')).not.toBeNull();
    expect(actionsCell.querySelector('.admin-danger')?.textContent).toBe('危险操作');
    expect(container!.textContent).toContain('主操作');
  });
});

describe('ModalSheet', () => {
  it('renders an accessible dialog when open and nothing when closed', async () => {
    await render(<ModalSheet open={false} title="标题" onClose={() => undefined}>内容</ModalSheet>);
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { root!.render(<ModalSheet open title="标题" onClose={() => undefined}>内容</ModalSheet>); });
    const dialog = container!.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('h3')?.textContent).toBe('标题');
    expect(container!.querySelector('.modal-sheet-close')).not.toBeNull();
  });

  it('closes on Esc and on backdrop click', async () => {
    const onClose = vi.fn();
    await render(<ModalSheet open title="标题" onClose={onClose}>内容</ModalSheet>);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    const backdrop = container!.querySelector('.modal-backdrop')!;
    await act(async () => { backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ConfirmDialog', () => {
  it('shows message, confirm and cancel; confirm invokes the action', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await render(<ConfirmDialog open title="停用地点" message="确定停用？" confirmLabel="停用" danger onConfirm={onConfirm} onClose={onClose} />);
    expect(container!.textContent).toContain('确定停用？');
    const buttons = container!.querySelectorAll('.confirm-dialog-actions button');
    expect(buttons[0]?.textContent).toBe('取消');
    expect(buttons[1]?.textContent).toBe('停用');
    await act(async () => { (buttons[1] as HTMLButtonElement).click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { (buttons[0] as HTMLButtonElement).click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AdminState', () => {
  it('renders every state kind with its data-testid', async () => {
    await render(<>
      <AdminState kind="loading" />
      <AdminState kind="empty" message="空" />
      <AdminState kind="error" message="错了" />
      <AdminState kind="flag-disabled" />
      <AdminState kind="unauthorized" />
      <AdminState kind="provider-unconfigured" />
    </>);
    const states = container!.querySelectorAll('[data-testid="admin-state"]');
    expect(states.length).toBe(6);
    expect(container!.textContent).toContain('空');
    expect(container!.textContent).toContain('错了');
  });

  it('maps ApiError statuses to kinds', () => {
    expect(adminStateFromError(new ApiError('no', 401)).kind).toBe('unauthorized');
    expect(adminStateFromError(new ApiError('未启用', 400)).kind).toBe('flag-disabled');
    expect(adminStateFromError(new ApiError('provider 未配置', 400)).kind).toBe('provider-unconfigured');
    expect(adminStateFromError(new ApiError('boom', 500)).kind).toBe('error');
  });
});
