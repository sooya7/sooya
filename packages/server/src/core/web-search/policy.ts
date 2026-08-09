import type { WebSearchFreshness } from './types.js';

export type WebSearchReason = 'none' | 'explicit' | 'local' | 'fresh_external';

export interface WebSearchDecision {
  offer: boolean;
  reason: WebSearchReason;
  freshness?: WebSearchFreshness;
}

const EXPLICIT_SEARCH = /(?:联网|上网|搜索|搜一下|查一下|查查|核实|求证)/iu;
const LOCAL_SCOPE = /(?:附近|周边|当地|本地|离我近|去哪(?:里|儿)?)/iu;
const LOCAL_TOPIC = /(?:吃|餐厅|饭店|咖啡|活动|展览|演出|景点|公园|商场|医院|药店|停车|充电|好玩|推荐)/iu;
const FRESHNESS = /(?:最新|最近|目前|当前|现在|今天|今日|本周|本月)/iu;
const EXTERNAL_TOPIC = /(?:新闻|消息|价格|版本|汇率|行情|交通|路况|比赛|赛事|比分|政策|规定|活动|展览|演出|天气|门票|营业|发布|更新)/iu;

export function decideWebSearch(input: string): WebSearchDecision {
  const text = input.trim();
  if (!text) return { offer: false, reason: 'none' };
  if (EXPLICIT_SEARCH.test(text)) return { offer: true, reason: 'explicit' };
  if (LOCAL_SCOPE.test(text) && LOCAL_TOPIC.test(text)) return { offer: true, reason: 'local' };
  if (FRESHNESS.test(text) && EXTERNAL_TOPIC.test(text)) {
    return {
      offer: true,
      reason: 'fresh_external',
      ...(/(?:今天|今日|现在|当前)/iu.test(text) ? { freshness: 'day' as const } : {})
    };
  }
  if (EXTERNAL_TOPIC.test(text) && /(?:多少|是什么|怎么样|有什(?:么|麽)|如何|是否|吗|呢|变化)/iu.test(text)) {
    return { offer: true, reason: 'fresh_external' };
  }
  return { offer: false, reason: 'none' };
}
