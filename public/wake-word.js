export function addressedText(input, { name = '프라이데이', requireWakeWord = true } = {}) {
  const text = String(input || '').trim();
  const names = [name];
  if (name.replace(/\s/g, '') === '프라이데이') names.push('후라이데이', '프라이데', '프라이데이야', 'friday');
  const escaped = names.sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split('').join('\\s*')).join('|');
  const expression = new RegExp(`^(?:${escaped})(?:야|여)?(?=$|[\\s,，.!！?:：]|[가-힣])(?:[\\s,，.!！?:：]*)`, 'iu');
  const match = text.match(expression);
  return { addressed: !requireWakeWord || Boolean(match), text: match ? text.slice(match[0].length).trim() : text };
}
