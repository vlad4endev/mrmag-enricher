/**
 * Конструктор атрибутов и фильтров — UI поверх /api/dictionaries.
 * Подключается из index_final.html; использует apiJson/esc из страницы.
 */
(function () {
  'use strict';

  let schemaAudit = null;
  let schemaPreview = null;
  let editCode = null;

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

  window.refreshSchemaMeta = function refreshSchemaMeta(extra) {
    const el = $('dictMeta');
    if (!el || !window.dictCurrent) return;
    const d = window.dictCurrent;
    const attrs = d.attrs || [];
    const facets = attrs.filter(a => a.facet?.enabled).length;
    const problems = schemaAudit?.problems ?? '—';
    el.innerHTML = `
      <span class="set-badge">ID: ${esc(d.id)}</span>
      <span class="set-note">${esc(d.name || '')}</span>
      <span class="muted">Атрибутов: ${attrs.length}</span>
      <span class="muted">Фильтров: ${facets}</span>
      <span class="muted">Проблем: ${problems}</span>
      ${window.dictDirty ? '<span class="set-badge" style="background:var(--abg);border-color:var(--abd);color:var(--amber)">не сохранено</span>' : ''}
      ${extra ? `<span class="muted">${esc(extra)}</span>` : ''}
    `;
  };

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
      body.innerHTML = '<tr><td colspan="10" class="muted">Нет атрибутов — добавьте строку</td></tr>';
      return;
    }
    const rows = [...attrs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.code).localeCompare(String(b.code)));
    body.innerHTML = rows.map(a => {
      const on = !!a.facet?.enabled;
      const kind = facetKindUi(a);
      const aud = auditFor(a.code);
      const st = aud?.status || (on && (a.type === 'enum' || a.type === 'multi_enum') && !valueCount(a) ? 'WARN' : 'OK');
      const warn = (aud?.issues || []).filter(i => i.severity === 'error' || i.severity === 'warn').length;
      return `<tr data-code="${esc(a.code)}" class="${on ? '' : 'dict-facet-off'} ${editCode === a.code ? 'sch-row-on' : ''}" onclick="openSchemaEditor('${esc(a.code)}')">
        <td>${a.order ?? 0}</td>
        <td><code>${esc(a.code)}</code></td>
        <td><b>${esc(a.name || '')}</b>${a.unit ? ` <span class="muted">${esc(a.unit)}</span>` : ''}</td>
        <td>${esc(a.type || '')}</td>
        <td>${on ? '✓' : '—'}</td>
        <td>${on ? esc(kind) : 'none'}</td>
        <td>${valueCount(a)}</td>
        <td class="muted">${a.coverage_final ?? a.coverage_now ?? '—'}</td>
        <td>${statusBadge(st)}</td>
        <td class="muted">${warn || '—'}</td>
      </tr>`;
    }).join('');
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

  window.openSchemaEditor = function openSchemaEditor(code) {
    const attr = (dictCurrent?.attrs || []).find(a => a.code === code);
    const panel = $('schDrawer');
    if (!attr || !panel) return;
    editCode = code;
    panel.classList.add('open');
    $('schDrawerTitle').textContent = attr.name || code;
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
    renderSchemaTable(dictCurrent.attrs || []);
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
    $('schDrawer')?.classList.remove('open');
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
})();
