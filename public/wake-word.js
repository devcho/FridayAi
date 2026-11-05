export function addressedText(input, { name = '프라이데이', requireWakeWord = true } = {}) {
  const text = String(input || '').trim();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split('').join('\\s*');
  const expression = new RegExp(`^(?:${escaped}|friday)(?:야|여)?(?=$|[\\s,，.!！?:：]|[가-힣])(?:[\\s,，.!！?:：]*)`, 'iu');
  const match = text.match(expression);
  return { addressed: !requireWakeWord || Boolean(match), text: match ? text.slice(match[0].length).trim() : text };
}
