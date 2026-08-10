import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PANEL = read('./AdminPanel.tsx');
const EDITORS = read('./FeatureAdminPage.tsx');
const SHELL = read('../AppShell.tsx');
const NAVIGATION = read('../lib/navigation.ts');

/**
 * The two admin pages are now one console. `e2e/features-1-9.e2e.ts` drives
 * the legacy `/admin/features` address and expects to land on the avatar tab and to reach the other
 * feature sections by their visible button names, so these are contracts, not
 * cosmetics.
 */
describe('merged admin console', () => {
  it('routes the console through canonical admin paths and keeps the legacy address recognizable', () => {
    expect(PANEL).toContain("if (normalized === '/admin/features') return 'avatar'");
    expect(NAVIGATION).toContain("normalized === '/admin'");
    expect(NAVIGATION).toContain("normalized.startsWith('/admin/')");
    expect(SHELL).toContain("route === 'admin'");
    expect(SHELL).not.toContain('FeatureAdminPage');
  });

  it('lets the console be entered at a chosen tab', () => {
    expect(PANEL).toContain("initialTab = 'overview'");
    expect(PANEL).toContain('useState<Tab>(() => tabFromAdminPath(window.location.pathname, initialTab))');
    expect(PANEL).toContain('adminPathForTab');
    expect(PANEL).toContain('beforeunload');
  });

  it('offers every section in one navigation', () => {
    // Voice-system convergence: the standalone「情绪语音」tab is gone; TTS
    // parameters live under 模型配置, behavior knobs under 助手配置.
    for (const label of ['概览', '助手配置', '双方头像', '她的生活', '模型配置', '内容管理', '存储治理', '运维与备份']) {
      expect(PANEL).toContain(`label: '${label}'`);
    }
    expect(PANEL).not.toContain("label: '情绪语音'");
  });

  it('renders each feature section from the shared editors', () => {
    for (const editor of ['AvatarEditor', 'StorageEditor']) {
      expect(EDITORS).toContain(`export function ${editor}(`);
    }
    expect(EDITORS).not.toContain('export function VoiceEditor(');
    expect(EDITORS).not.toContain('export function LifePanel(');
    expect(EDITORS).not.toContain('export function LifeAdminLink(');
    const featureImports = PANEL.match(/import \{([^}]+)\} from '\.\/FeatureAdminPage\.js';/)?.[1];
    for (const imported of ['AvatarEditor', 'emotionLabel', 'ReferencesEditor', 'StorageEditor']) {
      expect(featureImports).toContain(imported);
    }
    expect(featureImports).not.toContain('VoiceEditor');
    for (const branch of ["tab === 'avatar'", "tab === 'life'", "tab === 'storage'"]) {
      expect(PANEL).toContain(branch);
    }
    expect(PANEL).not.toContain("tab === 'voice'");
  });

  it('renders the life tab as the autonomous observation panel only', () => {
    expect(PANEL).toContain("import { LifeObservationPanel } from './life/LifeObservationPanel.js'");
    expect(PANEL).toContain('<LifeObservationPanel onNotice={setNotice} />');
    expect(PANEL).not.toContain('LifeAdminLink');
    expect(SHELL).not.toContain('LifeAdminPage');
    expect(SHELL).not.toContain('isLifeConsole');
  });

  it('keeps a single page shell so the duplicate console cannot come back', () => {
    expect(EDITORS).not.toContain('export default function');
    expect(EDITORS).not.toContain('admin-lock');
  });

  /**
   * ci run 117 caught what the contracts above could not: the console header
   * renders the active tab title as an `h1`, and every embedded editor repeated
   * that exact title as its own `h2`. Two headings with one accessible name is a
   * strict-mode violation for `getByRole('heading', { name })`, which is how
   * `features-1-9.e2e.ts` finds the avatar section, and it read as a flake
   * because whichever heading mounted second decided the outcome.
   */
  it('never repeats a tab title as a heading inside an editor', () => {
    const titles = [...PANEL.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
    expect(titles.length).toBeGreaterThanOrEqual(8);
    const headings = [...EDITORS.matchAll(/<h[12]>([^<{]+)<\/h[12]>/g)].map((m) => m[1]);
    expect(headings.filter((h) => titles.includes(h))).toEqual([]);
  });

  /**
   * The console notice used to stay on screen forever once set — "人设已保存"
   * outlived its welcome by hours. It goes through useAutoNotice now, whose
   * 5-second auto-clear has behavioral tests in lib/autoNotice.test.tsx.
   */
  it('auto-dismisses the console notice instead of pinning it forever', () => {
    expect(PANEL).toContain('useAutoNotice');
    expect(PANEL).toContain('const [notice, setNotice] = useAutoNotice()');
    expect(PANEL).not.toContain('const [notice, setNotice] = useState');
  });

  it('routes top-level links without losing the unsaved-change guard', () => {
    expect(PANEL).toContain("import { AppLink } from './AppLink.js'");
    expect(PANEL).toContain('confirmRouteLeave');
    expect(PANEL).toContain("navigate(adminPathForTab(tab))");
    expect(PANEL).not.toContain("<a className=\"admin-side-action\" href=\"/\"");
  });
});
