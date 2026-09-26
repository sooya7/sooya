// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DecisionModelEditor } from './DecisionModelEditor.js';
const api = vi.hoisted(() => ({ updateModels: vi.fn(async (patch) => ({ models: patch })), testBehaviorDecision: vi.fn(async () => ({ ok: true, result: { memory: 'review', probabilities: { memory: 0.6, image: 0.1, video: 0.01, voice: 0.99 } } })) }));
vi.mock('../lib/admin.js', () => ({ adminApi: api }));
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.clearAllMocks(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const saved = { provider: 'aliyun-beijing', apiKeyConfigured: true, enabled: true, baseUrl: 'https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'decision-model-preview' };
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === text)!;
it('switches providers with the correct model and prevents reusing the previous provider secret', async () => {
  await act(async () => root.render(<DecisionModelEditor config={saved} onSaved={vi.fn()} onNotice={vi.fn()} />));
  const select = container.querySelector('select')!;
  await act(async () => { select.value = 'typesafe'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('测试已保存配置').disabled).toBe(true);
  await act(async () => button('保存行为决策配置').click());
  expect(api.updateModels).toHaveBeenCalledWith({ decision: expect.objectContaining({ provider: 'typesafe', model: 'jev-latest', baseUrl: 'https://api.typesafe.ai/v1', apiKey: '' }) });
});
it('tests saved settings without invoking generation and displays probabilities', async () => {
  await act(async () => root.render(<DecisionModelEditor config={saved} onSaved={vi.fn()} onNotice={vi.fn()} />));
  await act(async () => button('测试已保存配置').click());
  expect(api.testBehaviorDecision).toHaveBeenCalledTimes(1);
  expect(api.updateModels).not.toHaveBeenCalled();
  expect(container.textContent).toContain('语音 99.0%');
  expect(container.textContent).toContain('交由现有记忆流程复核');
});
