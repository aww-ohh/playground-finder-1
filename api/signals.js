// api/signals.js — Vercel serverless function
// Accepts a list of parks (each with placeId, name, and review texts) and
// returns Gemini-extracted signals keyed by placeId. Called by the front end
// AFTER /api/places returns, so cards can render immediately and signals
// stream in shortly after.
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
  if (!body || !Array.isArray(body.parks)) {
    return res.status(400).json({ error: 'Missing or invalid parks array' });
  }
  var parks = body.parks;
  // Cap parks count to prevent abusive payloads (each park can be ~5 reviews ~1KB each).
  if (parks.length > 30) {
    return res.status(400).json({ error: 'Too many parks in one request (max 30)' });
  }
  if (parks.length === 0) {
    return res.status(200).json({ signals: {} });
  }

  // ---- 3. Check Gemini key ----
  var geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    // No key — return empty signals so the frontend falls back to defaults.
    return res.status(200).json({ signals: {} });
  }

  // ---- 4. Build the batch prompt ----
  var parkSections = [];
  var parkIds = []; // tracks which placeIds we actually included
  parks.forEach(function (p) {
    if (!p || !p.placeId || !Array.isArray(p.reviews) || p.reviews.length === 0) return;
    var reviewText = p.reviews.filter(function (r) { return r && r.length > 0; }).join('\n');
    if (reviewText.length === 0) return;
    parkSections.push('PARK ' + (parkSections.length + 1) + ': ' + (p.name || 'Unknown') + '\n' + reviewText);
    parkIds.push(p.placeId);
  });

  if (parkSections.length === 0) {
    return res.status(200).json({ signals: {} });
  }

  var prompt = 'You are analyzing reviews of multiple parks and playgrounds. '
    + 'For each park below, extract information about seven dimensions from its reviews.\n\n'
    + 'Dimensions:\n'
    + '1. fenced - Is the area fenced? Values: "yes", "no", or "not_mentioned"\n'
    + '2. shade - Is there shade available? Values: "yes", "no", or "not_mentioned"\n'
    + '3. bathrooms - Are there bathrooms or restrooms? Values: "yes", "no", or "not_mentioned"\n'
    + '4. ageSuitability - What ages is it suitable for? Values: "toddler", "older", "both", or "not_mentioned"\n'
    + '5. parking - What parking is available? Values: "lot", "street", "both", or "not_mentioned"\n'
    + '6. tennisCourts - Are there tennis courts at this park? Values: "yes", "no", or "not_mentioned"\n'
    + '7. changingTable - Do the bathrooms have a baby changing table or changing station? Values: "yes", "no", or "not_mentioned"\n\n'
    + 'Rules:\n'
    + '- If reviews are contradictory or vague about a dimension, return "not_mentioned"\n'
    + '- If reviews do not discuss a dimension at all, return "not_mentioned"\n'
    + '- When value is "not_mentioned", set summary to null\n'
    + '- When value is not "not_mentioned", provide a brief one-sentence summary in your own words\n'
    + '- Respond with ONLY valid JSON, no markdown fences, no other text\n\n'
    + 'Here are the parks and their reviews:\n\n'
    + parkSections.join('\n\n---\n\n')
    + '\n\nRespond with a JSON array where each element corresponds to a park in the same order:\n'
    + '[\n'
    + '  {\n'
    + '    "fenced": { "value": "...", "summary": "..." },\n'
    + '    "shade": { "value": "...", "summary": "..." },\n'
    + '    "bathrooms": { "value": "...", "summary": "..." },\n'
    + '    "ageSuitability": { "value": "...", "summary": "..." },\n'
    + '    "parking": { "value": "...", "summary": "..." },\n'
    + '    "tennisCourts": { "value": "...", "summary": "..." },\n'
    + '    "changingTable": { "value": "...", "summary": "..." }\n'
    + '  },\n'
    + '  ...\n'
    + ']';

  // ---- 5. Call Gemini ----
  // gemini-2.5-flash-lite has a more generous free tier than gemini-2.5-flash and is faster.
  // For a structured-extraction task like ours, lite is plenty accurate.
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
      // body or status to the client (it can echo prompt fragments and
      // help attackers fingerprint the backend).
      try {
        var errBody = await geminiRes.text();
        console.error('Gemini error', geminiRes.status, errBody.substring(0, 400));
      } catch (e) {}
      return res.status(200).json({ signals: {} });
    }
    var geminiData = await geminiRes.json();
    var text = geminiData.candidates
      && geminiData.candidates[0]
      && geminiData.candidates[0].content
      && geminiData.candidates[0].content.parts
      && geminiData.candidates[0].content.parts[0]
      && geminiData.candidates[0].content.parts[0].text;
    if (!text) {
      console.error('Gemini: no text in response', JSON.stringify(geminiData).substring(0, 300));
      return res.status(200).json({
        signals: {}
      });
    }
    var cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    var parsed = JSON.parse(cleaned);

    var out = {};
    if (Array.isArray(parsed)) {
      parkIds.forEach(function (placeId, i) {
        if (parsed[i]) {
          out[placeId] = validateSignals(parsed[i]);
        }
      });
    }
    return res.status(200).json({ signals: out });
  } catch (err) {
    return res.status(200).json({ signals: {} });
  }
};

// ---- Helper: validate and normalize Gemini's response ----
// Each signal is tagged with source: 'gemini' when value is real (not 'not_mentioned').
//
// SECURITY: The `summary` text is the only free-form field we accept from
// Gemini. Reviews fed to Gemini are attacker-controlled (anyone can post a
// Google review). A prompt-injection attack could try to make Gemini emit
// HTML/JS in summary, which would then be rendered into innerHTML on the
// client. Defense in depth:
//   1) sanitizeSummary() on the server strips control chars + any '<' or '>',
//      and hard-caps at 200 chars (Gemini summaries are 1 sentence; never need more).
//   2) Client renders summary via escapeHtml() (see app.js renderSignalRow).
function sanitizeSummary(s) {
  if (typeof s !== 'string') return null;
  // Strip control characters (incl. NULs and direction-override codepoints)
  // and any '<' or '>' so even a CSP bypass would have nothing to chew on.
  var cleaned = s.replace(/[\u0000-\u001F\u007F-\u009F<>]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > 200) cleaned = cleaned.slice(0, 200);
  return cleaned;
}

function validateSignals(parsed) {
  // V5: tennisCourts joins fenced/shade/bathrooms as a yes/no/not_mentioned signal.
  // V10 F3: changingTable too — it's yes/no/not_mentioned just like the others,
  // so the shared boolean validation (allowed values + sanitized summary) covers it.
  var booleanDimensions = ['fenced', 'shade', 'bathrooms', 'tennisCourts', 'changingTable'];
  var booleanAllowed = ['yes', 'no', 'not_mentioned'];
  var ageAllowed = ['toddler', 'older', 'both', 'not_mentioned'];
  var parkingAllowed = ['lot', 'street', 'both', 'not_mentioned'];

  var result = {};

  booleanDimensions.forEach(function (dim) {
    if (parsed[dim] && booleanAllowed.indexOf(parsed[dim].value) !== -1) {
      var v = parsed[dim].value;
      result[dim] = {
        value: v,
        summary: v === 'not_mentioned' ? null : sanitizeSummary(parsed[dim].summary),
        source: v === 'not_mentioned' ? null : 'gemini'
      };
    } else {
      result[dim] = { value: 'not_mentioned', summary: null, source: null };
    }
  });

  if (parsed.ageSuitability && ageAllowed.indexOf(parsed.ageSuitability.value) !== -1) {
    var av = parsed.ageSuitability.value;
    result.ageSuitability = {
      value: av,
      summary: av === 'not_mentioned' ? null : sanitizeSummary(parsed.ageSuitability.summary),
      source: av === 'not_mentioned' ? null : 'gemini'
    };
  } else {
    result.ageSuitability = { value: 'not_mentioned', summary: null, source: null };
  }

  if (parsed.parking && parkingAllowed.indexOf(parsed.parking.value) !== -1) {
    var pv = parsed.parking.value;
    result.parking = {
      value: pv,
      summary: pv === 'not_mentioned' ? null : sanitizeSummary(parsed.parking.summary),
      source: pv === 'not_mentioned' ? null : 'gemini'
    };
  } else {
    result.parking = { value: 'not_mentioned', summary: null, source: null };
  }

  return result;
}
