export function speechText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '\n코드 내용은 화면에서 확인해 주세요.\n')
    .replace(/```[\s\S]*$/g, '\n코드 내용은 화면에서 확인해 주세요.')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function speechChunks(markdown, size = 700, { firstSize = size } = {}) {
  const text = speechText(markdown);
  if (!text) return [];
  const chunks = [];
  let rest = text;
  let limit = Math.max(2, Math.min(size, firstSize));
  while (rest) {
    const piece = rest.slice(0, limit);
    const first = chunks.length === 0 && firstSize < size;
    const boundary = first
      ? piece.search(/\n|[.!?](?=\s)|[。！？]/)
      : Math.max(piece.lastIndexOf('\n'), piece.lastIndexOf('. '), piece.lastIndexOf('! '), piece.lastIndexOf('? '), piece.lastIndexOf('。'));
    if (rest.length <= limit && (!first || boundary < 0 || boundary + 1 === rest.length)) break;
    let end = boundary >= (first ? 0 : limit / 3) ? boundary + 1 : limit;
    if (end === limit && piece.lastIndexOf(' ') >= limit / 3) end = piece.lastIndexOf(' ');
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
    limit = size;
  }
  if (rest) chunks.push(rest);
  return chunks;
}
