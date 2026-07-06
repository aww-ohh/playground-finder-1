// api/ask.js — Vercel serverless function
// "Ask about this park": takes ONE parent question plus that park's review
// texts, asks Gemini to answer using ONLY those reviews, and returns a short
// plain-text answer. Called by the front end when the user taps a preset chip
// or types their own question inside an expanded card.
//
// TRUST MODEL (why it's okay that the client sends the reviews): the reviews
// arrive from the browser, so yes, a hostile client could send made-up text.
// But all they'd get back is an answer about text THEY supplied — they can
// only waste their own time and our quota. The size caps below bound the cost
// of any single request, the GCP project quota bounds the total, and the
// answer is STILL sanitized before we return it (strip control chars + < >)
// because it eventually renders in a browser — defense in depth, same posture
// as api/signals.js.
module.exports = async function handler(req, res) {
  // ---- 1. Only POST ----
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- 2. Parse body (Vercel auto-parses JSON, but be defensive) ----
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body) {
    return res.status(400).json({ error: 'Missing request body' });
  }

  // ---- 3. Validate the question ----
  // Trimmed, 3–200 chars. Shorter than 3 can't be a real question ("a?"),
  // longer than 200 is either an accident or someone trying to stuff the prompt.
  var question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length < 3 || question.length > 200) {
    return res.status(400).json({ error: 'Question must be 3-200 characters' });
  }

  // ---- 4. Validate + cap the reviews ----
  // Cap at 10 reviews, 1500 chars each, ~8000 chars total — enough for a good
  // answer, small enough that no single request can run up a big Gemini bill.
  if (!Array.isArray(body.reviews)) {
    return res.status(400).json({ error: 'Missing or invalid reviews array' });
  }
  var reviews = [];
  var totalChars = 0;
  body.reviews.slice(0, 10).forEach(function (r) {
    if (typeof r !== 'string') return;
    var text = r.trim().slice(0, 1500);
    if (text.length === 0) return;
    if (totalChars + text.length > 8000) return; // total cap reached — drop the extras
    reviews.push(text);
    totalChars += text.length;
  });
  if (reviews.length === 0) {
    return res.status(400).json({ error: 'No usable review text' });
  }

  // ---- 5. Park name is optional — just cap it ----
  var parkName = typeof body.parkName === 'string' ? body.parkName.trim().slice(0, 100) : '';

  // ---- 6. Check Gemini key ----
  var geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    // No key configured — the front end shows its friendly "try again" line.
    return res.status(200).json({ answer: null });
  }

  // ---- 7. Build the prompt ----
  // "ONLY the visitor reviews" + "never guess" keeps Gemini honest: if the
  // reviews don't cover the question, we want "the reviews don't mention it",
  // not a plausible-sounding invention a parent might rely on.
  var numbered = reviews.map(function (r, i) {
    return (i + 1) + '. ' + r;
  }).join('\n\n');

  var prompt = 'You are answering a parent\'s question about the park "'
    + (parkName || 'this park')
    + '" using ONLY the visitor reviews below. '
    + 'If the reviews do not mention the answer, say the reviews don\'t mention it — never guess. '
    + 'Answer in 1-2 short sentences, plain text. '
    + 'Respond with ONLY valid JSON: {"answer": "..."}\n\n'
    + 'Question: ' + question + '\n\n'
    + 'Reviews:\n' + numbered;

  // ---- 8. Call Gemini ----
  // Same model as api/signals.js: gemini-2.5-flash-lite is fast, cheap, and
  // plenty for a grounded 1-2 sentence answer.
  var geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + geminiKey;
  try {
    var geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        }
      })
    });
    if (!geminiRes.ok) {
      // Log server-side for our own debugging; do NOT leak Gemini error
      // body or status to the client (same posture as api/signals.js).
      try {
        var errBody = await geminiRes.text();
        console.error('Gemini ask error', geminiRes.status, errBody.substring(0, 400));
      } catch (e) {}
      return res.status(200).json({ answer: null });
    }
    var geminiData = await geminiRes.json();
    var text = geminiData.candidates
      && geminiData.candidates[0]
      && geminiData.candidates[0].content
      && geminiData.candidates[0].content.parts
      && geminiData.candidates[0].content.parts[0]
      && geminiData.candidates[0].content.parts[0].text;
    if (!text) {
      console.error('Gemini ask: no text in response', JSON.stringify(geminiData).substring(0, 300));
      return res.status(200).json({ answer: null });
    }
    // Gemini sometimes wraps JSON in ``` fences despite responseMimeType — strip them.
    var cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    var parsed = JSON.parse(cleaned);
    var answer = sanitizeAnswer(parsed && parsed.answer);
    return res.status(200).json({ answer: answer });
  } catch (err) {
    console.error('Gemini ask failed', err && err.message);
    return res.status(200).json({ answer: null });
  }
};

// ---- Helper: sanitize Gemini's free-form answer ----
// SECURITY: the answer is derived from Google reviews, which anyone can post —
// so a prompt injection could try to make Gemini emit HTML/JS here. Same
// two-layer defense as signals.js sanitizeSummary:
//   1) Server strips control characters and any '<' or '>' so even a CSP
//      bypass would have nothing to chew on, and hard-caps at 400 chars
//      (answers are 1-2 sentences; never need more).
//   2) Client renders the answer via textContent only (see app.js runAsk).
function sanitizeAnswer(s) {
  if (typeof s !== 'string') return null;
  var cleaned = s.replace(/[\u0000-\u001F\u007F-\u009F<>]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > 400) cleaned = cleaned.slice(0, 400);
  return cleaned;
}
