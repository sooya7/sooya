import ConsoleApp from './console/ConsoleApp.js';

/**
 * QQ 单通道（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §13/§14）：QQ 是唯一聊天通道，
 * Web 只保留管理后台。/admin/* 是入口；旧地址（/gallery、旧子页、/console）
 * 由后台自己跳到对应的新页面。
 */
export default function AppShell() {
  return <ConsoleApp />;
}