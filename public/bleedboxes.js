// bleedboxes.js（前端）— 上传原稿，渲染裁切盒与出血盒核验报告
const form = document.getElementById('bleedboxes-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const PAGE_STATUS_LABEL = {
  ok: { text: '通过', cls: 'ok' },
  risk: { text: '风险', cls: 'risk' },
  undeclared: { text: '有未声明盒', cls: 'undeclared' },
  unknown: { text: '无法判断', cls: 'unknown' },
};

const EDGE_STATUS_LABEL = {
  ok: { text: '达标', cls: 'ok' },
  risk: { text: '出血不足', cls: 'risk' },
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  resultBox.hidden = true;

  const fileInput = document.getElementById('pdf');
  const file = fileInput.files[0];
  if (!file) {
    showError('请先选择一个 PDF 文件。');
    return;
  }

  const finishedWidthMm = Number(document.getElementById('finishedWidthMm').value);
  const finishedHeightMm = Number(document.getElementById('finishedHeightMm').value);
  const minBleedMm = Number(document.getElementById('minBleedMm').value);
  for (const [label, value] of [
    ['成品宽度', finishedWidthMm],
    ['成品高度', finishedHeightMm],
    ['最低出血量', minBleedMm],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      showError(`${label}必须为大于 0 的数字（毫米）。`);
      return;
    }
  }

  const body = new FormData();
  body.append('pdf', file);
  body.append('finishedWidthMm', String(finishedWidthMm));
  body.append('finishedHeightMm', String(finishedHeightMm));
  body.append('minBleedMm', String(minBleedMm));

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/bleedboxes', { method: 'POST', body });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || `核验失败（HTTP ${resp.status}）。`);
    }
    renderReport(data);
  } catch (err) {
    showError(err.message || '请求失败，请确认服务已启动。');
  } finally {
    loadingBox.hidden = true;
    submitBtn.disabled = false;
  }
});

function renderReport(data) {
  const { summary, finishedMm, minBleedMm } = data;

  const pageList = (arr) =>
    arr.length === 0 ? '无' : `第 ${arr.join('、')} 页`;

  document.getElementById('summary').replaceChildren(
    row('源文件', data.originalName),
    row('总页数', `${summary.totalPages} 页`),
    row(
      '成品尺寸',
      `${finishedMm.width} × ${finishedMm.height} mm（旋转后阅读方向）`
    ),
    row('最低出血量', `四边均 ${minBleedMm} mm（恰好达到不报）`),
    row('通过', summary.riskPages.length || summary.undeclaredPages.length || summary.unknownPages.length
      ? `${summary.okPages.length} 页（第 ${summary.okPages.join('、') || '—'} 页）`
      : `${summary.totalPages} 页全部通过`),
    row('风险页', `${summary.riskPages.length} 页（${pageList(summary.riskPages)}）：尺寸不符或出血不足`),
    row(
      '尺寸不符页',
      `${summary.sizeMismatchPages.length} 页（${pageList(summary.sizeMismatchPages)}）`
    ),
    row(
      '出血不足页',
      `${summary.bleedRiskPages.length} 页（${pageList(summary.bleedRiskPages)}）`
    ),
    row(
      '未声明页',
      `${summary.undeclaredPages.length} 页（${pageList(summary.undeclaredPages)}）：TrimBox 或 BleedBox 未显式声明`
    ),
    row('无法判断页', `${summary.unknownPages.length} 页（${pageList(summary.unknownPages)}）：盒无效或交集为空`)
  );

  const pagesWrap = document.getElementById('pages');
  pagesWrap.textContent = '';
  for (const page of data.pages) {
    pagesWrap.appendChild(renderPage(page));
  }

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPage(page) {
  const status = PAGE_STATUS_LABEL[page.status];
  const card = document.createElement('div');
  card.className = `card page-card ${status.cls}`;

  const head = document.createElement('div');
  head.className = 'page-head';

  const title = document.createElement('span');
  title.className = 'page-title';
  title.textContent = `第 ${page.pageNumber} 页`;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'page-meta';
  meta.textContent = `Rotate ${page.rotation === null ? '—' : page.rotation}° ｜ TrimBox ${
    boxStateText(page.boxes.trim)
  } ｜ BleedBox ${boxStateText(page.boxes.bleed)}`;
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  card.appendChild(renderBoxTable(page.boxes));
  card.appendChild(renderSizeCheck(page.sizeCheck));

  if (page.bleedEdges) {
    card.appendChild(renderBleedTable(page));
  } else if (page.bleedDeclared && page.status === 'unknown') {
    card.appendChild(noteP('BleedBox 与 CropBox、MediaBox 无交集（或交集退化），无法计算可用出血。'));
  } else if (!page.bleedDeclared && page.status !== 'unknown') {
    card.appendChild(noteP('页面未显式声明 BleedBox，不套用默认盒，四边出血距离无法计算。'));
  }

  for (const text of page.notes) {
    card.appendChild(noteP(text));
  }
  return card;
}

function renderBoxTable(boxes) {
  const table = document.createElement('table');
  table.className = 'bleed-boxes';
  table.innerHTML = `
    <thead>
      <tr><th>页面盒</th><th>状态</th><th>原点 x / y（mm）</th><th>宽 × 高（mm，未旋转用户空间）</th></tr>
    </thead>
    <tbody></tbody>`;
  const rows = [
    ['MediaBox', boxes.media, true],
    ['CropBox', boxes.crop, true],
    ['TrimBox', boxes.trim, false],
    ['BleedBox', boxes.bleed, false],
  ];
  const tbody = table.querySelector('tbody');
  for (const [name, info, required] of rows) {
    const tr = document.createElement('tr');
    if (info.invalid || (!info.declared && !info.defaulted)) tr.className = 'row-unknown';
    tr.appendChild(td(name, 'boxname'));

    const stateTd = document.createElement('td');
    if (info.defaulted) stateTd.textContent = '缺省（取 MediaBox）';
    else if (info.invalid) stateTd.textContent = '已声明但无效';
    else if (info.declared) stateTd.textContent = '显式声明';
    else stateTd.textContent = required ? '缺失/无效' : '未声明';
    tr.appendChild(stateTd);

    if (info.rectMm) {
      tr.appendChild(td(`${fmt(info.rectMm.x)} / ${fmt(info.rectMm.y)}`, 'num'));
      tr.appendChild(td(`${fmt(info.rectMm.width)} × ${fmt(info.rectMm.height)}`, 'num'));
    } else {
      tr.appendChild(td('—', 'num'));
      tr.appendChild(td('—', 'num'));
    }
    tbody.appendChild(tr);
  }
  return table;
}

function boxStateText(info) {
  if (info.invalid) return '已声明但无效';
  return info.declared ? '已声明' : '未声明';
}

function renderSizeCheck(sizeCheck) {
  if (!sizeCheck) {
    return noteP('盒几何无效，成品尺寸无法核对。');
  }
  const p = document.createElement('p');
  p.className = 'size-check';
  if (sizeCheck.status === 'undeclared') {
    p.textContent =
      `成品尺寸：期望 ${fmt(sizeCheck.expectedMm.width)} × ${fmt(sizeCheck.expectedMm.height)} mm；` +
      'TrimBox 未声明，无法核对。';
    return p;
  }
  const mismatch = sizeCheck.status === 'mismatch';
  p.classList.add(mismatch ? 'size-mismatch' : 'size-ok');
  p.textContent =
    `成品尺寸（旋转后阅读方向）：TrimBox ${fmt(sizeCheck.actualMm.width)} × ${fmt(sizeCheck.actualMm.height)} mm` +
    `，期望 ${fmt(sizeCheck.expectedMm.width)} × ${fmt(sizeCheck.expectedMm.height)} mm` +
    `，差值 ${signedFmt(sizeCheck.diffMm.width)} / ${signedFmt(sizeCheck.diffMm.height)} mm` +
    (mismatch ? ' —— 尺寸不符（超过 0.5 mm）。' : ' —— 相符（误差不超过 0.5 mm）。');
  return p;
}

function renderBleedTable(page) {
  const wrap = document.createElement('div');
  const caption = document.createElement('p');
  caption.className = 'table-caption';
  caption.textContent = page.usableBleedRectMm
    ? `可用出血范围 = BleedBox ∩ CropBox ∩ MediaBox（${fmt(page.usableBleedRectMm.width)} × ${fmt(page.usableBleedRectMm.height)} mm，未旋转用户空间）；四边超出 TrimBox 的距离（旋转后阅读方向）：`
    : '四边超出 TrimBox 的距离（旋转后阅读方向）：';
  wrap.appendChild(caption);

  const table = document.createElement('table');
  table.className = 'bleed-edges';
  table.innerHTML = `
    <thead>
      <tr><th>边</th><th>可用出血（mm）</th><th>最低要求（mm）</th><th>状态</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  for (const edge of page.bleedEdges) {
    const tr = document.createElement('tr');
    if (edge.status === 'risk') tr.className = 'row-mismatch';
    tr.appendChild(td(edge.edgeName));
    tr.appendChild(td(signedFmt(edge.distanceMm), 'num'));
    tr.appendChild(td(fmt(edge.requiredMm), 'num'));
    const stateTd = document.createElement('td');
    const label = EDGE_STATUS_LABEL[edge.status];
    const chip = document.createElement('span');
    chip.className = `badge ${label.cls}`;
    chip.textContent = label.text;
    stateTd.appendChild(chip);
    tr.appendChild(stateTd);
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function noteP(text) {
  const p = document.createElement('p');
  p.className = 'page-note';
  p.textContent = text;
  return p;
}

function td(text, className) {
  const el = document.createElement('td');
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function row(dtText, ddText) {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = dtText;
  const dd = document.createElement('dd');
  dd.textContent = ddText;
  frag.append(dt, dd);
  return frag;
}

function fmt(n) {
  return (n === null || n === undefined) ? '—' : String(n);
}
function signedFmt(n) {
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}
