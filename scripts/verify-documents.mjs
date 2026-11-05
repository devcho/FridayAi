import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DocumentService } from '../lib/documents.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, 'data', `document-check-${Date.now()}`);
await fs.mkdir(workspace, { recursive: true });
const documents = new DocumentService({ projectRoot: root });
try {
  for (const format of ['docx','xlsx','pptx','hwpx','hwp']) {
    const prepared = await documents.prepare(workspace, { path: `프라이데이-문서검증.${format}`, title: '프라이데이 문서 검증', content: '# 프로젝트 계획\n한국어 문서 작성이 정상 동작합니다.\n- 로컬 실행\n- 문서 생성\n\n| 항목 | 수량 | 금액 |\n| --- | --- | --- |\n| 개발 | 2 | 1000 |\n| 검증 | 3 | 1500 |' });
    const result = await documents.commit(workspace, prepared);
    const read = await documents.read(workspace, result.path);
    assert.match(read.content, /한국어/); assert.match(read.content, /개발/);
    console.log(JSON.stringify({ format, verified: true, bytes: result.bytes, path: path.join(workspace, result.path) }));
  }
} finally { documents.dispose(); }
