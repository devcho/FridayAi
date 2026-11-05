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

export function speechChunks(markdown, size = 700) {
  const text = speechText(markdown);
  if (!text) return [];
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    const piece = rest.slice(0, size);
    const boundary = Math.max(piece.lastIndexOf('\n'), piece.lastIndexOf('. '), piece.lastIndexOf('! '), piece.lastIndexOf('? '), piece.lastIndexOf('。'));
    let end = boundary >= size / 3 ? boundary + 1 : size;
    if (end === size && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    chunks.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
