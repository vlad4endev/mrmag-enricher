import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYml, offerFacts } from './pipeline/yml_feed.js';
import { createAlbum, importFeedOffers, getAlbum } from './pipeline/photos.js';

const xml = `<?xml version="1.0"?><yml_catalog><shop><categories>
<category id="p1" url="x">Стеклянная тара</category><category id="c1" parentId="p1" url="y">Стеклянные банки</category></categories><offers>
<offer id="o1" available="true"><vendor>Aviora</vendor><vendorCode>104-127</vendorCode><name>Банка &quot;Твист&quot; 250 мл</name><description></description><url>u1</url><categoryId>c1</categoryId><picture>https://s/1.png</picture><price>5</price>
<param name="Объем, мл">250</param><param name="Хит">false</param><param name="Code">1</param><param name="Синоним">банка твист</param></offer>
<offer id="o2"><name>Без фото</name><categoryId>c1</categoryId></offer></offers></shop></yml_catalog>`;

// режем на куски по 7 байт: граница чанка не должна ломать разбор
const bytes = Buffer.from(xml);
const chunks = []; for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
const { offers } = await parseYml(chunks);
assert.equal(offers.length, 2);
const [o] = offers;
assert.equal(o.name, 'Банка "Твист" 250 мл');
assert.equal(o.category, 'Стеклянная тара › Стеклянные банки');
assert.deepEqual(o.params, [{ name: 'Объем, мл', value: '250' }]); // служебные param отброшены
assert.deepEqual(offerFacts(o).specs, { 'Объем, мл': '250' });
assert.deepEqual(o.synonyms, ['банка твист']);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-'));
process.env.PHOTOS_DIR = path.join(root, 'photos');
const album = createAlbum('t', {}, root);
const r = importFeedOffers(album.id, offers, root);
assert.equal(r.added, 1);                      // оффер без фото пропущен
assert.equal(importFeedOffers(album.id, offers, root).added, 0); // повтор не дублирует
const item = getAlbum(album.id, root).items[0];
assert.equal(item.feed.specs[0].value, '250');
assert.equal(item.image_url, 'https://s/1.png');
console.log('yml ok');

// providerFetch отдаёт бинарное тело (картинки идут через него, если сайт магазина недоступен напрямую)
{
  const { providerFetch } = await import('./socks.js');
  const http = await import('node:http');
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 7]);
  const srv = http.createServer((q, r) => r.end(bin)).listen(0);
  const res = await providerFetch(`http://127.0.0.1:${srv.address().port}/x.png`, {}, { useProxy: false });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bin);
  let got = Buffer.alloc(0);
  for await (const c of res.body) got = Buffer.concat([got, c]);
  assert.deepEqual(got, bin);
  srv.close();
  console.log('binary ok');
}
