import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PANEL = read('./AdminPanel.tsx');
const EDITORS = read('./FeatureAdminPage.tsx');
const MAIN = read('../main.tsx');

/**
 * The two admin pages are now one console. `e2e/features-1-9.e2e.ts` drives
 * `/admin/features` and expects to land on the avatar tab and to reach the other
 * feature sections by their visible button names, so these are contracts, not
 * cosmetics.
 */
describe('merged admin console', () => {
  it('enters the console on the avatar tab at /admin/features', () => {
    expect(MAIN).toContain('/admin/features');
    expect(MAIN).toContain('<AdminPanel initialTab="avatar" />');
    expect(MAIN).not.toContain('FeatureAdminPage');
  });

  it('lets the console be entered at a chosen tab', () => {
    expect(PANEL).toContain("initialTab = 'overview'");
    expect(PANEL).toContain('useState<Tab>(initialTab)');
  });

  it('offers every section in one navigation', () => {
    for (const label of ['概览', '助手配置', '双方头像', '情绪语音', '世界引擎', '模型配置', '内容管理', '存储治理', '运维与备份']) {
      expect(PANEL).toContain(`label: '${label}'`);
    }
  });

  it('renders each feature section from the shared editors', () => {
    for (const editor of ['AvatarEditor', 'VoiceEditor', 'WorldEditor', 'StorageEditor']) {
      expect(EDITORS).toContain(`export function ${editor}(`);
    }
    expect(PANEL).toContain("import { AvatarEditor, StorageEditor, VoiceEditor, WorldEditor } from './FeatureAdminPage.js'");
    for (const branch of ["tab === 'avatar'", "tab === 'voice'", "tab === 'world'", "tab === 'storage'"]) {
      expect(PANEL).toContain(branch);
    }
  });

  it('keeps a single page shell so the duplicate console cannot come back', () => {
    expect(EDITORS).not.toContain('export default function');
    expect(EDITORS).not.toContain('admin-lock');
  });
});
