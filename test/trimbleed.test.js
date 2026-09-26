// test/trimbleed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import {
  checkTrimBleed,
  normalizeRotation,
  boxFromNumbers,
  intersectBoxes,
  boxReadingSize,
  bleedDistancesPt,
  readingBleedEdges,
  findInsufficientEdges,
  TrimBleedError,
  PAGE_STATUS,
  PT_PER_MM,
  SIZE_TOLERANCE_MM,
  SCOPE_NOTE,
} from '../trimbleed.js';

const mm = (n) => n * PT_PER_MM;

// ---- 纯函数：旋转角规范化 ----

test('旋转角规范化：0/90/180/270 及等效角', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(270), 270);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
});

test('旋转角规范化：非 90 整数倍与非法值返回 null', () => {
  assert.equal(normalizeRotation(45), null);
  assert.equal(normalizeRotation(90.5), null);
  assert.equal(normalizeRotation(NaN), null);
  assert.equal(normalizeRotation(Infinity), null);
  assert.equal(normalizeRotation('90'), null);
});

// ---- 纯函数：盒解析与交集 ----

test('盒构造：归一化角点，退化盒无效', () => {
  assert.deepEqual(boxFromNumbers([10, 20, 30, 40]), {
    x1: 10,
    y1: 20,
    x2: 30,
    y2: 40,
  });
  // 角点颠倒时按 min/max 归一
  assert.deepEqual(boxFromNumbers([30, 40, 10, 20]), {
    x1: 10,
    y1: 20,
    x2: 30,
    y2: 40,
  });
  assert.equal(boxFromNumbers([10, 20, 10, 40]), null); // 宽为 0
  assert.equal(boxFromNumbers([10, 20, 30, 20]), null); // 高为 0
  assert.equal(boxFromNumbers([10, 20, 30]), null); // 元素不足
  assert.equal(boxFromNumbers([10, 20, 30, 'x']), null); // 非数字
  assert.equal(boxFromNumbers([10, 20, 30, NaN]), null);
});

test('盒交集：相交、相触与相离', () => {
  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.deepEqual(intersectBoxes(a, { x1: 5, y1: 5, x2: 15, y2: 15 }), {
    x1: 5,
    y1: 5,
    x2: 10,
    y2: 10,
  });
  // 仅边缘相触（面积为零）视为无交集
  assert.equal(intersectBoxes(a, { x1: 10, y1: 0, x2: 20, y2: 10 }), null);
  // 完全相离
  assert.equal(intersectBoxes(a, { x1: 20, y1: 20, x2: 30, y2: 30 }), null);
});

test('阅读方向尺寸：90/270 度时宽高互换', () => {
  const box = { x1: 0, y1: 0, x2: 200, y2: 100 };
  assert.deepEqual(boxReadingSize(box, 0), { widthPt: 200, heightPt: 100 });
  assert.deepEqual(boxReadingSize(box, 180), { widthPt: 200, heightPt: 100 });
  assert.deepEqual(boxReadingSize(box, 90), { widthPt: 100, heightPt: 200 });
  assert.deepEqual(boxReadingSize(box, 270), { widthPt: 100, heightPt: 200 });
});

test('阅读方向四边映射：随旋转角变化', () => {
  const trim = { x1: 10, y1: 10, x2: 110, y2: 210 };
  const range = { x1: 1, y1: 2, x2: 120, y2: 220 };
  const d = bleedDistancesPt(trim, range);
  assert.deepEqual(d, { x1: 9, y1: 8, x2: 10, y2: 10 });

  const at0 = Object.fromEntries(
    readingBleedEdges(d, 0).map((e) => [e.edge, e.distancePt])
  );
  assert.deepEqual(at0, { left: 9, right: 10, top: 10, bottom: 8 });

  const at90 = Object.fromEntries(
    readingBleedEdges(d, 90).map((e) => [e.edge, e.distancePt])
  );
  assert.deepEqual(at90, { left: 8, right: 10, top: 9, bottom: 10 });

  const at180 = Object.fromEntries(
    readingBleedEdges(d, 180).map((e) => [e.edge, e.distancePt])
  );
  assert.deepEqual(at180, { left: 10, right: 9, top: 8, bottom: 10 });

  const at270 = Object.fromEntries(
    readingBleedEdges(d, 270).map((e) => [e.edge, e.distancePt])
  );
  assert.deepEqual(at270, { left: 10, right: 8, top: 10, bottom: 9 });
});

test('出血不足判定：严格小于才报，恰好达到不报', () => {
  const edges = [
    { edge: 'left', edgeName: '左', distancePt: 10 },
    { edge: 'right', edgeName: '右', distancePt: 10 },
  ];
  assert.equal(findInsufficientEdges(edges, 10).length, 0); // 恰好达到不报
  assert.equal(findInsufficientEdges(edges, 10.1).length, 2); // 严格小于才报
  assert.equal(findInsufficientEdges(edges, 5).length, 0);
});

// ---- 构造工具 ----

/**
 * 构造单/多页 PDF。每页 spec：
 * mediaBox/cropBox/trimBox/bleedBox 为 [x, y, w, h]（pt，setters 语义），
 * rotation 为度；rawRotation 直接写页字典（用于非法旋转角）；
 * 缺省 mediaBox 时为 [0,0,mm(216),mm(303)]。
 */
async function makePdf(pagesSpec) {
  const doc = await PDFDocument.create();
  for (const spec of pagesSpec) {
    const media = spec.mediaBox || [0, 0, mm(216), mm(303)];
    const page = doc.addPage([media[2], media[3]]);
    if (media[0] !== 0 || media[1] !== 0) page.setMediaBox(...media);
    if (spec.cropBox) page.setCropBox(...spec.cropBox);
    if (spec.trimBox) page.setTrimBox(...spec.trimBox);
    if (spec.bleedBox) page.setBleedBox(...spec.bleedBox);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.rawRotation !== undefined) {
      page.node.set(PDFName.of('Rotate'), doc.context.obj(spec.rawRotation));
    }
  }
  return Buffer.from(await doc.save());
}

/** 标准合规页：成品 210×297，四边出血 3 mm（TrimBox 原点非零）。 */
function okPageSpec() {
  return {
    trimBox: [mm(3), mm(3), mm(210), mm(297)],
    bleedBox: [0, 0, mm(216), mm(303)],
  };
}

const OPTS = { trimWidthMm: 210, trimHeightMm: 297, minBleedMm: 3 };

// ---- 集成：输入校验 ----

test('输入校验：空文件、非 PDF、非法参数', async () => {
  await assert.rejects(() => checkTrimBleed(Buffer.alloc(0), OPTS), TrimBleedError);
  await assert.rejects(
    () => checkTrimBleed(Buffer.from('not a pdf'), OPTS),
    TrimBleedError
  );
  const buf = await makePdf([okPageSpec()]);
  for (const bad of [0, -1, NaN, undefined]) {
    await assert.rejects(
      () => checkTrimBleed(buf, { ...OPTS, trimWidthMm: bad }),
      TrimBleedError
    );
    await assert.rejects(
      () => checkTrimBleed(buf, { ...OPTS, trimHeightMm: bad }),
      TrimBleedError
    );
    await assert.rejects(
      () => checkTrimBleed(buf, { ...OPTS, minBleedMm: bad }),
      TrimBleedError
    );
  }
});

// ---- 集成：通过 / 尺寸 / 出血 ----

test('合规页：尺寸一致、四边出血恰好 3 mm，判定通过', async () => {
  const buf = await makePdf([okPageSpec()]);
  const report = await checkTrimBleed(buf, OPTS);
  assert.equal(report.pageCount, 1);
  const page = report.pages[0];
  assert.equal(page.status, PAGE_STATUS.ok);
  assert.equal(page.rotation, 0);
  assert.equal(page.trimDeclared, true);
  assert.equal(page.bleedDeclared, true);
  assert.deepEqual(page.trimSizeMm, { widthMm: 210, heightMm: 297 });
  assert.equal(page.size.withinTolerance, true);
  assert.equal(page.edges.length, 4);
  for (const edge of page.edges) {
    assert.equal(edge.bleedMm, 3);
    assert.equal(edge.risk, false);
  }
  assert.equal(report.summary.okPages, 1);
  assert.equal(report.scopeNote, SCOPE_NOTE);
});

test('尺寸不符：TrimBox 误差超过 0.5 mm', async () => {
  const buf = await makePdf([
    { trimBox: [mm(3), mm(3), mm(209), mm(297)], bleedBox: [0, 0, mm(216), mm(303)] },
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const page = report.pages[0];
  assert.equal(page.status, PAGE_STATUS.sizeMismatch);
  assert.equal(page.size.withinTolerance, false);
  assert.equal(page.size.diffWidthMm, -1);
  assert.match(page.note, /尺寸不符|误差超过/);
  assert.equal(report.summary.sizeMismatchPages, 1);
  assert.equal(report.summary.riskPages, 1);
});

test('尺寸误差恰好 0.5 mm 不报，0.6 mm 报', async () => {
  // TrimBox 加宽后 MediaBox/BleedBox 同步外扩，保持四边出血 3 mm
  const exact = await makePdf([
    {
      mediaBox: [0, 0, mm(216.5), mm(303)],
      trimBox: [mm(3), mm(3), mm(210.5), mm(297)],
      bleedBox: [0, 0, mm(216.5), mm(303)],
    },
  ]);
  const r1 = await checkTrimBleed(exact, OPTS);
  assert.equal(r1.pages[0].status, PAGE_STATUS.ok);
  assert.equal(SIZE_TOLERANCE_MM, 0.5);

  const over = await makePdf([
    {
      mediaBox: [0, 0, mm(216.6), mm(303)],
      trimBox: [mm(3), mm(3), mm(210.6), mm(297)],
      bleedBox: [0, 0, mm(216.6), mm(303)],
    },
  ]);
  const r2 = await checkTrimBleed(over, OPTS);
  assert.equal(r2.pages[0].status, PAGE_STATUS.sizeMismatch);
});

test('出血不足：单边严格小于最低出血量才报', async () => {
  // 左边出血 2 mm，其余三边 3 mm
  const buf = await makePdf([
    {
      trimBox: [mm(3), mm(3), mm(210), mm(297)],
      bleedBox: [mm(1), 0, mm(215), mm(303)],
    },
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const page = report.pages[0];
  assert.equal(page.status, PAGE_STATUS.risk);
  const left = page.edges.find((e) => e.edge === 'left');
  assert.equal(left.bleedMm, 2);
  assert.equal(left.risk, true);
  for (const e of page.edges.filter((e) => e.edge !== 'left')) {
    assert.equal(e.risk, false);
  }
  assert.match(page.note, /左边/);
  assert.equal(report.summary.bleedRiskPages, 1);
});

test('可用出血范围受 CropBox 与 MediaBox 共同裁切', async () => {
  // BleedBox 外扩 5 mm，但 MediaBox 只外扩 2 mm → 可用出血被裁为 2 mm
  const buf = await makePdf([
    {
      mediaBox: [0, 0, mm(214), mm(301)],
      trimBox: [mm(2), mm(2), mm(210), mm(297)],
      bleedBox: [mm(-3), mm(-3), mm(220), mm(309)],
    },
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const page = report.pages[0];
  assert.equal(page.status, PAGE_STATUS.risk);
  for (const e of page.edges) {
    assert.equal(e.bleedMm, 2);
    assert.equal(e.risk, true);
  }
});

// ---- 集成：未声明 / 无法判断 ----

test('未声明：缺 TrimBox、BleedBox 时不套用默认盒', async () => {
  const both = await makePdf([{}]);
  const r1 = await checkTrimBleed(both, OPTS);
  assert.equal(r1.pages[0].status, PAGE_STATUS.undeclared);
  assert.match(r1.pages[0].note, /TrimBox、BleedBox/);
  assert.equal(r1.pages[0].edges, null);
  assert.equal(r1.summary.undeclaredPages, 1);

  const trimOnly = await makePdf([
    { trimBox: [mm(3), mm(3), mm(210), mm(297)] },
  ]);
  const r2 = await checkTrimBleed(trimOnly, OPTS);
  assert.equal(r2.pages[0].status, PAGE_STATUS.undeclared);
  assert.match(r2.pages[0].note, /BleedBox/);
  assert.doesNotMatch(r2.pages[0].note, /TrimBox、/);
  // 已声明的 TrimBox 仍给出阅读方向尺寸供参考
  assert.deepEqual(r2.pages[0].trimSizeMm, { widthMm: 210, heightMm: 297 });
});

test('无法判断：BleedBox 与 CropBox、MediaBox 无交集', async () => {
  const buf = await makePdf([
    {
      trimBox: [mm(3), mm(3), mm(210), mm(297)],
      bleedBox: [mm(500), mm(500), mm(100), mm(100)], // 完全在页面外
    },
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const page = report.pages[0];
  assert.equal(page.status, PAGE_STATUS.unknown);
  assert.match(page.note, /无交集/);
  assert.equal(report.summary.unknownPages, 1);
});

test('无法判断：盒无效（宽高非正）与非法旋转角', async () => {
  const zeroWidth = await makePdf([
    {
      trimBox: [mm(3), mm(3), 0, mm(297)], // 宽为 0
      bleedBox: [0, 0, mm(216), mm(303)],
    },
  ]);
  const r1 = await checkTrimBleed(zeroWidth, OPTS);
  assert.equal(r1.pages[0].status, PAGE_STATUS.unknown);
  assert.match(r1.pages[0].note, /TrimBox 无效/);

  const badRotation = await makePdf([
    { ...okPageSpec(), rawRotation: 45 },
  ]);
  const r2 = await checkTrimBleed(badRotation, OPTS);
  assert.equal(r2.pages[0].status, PAGE_STATUS.unknown);
  assert.match(r2.pages[0].note, /旋转角/);
});

// ---- 集成：非零原点与旋转 ----

test('非零盒原点：MediaBox 不平移置零时距离仍正确', async () => {
  // MediaBox 原点 (100,100)，TrimBox 外扩 3 mm，BleedBox 外扩 4 mm
  const buf = await makePdf([
    {
      mediaBox: [100, 100, mm(218), mm(305)],
      trimBox: [100 + mm(4), 100 + mm(4), mm(210), mm(297)],
      bleedBox: [100, 100, mm(218), mm(305)],
    },
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const page = report.pages[0];
  assert.equal(page.status, PAGE_STATUS.ok);
  for (const e of page.edges) {
    assert.equal(e.bleedMm, 4);
    assert.equal(e.risk, false);
  }
  assert.deepEqual(page.trimSizeMm, { widthMm: 210, heightMm: 297 });
});

test('旋转 90 度：阅读方向左边对应用户空间下边，宽高互换', async () => {
  // 用户空间横向 303×216，旋转 90° 后阅读方向为 216×303 竖版
  // 用户空间下边（阅读方向左边）出血 1 mm，其余边 3 mm
  const buf = await makePdf([
    {
      mediaBox: [0, 0, mm(303), mm(216)],
      trimBox: [mm(3), mm(3), mm(297), mm(210)],
      bleedBox: [0, mm(2), mm(303), mm(214)],
      rotation: 90,
    },
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const page = report.pages[0];
  assert.equal(page.rotation, 90);
  assert.deepEqual(page.trimSizeMm, { widthMm: 210, heightMm: 297 });
  assert.equal(page.size.withinTolerance, true);
  assert.equal(page.status, PAGE_STATUS.risk);
  const byEdge = Object.fromEntries(page.edges.map((e) => [e.edge, e]));
  assert.equal(byEdge.left.bleedMm, 1);
  assert.equal(byEdge.left.risk, true);
  assert.equal(byEdge.right.bleedMm, 3);
  assert.equal(byEdge.top.bleedMm, 3);
  assert.equal(byEdge.bottom.bleedMm, 3);
});

test('旋转 180/270 度：阅读方向边映射正确', async () => {
  // 用户空间右边（180° 阅读方向左边）出血 1 mm，其余边 3 mm
  const buf180 = await makePdf([
    {
      mediaBox: [0, 0, mm(216), mm(303)],
      trimBox: [mm(3), mm(3), mm(210), mm(297)],
      bleedBox: [0, 0, mm(214), mm(303)],
      rotation: 180,
    },
  ]);
  const r180 = await checkTrimBleed(buf180, OPTS);
  const byEdge180 = Object.fromEntries(
    r180.pages[0].edges.map((e) => [e.edge, e])
  );
  assert.equal(r180.pages[0].status, PAGE_STATUS.risk);
  assert.equal(byEdge180.left.bleedMm, 1);
  assert.equal(byEdge180.left.risk, true);
  assert.equal(byEdge180.right.bleedMm, 3);

  // 用户空间上边（270° 阅读方向左边）出血 1 mm，其余边 3 mm
  const buf270 = await makePdf([
    {
      mediaBox: [0, 0, mm(303), mm(216)],
      trimBox: [mm(3), mm(3), mm(297), mm(210)],
      bleedBox: [0, 0, mm(303), mm(214)],
      rotation: 270,
    },
  ]);
  const r270 = await checkTrimBleed(buf270, OPTS);
  const byEdge270 = Object.fromEntries(
    r270.pages[0].edges.map((e) => [e.edge, e])
  );
  assert.equal(r270.pages[0].status, PAGE_STATUS.risk);
  assert.equal(byEdge270.left.bleedMm, 1);
  assert.equal(byEdge270.left.risk, true);
  assert.deepEqual(r270.pages[0].trimSizeMm, { widthMm: 210, heightMm: 297 });
});

test('继承的 MediaBox / CropBox / Rotate：自 Pages 父节点取得', async () => {
  // 用户空间横向 303×216，继承 Rotate 270° 后阅读方向为 210×297 竖版成品
  const doc = await PDFDocument.create();
  const page = doc.addPage([mm(303), mm(216)]);
  page.setTrimBox(mm(3), mm(3), mm(297), mm(210));
  page.setBleedBox(0, 0, mm(303), mm(216));

  // 把 MediaBox 移到页树父节点，并在父节点声明 CropBox 与 Rotate
  const leaf = page.node;
  const parent = leaf.Parent();
  const mediaBox = leaf.get(PDFName.of('MediaBox'));
  parent.set(PDFName.of('MediaBox'), mediaBox);
  // CropBox 只在用户空间左、下边内缩（1 mm、2 mm），裁掉部分出血
  parent.set(
    PDFName.of('CropBox'),
    doc.context.obj([mm(1), mm(2), mm(303), mm(216)])
  );
  parent.set(PDFName.of('Rotate'), doc.context.obj(270));
  leaf.delete(PDFName.of('MediaBox'));

  const buf = Buffer.from(await doc.save());
  const report = await checkTrimBleed(buf, OPTS);
  const p = report.pages[0];
  assert.equal(p.rotation, 270);
  assert.deepEqual(p.mediaBoxMm, { widthMm: 303, heightMm: 216 });
  assert.deepEqual(p.cropBoxMm, { widthMm: 302, heightMm: 214 });
  // 阅读方向：用户空间 297×210 的 TrimBox 旋转 270° 后为 210×297
  assert.deepEqual(p.trimSizeMm, { widthMm: 210, heightMm: 297 });
  // 270°：阅读方向右边 = 用户空间下边（被裁到 1 mm），
  //       阅读方向下边 = 用户空间左边（被裁到 2 mm）
  const byEdge = Object.fromEntries(p.edges.map((e) => [e.edge, e]));
  assert.equal(p.status, PAGE_STATUS.risk);
  assert.equal(byEdge.right.bleedMm, 1);
  assert.equal(byEdge.right.risk, true);
  assert.equal(byEdge.bottom.bleedMm, 2);
  assert.equal(byEdge.bottom.risk, true);
  assert.equal(byEdge.left.bleedMm, 3);
  assert.equal(byEdge.top.bleedMm, 3);
});

// ---- 集成：多页汇总 ----

test('汇总：风险页、未声明页与无法判断页分别列出页号', async () => {
  const buf = await makePdf([
    okPageSpec(), // 1 通过
    { trimBox: [mm(3), mm(3), mm(200), mm(297)], bleedBox: [0, 0, mm(216), mm(303)] }, // 2 尺寸不符
    { trimBox: [mm(3), mm(3), mm(210), mm(297)], bleedBox: [mm(2), 0, mm(215), mm(303)] }, // 3 出血不足
    {}, // 4 未声明
    { trimBox: [mm(3), mm(3), mm(210), mm(297)], bleedBox: [mm(500), mm(500), mm(10), mm(10)] }, // 5 无法判断
  ]);
  const report = await checkTrimBleed(buf, OPTS);
  const { summary } = report;
  assert.equal(summary.totalPages, 5);
  assert.equal(summary.okPages, 1);
  assert.equal(summary.riskPages, 2);
  assert.equal(summary.sizeMismatchPages, 1);
  assert.equal(summary.bleedRiskPages, 1);
  assert.equal(summary.undeclaredPages, 1);
  assert.equal(summary.unknownPages, 1);
  assert.deepEqual(summary.riskPageNumbers, [2, 3]);
  assert.deepEqual(summary.undeclaredPageNumbers, [4]);
  assert.deepEqual(summary.unknownPageNumbers, [5]);
});
