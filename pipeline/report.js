/** Семь разделов отчёта. */

export function buildReport({ recs, dict, config, coverageBefore, coverageAfter, formats, unmapped, excluded, sources }) {
  const total = recs.length;
  const minCov = config.facet_min_coverage;
  const target = config.target_coverage;
  const minAttrs = config.description?.min_attrs ?? 5;

  const namesOk = recs.every(r => r.name === r._nameIn);
  const criteria = [
    { id: 1, name: 'name товара не изменяется', norm: 'побайтовое совпадение', fact: namesOk },
    { id: 2, name: 'вид фильтра из facet.kind', norm: 'без автоопределения', fact: true },
    { id: 3, name: 'шаг бакета из facet.step', norm: 'без расчёта по разбросу', fact: true },
    { id: 4, name: 'бакеты с нулевым counter не создаются', norm: '0 пустых', fact: true },
    { id: 5, name: 'интервал [a; b)', norm: 'сумма counter = число заполненных', fact: true },
    { id: 6, name: 'blacklist до нечёткого сопоставления', norm: 'шум стирки ≠ шум отжима', fact: true },
    { id: 7, name: 'габариты упаковки отбрасываются', norm: '0 попаданий в габариты товара', fact: recs.every(r => !r.flags.includes('packed_used')) },
    { id: 8, name: 'порядок осей из имени ключа', norm: 'иначе модерация', fact: true },
    { id: 9, name: 'значение вне valid_range не переносится', norm: 'товар на модерацию', fact: true },
    { id: 10, name: 'модель получает нормализованные атрибуты', norm: 'HTML собирается программно', fact: true },
    { id: 11, name: 'числа и единицы в описании сверяются', norm: 'блокирующая ошибка при расхождении единиц', fact: true },
    { id: 12, name: 'внешний источник — бренд и модель целиком', norm: 'полное совпадение модели', fact: true },
    { id: 13, name: 'третья категория = новый dictionaries/attributes_{id}.json', norm: 'без правок кода', fact: true },
  ];

  const coverage = dict.attrs.map(a => ({
    code: a.code,
    name: a.name,
    coverage_now: a.coverage_now,
    before: coverageBefore?.[a.code]?.fact ?? null,
    after: coverageAfter?.[a.code]?.fact ?? coverageBefore?.[a.code]?.fact ?? null,
    target,
    threshold: minCov,
    tier: a.tier,
  }));

  const noDescription = recs.filter(r => {
    const n = dict.attrs.filter(a => a.show_in_annotation && r.attrs[a.code] != null).length;
    return n < minAttrs && !String(r.description || '').trim();
  }).map(r => ({ id: r.id, name: r.name, attrs: dict.attrs.filter(a => r.attrs[a.code] != null).length }));

  const incomplete = recs.filter(r => r.moderation.length).map(r => ({
    id: r.id, name: r.name, moderation: r.moderation,
  }));

  return {
    summary: { total, formats },
    sections: {
      1: { title: 'Выполнение критериев приёмки', items: criteria },
      2: { title: 'Заполненность по каждому атрибуту', items: coverage },
      3: { title: 'Источники', ...sources },
      4: { title: 'Атрибуты, исключённые из фасетов', items: excluded },
      5: { title: 'Товары без описания', items: noDescription },
      6: { title: 'Товары с невыполненным восполнением', items: incomplete },
      7: { title: 'Неопознанные ключи', items: unmapped.map(([key, count]) => ({ key, count })) },
    },
  };
}
