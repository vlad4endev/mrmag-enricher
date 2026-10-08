import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYml, offerFacts, isUsablePictureUrl, parsePictures } from './pipeline/yml_feed.js';
import { createAlbum, importFeedOffers, getAlbum } from './pipeline/photos.js';

const xml = `<?xml version="1.0"?><yml_catalog><shop><name>T</name><url>https://shop.example</url><categories>
<category id="p1" url="x">Стеклянная тара</category><category id="c1" parentId="p1" url="y">Стеклянные банки</category></categories><offers>
<offer id="o1" available="true"><vendor>Aviora</vendor><vendorCode>104-127</vendorCode><name>Банка &quot;Твист&quot; 250 мл</name><description></description><url>u1</url><categoryId>c1</categoryId><picture>https://s/1.png</picture><price>5</price>
<param name="Объем, мл">250</param><param name="Хит">false</param><param name="Code">1</param><param name="Синоним">банка твист</param></offer>
<offer id="o2"><name>Без фото</name><categoryId>c1</categoryId></offer>
<offer id="o3"><name>Заглушка</name><categoryId>c1</categoryId><picture>https://shop.example/images/noimage.png</picture></offer>
<offer id="o4"><name>Сначала заглушка</name><categoryId>c1</categoryId>
<picture>https://shop.example/images/noimage.png</picture>
<picture>https://cdn.example/real/product.jpg</picture></offer>
<offer id="o5"><name>Относительный путь</name><categoryId>c1</categoryId><picture>/images/shop/item.webp</picture></offer>
</offers></shop></yml_catalog>`;

assert.equal(isUsablePictureUrl('https://s/1.png'), true);
assert.equal(isUsablePictureUrl('https://shop.example/images/noimage.png'), false);
assert.equal(isUsablePictureUrl('/local.png'), false);

// режем на куски по 7 байт: граница чанка не должна ломать разбор
const bytes = Buffer.from(xml);
const chunks = []; for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
const { offers, shopUrl } = await parseYml(chunks);
assert.equal(shopUrl, 'https://shop.example');
// o2 без picture, o3 только noimage — отброшены; o1, o4 (вторая picture), o5 (relative→absolute)
assert.equal(offers.length, 3);
{
  const filtered = await parseYml([xml], { limit: 50, filter: o => o.category.toLowerCase().includes('неттакогораздела') });
  assert.equal(filtered.offers.length, 0);
  assert.ok(filtered.stats.skipped_filter >= 1);
  assert.ok(filtered.stats.scanned >= 3);
}
const [o, oMulti, oRel] = offers;
assert.equal(o.name, 'Банка "Твист" 250 мл');
assert.equal(o.category, 'Стеклянная тара › Стеклянные банки');
assert.deepEqual(o.params, [{ name: 'Объем, мл', value: '250' }]); // служебные param отброшены
assert.deepEqual(offerFacts(o).specs, { 'Объем, мл': '250' });
assert.deepEqual(o.synonyms, ['банка твист']);
assert.equal(oMulti.image_url, 'https://cdn.example/real/product.jpg');
assert.deepEqual(parsePictures(`<picture>https://a/1.png</picture><picture>https://b/2.png</picture>`), [
  'https://a/1.png', 'https://b/2.png',
]);
assert.equal(oRel.image_url, 'https://shop.example/images/shop/item.webp');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-'));
process.env.PHOTOS_DIR = path.join(root, 'photos');
const album = createAlbum('t', {}, root);
const r = importFeedOffers(album.id, offers, root);
assert.equal(r.added, 3);
assert.equal(importFeedOffers(album.id, offers, root).added, 0); // повтор не дублирует
const item = getAlbum(album.id, root).items[0];
assert.equal(item.feed.specs[0].value, '250');
assert.equal(item.image_url, 'https://s/1.png');
assert.match(item.filename, /Банка/);
console.log('yml ok');

// Скачивание фото из фида: только напрямую (без прокси), только настоящая картинка
{
  const http = await import('node:http');
  const { readPhotoFile } = await import('./pipeline/photos.js');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2000, 1)]);
  let viaProxyAttempt = 0;
  const srv = http.createServer((q, r) => {
    if (q.url === '/ok.png') return r.end(png);
    if (q.url === '/stub.png') { r.setHeader('content-type', 'text/html'); return r.end('<html>' + 'x'.repeat(3000)); }
    if (q.url === '/fake.png') return r.end(Buffer.alloc(3000, 65));       // «.png» без сигнатуры картинки
    if (q.url === '/tiny.png') return r.end(png.subarray(0, 100));
    r.statusCode = 404; r.end('no');
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mk = (name) => ({ ...o, id: 'p-' + name, image_url: `${base}/${name}.png` });
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
  // прокси в коде скачивания картинок больше нет — попыток через providerFetch быть не должно
  assert.equal(viaProxyAttempt, 0);
  srv.close();
  console.log('image validation ok');
}

// noimage и пустые ссылки не попадают в альбом
{
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-'));
  process.env.PHOTOS_DIR = path.join(root3, 'photos');
  const al = createAlbum('n', {}, root3);
  const r3 = importFeedOffers(al.id, [
    { id: 'a', name: 'x', image_url: 'https://shop/images/noimage.png', params: [] },
    { id: 'b', name: 'y', image_url: '', params: [] },
    { id: 'c', name: 'z', image_url: 'https://cdn/ok.jpg', params: [] },
  ], root3);
  assert.equal(r3.added, 1);
  assert.equal(getAlbum(al.id, root3).items[0].image_url, 'https://cdn/ok.jpg');
  console.log('placeholder skip ok');
}

// Фид → vision: ссылка картинки уходит провайдеру, сервер CDN не качает (нет ECONNREFUSED/прокси)
{
  const { describePhoto, buildUserParts } = await import('./pipeline/photo_agent.js');
  const { loadPhotoForDescribe, applyDescribeResult } = await import('./pipeline/photos.js');
  const imgUrl = 'https://static.groster.me/images/shop/67304082-4919-11f1-9ee8-74563c4adfb9.png';
  const root4 = fs.mkdtempSync(path.join(os.tmpdir(), 'desc-'));
  process.env.PHOTOS_DIR = path.join(root4, 'photos');
  const al = createAlbum('d', {}, root4);
  importFeedOffers(al.id, [{
    id: 'feed-1',
    name: 'Банка Твист 250 мл',
    vendor: 'Aviora',
    vendor_code: '104-127',
    image_url: imgUrl,
    category: 'Стеклянная тара › Банки',
    description: '',
    url: 'https://shop/p/1',
    params: [{ name: 'Объем, мл', value: '250' }, { name: 'Цвет', value: 'Прозрачный' }],
    synonyms: ['твист'],
  }], root4);
  const itemId = getAlbum(al.id, root4).items[0].id;

  // loadPhotoForDescribe не ходит в сеть — только remote_url
  const file = await loadPhotoForDescribe(al.id, itemId, root4);
  assert.equal(file.remote_url, imgUrl);
  assert.equal(file.buf, null);
  assert.equal(file.item.feed.name, 'Банка Твист 250 мл');

  const parts = buildUserParts({
    imageUrl: file.remote_url,
    filename: file.item.filename,
    productId: file.item.product_id,
    dump: { name: file.item.feed.name, specs: { 'Объем, мл': '250' } },
    feed: true,
  });
  assert.equal(parts[1].image_url.url, imgUrl);
  assert.match(parts[0].text, /Банка Твист|Объем/);

  let captured = null;
  const notes = [];
  const result = await describePhoto(file, {
    model: 'test-vision',
    chatUrl: 'http://vision.test/v1/chat/completions',
    apiKey: 'k',
    onNote: (m) => notes.push(m),
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  caption: 'Банка твист 250 мл прозрачная',
                  on_image: 'банка, крышка, этикетка',
                  description: 'Стеклянная банка Твист объёмом 250 мл. Прозрачный корпус, как на фото.',
                  alt: 'Банка 250 мл',
                  tags: ['банка', 'твист', '250 мл', 'стекло'],
                  attributes: { view: 'packshot', color: 'прозрачный', product_type: 'банка' },
                  warnings: [],
                }),
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0 },
          });
        },
      };
    },
  });
  assert.ok(captured, 'vision-запрос ушёл');
  const content = captured.messages.find(m => m.role === 'user').content;
  const img = content.find(p => p.type === 'image_url');
  assert.equal(img.image_url.url, imgUrl, 'в vision ушла ссылка магазина, не data-URL');
  assert.match(content.find(p => p.type === 'text').text, /250/);
  assert.match(captured.messages[0].content, /ТОВАР ИЗ ФИДА|dump/i);
  assert.ok(notes.some(n => /ссылк/i.test(n)));
  assert.ok(!notes.some(n => /прокси|ECONNREFUSED|скачива/i.test(n)));

  const saved = applyDescribeResult(al.id, itemId, result, root4);
  assert.equal(saved.status, 'described');
  assert.ok(saved.description);
  assert.equal(getAlbum(al.id, root4).items[0].image_url, imgUrl);
  console.log('describe uses remote image url ok');
}

// Загруженный файл без image_url — по-прежнему data-URL из байтов
{
  const { describePhoto, buildUserParts } = await import('./pipeline/photo_agent.js');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2500, 9)]);
  const parts = buildUserParts({ mime: 'image/png', base64: png.toString('base64') });
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
  let captured = null;
  await describePhoto({ item: { filename: 'x.png' }, mime: 'image/png', buf: png }, {
    model: 'test-vision',
    chatUrl: 'http://vision.test/v1/chat/completions',
    fetchImpl: async (_u, init) => {
      captured = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              caption: 'Тест', on_image: 'x', description: 'Описание тестового фото для проверки.',
              alt: 't', tags: ['t'], attributes: {}, warnings: [],
            }) } }],
            usage: {},
          });
        },
      };
    },
  });
  const img = captured.messages.find(m => m.role === 'user').content.find(p => p.type === 'image_url');
  assert.deepEqual(Buffer.from(img.image_url.url.split(',')[1], 'base64'), png);
  console.log('describe uses local bytes ok');
}

// Куски фида склеиваются и парсятся как целый XML (обход nginx 413)
{
  const { acceptYmlChunk, discardYmlUpload } = await import('./pipeline/yml_chunks.js');
  const rootC = fs.mkdtempSync(path.join(os.tmpdir(), 'ych-'));
  process.env.PHOTOS_DIR = path.join(rootC, 'photos');
  const mid = Math.floor(xml.length / 2);
  const a = acceptYmlChunk(rootC, { upload_id: 'uploadtest01', part: 0, parts: 2, data: xml.slice(0, mid) });
  assert.equal(a.done, false);
  const b = acceptYmlChunk(rootC, { upload_id: 'uploadtest01', part: 1, parts: 2, data: xml.slice(mid) });
  assert.equal(b.done, true);
  const joined = fs.readFileSync(b.filePath, 'utf8');
  assert.equal(joined, xml);
  const parsed = await parseYml(fs.createReadStream(b.filePath));
  assert.equal(parsed.offers.length, 3);
  discardYmlUpload(rootC, b.uploadDir);
  assert.ok(!fs.existsSync(b.uploadDir));
  console.log('yml chunk upload ok');
}

// ML-выгрузка: полный набор полей + image_id, image = название товара
{
  const { photoExportRow, photoImageId, buildMlExport, applyDescribeResult } = await import('./pipeline/photos.js');
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
  }], rootE);
  const item = getAlbum(al.id, rootE).items[0];
  assert.equal(item.image_id, '67304082-4919-11f1-9ee8-74563c4adfb9');
  assert.equal(photoImageId(item), '67304082-4919-11f1-9ee8-74563c4adfb9');
  applyDescribeResult(al.id, item.id, {
    caption: 'Агрокассета на 10 ячеек',
    on_image: 'агрокассета, 10 ячеек',
    description: 'Описание кассеты для рассады.',
    alt: 'Черная агрокассета',
    tags: ['агрокассета', 'рассада'],
    attributes: { view: 'сверху', color: 'черный', product_type: 'агрокассета' },
  }, rootE);
  const row = photoExportRow(getAlbum(al.id, rootE).items[0]);
  assert.deepEqual(Object.keys(row), [
    'image', 'caption', 'objects', 'description', 'alt', 'tags', 'attributes', 'product_id', 'image_id',
  ]);
  assert.equal(row.image, 'Агрокассета 10 ячеек 10/67, 700 мкм,цвет  черный');
  assert.equal(row.product_id, '0a0a255e-cb2a-11ee-9fb8-ac1f6b855a52');
  assert.equal(row.image_id, '67304082-4919-11f1-9ee8-74563c4adfb9');
  assert.equal(row.objects, 'агрокассета, 10 ячеек');
  assert.ok(!('image_url' in row));
  assert.ok(!('name' in row));
  const pack = buildMlExport(al.id, { format: 'json' }, rootE);
  const arr = JSON.parse(pack.body);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].image_id, row.image_id);

  // XML как в фиде: yml_catalog / offer + те же ML-поля
  const { photosToYmlXml, escapeXml } = await import('./pipeline/photos.js');
  assert.equal(escapeXml(`a<"&>'`), 'a&lt;&quot;&amp;&gt;&apos;');
  const xmlPack = buildMlExport(al.id, { format: 'xml' }, rootE);
  assert.equal(xmlPack.filename, `photos_${al.id}.xml`);
  assert.match(xmlPack.mime, /xml/);
  assert.match(xmlPack.body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xmlPack.body, /<yml_catalog>/);
  assert.match(xmlPack.body, /<offer id="0a0a255e-cb2a-11ee-9fb8-ac1f6b855a52">/);
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
  console.log('ml export schema ok');
}

// Vision-промпт: контракт полей сохранён, объём урезан (токены system)
{
  const {
    defaultPhotoSystemPrompt, FEED_PROMPT_ADDENDUM, PHOTO_RESPONSE_SCHEMA, buildUserParts,
  } = await import('./pipeline/photo_agent.js');
  const sys = defaultPhotoSystemPrompt();
  const feed = FEED_PROMPT_ADDENDUM;
  for (const key of ['caption', 'on_image', 'description', 'alt', 'tags', 'attributes', 'warnings', 'product_type', 'brand_visible', 'text_on_image']) {
    assert.ok(sys.includes(key), `system missing ${key}`);
  }
  assert.ok(feed.includes('РЕЖИМ ФИДА'));
  assert.ok(feed.includes('dump'));
  assert.ok(sys.length < 1400, `system too long: ${sys.length}`);
  assert.ok(feed.length < 700, `feed addendum too long: ${feed.length}`);
  assert.ok((sys.length + feed.length) < 2000, `system+feed too long: ${sys.length + feed.length}`);
  const req = PHOTO_RESPONSE_SCHEMA.schema.required;
  assert.deepEqual(req, ['caption', 'on_image', 'description', 'alt', 'tags', 'attributes', 'warnings']);
  const parts = buildUserParts({
    imageUrl: 'https://cdn.example/a.png',
    filename: 'x',
    feed: true,
    dump: { name: 'Банка' },
  });
  const meta = JSON.parse(parts[0].text);
  assert.ok(meta.task.length < 80);
  assert.equal(meta.dump.name, 'Банка');
  console.log('photo prompt compact ok', sys.length + feed.length);
}
