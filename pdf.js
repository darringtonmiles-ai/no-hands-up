// Builds lesson PDFs: a pupil's own notes, or the teacher's full class record.
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, 'pdf-fonts'); // WOFF (not WOFF2): pdfkit draws WOFF2 text blank
const INK = '#1B2A4A';
const GRAPHITE = '#5B6472';
const RULE = '#C9D6EA';
const HIGHLIGHT = '#FFE45C';
const LETTERS = 'ABCDEF';

function lessonPdf(out, { className, lesson, questions, student, mediaPath }) {
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `${className} lesson notes` } });
  doc.pipe(out);
  try {
    doc.registerFont('body', path.join(FONT_DIR, 'atkinson-hyperlegible-latin-400-normal.woff'));
    doc.registerFont('bold', path.join(FONT_DIR, 'atkinson-hyperlegible-latin-700-normal.woff'));
  } catch {
    doc.registerFont('body', 'Helvetica');
    doc.registerFont('bold', 'Helvetica-Bold');
  }
  const W = doc.page.width - 112;
  const left = 56;
  const date = new Date(lesson.startedAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Header
  doc.font('bold').fontSize(22).fillColor(INK).text(lesson.title || (student ? 'Lesson notes' : 'Lesson record'), left, 56, { width: W });
  doc.moveDown(0.2);
  doc.font('body').fontSize(11).fillColor(GRAPHITE)
    .text(`${className}, ${date}${student ? `. Notes for ${student.name}` : `. Full record of every pupil's answers`}`, { width: W });
  rule(doc);

  if (!questions.length) {
    doc.font('body').fontSize(12).fillColor(INK).text('No questions were asked in this lesson.');
  }

  questions.forEach((q, i) => {
    ensure(doc, 90);
    doc.font('bold').fontSize(10).fillColor(GRAPHITE).text(`Question ${i + 1}`, left, doc.y, { width: W });
    doc.moveDown(0.15);
    if (q.text) doc.font('bold').fontSize(14).fillColor(INK).text(q.text, { width: W });
    else if (!q.image) doc.font('body').fontSize(12).fillColor(GRAPHITE).text('Question shown on the board in class', { width: W });
    if (q.image) image(doc, mediaPath(q.image), W, 220);

    if (q.mode === 'choice') {
      doc.moveDown(0.3);
      q.options.forEach((o, k) => {
        const isCorrect = q.revealed && q.correct === k;
        const count = q.tally ? q.tally[k] : null;
        const mine = student && q.answers.find((a) => a.studentId === student.id && a.choice === k);
        let line = `${LETTERS[k]}.  ${o}`;
        if (!student && count != null) line += `   (${count} ${count === 1 ? 'pupil' : 'pupils'})`;
        if (isCorrect) line += '   Correct answer';
        if (mine) line += '   Your choice';
        doc.font(isCorrect || mine ? 'bold' : 'body').fontSize(12).fillColor(INK).text(line, { width: W });
      });
    }

    doc.moveDown(0.5);
    if (student) {
      const mine = q.answers.find((a) => a.studentId === student.id);
      if (q.mode !== 'choice') {
        label(doc, 'Your answer', mine && mine.starred);
        if (!mine) doc.font('body').fontSize(12).fillColor(GRAPHITE).text('You did not answer this question.', { width: W });
        else answerBody(doc, mine, mediaPath, W, true);
      } else if (!mine) {
        doc.font('body').fontSize(12).fillColor(GRAPHITE).text('You did not answer this question.', { width: W });
      } else if (q.revealed && q.correct != null) {
        doc.font('bold').fontSize(12).fillColor(INK)
          .text(mine.choice === q.correct ? 'You got this right.' : `You chose ${LETTERS[mine.choice]}. The answer was ${LETTERS[q.correct]}.`, { width: W });
      }
      const others = q.answers.filter((a) => a.starred && a.studentId !== student.id);
      if (others.length && q.mode !== 'choice') {
        doc.moveDown(0.6);
        label(doc, others.length === 1 ? 'Highlighted answer from the class' : 'Highlighted answers from the class', true);
        others.forEach((a, k) => {
          if (k) doc.moveDown(0.4);
          answerBody(doc, a, mediaPath, W);
        });
      }
    } else if (q.mode !== 'choice') {
      if (!q.answers.length) doc.font('body').fontSize(12).fillColor(GRAPHITE).text('No answers.', { width: W });
      q.answers.forEach((a, k) => {
        if (k) doc.moveDown(0.5);
        ensure(doc, 40);
        label(doc, a.name, a.starred);
        answerBody(doc, a, mediaPath, W, true);
      });
    } else {
      const names = q.answers.map((a) => `${a.name}: ${LETTERS[a.choice]}`).join(',  ');
      if (names) doc.font('body').fontSize(10).fillColor(GRAPHITE).text(names, { width: W });
    }
    rule(doc);
  });

  doc.end();
}

// Feedback is private to the pupil it was written for, so it is only printed when showFeedback is true.
function answerBody(doc, a, mediaPath, W, showFeedback) {
  if (a.text) doc.font('body').fontSize(12).fillColor(INK).text(a.text, { width: W, lineGap: 2 });
  if (a.drawing) image(doc, mediaPath(a.drawing), W, 260, true);
  if (showFeedback && a.feedback) {
    ensure(doc, 30);
    doc.moveDown(0.3);
    const y = doc.y;
    doc.font('bold').fontSize(11).fillColor(INK).text('Teacher comment: ', 68, y, { continued: true, width: W - 12 })
      .font('body').text(a.feedback);
    doc.save().lineWidth(2).strokeColor(HIGHLIGHT).moveTo(60, y - 1).lineTo(60, doc.y).stroke().restore();
    doc.text('', 56, doc.y);
  }
}

function label(doc, text, starred) {
  ensure(doc, 30);
  const y = doc.y;
  doc.font('bold').fontSize(11);
  const w = doc.widthOfString(text);
  if (starred) {
    doc.save().rect(54, y - 1, w + 26, 16).fill(HIGHLIGHT).restore();
    star(doc, 56 + w + 14, y + 7, 5.5);
  }
  doc.fillColor(INK).text(text, 56, y, { lineBreak: false });
  doc.text('', 56, y + 18);
  if (starred) {
    // nothing else; the highlight and star mark it
  }
}

function star(doc, cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]);
  }
  doc.save().polygon(...pts).fill(INK).restore();
}

function image(doc, file, W, maxH, framed) {
  if (!file || !fs.existsSync(file)) return;
  try {
    const img = doc.openImage(file);
    const scale = Math.min(W / img.width, maxH / img.height, 1.5);
    const w = img.width * scale, h = img.height * scale;
    ensure(doc, h + 12);
    const y = doc.y + 4;
    doc.image(img, 56, y, { width: w, height: h });
    if (framed) doc.save().lineWidth(0.75).strokeColor(RULE).rect(56, y, w, h).stroke().restore();
    doc.text('', 56, y + h + 6);
  } catch { /* skip unreadable image */ }
}

function rule(doc) {
  doc.moveDown(0.8);
  ensure(doc, 20);
  const y = doc.y;
  doc.save().lineWidth(0.75).strokeColor(RULE).moveTo(56, y).lineTo(doc.page.width - 56, y).stroke().restore();
  doc.text('', 56, y + 14);
}

function ensure(doc, needed) {
  if (doc.y + needed > doc.page.height - 56) doc.addPage();
}

module.exports = { lessonPdf };
