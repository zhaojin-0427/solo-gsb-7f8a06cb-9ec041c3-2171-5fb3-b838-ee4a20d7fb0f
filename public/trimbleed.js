// trimbleed.js（前端）— 上传原稿，渲染裁切与出血盒核验报告
const form = document.getElementById('trimbleed-form');
const errorBox = document.getElementById('error');
const loadingBox = document.getElementById('loading');
const resultBox = document.getElementById('result');
const submitBtn = document.getElementById('submit-btn');

const PAGE_STATUS_LABEL = {
  ok: { text: '通过', cls: 'ok' },
  'size-mismatch': { text: '尺寸不符', cls: 'risk' },
  risk: { text: '出血不足', cls: 'risk' },
  undeclared: { text: '未声明', cls: 'undeclared' },
  unknown: { text: '无法判断', cls: 'unknown' },
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

  const fields = [
    ['成品宽度', 'trimWidthMm'],
    ['成品高度', 'trimHeightMm'],
    ['最低出血量', 'minBleedMm'],
  ];
  const body = new FormData();
  body.append('pdf', file);
  for (const [label, id] of fields) {
    const value = Number(document.getElementById(id).value);
    if (!Number.isFinite(value) || value <= 0) {
      showError(`${label}必须为大于 0 的数字（毫米）。`);
      return;
    }
    body.append(id, String(value));
  }

  loadingBox.hidden = false;
  submitBtn.disabled = true;
  try {
    const resp = await fetch('/api/trimbleed', { method: 'POST', body });
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

function pageListText(numbers) {
  return `第 ${numbers.join('、')} 页`;
}

function renderReport(data) {
  const { summary } = data;

  document.getElementById('summary').replaceChildren(
    row('源文件', data.originalName),
    row('总页数', `${summary.totalPages} 页`),
    row('成品尺寸', `${data.trimWidthMm} × ${data.trimHeightMm} mm（阅读方向）`),
    row('最低出血量', `${data.minBleedMm} mm`),
    row(
      '风险页',
      summary.riskPages === 0
        ? '无'
        : `${summary.riskPages} 页（${pageListText(summary.riskPageNumbers)}）：` +
          `尺寸不符 ${summary.sizeMismatchPages} 页、出血不足 ${summary.bleedRiskPages} 页`
    ),
    row(
      '未声明页',
      summary.undeclaredPages === 0
        ? '无'
        : `${summary.undeclaredPages} 页（${pageListText(summary.undeclaredPageNumbers)}）：` +
          '缺少 TrimBox 或 BleedBox 声明'
    ),
    row(
      '无法判断页',
      summary.unknownPages === 0
        ? '无'
        : `${summary.unknownPages} 页（${pageListText(summary.unknownPageNumbers)}）：` +
          '盒无效、无交集或旋转角非法'
    ),
    row('通过', `${summary.okPages} 页`)
  );

  const pagesWrap = document.getElementById('pages');
  pagesWrap.textContent = '';
  for (const page of data.pages) {
    pagesWrap.appendChild(renderPage(page, data.minBleedMm));
  }

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPage(page, minBleedMm) {
  const status = PAGE_STATUS_LABEL[page.status];
  const card = document.createElement('div');
  card.className = `card page-card ${status.cls}`;

  const head = document.createElement('div');
  head.className = 'page-head';

  const title = document.createElement('span');
  title.className = 'page-title';
  title.textContent = `第 ${page.pageNumber} 页`;
  head.appendChild(title);

  const metaParts = [`旋转 ${page.rotation}°`];
  if (page.mediaBoxMm) {
    metaParts.push(`MediaBox ${page.mediaBoxMm.widthMm}×${page.mediaBoxMm.heightMm} mm`);
  }
  if (page.cropBoxMm) {
    metaParts.push(`CropBox ${page.cropBoxMm.widthMm}×${page.cropBoxMm.heightMm} mm`);
  }
  if (page.trimSizeMm) {
    metaParts.push(
      `TrimBox（阅读方向）${page.trimSizeMm.widthMm}×${page.trimSizeMm.heightMm} mm`
    );
  }
  const meta = document.createElement('span');
  meta.className = 'page-meta';
  meta.textContent = metaParts.join(' · ');
  head.appendChild(meta);

  const badge = document.createElement('span');
  badge.className = `badge ${status.cls}`;
  badge.textContent = status.text;
  head.appendChild(badge);
  card.appendChild(head);

  if (page.size) {
    card.appendChild(renderSizeTable(page.size));
  }
  if (page.edges) {
    card.appendChild(renderEdgeTable(page.edges, minBleedMm));
  }

  if (page.note) {
    const note = document.createElement('p');
    note.className = 'page-note';
    note.textContent = page.note;
    card.appendChild(note);
  }
  if (!page.size && !page.edges && !page.note) {
    const note = document.createElement('p');
    note.className = 'page-note';
    note.textContent = '本页无可用盒信息。';
    card.appendChild(note);
  }
  return card;
}

function renderSizeTable(size) {
  const table = document.createElement('table');
  table.className = 'check trimbleed';
  table.innerHTML = `
    <thead>
      <tr><th>成品尺寸核验</th><th>宽（mm）</th><th>高（mm）</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  const r1 = document.createElement('tr');
  r1.appendChild(td('成品（输入）'));
  r1.appendChild(td(String(size.expectedWidthMm), 'num'));
  r1.appendChild(td(String(size.expectedHeightMm), 'num'));
  tbody.appendChild(r1);

  const r2 = document.createElement('tr');
  r2.appendChild(td('TrimBox（阅读方向）'));
  r2.appendChild(td(String(size.actualWidthMm), 'num'));
  r2.appendChild(td(String(size.actualHeightMm), 'num'));
  tbody.appendChild(r2);

  const r3 = document.createElement('tr');
  if (!size.withinTolerance) r3.className = 'row-mismatch';
  r3.appendChild(td('误差'));
  r3.appendChild(td(formatDiff(size.diffWidthMm), 'num'));
  r3.appendChild(td(formatDiff(size.diffHeightMm), 'num'));
  tbody.appendChild(r3);

  return table;
}

function renderEdgeTable(edges, minBleedMm) {
  const table = document.createElement('table');
  table.className = 'check trimbleed';
  table.innerHTML = `
    <thead>
      <tr><th>四边可用出血（阅读方向）</th><th>超出 TrimBox（mm）</th><th>判定</th></tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  for (const edge of edges) {
    const tr = document.createElement('tr');
    if (edge.risk) tr.className = 'row-mismatch';
    tr.appendChild(td(`${edge.edgeName}边`));
    tr.appendChild(td(String(edge.bleedMm), 'num'));
    tr.appendChild(
      td(edge.risk ? `不足（要求 ≥ ${minBleedMm}）` : '达标')
    );
    tbody.appendChild(tr);
  }
  return table;
}

function formatDiff(n) {
  return n > 0 ? `+${n}` : String(n);
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

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}
