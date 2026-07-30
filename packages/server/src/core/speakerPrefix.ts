/**
 * 去掉模型在回复开头自带的「说话人：」前缀。
 *
 * 这是一对一私聊，不是群聊，回复里不该出现任何名牌。但模型见过太多聊天记录
 * 语料，经常自己加上 `SOOYA：`、`用户：`，甚至把对方的昵称当前缀写成
 * `小七：`——尤其是在上下文里带了摘要（摘要本身是 `用户: …` 这种转录格式）之后。
 *
 * 判定刻意保守：只认已知名牌（通用称呼 + 人格名 + 调用方给出的名字），
 * 或者 `【任意】：` 这种一眼就是转录格式的方括号名牌。像「结论：」「提醒：」
 * 这类正常开头必须留着，所以不能用「短词 + 冒号」这种通用规则。
 */

const GENERIC_LABELS = [
  '用户', '我', '你', '助手', '机器人', '小助手', '主人',
  'sooya', 'assistant', 'ai', 'user', 'me', 'bot', 'system'
];

const COLON = '[:：]';
/** 名牌外面可能包着 【】、[]、() 或 markdown 的粗体/斜体记号。 */
const OPEN = '[\\s>*_~`"“「【\\[(]*';
const CLOSE = '[\\s*_~`"”」】\\])]*';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `【任意内容】：` / `[任意内容]:` 只可能是转录格式，与正常句子不会混。 */
const BRACKETED = new RegExp(`^\\s*(?:【[^】\\n]{1,24}】|\\[[^\\]\\n]{1,24}\\])\\s*${COLON}?\\s*`);

/**
 * @param text  模型输出的最终文本
 * @param names 额外要当成名牌的名字，例如人格名、用户昵称
 */
export function stripSpeakerPrefix(text: string, names: Array<string | null | undefined> = []): string {
  if (!text) return text;

  const labels = [
    ...GENERIC_LABELS,
    ...names
      .map((name) => (name ?? '').trim())
      .filter((name) => name.length > 0 && name.length <= 24)
      .map((name) => name.toLowerCase())
  ];
  const unique = [...new Set(labels)].sort((a, b) => b.length - a.length);
  const labelPattern = new RegExp(
    `^${OPEN}(?:${unique.map(escapeRegExp).join('|')})${CLOSE}\\s*${COLON}\\s*`,
    'i'
  );

  let result = text;
  // 最多剥两层：偶尔会出现 `【SOOYA】：SOOYA：你好`。
  for (let round = 0; round < 2; round++) {
    const before = result;
    result = result.replace(labelPattern, '');
    if (result === before) result = result.replace(BRACKETED, '');
    if (result === before) break;
    // 整段只有一个名牌时不要把内容清空。
    if (!result.trim()) return before;
  }
  return result;
}
