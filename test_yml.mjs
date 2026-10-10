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
const item = getAlbum(album.id, root, { light: false }).items[0];
// После slim: params[] → объект { name: value }.
assert.equal(item.feed.specs['Объем, мл'] ?? item.feed.specs?.[0]?.value, '250');
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

// Скачивание фото из фида: берём только настоящую картинку, иначе товар пропускается без вызова модели
{
  const http = await import('node:http');
  const { readPhotoFile } = await import('./pipeline/photos.js');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2000, 1)]);
  const srv = http.createServer((q, r) => {
    if (q.url === '/ok.png') return r.end(png);
    if (q.url === '/stub.png') { r.setHeader('content-type', 'text/html'); return r.end('<html>' + 'x'.repeat(3000)); }
    if (q.url === '/fake.png') return r.end(Buffer.alloc(3000, 65));       // «.png» без сигнатуры картинки
    if (q.url === '/tiny.png') return r.end(png.subarray(0, 100));
    r.statusCode = 404; r.end('no');
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mk = (name) => ({ ...xmlOffer, id: 'p-' + name, image_url: `${base}/${name}.png` });
  const xmlOffer = offers[0];
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  process.env.PHOTOS_DIR = path.join(root2, 'photos');
  const al = createAlbum('i', {}, root2);
  importFeedOffers(al.id, ['ok', 'stub', 'fake', 'tiny', 'missing'].map(mk), root2);
  const items = getAlbum(al.id, root2).items;
  const byName = n => items.find(i => i.product_id === 'p-' + n).id;
  assert.equal((await readPhotoFile(al.id, byName('ok'), root2)).mime, 'image/png');
  for (const n of ['stub', 'fake', 'tiny', 'missing']) {
    await assert.rejects(readPhotoFile(al.id, byName(n), root2), /изображение недоступно/, n);
  }
  srv.close();
  console.log('image validation ok');
}

// ML-выгрузка: полный набор полей + image_id, image = название товара; все described в файле
{
  const {
    photoExportRow, photoImageId, buildMlExport, applyDescribeResult,
    photosToYmlXml, escapeXml, PHOTO_EXPORT_KEYS, isPhotoExportable,
  } = await import('./pipeline/photos.js');
  const rootE = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-exp-'));
  process.env.PHOTOS_DIR = path.join(rootE, 'photos');
  const al = createAlbum('exp', {}, rootE);
  const imgUrl = 'https://static.groster.me/images/shop/67304082-4919-11f1-9ee8-74563c4adfb9.png';
  importFeedOffers(al.id, [{
    id: '0a0a255e-cb2a-11ee-9fb8-ac1f6b855a52',
    name: 'Агрокассета 10 ячеек 10/67, 700 мкм,цвет  черный',
    vendor: 'X',
    vendor_code: 'A-1',
    image_url: imgUrl,
    category: 'Агро › Кассеты',
    description: '',
    url: 'https://shop/p/1',
    params: [],
    synonyms: [],
  }, {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'Второй товар без описания',
    vendor: 'Y',
    vendor_code: 'B-2',
    image_url: 'https://static.groster.me/images/shop/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg',
    category: 'Агро',
    description: '',
    url: 'https://shop/p/2',
    params: [],
    synonyms: [],
  }], rootE);
  const items = getAlbum(al.id, rootE, { light: false }).items;
  assert.equal(items.length, 2);
  assert.equal(items[0].image_id, '67304082-4919-11f1-9ee8-74563c4adfb9');
  assert.equal(photoImageId(items[0]), '67304082-4919-11f1-9ee8-74563c4adfb9');
  assert.equal(isPhotoExportable(items[0]), false);

  await applyDescribeResult(al.id, items[0].id, {
    caption: 'Агрокассета на 10 ячеек',
    on_image: 'агрокассета, 10 ячеек',
    description: 'Описание кассеты для рассады.',
    alt: 'Черная агрокассета',
    tags: ['агрокассета', 'рассада'],
    attributes: { view: 'сверху', color: 'черный', product_type: 'агрокассета' },
  }, rootE);
  await applyDescribeResult(al.id, items[1].id, {
    caption: 'Второй товар',
    on_image: 'коробка',
    description: 'Короткое описание второго.',
    alt: 'Второй',
    tags: ['второй'],
    attributes: { view: 'front' },
  }, rootE);

  const after = getAlbum(al.id, rootE, { light: false }).items;
  assert.equal(after.filter(isPhotoExportable).length, 2);

  const row = photoExportRow(after[0]);
  assert.deepEqual(Object.keys(row), PHOTO_EXPORT_KEYS);
  assert.equal(row.image, 'Агрокассета 10 ячеек 10/67, 700 мкм,цвет  черный');
  assert.equal(row.product_id, '0a0a255e-cb2a-11ee-9fb8-ac1f6b855a52');
  assert.equal(row.image_id, '67304082-4919-11f1-9ee8-74563c4adfb9');
  assert.equal(row.objects, 'агрокассета, 10 ячеек');
  assert.ok(!('image_url' in row));
  assert.ok(!('name' in row));

  const pack = buildMlExport(al.id, { format: 'json' }, rootE);
  const arr = JSON.parse(pack.body);
  assert.equal(pack.count, 2);
  assert.equal(arr.length, 2, 'все описанные должны попасть в JSON');
  assert.equal(arr[0].image_id, row.image_id);
  assert.equal(arr[1].product_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  for (const r of arr) {
    assert.deepEqual(Object.keys(r), PHOTO_EXPORT_KEYS);
  }

  const jsonl = buildMlExport(al.id, { format: 'jsonl' }, rootE);
  assert.equal(jsonl.body.trim().split('\n').length, 2);

  assert.equal(escapeXml(`a<"&>'`), 'a&lt;&quot;&amp;&gt;&apos;');
  const xmlPack = buildMlExport(al.id, { format: 'xml' }, rootE);
  assert.equal(xmlPack.filename, `photos_${al.id}.xml`);
  assert.equal(xmlPack.count, 2);
  assert.match(xmlPack.mime, /xml/);
  assert.match(xmlPack.body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xmlPack.body, /<yml_catalog>/);
  assert.match(xmlPack.body, /<offer id="0a0a255e-cb2a-11ee-9fb8-ac1f6b855a52">/);
  assert.match(xmlPack.body, /<offer id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb">/);
  assert.match(xmlPack.body, /<name>Агрокассета 10 ячеек 10\/67, 700 мкм,цвет  черный<\/name>/);
  assert.match(xmlPack.body, /<picture>https:\/\/static\.groster\.me\/images\/shop\/67304082-4919-11f1-9ee8-74563c4adfb9\.png<\/picture>/);
  assert.match(xmlPack.body, /<caption>Агрокассета на 10 ячеек<\/caption>/);
  assert.match(xmlPack.body, /<objects>агрокассета, 10 ячеек<\/objects>/);
  assert.match(xmlPack.body, /<description>Описание кассеты для рассады\.<\/description>/);
  assert.match(xmlPack.body, /<alt>Черная агрокассета<\/alt>/);
  assert.match(xmlPack.body, /<tag>агрокассета<\/tag>/);
  assert.match(xmlPack.body, /<param name="view">сверху<\/param>/);
  assert.match(xmlPack.body, /<product_id>0a0a255e-cb2a-11ee-9fb8-ac1f6b855a52<\/product_id>/);
  assert.match(xmlPack.body, /<image_id>67304082-4919-11f1-9ee8-74563c4adfb9<\/image_id>/);
  const ymlAlias = buildMlExport(al.id, { format: 'yml' }, rootE);
  assert.equal(ymlAlias.filename, xmlPack.filename);
  assert.equal(ymlAlias.body, xmlPack.body);
  const direct = photosToYmlXml([row], { imageUrls: [imgUrl] });
  assert.match(direct, /<picture>/);

  // streamMlExport: те же байты, что buildMlExport, без пика RAM на весь файл.
  {
    const { streamMlExport, photoOfferXml } = await import('./pipeline/photos.js');
    assert.match(photoOfferXml(row, { picture: imgUrl }), /<picture>/);
    const chunks = [];
    const fakeRes = {
      destroyed: false,
      writableEnded: false,
      headers: null,
      writeHead(code, h) { this.statusCode = code; this.headers = h; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
      once() {},
      off() {},
    };
    const streamed = await streamMlExport(fakeRes, al.id, { format: 'xml' }, rootE);
    assert.equal(fakeRes.statusCode, 200);
    assert.equal(String(fakeRes.headers['X-Export-Count']), '2');
    assert.match(fakeRes.headers['Content-Type'], /xml/);
    const body = Buffer.concat(chunks).toString('utf8');
    assert.equal(body, xmlPack.body);
    assert.equal(streamed.count, 2);
  }
  console.log('ml export schema ok');
}
