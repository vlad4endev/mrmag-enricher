/**
 * Конструктор атрибутов: таблица + правая панель (AttributesEditor UX).
 * Данные — dictionaries/attributes_{id}.json через /api/dictionaries.
 */
(function () {
  'use strict';

  const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const TYPES = [
    { v: 'enum', t: 'enum' },
    { v: 'string', t: 'string' },
    { v: 'number', t: 'number' },
    { v: 'integer', t: 'integer' },
    { v: 'boolean', t: 'boolean' },
    { v: 'text', t: 'text' },
  ];
  const WIDGETS = [
    { v: 'checkbox', t: 'Чекбоксы' },
    { v: 'radio', t: 'Радио' },
    { v: 'slider', t: 'Слайдер' },
    { v: 'toggle', t: 'Переключатель' },
  ];

  let schemaAudit = null;
  let editCode = null;
  let listFilter = 'all';
  let listQuery = '';
  let marked = new Set();
  let importSuggestions = [];
  let issueActions = [];

  function $(id) { return document.getElementById(id); }

  function canonList(attr) {
    return Object.keys(attr.value_aliases || {});
  }

  function aliasesOf(attr, canon) {
    const list = (attr.value_aliases || {})[canon] || [];
    return list.filter(s => s !== canon);
  }

  function widgetOf(attr) {
    if (attr.facet?.widget) return attr.facet.widget;
    if (attr.type === 'boolean') return 'toggle';
    if (attr.facet?.kind === 'range') return 'slider';
    if (attr.facet?.kind === 'boolean') return 'toggle';
    return 'checkbox';
  }

  function isBrandAttr(attr) {
    const k = String(attr?.code || '').trim().toLowerCase();
    const n = String(attr?.name || '').trim().toLowerCase();
    const lab = String(attr?.facet?.label || '').trim().toLowerCase();
    return k === 'brand' || k === 'бренд' || n === 'бренд' || n === 'brand' || lab === 'бренд' || lab === 'brand';
  }

  function kindFromWidget(widget, type) {
    if (type === 'boolean' || widget === 'toggle') return 'boolean';
    if (widget === 'slider') return 'range';
    return 'enum';
  }

  function localIssues(attr, all) {
    const issues = [];
    if (!String(attr.code || '').trim()) issues.push({ level: 'error', text: 'Пустой key' });
    else if (!KEY_RE.test(attr.code)) issues.push({ level: 'error', text: 'key: латиница/цифры/_' });
    if (all.some(x => x !== attr && x.code === attr.code))
      issues.push({ level: 'error', text: 'Дубликат key' });
    if (!String(attr.name || '').trim()) issues.push({ level: 'error', text: 'Нет названия' });
    const canons = canonList(attr);
    if (attr.type === 'enum' && !canons.length)
      issues.push({ level: 'warn', text: 'enum без канонических значений' });
    if ((attr.type === 'number' || attr.type === 'integer') && !attr.unit)
      issues.push({ level: 'warn', text: 'У числового атрибута нет единицы' });
    if (attr.facet?.enabled && attr.type === 'enum' && canons.length > 40)
      issues.push({ level: 'warn', text: 'Слишком много значений для фасета' });
    const lower = canons.map(c => c.trim().toLowerCase());
    if (new Set(lower).size !== lower.length)
      issues.push({ level: 'error', text: 'Дубликаты значений' });
    const aud = (schemaAudit?.attributes || []).find(a => a.code === attr.code);
    (aud?.issues || []).forEach(i => {
      if (i.severity === 'error' || i.severity === 'warn')
        issues.push({ level: i.severity === 'error' ? 'error' : 'warn', text: i.message });
    });
    return issues;
  }

  function issueLevel(issues) {
    if (issues.some(i => i.level === 'error')) return 'err';
    if (issues.length) return 'warn';
    return '';
  }

  function markDirty(msg) {
    window.dictDirty = true;
    refreshSchemaMeta(msg || '');
    setDictButtons({ save: true, del: true, add: true });
  }

  window.refreshSchemaMeta = function refreshSchemaMeta(extra) {
    const el = $('dictMeta');
    if (!el) return;
    if (!window.dictCurrent) {
      el.innerHTML = extra ? `<span>${esc(extra)}</span>` : '';
      return;
    }
    const d = window.dictCurrent;
    const attrs = d.attrs || [];
    const facets = attrs.filter(a => a.facet?.enabled).length;
    const enums = attrs.filter(a => a.type === 'enum').length;
    const problems = attrs.filter(a => localIssues(a, attrs).length).length;
    el.innerHTML = `
      <code>${esc(d.file || ('dictionaries/attributes_' + d.id + '.json'))}</code>
      <b>${attrs.length}</b> атрибутов<i></i>
      <b>${facets}</b> в фильтрах<i></i>
      <b>${enums}</b> enum
      ${problems ? `<span class="ae-meta-warn">${problems} с проблемами</span>` : ''}
      ${window.dictDirty ? '<span class="ae-meta-dirty">не сохранено</span>' : ''}
      ${extra ? `<span>${esc(extra)}</span>` : ''}
    `;
    const set = (id, n) => { const nEl = $(id); if (nEl) nEl.textContent = String(n); };
    set('aeCntAll', attrs.length);
    set('aeCntFacet', facets);
    set('aeCntProblems', problems);
    set('aeCntEnum', enums);
  };

  function shownAttrs(attrs) {
    const q = listQuery;
    return [...attrs]
      .filter(a => {
        if (listFilter === 'facet') return !!a.facet?.enabled;
        if (listFilter === 'problems') return localIssues(a, attrs).length > 0;
        if (listFilter === 'enum') return a.type === 'enum';
        return true;
      })
      .filter(a => {
        if (!q) return true;
        const hay = [
          a.code, a.name, a.unit,
          ...canonList(a),
          ...Object.values(a.value_aliases || {}).flat(),
        ].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.code).localeCompare(String(b.code)));
  }

  window.setSchemaListFilter = function setSchemaListFilter(mode) {
    listFilter = mode || 'all';
    document.querySelectorAll('[data-sch-filter]').forEach(b => {
      b.classList.toggle('on', b.dataset.schFilter === listFilter);
    });
    renderSchemaTable(dictCurrent?.attrs || []);
  };

  window.onSchemaListFilter = function onSchemaListFilter() {
    listQuery = String($('schSearch')?.value || '').trim().toLowerCase();
    renderSchemaTable(dictCurrent?.attrs || []);
  };

  function chkHtml(on, attrs) {
    return `<button type="button" class="ae-chk ${on ? 'on' : ''}" ${attrs || ''}>${on ? '✓' : ''}</button>`;
  }

  window.renderSchemaTable = function renderSchemaTable(attrs) {
    const body = $('dictBody');
    if (!body) return;
    attrs = attrs || [];
    if (!attrs.length) {
      body.innerHTML = '<tr><td colspan="10" class="ae-none">Нет атрибутов — добавьте строку</td></tr>';
      refreshSchemaMeta();
      renderIdlePanel();
      return;
    }
    const rows = shownAttrs(attrs);
    const all = attrs;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="10" class="ae-none">Под фильтр ничего не попало</td></tr>';
    } else {
      body.innerHTML = rows.map(a => {
        const issues = localIssues(a, all);
        const lvl = issueLevel(issues);
        const canons = canonList(a);
        const vals = a.type === 'enum'
          ? (canons.length
            ? `<span class="ae-vals">${canons.slice(0, 3).map(v => `<span>${esc(v)}</span>`).join('')}${canons.length > 3 ? `<em>+${canons.length - 3}</em>` : ''}</span>`
            : '<span class="ae-warn-text">каноны не заданы</span>')
          : '<span class="ae-dash">—</span>';
        const typeOpts = TYPES.map(t =>
          `<option value="${t.v}" ${a.type === t.v ? 'selected' : ''}>${t.t}</option>`
        ).join('');
        return `<tr data-code="${esc(a.code)}" class="${editCode === a.code ? 'sel' : ''} ${lvl ? 'row-' + lvl : ''}">
          <td data-stop>${chkHtml(marked.has(a.code), `data-ae="mark"`)}</td>
          <td class="ae-ord" data-stop>
            <span class="ae-ord-n">${(a.order ?? 0)}</span>
            <span class="ae-ord-btns">
              <button type="button" data-ae="up" title="Выше">▲</button>
              <button type="button" data-ae="down" title="Ниже">▼</button>
            </span>
          </td>
          <td data-stop><input class="ae-cell mono" data-ae="code" value="${esc(a.code)}" spellcheck="false"></td>
          <td data-stop><input class="ae-cell" data-ae="name" value="${esc(a.name || '')}"></td>
          <td data-stop><select class="ae-cell" data-ae="type">${typeOpts}</select></td>
          <td data-stop><input class="ae-cell ae-unit" data-ae="unit" value="${esc(a.unit || '')}"></td>
          <td data-stop>${chkHtml(isBrandAttr(a) ? false : !!a.facet?.enabled, isBrandAttr(a)
            ? 'data-ae="facet" disabled aria-disabled="true" title="Бренд не фасет: сопоставление по id"'
            : 'data-ae="facet" title="В фильтрах"')}</td>
          <td data-stop>${chkHtml(!!a.show_in_annotation, 'data-ae="ann" title="Извлекать"')}</td>
          <td>${vals}</td>
          <td data-stop>
            <div class="ae-row-acts">
              ${lvl ? `<span class="ae-dot ae-dot-${lvl}" title="${esc(issues.map(i => i.text).join('; '))}"></span>` : ''}
              <button type="button" class="ae-icon-btn danger" data-ae="del" title="Удалить">×</button>
            </div>
          </td>
        </tr>`;
      }).join('');
    }

    const visibleCodes = rows.map(a => a.code);
    const allMarked = visibleCodes.length > 0 && visibleCodes.every(c => marked.has(c));
    const markAll = $('aeMarkAll');
    if (markAll) {
      markAll.classList.toggle('on', allMarked);
      markAll.textContent = allMarked ? '✓' : '';
    }
    updateBulkBar();

    body.querySelectorAll('tr[data-code]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-stop]')) return;
        openSchemaEditor(tr.dataset.code);
      });
      tr.querySelectorAll('[data-ae]').forEach(el => {
        const act = el.dataset.ae;
        if (act === 'mark' || act === 'facet' || act === 'ann' || act === 'up' || act === 'down' || act === 'del') {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            onRowAction(tr.dataset.code, act);
          });
        } else {
          el.addEventListener('focus', () => openSchemaEditor(tr.dataset.code, { keepPanel: true }));
          el.addEventListener('change', () => onCellEdit(tr.dataset.code, act, el));
          if (el.tagName === 'INPUT') {
            el.addEventListener('input', () => { window.dictDirty = true; });
          }
        }
      });
    });

    const hint = $('schListHint');
    if (hint) {
      hint.textContent = rows.length === attrs.length
        ? `${attrs.length} атрибутов · ↑ ↓ Esc`
        : `Показано ${rows.length} из ${attrs.length}`;
    }
    refreshSchemaMeta();
    document.querySelectorAll('#dictBody tr[data-code]').forEach(tr => {
      tr.classList.toggle('sel', tr.dataset.code === editCode);
    });
  };

  function onRowAction(code, act) {
    const attrs = dictCurrent?.attrs || [];
    const attr = attrs.find(a => a.code === code);
    if (!attr) return;
    if (act === 'mark') {
      if (marked.has(code)) marked.delete(code); else marked.add(code);
      renderSchemaTable(attrs);
      return;
    }
    if (act === 'facet') {
      if (isBrandAttr(attr)) return;
      attr.facet = attr.facet || {};
      attr.facet.enabled = !attr.facet.enabled;
      if (attr.facet.enabled && !attr.facet.kind) attr.facet.kind = kindFromWidget(widgetOf(attr), attr.type);
      markDirty();
      renderSchemaTable(attrs);
      if (editCode === code) openSchemaEditor(code);
      return;
    }
    if (act === 'ann') {
      attr.show_in_annotation = !attr.show_in_annotation;
      markDirty();
      renderSchemaTable(attrs);
      if (editCode === code) openSchemaEditor(code);
      return;
    }
    if (act === 'up' || act === 'down') {
      moveAttr(code, act === 'up' ? -1 : 1);
      return;
    }
    if (act === 'del') {
      if (attrs.length <= 1) { refreshSchemaMeta('нужен хотя бы один атрибут'); return; }
      if (!confirm(`Удалить «${attr.name || code}»?`)) return;
      dictCurrent.attrs = attrs.filter(a => a !== attr);
      marked.delete(code);
      if (editCode === code) { editCode = null; renderIdlePanel(); }
      markDirty('удалено');
      renderSchemaTable(dictCurrent.attrs);
    }
  }

  function onCellEdit(code, field, el) {
    const attr = (dictCurrent?.attrs || []).find(a => a.code === code);
    if (!attr) return;
    if (field === 'code') {
      const next = String(el.value || '').trim();
      if (!KEY_RE.test(next)) {
        refreshSchemaMeta('код: латиница/цифры/_');
        el.value = attr.code;
        return;
      }
      if ((dictCurrent.attrs || []).some(a => a !== attr && a.code === next)) {
        refreshSchemaMeta(`код «${next}» занят`);
        el.value = attr.code;
        return;
      }
      if (marked.has(attr.code)) { marked.delete(attr.code); marked.add(next); }
      attr.code = next;
      editCode = next;
    }
    if (field === 'name') {
      attr.name = el.value;
      if (!Array.isArray(attr.synonyms) || !attr.synonyms.length) attr.synonyms = [attr.name];
      else attr.synonyms[0] = attr.name;
      if (attr.facet && !attr.facet.label) attr.facet.label = attr.name;
    }
    if (field === 'type') {
      attr.type = el.value;
      if (attr.type === 'boolean') {
        attr.facet = attr.facet || {};
        attr.facet.kind = 'boolean';
      }
    }
    if (field === 'unit') attr.unit = el.value.trim() || null;
    markDirty();
    renderSchemaTable(dictCurrent.attrs);
    if (editCode) openSchemaEditor(editCode);
  }

  function moveAttr(code, dir) {
    const list = [...(dictCurrent?.attrs || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const i = list.findIndex(a => a.code === code);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((a, k) => { a.order = k; });
    dictCurrent.attrs = list;
    markDirty();
    renderSchemaTable(list);
  }

  function updateBulkBar() {
    const bar = $('aeBulk');
    const lab = $('aeBulkLabel');
    if (!bar) return;
    const n = marked.size;
    bar.hidden = n === 0;
    if (lab) lab.textContent = `Выбрано ${n}`;
  }

  window.aeToggleMarkAll = function aeToggleMarkAll() {
    const rows = shownAttrs(dictCurrent?.attrs || []);
    const allOn = rows.length && rows.every(a => marked.has(a.code));
    if (allOn) rows.forEach(a => marked.delete(a.code));
    else rows.forEach(a => marked.add(a.code));
    renderSchemaTable(dictCurrent?.attrs || []);
  };

  window.aeClearMarks = function aeClearMarks() {
    marked.clear();
    renderSchemaTable(dictCurrent?.attrs || []);
  };

  window.aeBulkPatch = function aeBulkPatch(upd) {
    (dictCurrent?.attrs || []).forEach(a => {
      if (!marked.has(a.code)) return;
      if ('facet' in upd && !isBrandAttr(a)) {
        a.facet = a.facet || {};
        a.facet.enabled = !!upd.facet;
      }
      if ('annotate' in upd) a.show_in_annotation = !!upd.annotate;
    });
    markDirty('массовое изменение');
    renderSchemaTable(dictCurrent.attrs);
  };

  window.aeBulkDelete = function aeBulkDelete() {
    if (!marked.size) return;
    if ((dictCurrent.attrs || []).length - marked.size < 1) {
      refreshSchemaMeta('нужен хотя бы один атрибут');
      return;
    }
    if (!confirm(`Удалить ${marked.size} атрибутов?`)) return;
    dictCurrent.attrs = dictCurrent.attrs.filter(a => !marked.has(a.code));
    if (editCode && marked.has(editCode)) { editCode = null; renderIdlePanel(); }
    marked.clear();
    markDirty('удалено');
    renderSchemaTable(dictCurrent.attrs);
  };

  function renderIdlePanel() {
    const title = $('schDrawerTitle');
    const body = $('schDrawerBody');
    if (title) {
      title.innerHTML = `<div><div class="ae-panel-key">Редактор</div><div class="ae-panel-sub">выберите строку</div></div>`;
    }
    if (body) {
      body.innerHTML = `<div class="ae-panel-empty">
        <p class="ae-empty-title">Ничего не выбрано</p>
        <p class="ae-empty-text">Кликните строку — здесь откроются каноны, синонимы, фасет и «не путать с».</p>
      </div>`;
    }
  }

  function chipsHtml(items, dataKey) {
    return `<div class="ae-chips" data-chips="${esc(dataKey)}">
      ${(items || []).map((x, i) =>
        `<span class="ae-chip">${esc(x)}<button type="button" data-chip-rm="${i}">×</button></span>`
      ).join('')}
      <input class="ae-chip-input" data-chip-add placeholder="${dataKey === 'blacklist' ? 'термин + Enter' : 'синоним + Enter'}">
    </div>`;
  }

  window.openSchemaEditor = function openSchemaEditor(code, opts) {
    const attr = (dictCurrent?.attrs || []).find(a => a.code === code);
    const body = $('schDrawerBody');
    const title = $('schDrawerTitle');
    if (!attr || !body) return;
    editCode = code;
    document.querySelectorAll('#dictBody tr[data-code]').forEach(tr => {
      tr.classList.toggle('sel', tr.dataset.code === code);
    });
    if (title) {
      title.innerHTML = `<div>
        <div class="ae-panel-key">${esc(attr.code || 'без ключа')}</div>
        <div class="ae-panel-sub">${esc(attr.name || 'Без названия')}</div>
      </div>
      <button type="button" class="ae-icon-btn" onclick="closeSchemaEditor()" title="Закрыть (Esc)">×</button>`;
    }

    const issues = localIssues(attr, dictCurrent.attrs || []);
    const canons = Object.entries(attr.value_aliases || {});
    const facetOn = !!attr.facet?.enabled;
    const widget = widgetOf(attr);
    const blacklist = attr.blacklist || [];

    body.innerHTML = `
      ${issues.length ? `<ul class="ae-issues">${issues.map(i =>
        `<li class="ae-issue ae-issue-${i.level}">${esc(i.text)}</li>`).join('')}</ul>` : ''}
      <section class="ae-grp">
        <div class="ae-grp-title">Основное</div>
        <label class="ae-fld"><span>Ключ</span><input class="mono" id="schCode" value="${esc(attr.code)}" spellcheck="false"></label>
        <label class="ae-fld"><span>Название</span><input id="schName" value="${esc(attr.name || '')}"></label>
        <div class="ae-fld-row">
          <label class="ae-fld"><span>Тип</span>
            <select id="schType">${TYPES.map(t =>
              `<option value="${t.v}" ${attr.type === t.v ? 'selected' : ''}>${t.t}</option>`).join('')}</select>
          </label>
          <label class="ae-fld"><span>Единица</span>
            <input id="schUnit" value="${esc(attr.unit || '')}" placeholder="кг, см, дБ">
          </label>
        </div>
        <label class="ae-fld"><span>Подсказка для модели</span>
          <textarea id="schDesc" rows="2" placeholder="Как трактовать при извлечении">${esc(attr.description || '')}</textarea>
        </label>
      </section>
      <section class="ae-grp">
        <div class="ae-grp-title">Канонические значения ${attr.type === 'enum' ? `<span class="ae-count">${canons.length}</span>` : ''}</div>
        ${attr.type !== 'enum' && attr.type !== 'text'
          ? `<p class="ae-note">Каноны для enum/text. Сейчас: ${esc(attr.type)}.</p>`
          : `<div id="schCanons">${canons.map(([canon, syns]) => {
            const al = (syns || []).filter(s => s !== canon);
            return `<div class="ae-canon" data-canon="${esc(canon)}">
              <div class="ae-canon-head">
                <input data-cf="canon" value="${esc(canon)}">
                <button type="button" class="ae-icon-btn danger" data-cf="del">×</button>
              </div>
              ${chipsHtml(al, 'syn')}
            </div>`;
          }).join('')}</div>
          <button type="button" class="sbtn ghost" id="schAddCanon" style="width:100%">Добавить значение</button>`}
      </section>
      <section class="ae-grp">
        <div class="ae-grp-title">Фасет в каталоге</div>
        <label class="ae-switch">${chkHtml(isBrandAttr(attr) ? false : facetOn, isBrandAttr(attr)
          ? 'id="schFacet" disabled aria-disabled="true" title="Бренд не фасет: сопоставление по id"'
          : 'id="schFacet"')} <span>Показывать в фильтрах${isBrandAttr(attr) ? ' (бренд — по id)' : ''}</span></label>
        <label class="ae-fld" id="schWidgetWrap" style="${facetOn ? '' : 'display:none'}">
          <span>Виджет</span>
          <select id="schWidget">${WIDGETS.map(w =>
            `<option value="${w.v}" ${widget === w.v ? 'selected' : ''}>${w.t}</option>`).join('')}</select>
        </label>
        <label class="ae-switch">${chkHtml(!!attr.show_in_annotation, 'id="schAnn"')} <span>Извлекать при обогащении</span></label>
        <label class="ae-fld" id="schBreaksWrap" style="${facetOn && widget === 'slider' ? '' : 'display:none'}">
          <span>Границы range (через запятую)</span>
          <input id="schBreaksRaw" value="${esc((attr.facet?.breaks || []).join(', '))}" placeholder="0, 5, 7, 10">
        </label>
      </section>
      <section class="ae-grp">
        <div class="ae-grp-title">Не путать с</div>
        <p class="ae-note">Термины/ключи, куда модель ошибочно кладёт значение.</p>
        ${chipsHtml(blacklist, 'blacklist')}
        <div class="ae-suggest" id="schSuggest">
          ${(dictCurrent.attrs || []).filter(x => x.code !== attr.code && !blacklist.includes(x.code)).slice(0, 8)
            .map(x => `<button type="button" class="ae-chip-ghost" data-suggest="${esc(x.code)}">+ ${esc(x.code)}</button>`).join('')}
        </div>
      </section>
      <div class="ae-panel-acts">
        <button type="button" class="sbtn primary" onclick="applySchemaEditor()">Применить</button>
        <button type="button" class="sbtn ghost" onclick="closeSchemaEditor()">Закрыть</button>
        <button type="button" class="sbtn danger" onclick="deleteSchemaAttr()">Удалить</button>
      </div>
    `;

    wirePanel(attr);
    if (!opts?.keepPanel) body.scrollTop = 0;
  };

  function rewireChips(scope) {
    wireChips(scope || $('schDrawerBody'), (key, items, box) => {
      const parent = box.parentElement;
      box.outerHTML = chipsHtml(items, key);
      if (parent) rewireChips(parent.closest('.ae-canon') || $('schDrawerBody'));
      else rewireChips($('schDrawerBody'));
    });
  }

  function wireChips(root, onChange) {
    if (!root) return;
    root.querySelectorAll('[data-chips]').forEach(box => {
      if (box.dataset.wired) return;
      box.dataset.wired = '1';
      const input = box.querySelector('[data-chip-add]');
      const commit = () => {
        const t = String(input?.value || '').trim();
        if (!t) return;
        input.value = '';
        const items = [...box.querySelectorAll('.ae-chip')].map(c => c.childNodes[0].textContent);
        items.push(t);
        onChange(box.dataset.chips, items, box);
      };
      input?.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      });
      input?.addEventListener('blur', commit);
      box.addEventListener('click', e => {
        const btn = e.target.closest('[data-chip-rm]');
        if (!btn) return;
        const items = [...box.querySelectorAll('.ae-chip')].map(c => c.childNodes[0].textContent);
        items.splice(Number(btn.dataset.chipRm), 1);
        onChange(box.dataset.chips, items, box);
      });
    });
  }

  function wirePanel(attr) {
    const facetBtn = $('schFacet');
    const annBtn = $('schAnn');
    facetBtn?.addEventListener('click', () => {
      if (facetBtn.disabled || isBrandAttr(attr)) return;
      const on = !facetBtn.classList.contains('on');
      facetBtn.classList.toggle('on', on);
      facetBtn.textContent = on ? '✓' : '';
      if ($('schWidgetWrap')) $('schWidgetWrap').style.display = on ? '' : 'none';
      syncBreaksVis();
    });
    annBtn?.addEventListener('click', () => {
      const on = !annBtn.classList.contains('on');
      annBtn.classList.toggle('on', on);
      annBtn.textContent = on ? '✓' : '';
    });
    $('schWidget')?.addEventListener('change', syncBreaksVis);
    function syncBreaksVis() {
      const on = $('schFacet')?.classList.contains('on');
      const w = $('schWidget')?.value;
      if ($('schBreaksWrap')) $('schBreaksWrap').style.display = on && w === 'slider' ? '' : 'none';
    }
    $('schAddCanon')?.addEventListener('click', () => {
      const wrap = $('schCanons');
      if (!wrap) return;
      const div = document.createElement('div');
      div.className = 'ae-canon';
      div.innerHTML = `<div class="ae-canon-head">
        <input data-cf="canon" value="" placeholder="Канон">
        <button type="button" class="ae-icon-btn danger" data-cf="del">×</button>
      </div>${chipsHtml([], 'syn')}`;
      wrap.appendChild(div);
      div.querySelector('[data-cf="del"]').onclick = () => div.remove();
      rewireChips(div);
    });
    document.querySelectorAll('#schCanons [data-cf="del"]').forEach(btn => {
      btn.onclick = () => btn.closest('.ae-canon')?.remove();
    });
    rewireChips($('schDrawerBody'));
    $('schSuggest')?.querySelectorAll('[data-suggest]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.suggest;
        const box = $('schDrawerBody').querySelector('[data-chips="blacklist"]');
        if (!box) return;
        const items = [...box.querySelectorAll('.ae-chip')].map(c => c.childNodes[0].textContent);
        if (items.includes(code)) return;
        items.push(code);
        box.outerHTML = chipsHtml(items, 'blacklist');
        rewireChips($('schDrawerBody'));
        btn.remove();
      });
    });
  }

  window.applySchemaEditor = function applySchemaEditor() {
    if (!dictCurrent || !editCode) return;
    const attr = dictCurrent.attrs.find(a => a.code === editCode);
    if (!attr) return;
    const nextCode = String($('schCode')?.value || '').trim();
    if (!KEY_RE.test(nextCode)) { refreshSchemaMeta('код: латиница/цифры/_'); return; }
    if (dictCurrent.attrs.some(a => a !== attr && a.code === nextCode)) {
      refreshSchemaMeta(`код «${nextCode}» занят`);
      return;
    }
    if (marked.has(attr.code) && attr.code !== nextCode) {
      marked.delete(attr.code); marked.add(nextCode);
    }
    attr.code = nextCode;
    attr.name = $('schName')?.value || attr.name;
    attr.description = $('schDesc')?.value || '';
    attr.type = $('schType')?.value || attr.type;
    attr.unit = $('schUnit')?.value?.trim() || null;
    attr.facet = attr.facet || {};
    attr.facet.enabled = isBrandAttr(attr) ? false : !!$('schFacet')?.classList.contains('on');
    attr.show_in_annotation = !!$('schAnn')?.classList.contains('on');
    const widget = $('schWidget')?.value || widgetOf(attr);
    attr.facet.widget = widget;
    attr.facet.kind = kindFromWidget(widget, attr.type);
    attr.facet.label = attr.facet.label || attr.name;
    if (attr.facet.enabled && widget === 'slider') {
      const raw = String($('schBreaksRaw')?.value || '').split(/[,;\s]+/).map(Number).filter(Number.isFinite);
      if (raw.length >= 2) attr.facet.breaks = raw;
    }
    if (attr.type === 'enum' || attr.type === 'text') {
      const aliases = {};
      document.querySelectorAll('#schCanons .ae-canon').forEach(el => {
        const canon = el.querySelector('[data-cf="canon"]')?.value?.trim();
        if (!canon) return;
        const synBox = el.querySelector('[data-chips="syn"]');
        const syns = synBox
          ? [...synBox.querySelectorAll('.ae-chip')].map(c => c.childNodes[0].textContent.trim()).filter(Boolean)
          : [];
        if (!syns.includes(canon)) syns.unshift(canon);
        aliases[canon] = syns;
      });
      attr.value_aliases = aliases;
    }
    const blBox = $('schDrawerBody')?.querySelector('[data-chips="blacklist"]');
    if (blBox) {
      attr.blacklist = [...blBox.querySelectorAll('.ae-chip')].map(c => c.childNodes[0].textContent.trim()).filter(Boolean);
    }
    if (!Array.isArray(attr.synonyms) || !attr.synonyms.length) attr.synonyms = [attr.name];
    editCode = attr.code;
    markDirty('применено — сохраните');
    renderSchemaTable(dictCurrent.attrs);
    openSchemaEditor(attr.code);
  };

  window.closeSchemaEditor = function closeSchemaEditor() {
    editCode = null;
    renderIdlePanel();
    if (dictCurrent) renderSchemaTable(dictCurrent.attrs || []);
  };

  window.deleteSchemaAttr = function deleteSchemaAttr() {
    if (!dictCurrent || !editCode) return;
    if ((dictCurrent.attrs || []).length <= 1) {
      refreshSchemaMeta('нужен хотя бы один атрибут');
      return;
    }
    if (!confirm(`Удалить «${editCode}»?`)) return;
    dictCurrent.attrs = dictCurrent.attrs.filter(a => a.code !== editCode);
    marked.delete(editCode);
    editCode = null;
    markDirty('удалено');
    renderIdlePanel();
    renderSchemaTable(dictCurrent.attrs);
  };

  /* ── audit / preview / import (API) ── */

  function statusBadge(st) {
    if (st === 'ERROR') return '<span class="sch-badge sch-err">ERROR</span>';
    if (st === 'WARN') return '<span class="sch-badge sch-warn">WARN</span>';
    return '<span class="sch-badge sch-ok">OK</span>';
  }

  window.runSchemaAudit = async function runSchemaAudit() {
    if (!window.dictCurrent?.id) return;
    try {
      schemaAudit = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/audit');
      renderAuditPanel();
      renderSchemaTable(dictCurrent.attrs || []);
      refreshSchemaMeta('проверка выполнена');
    } catch (e) {
      refreshSchemaMeta(e.message || 'ошибка проверки');
    }
  };

  function renderAuditPanel() {
    const box = $('schAuditBox');
    if (!box) return;
    issueActions = [];
    if (!schemaAudit) {
      box.innerHTML = '<p class="muted">Нажмите «Проверить»</p>';
      return;
    }
    const bad = (schemaAudit.attributes || []).filter(a => a.status !== 'OK');
    if (!bad.length) {
      box.innerHTML = '<p class="muted">Критических проблем не найдено</p>';
      return;
    }
    box.innerHTML = bad.map(a => {
      const issues = (a.issues || []).filter(i => i.severity !== 'info').slice(0, 8);
      return `<div class="sch-issue-block">
        <div class="sch-issue-h">${statusBadge(a.status)} <b>${esc(a.name)}</b> <code>${esc(a.code)}</code></div>
        <ul>${issues.map(i => {
          const idx = issueActions.length;
          issueActions.push({ code: a.code, issue: i });
          const acts = (i.actions || []).map(act =>
            `<button type="button" class="sbtn ghost" style="padding:2px 6px;font-size:11px"
              data-issue-idx="${idx}" data-act="${esc(act)}">${esc(act)}</button>`
          ).join('');
          return `<li class="sch-${i.severity}">${esc(i.message)}
            ${acts ? `<span class="sch-acts">${acts}</span>` : ''}</li>`;
        }).join('')}</ul>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-issue-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = issueActions[Number(btn.dataset.issueIdx)];
        if (!row) return;
        schemaIssueAction(row.code, btn.dataset.act, row.issue);
      });
    });
  }

  window.schemaIssueAction = function schemaIssueAction(code, action, issue) {
    const attr = (dictCurrent?.attrs || []).find(a => a.code === code);
    if (!attr) return;
    if (action === 'delete' && issue?.value) {
      if (!confirm(`Удалить значение «${issue.value}»?`)) return;
      const aliases = attr.value_aliases || {};
      if (aliases[issue.value]) delete aliases[issue.value];
      else {
        for (const [canon, list] of Object.entries(aliases)) {
          aliases[canon] = (list || []).filter(s => s !== issue.value && s !== issue.canon);
        }
      }
      attr.value_aliases = aliases;
      markDirty('значение удалено');
      renderSchemaTable(dictCurrent.attrs);
      if (editCode === code) openSchemaEditor(code);
      return;
    }
    if (action === 'merge' && issue?.merge_into && issue?.merge_from) {
      if (!confirm(`Объединить «${issue.merge_from}» → «${issue.merge_into}»?`)) return;
      const aliases = { ...(attr.value_aliases || {}) };
      const from = aliases[issue.merge_from] || [];
      const into = aliases[issue.merge_into] || [];
      aliases[issue.merge_into] = [...new Set([...into, issue.merge_from, ...from])];
      delete aliases[issue.merge_from];
      attr.value_aliases = aliases;
      markDirty('объединено');
      renderSchemaTable(dictCurrent.attrs);
      if (editCode === code) openSchemaEditor(code);
    }
  };

  window.runSchemaPreview = async function runSchemaPreview() {
    if (!window.dictCurrent?.id) return;
    try {
      const data = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/filter-preview');
      showFacetModal(data?.filters || buildLocalFacets());
      refreshSchemaMeta('превью фильтров');
    } catch (e) {
      showFacetModal(buildLocalFacets());
      refreshSchemaMeta(e.message || 'локальное превью');
    }
  };

  function buildLocalFacets() {
    return (dictCurrent?.attrs || []).filter(a => a.facet?.enabled).map(a => ({
      name: a.facet?.label || a.name,
      kind: a.facet?.kind || 'enum',
      unit: a.unit,
      values: canonList(a).map(v => ({ value: v, count: 0 })),
    }));
  }

  function showFacetModal(filters) {
    const host = $('aeFacetModal');
    if (!host) return;
    host.hidden = false;
    host.innerHTML = `<div class="ae-modal-wrap" id="aeModalBg">
      <div class="ae-modal" role="dialog">
        <header class="ae-modal-head">
          <h3>Фильтры на витрине — ${filters.length}</h3>
          <button type="button" class="ae-icon-btn" id="aeModalClose">×</button>
        </header>
        <div class="ae-modal-body">
          ${filters.length ? filters.map(f => {
            const vals = (f.values || []).slice(0, 6);
            return `<div>
              <div class="ae-facet-name">${esc(f.name || f.code || '')}${f.unit ? `<span class="unit">, ${esc(f.unit)}</span>` : ''}</div>
              ${(f.kind === 'range' || f.kind === 'boolean')
                ? `<div class="ae-note">${esc(f.kind)}</div>`
                : `<div class="ae-facet-vals">${vals.length
                  ? vals.map(v => `<span class="ae-facet-val">${esc(v.value ?? v)}</span>`).join('')
                    + ((f.values || []).length > 6 ? `<span class="ae-note">ещё ${(f.values || []).length - 6}</span>` : '')
                  : '<span class="ae-note">нет значений</span>'}</div>`}
            </div>`;
          }).join('') : '<p class="ae-note">Нет включённых фильтров</p>'}
        </div>
      </div>
    </div>`;
    const close = () => { host.hidden = true; host.innerHTML = ''; };
    $('aeModalClose')?.addEventListener('click', close);
    $('aeModalBg')?.addEventListener('click', e => { if (e.target.id === 'aeModalBg') close(); });
  }

  window.runSchemaImport = async function runSchemaImport(mode) {
    if (!dictCurrent?.id) return;
    const text = $('schImportText')?.value || '';
    const meta = $('schImportMeta');
    const btn = $('schImportApplyBtn');
    if (btn) btn.disabled = true;
    if (meta) meta.textContent = 'разбор…';
    try {
      const data = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/import-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mode, attrs: dictCurrent.attrs }),
      });
      importSuggestions = (data.suggestions || []).map(s => ({
        ...s,
        selected: s.selected !== false && s.action !== 'skip',
      }));
      renderImportBox();
      if (meta) {
        meta.textContent = `${data.mode || mode}: ${importSuggestions.length} предложений`
          + (data.fallback ? ` (${data.fallback})` : '');
      }
      if (btn) btn.disabled = !importSuggestions.some(s => s.selected);
    } catch (e) {
      if (meta) meta.textContent = e.message || 'ошибка импорта';
      importSuggestions = [];
      renderImportBox();
    }
  };

  function renderImportBox() {
    const box = $('schImportBox');
    const btn = $('schImportApplyBtn');
    if (!box) return;
    if (!importSuggestions.length) { box.innerHTML = ''; if (btn) btn.disabled = true; return; }
    box.innerHTML = `<div class="sch-import-list">${importSuggestions.map((s, i) => `
      <label class="sch-import-row">
        <input type="checkbox" data-imp="${i}" ${s.selected ? 'checked' : ''}>
        <div class="sch-import-body">
          <div><b>${esc(s.action)}</b> → <code>${esc(s.code || s.new_code || '—')}</code>
            ${s.canon ? ` · ${esc(s.canon)}` : ''} ${s.name ? ` · ${esc(s.name)}` : ''}</div>
          <div class="muted">${esc(s.line || s.note || '')}</div>
        </div>
      </label>`).join('')}</div>`;
    box.querySelectorAll('[data-imp]').forEach(inp => {
      inp.addEventListener('change', () => {
        importSuggestions[Number(inp.dataset.imp)].selected = inp.checked;
        if (btn) btn.disabled = !importSuggestions.some(s => s.selected);
      });
    });
    if (btn) btn.disabled = !importSuggestions.some(s => s.selected);
  }

  window.applySchemaImport = async function applySchemaImport() {
    if (!dictCurrent?.id || !importSuggestions.length) return;
    const selected = importSuggestions.filter(s => s.selected && s.action !== 'skip');
    if (!selected.length) { refreshSchemaMeta('ничего не выбрано'); return; }
    if (!confirm(`Применить ${selected.length} предложений к черновику?`)) return;
    const meta = $('schImportMeta');
    try {
      const data = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/import-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: selected, attrs: dictCurrent.attrs, save: false }),
      });
      dictCurrent.attrs = data.attrs || dictCurrent.attrs;
      markDirty(`применено ${data.applied}, создано ${data.created}`);
      renderSchemaTable(dictCurrent.attrs);
      if (meta) meta.textContent = `черновик · +${data.created}`;
    } catch (e) {
      if (meta) meta.textContent = e.message || 'не удалось применить';
    }
  };

  /* hooks into legacy page functions */
  const _origRender = window.renderDictTable;
  window.renderDictTable = function (attrs) {
    if ($('schConstructor')) {
      renderSchemaTable(attrs || []);
      return;
    }
    if (typeof _origRender === 'function') _origRender(attrs);
  };

  const _origDictStatus = window.dictStatus;
  window.dictStatus = function (msg, ok) {
    if ($('schConstructor')) {
      if (!window.dictCurrent) {
        const el = $('dictMeta');
        if (el) el.innerHTML = msg ? `<span>${esc(msg)}</span>` : '';
        return;
      }
      refreshSchemaMeta(ok === false ? (msg || 'ошибка') : (msg || ''));
      return;
    }
    if (typeof _origDictStatus === 'function') _origDictStatus(msg, ok);
  };

  const _origAdd = window.addDictAttr;
  window.addDictAttr = function () {
    if (typeof _origAdd === 'function') _origAdd();
    const attrs = dictCurrent?.attrs || [];
    const last = attrs[attrs.length - 1];
    if (last) openSchemaEditor(last.code);
  };

  document.addEventListener('keydown', (e) => {
    const dictPanel = $('setDict');
    const onDict = dictPanel?.classList.contains('on');
    if (e.key === 'Escape') {
      if (!$('aeFacetModal')?.hidden) {
        $('aeFacetModal').hidden = true;
        $('aeFacetModal').innerHTML = '';
        return;
      }
      if (onDict && editCode) closeSchemaEditor();
      return;
    }
    if (!onDict) return;
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = shownAttrs(dictCurrent?.attrs || []);
    if (!rows.length) return;
    e.preventDefault();
    const i = Math.max(0, rows.findIndex(a => a.code === editCode));
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
    openSchemaEditor(rows[next].code);
  });
})();
