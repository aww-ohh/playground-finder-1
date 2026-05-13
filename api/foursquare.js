// api/foursquare.js — Vercel serverless function
// Accepts a list of parks (placeId, name, lat, lng) and returns matching
// Foursquare places (rating + total ratings) keyed by Google placeId.
// Foursquare ratings are 0–10; we normalize to 0–5 to match Google.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- Parse body ----
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || !Array.isArray(body.parks)) {
    return res.status(400).json({ error: 'Missing or invalid parks array' });
  }
  if (body.parks.length === 0) {
    return res.status(200).json({ fsq: {} });
  }

  // ---- Check Foursquare key ----
  var fsqKey = process.env.FOURSQUARE_API_KEY;
  if (!fsqKey) {
    return res.status(200).json({ fsq: {} });
  }

  // ---- For each park, search Foursquare in parallel ----
  var lookups = body.parks.map(function (p) {
    if (!p || !p.placeId || !p.name || typeof p.lat !== 'number' || typeof p.lng !== 'number') {
      return Promise.resolve({ placeId: p && p.placeId, match: null });
    }
    var url = 'https://api.foursquare.com/v3/places/search'
      + '?query=' + encodeURIComponent(p.name)
      + '&ll=' + p.lat + ',' + p.lng
      + '&radius=400'
      + '&limit=3'
      + '&sort=DISTANCE'
      + '&fields=fsq_id,name,rating,total_ratings';
    return fetch(url, {
      headers: {
        'Authorization': fsqKey,        // Foursquare wants the raw key (no "Bearer ")
        'Accept': 'application/json'
      }
    })
      .then(function (fsqRes) {
        if (!fsqRes.ok) return null;
        return fsqRes.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.results) || data.results.length === 0) {
          return { placeId: p.placeId, match: null };
        }
        var best = pickBestMatch(p.name, data.results);
        // Only count it as a match if there's actually a rating to show
        if (!best || typeof best.rating !== 'number' || best.rating <= 0) {
          return { placeId: p.placeId, match: null };
        }
        return {
          placeId: p.placeId,
          match: {
            fsqId: best.fsq_id,
            rating: Math.round((best.rating / 2) * 10) / 10, // 0–10 → 0–5, one decimal
            ratingOriginal: best.rating,
            reviewCount: typeof best.total_ratings === 'number' ? best.total_ratings : 0
          }
        };
      })
      .catch(function () { return { placeId: p.placeId, match: null }; });
  });

  try {
    var results = await Promise.all(lookups);
    var out = {};
    results.forEach(function (r) {
      if (r && r.placeId && r.match) {
        out[r.placeId] = r.match;
      }
    });
    return res.status(200).json({ fsq: out });
  } catch (err) {
    return res.status(200).json({ fsq: {} });
  }
};

// ---- Name matching: pick the closest match among Foursquare results ----
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickBestMatch(googleName, places) {
  var target = normalize(googleName);
  if (!target) return places[0] || null;
  var targetWords = target.split(' ').filter(function (w) { return w.length > 2; });

  var best = null;
  var bestScore = 0;
  places.forEach(function (b) {
    var n = normalize(b.name);
    if (!n) return;
    var score = 0;
    if (n.indexOf(target) !== -1 || target.indexOf(n) !== -1) score += 5;
    var bWords = n.split(' ');
    targetWords.forEach(function (w) {
      if (bWords.indexOf(w) !== -1) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  });

  if (bestScore >= 2) return best;
  return null;
}
