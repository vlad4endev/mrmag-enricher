/**
 * Конструктор атрибутов и фильтров — UI поверх /api/dictionaries.
 * Подключается из index_final.html; использует apiJson/esc из страницы.
 */
(function () {
  'use strict';

  let schemaAudit = null;
  let schemaPreview = null;
  let editCode = null;
  let listFilter = 'all';
  let listQuery = '';

  function $(id) { return document.getElementById(id); }

  function statusBadge(st) {
    if (st === 'ERROR') return '<span class="sch-badge sch-err">ERROR</span>';
    if (st === 'WARN') return '<span class="sch-badge sch-warn">WARN</span>';
    return '<span class="sch-badge sch-ok">OK</span>';
  }

  function auditFor(code) {
    return (schemaAudit?.attributes || []).find(a => a.code === code);
  }

  function valueCount(attr) {
    if (attr.type === 'boolean') return 2;
    const aliases = attr.value_aliases || {};
    return Object.keys(aliases).length;
  }

  function facetKindUi(attr) {
    if (!attr.facet?.enabled) return 'none';
    if (attr.type === 'boolean') return attr.facet.kind === 'enum' ? 'boolean' : (attr.facet.kind || 'boolean');
    return attr.facet.kind || 'enum';
  }

  function attrStatus(a) {
    const on = !!a.facet?.enabled;
    const aud = auditFor(a.code);
    return aud?.status || (on && (a.type === 'enum' || a.type === 'multi_enum') && !valueCount(a) ? 'WARN' : 'OK');
  }

  function attrWarnCount(a) {
    return (auditFor(a.code)?.issues || []).filter(i => i.severity === 'error' || i.severity === 'warn').length;
  }

  function typeLabel(type) {
    if (type === 'multi_enum') return 'multi enum';
    return type || '—';
  }

  function coverageLabel(a) {
    const v = a.coverage_final ?? a.coverage_now;
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (n <= 1) return Math.round(n * 100) + '%';
    return String(n);
  }

  window.refreshSchemaMeta = function refreshSchemaMeta(extra) {
    const el = $('dictMeta');
    if (!el) return;
    if (!window.dictCurrent) {
      el.innerHTML = extra ? `<span class="muted">${esc(extra)}</span>` : '';
      return;
    }
    const d = window.dictCurrent;
    const attrs = d.attrs || [];
    const facets = attrs.filter(a => a.facet?.enabled).length;
    const problems = schemaAudit?.problems;
    const problemN = typeof problems === 'number'
      ? problems
      : attrs.filter(a => attrStatus(a) !== 'OK').length;
    const dirty = !!window.dictDirty;
    const problemClass = problemN > 0 ? (attrs.some(a => attrStatus(a) === 'ERROR') ? 'err' : 'warn') : '';
    el.innerHTML = `
      <div class="sch-stats">
        <div class="sch-stat">
          <span class="sch-stat-v">${attrs.length}</span>
          <span class="sch-stat-l">атрибутов · ${esc(d.id)}</span>
        </div>
        <div class="sch-stat">
          <span class="sch-stat-v">${facets}</span>
          <span class="sch-stat-l">в фильтрах</span>
        </div>
        <div class="sch-stat ${problemClass}">
          <span class="sch-stat-v">${problemN}</span>
          <span class="sch-stat-l">проблем</span>
        </div>
        <div class="sch-stat ${dirty ? 'dirty' : ''}">
          <span class="sch-stat-v">${dirty ? '●' : '○'}</span>
          <span class="sch-stat-l">${dirty ? 'не сохранено' : 'сохранено'}${extra ? ' · ' + esc(extra) : ''}</span>
        </div>
      </div>
      ${d.name ? `<div class="muted" style="margin-top:6px">${esc(d.name)}${d.file ? ' · ' + esc(d.file) : ''}</div>` : ''}
    `;
  };

  window.setSchemaListFilter = function setSchemaListFilter(mode, btn) {
    listFilter = mode || 'all';
    document.querySelectorAll('[data-sch-filter]').forEach(b => {
      b.classList.toggle('on', b.dataset.schFilter === listFilter);
    });
    if (btn) btn.classList.add('on');
    applySchemaListFilter();
  };

  window.onSchemaListFilter = function onSchemaListFilter() {
    listQuery = String($('schSearch')?.value || '').trim().toLowerCase();
    applySchemaListFilter();
  };

  function applySchemaListFilter() {
    const body = $('dictBody');
    if (!body) return;
    const rows = [...body.querySelectorAll('.sch-row')];
    let visible = 0;
    rows.forEach(row => {
      const q = listQuery;
      const hay = (row.dataset.hay || '').toLowerCase();
      const matchQ = !q || hay.includes(q);
      let matchF = true;
      if (listFilter === 'facet') matchF = row.dataset.facet === '1';
      else if (listFilter === 'problems') matchF = row.dataset.status !== 'OK';
      else if (listFilter === 'enum') matchF = row.dataset.type === 'enum' || row.dataset.type === 'multi_enum';
      const show = matchQ && matchF;
      row.hidden = !show;
      if (show) visible++;
    });
    let empty = body.querySelector('.sch-empty-filter');
    if (!rows.length) return;
    if (!visible) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'sch-empty sch-empty-filter';
        empty.textContent = 'Ничего не найдено — сбросьте поиск или фильтр';
        body.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
    const hint = $('schListHint');
    if (hint && window.dictCurrent) {
      hint.textContent = visible === rows.length
        ? `${rows.length} атрибутов · клик открывает редактор`
        : `Показано ${visible} из ${rows.length}`;
    }
  }

  window.runSchemaAudit = async function runSchemaAudit() {
    if (!window.dictCurrent?.id) return;
    try {
      schemaAudit = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/audit');
      refreshSchemaMeta('проверка выполнена');
      renderSchemaTable(dictCurrent.attrs || []);
      renderAuditPanel();
    } catch (e) {
      refreshSchemaMeta(e.message || 'ошибка проверки');
    }
  };

  window.runSchemaPreview = async function runSchemaPreview() {
    if (!window.dictCurrent?.id) return;
    try {
      schemaPreview = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/filter-preview');
      renderPreviewPanel();
      refreshSchemaMeta('превью фильтров');
    } catch (e) {
      refreshSchemaMeta(e.message || 'ошибка превью');
    }
  };

  let issueActions = [];

  function renderAuditPanel() {
    const box = $('schAuditBox');
    if (!box) return;
    issueActions = [];
    if (!schemaAudit) {
      box.innerHTML = '<p class="muted">Нажмите «Проверить категорию»</p>';
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
            ${acts ? `<span class="sch-acts">${acts}</span>` : ''}
          </li>`;
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
      if (!confirm(`Удалить значение «${issue.value}» из «${attr.name}»?`)) return;
      const aliases = attr.value_aliases || {};
      if (aliases[issue.value]) {
        delete aliases[issue.value];
      } else {
        for (const [canon, list] of Object.entries(aliases)) {
          aliases[canon] = (list || []).filter(s => s !== issue.value && s !== issue.canon);
        }
      }
      attr.value_aliases = aliases;
      dictDirty = true;
      renderSchemaTable(dictCurrent.attrs);
      if (editCode === code) openSchemaEditor(code);
      refreshSchemaMeta('значение удалено — сохраните');
      return;
    }
    if (action === 'merge' && issue?.merge_into && issue?.merge_from) {
      if (!confirm(`Объединить «${issue.merge_from}» → канон «${issue.merge_into}»?`)) return;
      const aliases = { ...(attr.value_aliases || {}) };
      const from = aliases[issue.merge_from] || [];
      const into = aliases[issue.merge_into] || [];
      aliases[issue.merge_into] = [...new Set([...into, issue.merge_from, ...from])];
      delete aliases[issue.merge_from];
      attr.value_aliases = aliases;
      dictDirty = true;
      renderSchemaTable(dictCurrent.attrs);
      if (editCode === code) openSchemaEditor(code);
      refreshSchemaMeta('объединено — сохраните');
      return;
    }
    if (action === 'move' && issue?.suggest_attr) {
      alert(`Перенос в «${issue.suggest_attr}»: откройте оба атрибута и перенесите значение вручную (автоперенос с сохранением синонимов — в следующей итерации).`);
      openSchemaEditor(issue.suggest_attr);
      return;
    }
    // keep — nothing
  };

  function renderPreviewPanel() {
    const box = $('schPreviewBox');
    if (!box) return;
    if (!schemaPreview?.filters?.length) {
      box.innerHTML = '<p class="muted">Нет включённых фильтров или нажмите «Превью фильтров»</p>';
      return;
    }
    box.innerHTML = schemaPreview.filters.map(f => {
      const vals = (f.values || []).slice(0, 12).map(v =>
        `<div class="sch-prev-row"><span>${esc(v.value)}</span><span class="muted">${v.count} тов.</span></div>`
      ).join('');
      return `<div class="sch-prev-card">
        <div class="sch-prev-h">${esc(f.name)} <span class="muted">${esc(f.kind)}</span></div>
        ${vals || '<div class="muted">нет значений в схеме</div>'}
      </div>`;
    }).join('');
  }

  window.renderSchemaTable = function renderSchemaTable(attrs) {
    const body = $('dictBody');
    if (!body) return;
    if (!attrs.length) {
      body.innerHTML = '<div class="sch-empty">Нет атрибутов — добавьте строку</div>';
      return;
    }
    const rows = [...attrs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.code).localeCompare(String(b.code)));
    body.innerHTML = rows.map(a => {
      const on = !!a.facet?.enabled;
      const kind = facetKindUi(a);
      const st = attrStatus(a);
      const warn = attrWarnCount(a);
      const cov = coverageLabel(a);
      const nVals = valueCount(a);
      const selected = editCode === a.code;
      const hay = `${a.code} ${a.name || ''} ${a.unit || ''} ${a.type || ''}`;
      const canons = Object.keys(a.value_aliases || {});
      const preview = canons.slice(0, 4).map(v => `<span class="sch-val">${esc(v)}</span>`).join('')
        + (canons.length > 4 ? `<span class="sch-val more">+${canons.length - 4}</span>` : '');
      const typeChip = `<span class="sch-chip muted">${esc(typeLabel(a.type))}${a.cardinality === 'multi' ? ' · multi' : ''}</span>`;
      const facetChip = on
        ? `<span class="sch-chip facet">${esc(kind)}${nVals ? ` · <span class="n">${nVals}</span>` : ''}</span>`
        : `<span class="sch-chip muted">спека</span>`;
      const covChip = cov != null ? `<span class="sch-chip muted" title="покрытие">покр. <span class="n">${esc(cov)}</span></span>` : '';
      const warnChip = warn ? `<span class="sch-badge sch-${st === 'ERROR' ? 'err' : 'warn'}">${warn}</span>` : statusBadge(st);
      return `<div class="sch-row ${on ? '' : 'off'} ${selected ? 'on' : ''}"
        role="listitem" tabindex="0"
        data-code="${esc(a.code)}"
        data-hay="${esc(hay)}"
        data-facet="${on ? '1' : '0'}"
        data-status="${esc(st)}"
        data-type="${esc(a.type || '')}"
        onclick="openSchemaEditor('${esc(a.code)}')"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSchemaEditor('${esc(a.code)}')}">
        <div class="sch-row-main">
          <div class="sch-row-title">
            <span class="sch-row-name">${esc(a.name || a.code)}</span>
            ${a.unit ? `<span class="sch-row-unit">${esc(a.unit)}</span>` : ''}
          </div>
          <div class="sch-row-meta">
            <span class="sch-row-code">${esc(a.code)}</span>
            <span>#${a.order ?? 0}</span>
          </div>
          ${preview ? `<div class="sch-row-vals">${preview}</div>` : ''}
        </div>
        <div class="sch-row-side">
          <div class="sch-row-side-top">
            ${typeChip}
            ${facetChip}
            ${covChip}
            ${warnChip}
            <span class="sch-row-go" aria-hidden="true">›</span>
          </div>
        </div>
      </div>`;
    }).join('');
    applySchemaListFilter();
  };

  // Override legacy table renderer used by loadDictionary / saveDictionary
  const _origRender = window.renderDictTable;
  window.renderDictTable = function (attrs) {
    if ($('schConstructor')) {
      renderSchemaTable(attrs);
      refreshSchemaMeta();
      return;
    }
    if (typeof _origRender === 'function') _origRender(attrs);
  };

  // Keep meta consistent when legacy dictStatus is called
  const _origDictStatus = window.dictStatus;
  window.dictStatus = function (msg, ok) {
    if ($('schConstructor') && window.dictCurrent) {
      refreshSchemaMeta(ok === false ? (msg || 'ошибка') : (msg || ''));
      return;
    }
    if (typeof _origDictStatus === 'function') _origDictStatus(msg, ok);
  };

  window.openSchemaEditor = function openSchemaEditor(code) {
    const attr = (dictCurrent?.attrs || []).find(a => a.code === code);
    const panel = $('schDrawer');
    if (!attr || !panel) return;
    editCode = code;
    document.querySelectorAll('#dictBody .sch-row').forEach(row => {
      row.classList.toggle('on', row.dataset.code === code);
    });
    panel.classList.add('open');
    const title = $('schDrawerTitle');
    if (title) {
      title.innerHTML = `${esc(attr.name || code)} <span class="sch-drawer-sub">${esc(attr.code)}</span>`;
    }
    const facet = attr.facet || {};
    const kind = facetKindUi(attr);
    const aliases = attr.value_aliases || {};
    const canonRows = Object.entries(aliases).map(([canon, syns]) => {
      const synText = (syns || []).join('\n');
      return `<div class="sch-canon" data-canon="${esc(canon)}">
        <div class="sch-canon-h">
          <input type="text" data-cf="canon" value="${esc(canon)}" placeholder="Канон">
          <button type="button" class="sbtn danger" style="padding:4px 8px" data-cf="del-canon">×</button>
        </div>
        <label class="muted">Синонимы (по одному на строку)</label>
        <textarea data-cf="syns" rows="3">${esc(synText)}</textarea>
      </div>`;
    }).join('');

    const breaks = Array.isArray(facet.breaks) ? facet.breaks : [];
    const rangeRows = breaks.length
      ? breaks.slice(0, -1).map((lo, i) => {
        const hi = breaks[i + 1];
        const open = facet.open_last && i === breaks.length - 2;
        return `<tr>
          <td><input type="number" data-rf="lo" data-i="${i}" value="${lo}"></td>
          <td><input type="number" data-rf="hi" data-i="${i}" value="${open ? '' : hi}" placeholder="∞"></td>
          <td class="muted">${open ? hi + '+' : lo + '–' + hi}</td>
        </tr>`;
      }).join('')
      : '';

    panel.querySelector('.sch-drawer-body').innerHTML = `
      <div class="set-row"><label>Название</label><input type="text" id="schName" value="${esc(attr.name || '')}"></div>
      <div class="set-row"><label>Key (code)</label><input type="text" id="schCode" value="${esc(attr.code)}" spellcheck="false"></div>
      <div class="set-grid">
        <div class="set-row"><label>Тип данных</label>
          <select id="schType">
            ${['string','text','integer','number','boolean','enum','multi_enum'].map(t =>
              `<option value="${t}" ${attr.type === t || (t === 'multi_enum' && attr.type === 'enum' && attr.cardinality === 'multi') ? 'selected' : ''}>${t}</option>`
            ).join('')}
          </select>
        </div>
        <div class="set-row"><label>Единица</label><input type="text" id="schUnit" value="${esc(attr.unit || '')}" placeholder="—"></div>
      </div>
      <label class="set-check"><input type="checkbox" id="schFacet" ${facet.enabled ? 'checked' : ''}> Использовать в фильтрах</label>
      <div class="set-grid">
        <div class="set-row"><label>Тип фильтра</label>
          <select id="schFacetKind">
            <option value="none" ${kind === 'none' ? 'selected' : ''}>none</option>
            <option value="enum" ${kind === 'enum' ? 'selected' : ''}>enum</option>
            <option value="range" ${kind === 'range' ? 'selected' : ''}>range</option>
            <option value="boolean" ${kind === 'boolean' ? 'selected' : ''}>boolean</option>
          </select>
        </div>
        <div class="set-row"><label>Порядок</label><input type="number" id="schOrder" value="${attr.order ?? 0}"></div>
      </div>
      <div class="set-row"><label>Подпись фильтра</label><input type="text" id="schFacetLabel" value="${esc(facet.label || attr.name || '')}"></div>
      <div class="set-row"><label>Описание</label><textarea id="schDesc" rows="2">${esc(attr.description || '')}</textarea></div>

      <div class="sch-block" id="schEnumBlock" style="${attr.type === 'enum' || attr.type === 'text' || attr.cardinality === 'multi' ? '' : 'display:none'}">
        <div class="sch-block-h">Канонические значения (ENUM)</div>
        <p class="hint">AI не может создать значение вне этого списка. Синонимы → канон → filter.</p>
        <div id="schCanons">${canonRows || '<p class="muted">Нет канонов — добавьте</p>'}</div>
        <button type="button" class="sbtn ghost" id="schAddCanon"><i class="ti ti-plus"></i> Добавить значение</button>
      </div>

      <div class="sch-block" id="schRangeBlock" style="${kind === 'range' ? '' : 'display:none'}">
        <div class="sch-block-h">Диапазоны (RANGE)</div>
        <div class="set-grid">
          <div class="set-row"><label>Шаг</label><input type="number" id="schStep" value="${facet.step ?? ''}" min="0" step="any"></div>
          <div class="set-row"><label class="set-check" style="margin-top:22px"><input type="checkbox" id="schOpenLast" ${facet.open_last ? 'checked' : ''}> Последний открытый (N+)</label></div>
        </div>
        <table class="dict-table" style="margin-top:8px"><thead><tr><th>От</th><th>До</th><th>Label</th></tr></thead>
          <tbody id="schBreaksBody">${rangeRows || '<tr><td colspan="3" class="muted">Задайте breaks или step</td></tr>'}</tbody>
        </table>
        <button type="button" class="sbtn ghost" id="schAddBreak" style="margin-top:8px">+ Добавить диапазон</button>
        <div class="set-row" style="margin-top:8px"><label>Breaks через запятую</label>
          <input type="text" id="schBreaksRaw" value="${esc((facet.breaks || []).join(', '))}" placeholder="0, 100, 200, 300, 400, 500">
        </div>
      </div>

      <div class="sch-block" id="schBoolBlock" style="${attr.type === 'boolean' || kind === 'boolean' ? '' : 'display:none'}">
        <div class="sch-block-h">Boolean</div>
        <p class="hint">true → Есть · false → Нет. Отсутствие данных ≠ false (unknown).</p>
      </div>

      <div class="sch-block">
        <div class="sch-block-h">Не путать с</div>
        <p class="hint">Подписи других характеристик (blacklist) — для mapping/validation.</p>
        <textarea id="schBlacklist" rows="3" placeholder="по одной на строку">${esc((attr.blacklist || []).join('\n'))}</textarea>
      </div>

      <div class="sch-block">
        <div class="sch-block-h">Синонимы названия атрибута</div>
        <textarea id="schSynonyms" rows="2">${esc((attr.synonyms || []).join('\n'))}</textarea>
      </div>

      <div class="set-actions" style="margin-top:12px;position:sticky;bottom:0;background:var(--bg2);padding:10px 0">
        <button type="button" class="sbtn primary" onclick="applySchemaEditor()">Применить</button>
        <button type="button" class="sbtn ghost" onclick="closeSchemaEditor()">Закрыть</button>
        <button type="button" class="sbtn danger" onclick="deleteSchemaAttr()">Удалить атрибут</button>
      </div>
    `;

    $('schAddCanon')?.addEventListener('click', () => {
      const wrap = $('schCanons');
      if (!wrap) return;
      const div = document.createElement('div');
      div.className = 'sch-canon';
      div.innerHTML = `<div class="sch-canon-h">
        <input type="text" data-cf="canon" value="" placeholder="Канон">
        <button type="button" class="sbtn danger" style="padding:4px 8px" data-cf="del-canon">×</button>
      </div>
      <label class="muted">Синонимы (по одному на строку)</label>
      <textarea data-cf="syns" rows="3"></textarea>`;
      wrap.appendChild(div);
      div.querySelector('[data-cf="del-canon"]').onclick = () => div.remove();
    });
    panel.querySelectorAll('[data-cf="del-canon"]').forEach(btn => {
      btn.onclick = () => btn.closest('.sch-canon')?.remove();
    });
    $('schAddBreak')?.addEventListener('click', () => {
      const raw = $('schBreaksRaw');
      if (!raw) return;
      const nums = raw.value.split(/[,;\s]+/).map(Number).filter(Number.isFinite);
      const last = nums.length ? nums[nums.length - 1] : 0;
      nums.push(last + (Number($('schStep')?.value) || 100));
      raw.value = nums.join(', ');
    });
    $('schType')?.addEventListener('change', syncEditorBlocks);
    $('schFacetKind')?.addEventListener('change', syncEditorBlocks);
  };

  function syncEditorBlocks() {
    const type = $('schType')?.value;
    const kind = $('schFacetKind')?.value;
    const enumOn = type === 'enum' || type === 'text' || type === 'multi_enum';
    const rangeOn = kind === 'range';
    const boolOn = type === 'boolean' || kind === 'boolean';
    if ($('schEnumBlock')) $('schEnumBlock').style.display = enumOn ? '' : 'none';
    if ($('schRangeBlock')) $('schRangeBlock').style.display = rangeOn ? '' : 'none';
    if ($('schBoolBlock')) $('schBoolBlock').style.display = boolOn ? '' : 'none';
  }

  window.applySchemaEditor = function applySchemaEditor() {
    if (!dictCurrent || !editCode) return;
    const attr = dictCurrent.attrs.find(a => a.code === editCode);
    if (!attr) return;
    const nextCode = String($('schCode')?.value || '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nextCode)) {
      refreshSchemaMeta('код: латиница/цифры/_');
      return;
    }
    if (dictCurrent.attrs.some(a => a !== attr && a.code === nextCode)) {
      refreshSchemaMeta(`код «${nextCode}» занят`);
      return;
    }
    attr.code = nextCode;
    attr.name = $('schName')?.value || attr.name;
    attr.description = $('schDesc')?.value || '';
    let type = $('schType')?.value || attr.type;
    if (type === 'multi_enum') {
      attr.cardinality = 'multi';
      type = 'enum';
    } else if (type === 'enum') {
      attr.cardinality = attr.cardinality === 'multi' ? 'single' : (attr.cardinality || 'single');
    }
    attr.type = type;
    const unit = $('schUnit')?.value?.trim();
    attr.unit = unit || null;
    attr.order = Number($('schOrder')?.value) || 0;
    attr.facet = attr.facet || {};
    attr.facet.enabled = !!$('schFacet')?.checked;
    const fk = $('schFacetKind')?.value || 'enum';
    attr.facet.kind = fk === 'none' ? (attr.type === 'boolean' ? 'boolean' : 'enum') : fk;
    if (!attr.facet.enabled && fk === 'none') { /* ok */ }
    attr.facet.label = $('schFacetLabel')?.value || attr.name;
    attr.synonyms = String($('schSynonyms')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!attr.synonyms.length) attr.synonyms = [attr.name];
    attr.blacklist = String($('schBlacklist')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);

    if (attr.type === 'enum' || attr.type === 'text') {
      const aliases = {};
      document.querySelectorAll('#schCanons .sch-canon').forEach(el => {
        const canon = el.querySelector('[data-cf="canon"]')?.value?.trim();
        if (!canon) return;
        const syns = String(el.querySelector('[data-cf="syns"]')?.value || '')
          .split('\n').map(s => s.trim()).filter(Boolean);
        if (!syns.includes(canon)) syns.unshift(canon);
        aliases[canon] = syns;
      });
      attr.value_aliases = aliases;
    }

    if (attr.facet.kind === 'range') {
      const step = Number($('schStep')?.value);
      if (Number.isFinite(step) && step > 0) attr.facet.step = step;
      else delete attr.facet.step;
      attr.facet.open_last = !!$('schOpenLast')?.checked;
      const raw = String($('schBreaksRaw')?.value || '')
        .split(/[,;\s]+/).map(Number).filter(Number.isFinite);
      if (raw.length >= 2) attr.facet.breaks = raw;
      else delete attr.facet.breaks;
    }

    if (attr.type === 'boolean') {
      attr.facet.kind = 'boolean';
    }

    editCode = attr.code;
    dictDirty = true;
    renderSchemaTable(dictCurrent.attrs);
    refreshSchemaMeta('применено — сохраните файл');
    openSchemaEditor(attr.code);
  };

  window.closeSchemaEditor = function closeSchemaEditor() {
    editCode = null;
    const panel = $('schDrawer');
    panel?.classList.remove('open');
    const title = $('schDrawerTitle');
    if (title) {
      title.innerHTML = 'Редактор атрибута <span class="sch-drawer-sub">выберите слева</span>';
    }
    const body = panel?.querySelector('.sch-drawer-body');
    if (body) {
      body.innerHTML = `<div class="sch-drawer-idle">
        <b>Список слева → правка здесь</b>
        <p>Кликните атрибут, чтобы править тип, каноны, фильтр и «не путать с».</p>
      </div>`;
    }
    if (dictCurrent) renderSchemaTable(dictCurrent.attrs || []);
  };

  window.deleteSchemaAttr = function deleteSchemaAttr() {
    if (!dictCurrent || !editCode) return;
    if ((dictCurrent.attrs || []).length <= 1) {
      refreshSchemaMeta('нужен хотя бы один атрибут');
      return;
    }
    if (!confirm(`Удалить атрибут «${editCode}»?`)) return;
    dictCurrent.attrs = dictCurrent.attrs.filter(a => a.code !== editCode);
    dictDirty = true;
    closeSchemaEditor();
    renderSchemaTable(dictCurrent.attrs);
    refreshSchemaMeta('удалено — сохраните');
  };

  // Hook loadDictionary completion via mutation of dictStatus
  const _load = window.loadDictionary;
  if (typeof _load === 'function') {
    window.loadDictionary = async function (id) {
      schemaAudit = null;
      schemaPreview = null;
      editCode = null;
      $('schDrawer')?.classList.remove('open');
      await _load(id);
      if (dictCurrent) {
        refreshSchemaMeta();
        runSchemaAudit().catch(() => {});
      }
    };
  }

  const _status = window.dictStatus;
  if (typeof _status === 'function') {
    window.dictStatus = function (msg, ok) {
      if ($('schConstructor') && dictCurrent) {
        refreshSchemaMeta(msg || '');
        if (ok === false) refreshSchemaMeta(msg || 'ошибка');
        return;
      }
      return _status(msg, ok);
    };
  }

  let importSuggestions = [];

  function actionLabel(a) {
    return ({
      value: 'значение ENUM',
      synonym_name: 'синоним имени',
      blacklist: 'не путать с',
      new_attr: 'новый атрибут',
      skip: 'пропуск',
    })[a] || a;
  }

  function renderImportBox() {
    const box = $('schImportBox');
    const btn = $('schImportApplyBtn');
    if (!box) return;
    if (!importSuggestions.length) {
      box.innerHTML = '';
      if (btn) btn.disabled = true;
      return;
    }
    if (btn) btn.disabled = false;
    box.innerHTML = `<div class="sch-import-list">${importSuggestions.map((s, idx) => {
      const prop = s.proposed
        ? `<div class="muted">+ ${esc(s.proposed.code || '')} · ${esc(s.proposed.name || '')} · ${esc(s.proposed.type || '')}</div>`
        : '';
      const target = s.attr_code
        ? `<code>${esc(s.attr_code)}</code>${s.canon ? ` → <b>${esc(s.canon)}</b>` : ''}`
        : '';
      return `<label class="sch-import-row">
        <input type="checkbox" data-imp-idx="${idx}" ${s.selected !== false && s.action !== 'skip' ? 'checked' : ''}>
        <span class="sch-import-body">
          <span class="sch-badge ${s.action === 'skip' ? 'sch-warn' : (s.action === 'new_attr' ? 'sch-ok' : 'sch-ok')}">${esc(actionLabel(s.action))}</span>
          <b>${esc(s.raw)}</b>
          <div class="muted">${target} ${esc(s.note || '')} · ${Math.round((s.confidence || 0) * 100)}% · ${esc(s.source || '')}</div>
          ${prop}
        </span>
      </label>`;
    }).join('')}</div>
    <div class="set-actions" style="margin-top:8px">
      <button type="button" class="sbtn ghost" onclick="schemaImportSelectAll(true)">Выбрать все</button>
      <button type="button" class="sbtn ghost" onclick="schemaImportSelectAll(false)">Снять все</button>
      <button type="button" class="sbtn ghost" onclick="schemaImportSelectAction('new_attr')">Только новые атрибуты</button>
      <button type="button" class="sbtn ghost" onclick="schemaImportSelectAction('value')">Только значения</button>
    </div>`;
    box.querySelectorAll('[data-imp-idx]').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = Number(cb.dataset.impIdx);
        if (importSuggestions[i]) importSuggestions[i].selected = cb.checked;
      });
    });
  }

  window.schemaImportSelectAll = function (on) {
    importSuggestions.forEach(s => { s.selected = !!on && s.action !== 'skip'; });
    renderImportBox();
  };

  window.schemaImportSelectAction = function (action) {
    importSuggestions.forEach(s => { s.selected = s.action === action; });
    renderImportBox();
  };

  window.runSchemaImport = async function runSchemaImport(mode) {
    if (!dictCurrent?.id) return;
    const text = $('schImportText')?.value || '';
    const meta = $('schImportMeta');
    if (meta) meta.textContent = mode === 'ai' ? 'запрос к модели…' : 'эвристика…';
    try {
      const data = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/import-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          mode: mode === 'heuristic' ? 'heuristic' : 'ai',
          model: (typeof getV === 'function' ? getV('setModelName') : '') || undefined,
          attrs: dictCurrent.attrs,
        }),
      });
      importSuggestions = (data.suggestions || []).map(s => ({
        ...s,
        selected: s.selected !== false && s.action !== 'skip',
      }));
      renderImportBox();
      const nNew = importSuggestions.filter(s => s.action === 'new_attr').length;
      const nVal = importSuggestions.filter(s => s.action === 'value').length;
      if (meta) {
        meta.textContent = `${data.mode || mode}: ${importSuggestions.length} строк`
          + (nNew ? `, новых атрибутов ${nNew}` : '')
          + (nVal ? `, значений ${nVal}` : '')
          + (data.fallback ? ` (${data.fallback})` : '');
      }
    } catch (e) {
      if (meta) meta.textContent = e.message || 'ошибка импорта';
      importSuggestions = [];
      renderImportBox();
    }
  };

  window.applySchemaImport = async function applySchemaImport() {
    if (!dictCurrent?.id || !importSuggestions.length) return;
    const selected = importSuggestions.filter(s => s.selected && s.action !== 'skip');
    if (!selected.length) {
      refreshSchemaMeta('ничего не выбрано');
      return;
    }
    if (!confirm(`Применить ${selected.length} предложений к черновику справочника? Файл сохранится отдельно кнопкой «Сохранить».`)) return;
    const meta = $('schImportMeta');
    try {
      const data = await apiJson('/api/dictionaries/' + encodeURIComponent(dictCurrent.id) + '/import-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attrs: dictCurrent.attrs,
          suggestions: importSuggestions,
          save: false,
        }),
      });
      dictCurrent.attrs = data.attrs || dictCurrent.attrs;
      dictDirty = true;
      renderSchemaTable(dictCurrent.attrs);
      refreshSchemaMeta(`применено ${data.applied}, создано ${data.created}, пропуск ${data.skipped} — сохраните файл`);
      if (meta) meta.textContent = `черновик обновлён · +${data.created} атрибутов`;
      runSchemaAudit().catch(() => {});
    } catch (e) {
      if (meta) meta.textContent = e.message || 'не удалось применить';
    }
  };
})();
