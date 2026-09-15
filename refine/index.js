/**
 * Доводка готовых файлов обогащения — отдельный контур.
 * Не вызывает enrichProduct / POST /api/enrich / основной прогон.
 */

export { ingestPack, ingestProduct, detectCategory, detectShape, asProductList, asFilterList } from './ingest.js';
export { auditPack, auditProduct } from './audit.js';
export { repairPack, repairRecord } from './repair.js';
export { createRefineJobStore } from './jobs.js';

import { ingestPack } from './ingest.js';
import { auditPack } from './audit.js';
import { repairPack } from './repair.js';

/**
 * Синхронный анализ без записи на диск. Сеть не трогает.
 */
export function analyzeFiles(input, root = '.') {
  const pack = ingestPack({ ...input, root });
  const audit = auditPack(pack);
  return { pack, audit };
}

/**
 * Анализ + доработка. lookup=false — только то, что уже есть в файлах.
 */
export async function refineFiles(input, { lookup = true, onProgress = null, root = '.' } = {}) {
  const pack = ingestPack({ ...input, root });
  const result = await repairPack(pack, { lookup, onProgress });
  return result;
}
