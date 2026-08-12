// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAdminPage } from './McpAdminPage.js';

const adminMocks = vi.hoisted(() => ({
  mcpOverview: vi.fn(async () => ({
    configSource: '/opt/sooya/shared/config/mcp.json',
    globalPolicy: { readEnabled: true, writeEnabled: true, maintenanceEnabled: true },
    servers: [{
      id: 'ombre',
      enabled: true,
      url: 'http://127.0.0.1:18001/mcp',
      transport: 'streamable-http',
      authConfigured: true,
      required: false,
      state: 'ready',
      toolCount: 2,
      latencyMs: 18
    }],
    tools: [
      {
        name: 'ombre.breath',
        serverId: 'ombre',
        description: 'UNIQUE LONG TOOL DESCRIPTION THAT SHOULD STAY HIDDEN UNTIL THE TOOL IS OPENED',
        risk: 'read',
        phases: ['reply', 'proactive'],
        authorized: true
      },
      {
        name: 'ombre.hold',
        serverId: 'ombre',
        description: 'write memory',
        risk: 'write',
        phases: ['memory_commit'],
        authorized: true
      }
    ],
    memory: {
      backend: 'ombre',
      connection: 'connected',
      health: null,
      lastCommit: null,
      pending: 0,
      uncertain: 0,
      lastDream: null,
      dashboardUrl: null
    },
    dashboardUrl: null
  })),
  mcpToolSchema: vi.fn(async (name: string) => ({
    tool: {
      name,
      serverId: 'ombre',
      description: 'UNIQUE LONG TOOL DESCRIPTION THAT SHOULD STAY HIDDEN UNTIL THE TOOL IS OPENED',
      risk: 'read',
      phases: ['reply', 'proactive'],
      authorized: true,
      inputSchema: { type: 'object', properties: {} }
    }
  })),
  testMcpServer: vi.fn(),
  refreshMcpTools: vi.fn()
}));

vi.mock('../../lib/admin.js', () => ({ adminApi: adminMocks }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  adminMocks.mcpOverview.mockClear();
  adminMocks.mcpToolSchema.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('McpAdminPage', () => {
  it('keeps the tool registry collapsed and loads full details only on demand', async () => {
    await act(async () => {
      root!.render(<McpAdminPage onNotice={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1));
    expect(container!.textContent).toContain('工具与权限');
    expect(container!.textContent).toContain('读取 1 · 写入 1');
    expect(container!.querySelector('[data-testid="admin-mcp-tool-details"]')).toBeNull();
    expect(container!.textContent).not.toContain('UNIQUE LONG TOOL DESCRIPTION');

    const refresh = container!.querySelector('[data-testid="admin-mcp-status-refresh"]') as HTMLButtonElement;
    expect(refresh.textContent).toBe('');
    expect(refresh.getAttribute('aria-label')).toBe('刷新 MCP 状态');
    expect(refresh.style.width).toBe('36px');
    expect(refresh.style.minWidth).toBe('36px');

    const toggle = container!.querySelector('[data-testid="admin-mcp-tools-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.click());

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container!.querySelector('[data-testid="admin-mcp-tool-details"]')).not.toBeNull();
    expect(container!.textContent).toContain('ombre.breath');
    expect(container!.textContent).not.toContain('UNIQUE LONG TOOL DESCRIPTION');

    const toolButton = container!.querySelector('.admin-mcp-tool-row') as HTMLButtonElement;
    await act(async () => {
      toolButton.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(adminMocks.mcpToolSchema).toHaveBeenCalledWith('ombre.breath'));
    expect(container!.querySelector('[role="dialog"]')?.textContent).toContain('UNIQUE LONG TOOL DESCRIPTION');
  });
});
