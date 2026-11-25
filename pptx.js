// Reads a .pptx and suggests questions: each slide's text, any line with a question mark,
// A/B/C/D options if it looks like multiple choice, and the slide's main picture.
const AdmZip = require('adm-zip');

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

function paragraphs(xml) {
  const out = [];
  for (const p of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []) {
    const text = (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => decode(t.replace(/<\/?a:t>/g, ''))).join('').trim();
    if (text) out.push(text);
  }
  return out;
}

function rels(zip, relPath) {
  const entry = zip.getEntry(relPath);
  if (!entry) return [];
  const xml = entry.getData().toString('utf8');
  return (xml.match(/<Relationship\b[^>]*>/g) || []).map((r) => ({
    id: (/\bId="([^"]+)"/.exec(r) || [])[1],
    type: (/\bType="([^"]+)"/.exec(r) || [])[1] || '',
    target: (/\bTarget="([^"]+)"/.exec(r) || [])[1] || '',
  }));
}

function resolve(base, target) {
  const parts = base.split('/'); parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const OPTION = /^\(?([A-Fa-f])[).:]\s+(.+)$/;

function readSlides(buf, saveImage) {
  if (!buf || !buf.length) throw new Error('Choose a PowerPoint file');
  let zip;
  try { zip = new AdmZip(buf); } catch { throw new Error('That file is not a PowerPoint (.pptx). Save it as .pptx and try again'); }
  const pres = zip.getEntry('ppt/presentation.xml');
  if (!pres) throw new Error('That file is not a PowerPoint (.pptx). Save it as .pptx and try again');
  const presXml = pres.getData().toString('utf8');
  const presRels = rels(zip, 'ppt/_rels/presentation.xml.rels');
  const order = (presXml.match(/<p:sldId\b[^>]*>/g) || []).map((s) => (/r:id="([^"]+)"/.exec(s) || [])[1]);
  const title = decode(((zip.getEntry('docProps/core.xml') || { getData: () => Buffer.from('') })
    .getData().toString('utf8').match(/<dc:title>([\s\S]*?)<\/dc:title>/) || [])[1] || '').trim();

  const slides = [];
  order.slice(0, 300).forEach((rid, i) => {
    const rel = presRels.find((r) => r.id === rid);
    if (!rel) return;
    const path = resolve('ppt/presentation.xml', rel.target);
    const entry = zip.getEntry(path);
    if (!entry) return;
    const xml = entry.getData().toString('utf8');
    if (/<p:sld\b[^>]*\bshow="0"/.test(xml)) return; // hidden slide
    const paras = paragraphs(xml);

    // Main picture: the biggest PNG/JPEG the slide itself uses (not the master's logo).
    let image = null;
    const pics = rels(zip, path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))
      .filter((r) => r.type.endsWith('/image'))
      .map((r) => zip.getEntry(resolve(path, r.target)))
      .filter((e) => e && /\.(png|jpe?g)$/i.test(e.entryName))
      .sort((a, b) => b.header.size - a.header.size);
    if (pics[0] && pics[0].header.size > 300 && pics[0].header.size < 8e6) {
      image = saveImage(pics[0].getData(), /\.png$/i.test(pics[0].entryName) ? 'png' : 'jpg');
    }

    const options = paras.map((p) => OPTION.exec(p)).filter(Boolean);
    const isChoice = options.length >= 2 && options.length <= 6;
    const qLines = paras.filter((p) => p.includes('?') && !OPTION.test(p));
    const stem = isChoice ? paras.filter((p) => !OPTION.test(p)) : paras;
    const text = (qLines.length ? qLines : stem).join('\n').slice(0, 1000);

    slides.push({
      slide: i + 1,
      allText: paras.join('\n').slice(0, 2000),
      text,
      looksLikeQuestion: qLines.length > 0 || isChoice,
      mode: isChoice ? 'choice' : 'either',
      options: isChoice ? options.map((m) => m[2].trim()) : [],
      image,
    });
  });
  return { title, slides };
}

module.exports = { readSlides };
