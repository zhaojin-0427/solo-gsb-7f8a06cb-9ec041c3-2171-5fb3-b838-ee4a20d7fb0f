// trimbleed.js
// 裁切与出血盒核验核心逻辑。
//
// 规则：
//   - 逐页读取继承的 MediaBox、CropBox、Rotate（CropBox 缺省时取 MediaBox，
//     Rotate 缺省时取 0 度）；TrimBox、BleedBox 只认页面显式声明，
//     缺省时标为“未声明”，不套用默认盒；
//   - 按旋转后的阅读方向比较 TrimBox 与成品尺寸，任一边误差超过 0.5 毫米
//     报“尺寸不符”（恰好 0.5 毫米不报）；
//   - 可用出血范围 = BleedBox ∩ CropBox ∩ MediaBox，逐边（阅读方向）计算它
//     超出 TrimBox 的距离，严格小于最低出血量报“出血不足”，恰好达到不报；
//   - 非零盒原点照常处理；Rotate 支持 90/180/270 度，非 90 整数倍标“无法判断”；
//   - 盒无效（不是 4 个数、宽高非正）或三者交集为空时标“无法判断”；
//   - 只核验盒几何关系，不判断页面内容是否实际铺满出血区。
//
// 解析使用 pdf-lib 底层对象模型（PDFPageLeaf / PDFArray / PDFNumber），
// MediaBox、CropBox、Rotate 经 getInheritableAttribute 沿页树继承取得，
// TrimBox、BleedBox 按 PDF 规范不可继承，只读页面字典自身条目。

import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFNumber,
} from 'pdf-lib';

export class TrimBleedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrimBleedError';
  }
}

export const PT_PER_MM = 72 / 25.4;
// 成品尺寸容差（毫米）：误差超过 0.5 mm 报尺寸不符，恰好 0.5 mm 不报
export const SIZE_TOLERANCE_MM = 0.5;
// 比较容差（pt）：吸收浮点误差，恰好达到阈值时不报
export const EDGE_EPS_PT = 0.01;

export const EDGE_NAMES = {
  left: '左',
  right: '右',
  top: '上',
  bottom: '下',
};
const EDGE_ORDER = ['left', 'right', 'top', 'bottom'];

// 页面状态
export const PAGE_STATUS = {
  ok: 'ok', // 通过
  sizeMismatch: 'size-mismatch', // 尺寸不符
  risk: 'risk', // 出血不足
  undeclared: 'undeclared', // 未声明
  unknown: 'unknown', // 无法判断
};

export const SCOPE_NOTE =
  '只核验页面盒（MediaBox / CropBox / TrimBox / BleedBox）的几何关系，' +
  '不判断页面内容是否实际铺满出血区。';

// 阅读方向边 → 用户空间盒边（x1=左、x2=右、y1=下、y2=上）。
// Rotate 为顺时针角度：90° 时阅读方向左边对应用户空间下边，以此类推。
export const READING_EDGE_MAP = {
  0: { left: 'x1', right: 'x2', top: 'y2', bottom: 'y1' },
  90: { left: 'y1', right: 'y2', top: 'x1', bottom: 'x2' },
  180: { left: 'x2', right: 'x1', top: 'y1', bottom: 'y2' },
  270: { left: 'y2', right: 'y1', top: 'x2', bottom: 'x1' },
};

/** 规范化旋转角：归一到 0/90/180/270；非 90 整数倍返回 null。 */
export function normalizeRotation(angle) {
  if (typeof angle !== 'number' || !Number.isFinite(angle)) return null;
  const norm = ((Math.round(angle) % 360) + 360) % 360;
  return Object.prototype.hasOwnProperty.call(READING_EDGE_MAP, norm)
    ? norm
    : null;
}

/**
 * 由 4 个数构造盒（自动按 min/max 归一）。
 * 宽高非正（退化盒）返回 null。
 */
export function boxFromNumbers(nums) {
  if (!Array.isArray(nums) || nums.length !== 4) return null;
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  const x1 = Math.min(nums[0], nums[2]);
  const x2 = Math.max(nums[0], nums[2]);
  const y1 = Math.min(nums[1], nums[3]);
  const y2 = Math.max(nums[1], nums[3]);
  if (!(x2 > x1) || !(y2 > y1)) return null;
  return { x1, y1, x2, y2 };
}

/** 两盒交集；任一盒缺失、无交集（含仅相触、面积为零）时返回 null。 */
export function intersectBoxes(a, b) {
  if (!a || !b) return null;
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (!(x2 > x1) || !(y2 > y1)) return null;
  return { x1, y1, x2, y2 };
}

/** 盒在阅读方向上的宽、高（pt）：旋转 90/270 度时宽高互换。 */
export function boxReadingSize(box, rotation) {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  return rotation === 90 || rotation === 270
    ? { widthPt: h, heightPt: w }
    : { widthPt: w, heightPt: h };
}

/**
 * 可用出血范围超出 TrimBox 的距离（pt），按用户空间盒边给出。
 * 正值表示出血范围超出 TrimBox，负值表示 TrimBox 越出可用范围。
 */
export function bleedDistancesPt(trim, range) {
  return {
    x1: trim.x1 - range.x1,
    x2: range.x2 - trim.x2,
    y1: trim.y1 - range.y1,
    y2: range.y2 - trim.y2,
  };
}

/**
 * 把用户空间盒边距离映射为阅读方向四边（左、右、上、下）。
 * @returns {Array<{edge:string, edgeName:string, distancePt:number}>}
 */
export function readingBleedEdges(distances, rotation) {
  const map = READING_EDGE_MAP[rotation];
  return EDGE_ORDER.map((edge) => ({
    edge,
    edgeName: EDGE_NAMES[edge],
    distancePt: distances[map[edge]],
  }));
}

/** 判定出血不足的边：距离严格小于（最低出血量 − 容差）才报，恰好达到不报。 */
export function findInsufficientEdges(edges, minBleedPt) {
  return edges.filter((e) => e.distancePt < minBleedPt - EDGE_EPS_PT);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function mmToPt(mm) {
  return mm * PT_PER_MM;
}

function ptToMm(pt) {
  return pt / PT_PER_MM;
}

/** 读取沿页树继承的盒（MediaBox / CropBox）；缺失返回 undefined，无效返回 null。 */
function readInheritedBox(pageLeaf, name) {
  const raw = pageLeaf.getInheritableAttribute(PDFName.of(name));
  if (raw === undefined) return undefined;
  return parseBoxValue(pageLeaf, raw);
}

/** 读取页面字典显式声明的盒（TrimBox / BleedBox）；缺失返回 undefined，无效返回 null。 */
function readDeclaredBox(pageLeaf, name) {
  const raw = pageLeaf.get(PDFName.of(name));
  if (raw === undefined) return undefined;
  return parseBoxValue(pageLeaf, raw);
}

/** 把 PDF 对象解析为盒；不是 4 个数的数组或退化时返回 null。 */
function parseBoxValue(pageLeaf, raw) {
  const context = pageLeaf.context;
  const arr = context.lookupMaybe(raw, PDFArray);
  if (!(arr instanceof PDFArray) || arr.size() !== 4) return null;
  const nums = [];
  for (let i = 0; i < 4; i++) {
    const value = context.lookup(arr.get(i));
    if (!(value instanceof PDFNumber)) return null;
    nums.push(value.asNumber());
  }
  return boxFromNumbers(nums);
}

/** 读取继承的 Rotate；缺省 0 度，非 90 整数倍返回 null。 */
function readRotation(pageLeaf) {
  const raw = pageLeaf.getInheritableAttribute(PDFName.of('Rotate'));
  if (raw === undefined) return 0;
  const num = pageLeaf.context.lookupMaybe(raw, PDFNumber);
  if (!(num instanceof PDFNumber)) return null;
  return normalizeRotation(num.asNumber());
}

function boxSizeMm(box, rotation) {
  const { widthPt, heightPt } = boxReadingSize(box, rotation);
  return { widthMm: round1(ptToMm(widthPt)), heightMm: round1(ptToMm(heightPt)) };
}

/**
 * 分析单页盒几何。
 * @param pageLeaf pdf-lib PDFPageLeaf
 * @param {{trimWidthMm:number, trimHeightMm:number, minBleedMm:number}} opts 毫米
 */
function analyzePage(pageLeaf, pageNumber, opts) {
  const page = {
    pageNumber,
    rotation: 0,
    mediaBoxMm: null,
    cropBoxMm: null,
    trimDeclared: false,
    bleedDeclared: false,
    trimSizeMm: null, // 阅读方向
    bleedSizeMm: null, // 阅读方向
    size: null, // 成品尺寸核验
    edges: null, // 阅读方向四边可用出血
    status: PAGE_STATUS.unknown,
    note: null,
  };

  // MediaBox（继承，必需）
  const mediaBox = readInheritedBox(pageLeaf, 'MediaBox');
  if (!mediaBox) {
    page.note = 'MediaBox 缺失或无效，无法判断。';
    return page;
  }
  page.mediaBoxMm = boxSizeMm(mediaBox, 0);

  // CropBox（继承，缺省取 MediaBox）
  const cropRaw = readInheritedBox(pageLeaf, 'CropBox');
  if (cropRaw === null) {
    page.note = 'CropBox 无效（应为 4 个数且宽高为正），无法判断。';
    return page;
  }
  const cropBox = cropRaw === undefined ? mediaBox : cropRaw;
  page.cropBoxMm = boxSizeMm(cropBox, 0);

  // Rotate（继承，缺省 0 度）
  const rotation = readRotation(pageLeaf);
  if (rotation === null) {
    page.note = '页面旋转角不是 90 度的整数倍，无法判断。';
    return page;
  }
  page.rotation = rotation;

  // TrimBox / BleedBox（仅页面显式声明，不套用默认盒）
  const trimBox = readDeclaredBox(pageLeaf, 'TrimBox');
  const bleedBox = readDeclaredBox(pageLeaf, 'BleedBox');
  page.trimDeclared = trimBox !== undefined;
  page.bleedDeclared = bleedBox !== undefined;

  if (!page.trimDeclared || !page.bleedDeclared) {
    const missing = [
      !page.trimDeclared ? 'TrimBox' : null,
      !page.bleedDeclared ? 'BleedBox' : null,
    ].filter(Boolean);
    page.status = PAGE_STATUS.undeclared;
    page.note = `页面未声明 ${missing.join('、')}；未声明的盒不套用默认盒，跳过核验。`;
    if (trimBox) page.trimSizeMm = boxSizeMm(trimBox, rotation);
    if (bleedBox) page.bleedSizeMm = boxSizeMm(bleedBox, rotation);
    return page;
  }

  if (!trimBox) {
    page.note = 'TrimBox 无效（应为 4 个数且宽高为正），无法判断。';
    return page;
  }
  if (!bleedBox) {
    page.note = 'BleedBox 无效（应为 4 个数且宽高为正），无法判断。';
    return page;
  }
  page.trimSizeMm = boxSizeMm(trimBox, rotation);
  page.bleedSizeMm = boxSizeMm(bleedBox, rotation);

  // 成品尺寸核验（阅读方向）
  const trimSize = boxReadingSize(trimBox, rotation);
  const diffWidthMm = ptToMm(trimSize.widthPt) - opts.trimWidthMm;
  const diffHeightMm = ptToMm(trimSize.heightPt) - opts.trimHeightMm;
  const tolerancePt = mmToPt(SIZE_TOLERANCE_MM) + EDGE_EPS_PT;
  const withinTolerance =
    Math.abs(trimSize.widthPt - mmToPt(opts.trimWidthMm)) <= tolerancePt &&
    Math.abs(trimSize.heightPt - mmToPt(opts.trimHeightMm)) <= tolerancePt;
  page.size = {
    expectedWidthMm: opts.trimWidthMm,
    expectedHeightMm: opts.trimHeightMm,
    actualWidthMm: round1(ptToMm(trimSize.widthPt)),
    actualHeightMm: round1(ptToMm(trimSize.heightPt)),
    diffWidthMm: round1(diffWidthMm),
    diffHeightMm: round1(diffHeightMm),
    withinTolerance,
  };

  // 可用出血范围 = BleedBox ∩ CropBox ∩ MediaBox
  const range = intersectBoxes(intersectBoxes(bleedBox, cropBox), mediaBox);
  if (!range) {
    page.status = PAGE_STATUS.unknown;
    page.note = 'BleedBox 与 CropBox、MediaBox 无交集，无法判断可用出血范围。';
    return page;
  }

  // 阅读方向四边可用出血
  const edges = readingBleedEdges(bleedDistancesPt(trimBox, range), rotation);
  const minBleedPt = mmToPt(opts.minBleedMm);
  const insufficient = findInsufficientEdges(edges, minBleedPt);
  page.edges = edges.map((e) => ({
    edge: e.edge,
    edgeName: e.edgeName,
    bleedMm: round1(ptToMm(e.distancePt)),
    risk: e.distancePt < minBleedPt - EDGE_EPS_PT,
  }));

  const notes = [];
  if (!withinTolerance) {
    page.status = PAGE_STATUS.sizeMismatch;
    notes.push(
      `TrimBox 尺寸（阅读方向）${page.size.actualWidthMm}×${page.size.actualHeightMm} mm，` +
        `与成品 ${opts.trimWidthMm}×${opts.trimHeightMm} mm 的误差超过 ${SIZE_TOLERANCE_MM} mm。`
    );
  } else if (insufficient.length > 0) {
    page.status = PAGE_STATUS.risk;
  } else {
    page.status = PAGE_STATUS.ok;
  }
  if (insufficient.length > 0) {
    notes.push(
      `${insufficient.map((e) => e.edgeName).join('、')}边可用出血低于最低出血量 ${opts.minBleedMm} mm。`
    );
  }
  page.note = notes.length > 0 ? notes.join('') : null;
  return page;
}

/**
 * 裁切与出血盒核验主流程：校验上传文件与参数，逐页核验盒几何。
 * @param {Buffer} buffer 上传的原始 PDF 字节
 * @param {{trimWidthMm:number, trimHeightMm:number, minBleedMm:number}} opts 毫米
 */
export async function checkTrimBleed(buffer, opts = {}) {
  const { trimWidthMm, trimHeightMm, minBleedMm } = opts;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TrimBleedError('上传文件为空，请选择有效的 PDF 文件。');
  }
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') {
    throw new TrimBleedError('文件不是有效的 PDF（文件头损坏或并非 PDF 文件）。');
  }

  for (const [label, value] of [
    ['成品宽度', trimWidthMm],
    ['成品高度', trimHeightMm],
    ['最低出血量', minBleedMm],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new TrimBleedError(`${label}必须为大于 0 的数字（毫米）。`);
    }
  }

  let doc;
  let pdfPages;
  try {
    doc = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    // 部分损坏文件在访问页树时才暴露错误，一并纳入解析失败处理
    pdfPages = doc.getPages();
  } catch (err) {
    if (/encrypt|password/i.test(err.message || '')) {
      throw new TrimBleedError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
    throw new TrimBleedError(`PDF 文件损坏或无法解析：${err.message}`);
  }

  // 双保险：检查 trailer 中的 Encrypt 字典（个别加密文档的报错信息不含 encrypt）
  try {
    const encrypt =
      doc.context.trailer && doc.context.trailer.dict
        ? doc.context.trailer.dict.get('Encrypt')
        : undefined;
    if (encrypt) {
      throw new TrimBleedError('该 PDF 已加密，请先解除密码/加密后再上传。');
    }
  } catch (err) {
    if (err instanceof TrimBleedError) throw err;
    // 字典访问异常不影响主流程
  }

  if (pdfPages.length === 0) {
    throw new TrimBleedError('PDF 中没有任何页面。');
  }

  const optsMm = { trimWidthMm, trimHeightMm, minBleedMm };
  const pages = [];
  for (let i = 0; i < pdfPages.length; i++) {
    let page;
    try {
      page = analyzePage(pdfPages[i].node, i + 1, optsMm);
    } catch (err) {
      page = {
        pageNumber: i + 1,
        rotation: 0,
        mediaBoxMm: null,
        cropBoxMm: null,
        trimDeclared: false,
        bleedDeclared: false,
        trimSizeMm: null,
        bleedSizeMm: null,
        size: null,
        edges: null,
        status: PAGE_STATUS.unknown,
        note: `页面盒读取失败：${err.message}`,
      };
    }
    pages.push(page);
  }

  const pageNumbers = (pred) =>
    pages.filter(pred).map((pg) => pg.pageNumber);
  const riskPageNumbers = pageNumbers(
    (pg) =>
      pg.status === PAGE_STATUS.risk || pg.status === PAGE_STATUS.sizeMismatch
  );
  const undeclaredPageNumbers = pageNumbers(
    (pg) => pg.status === PAGE_STATUS.undeclared
  );
  const unknownPageNumbers = pageNumbers(
    (pg) => pg.status === PAGE_STATUS.unknown
  );

  return {
    trimWidthMm,
    trimHeightMm,
    minBleedMm,
    pageCount: pdfPages.length,
    pages,
    summary: {
      totalPages: pdfPages.length,
      okPages: pages.filter((pg) => pg.status === PAGE_STATUS.ok).length,
      riskPages: riskPageNumbers.length,
      sizeMismatchPages: pages.filter(
        (pg) => pg.status === PAGE_STATUS.sizeMismatch
      ).length,
      bleedRiskPages: pages.filter((pg) => pg.status === PAGE_STATUS.risk)
        .length,
      undeclaredPages: undeclaredPageNumbers.length,
      unknownPages: unknownPageNumbers.length,
      riskPageNumbers,
      undeclaredPageNumbers,
      unknownPageNumbers,
    },
    scopeNote: SCOPE_NOTE,
  };
}
