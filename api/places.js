// api/places.js — Vercel serverless function
// Accepts lat/lng from the front end, calls Google Places API (New),
// fetches photo URLs, extracts review signals via Gemini Flash,
// and returns a cleaned list of nearby parks and playgrounds.
module.exports = async function handler(req, res) {
  // ---- 1. Validate query parameters ----
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Missing or invalid lat/lng parameters' });
  }
  // ---- 1b. Validate radius parameter ----
  var allowedRadii = [0.5, 1, 2, 5];
  var radiusMiles = parseFloat(req.query.radius);
  if (req.query.radius !== undefined && allowedRadii.indexOf(radiusMiles) === -1) {
    return res.status(400).json({ error: 'Invalid radius parameter' });
  }
  if (isNaN(radiusMiles) || allowedRadii.indexOf(radiusMiles) === -1) {
    radiusMiles = 2; // default
  }
  var radiusMeters = radiusMiles * 1609.344;
  // ---- 2. Check for API keys ----
  var apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  var geminiKey = process.env.GEMINI_API_KEY;
  // Gemini key is optional — if missing, signals will be null
  // ---- 3. Call Google Places API (New) — Nearby Search ----
  var googleUrl = 'https://places.googleapis.com/v1/places:searchNearby';
  var requestBody = {
    includedTypes: ['park', 'playground'],
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radiusMeters
      }
    },
    maxResultCount: 20
  };
  var fieldMask = [
    'places.id',
    'places.displayName',
    'places.types',
    'places.location',
    'places.rating',
    'places.userRatingCount',
    'places.photos',
    'places.reviews'
  ].join(',');
  try {
    var response = await fetch(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to fetch places' });
    }
    var data = await response.json();
    // ---- 4. Handle empty results ----
    if (!data.places || data.places.length === 0) {
      return res.status(200).json({ results: [] });
    }
    // ---- 4b. Fetch photo URLs in parallel ----
    var photoPromises = data.places.map(function (place) {
      if (!place.photos || place.photos.length === 0) {
        return Promise.resolve(null);
      }
      var firstPhoto = place.photos[0];
      var photoMediaUrl = 'https://places.googleapis.com/v1/'
        + firstPhoto.name
        + '/media?maxHeightPx=400&skipHttpRedirect=true&key=' + apiKey;
      return fetch(photoMediaUrl)
        .then(function (photoRes) {
          if (!photoRes.ok) return null;
          return photoRes.json().then(function (photoData) {
            return {
              photoUrl: photoData.photoUri || null,
              photoAttribution: getAttribution(firstPhoto)
            };
          });
        })
        .catch(function () {
          return null;
        });
    });
    var photoResults = await Promise.all(photoPromises);
    // ---- 4c. Extract review signals via Gemini Flash ----
    // All parks are sent in a single Gemini call to stay within
    // the free tier rate limit (instead of one call per park).
    var signalResults = await extractAllSignals(data.places, geminiKey);
    // ---- 5. Clean and transform each result ----
    var results = data.places.map(function (place, index) {
      var placeLat = place.location.latitude;
      var placeLng = place.location.longitude;
      var photo = photoResults[index];
      var signals = signalResults[index];
      return {
        name: place.displayName.text,
        type: place.types.includes('playground') ? 'playground' : 'park',
        lat: placeLat,
        lng: placeLng,
        distance: haversine(lat, lng, placeLat, placeLng),
        rating: place.rating || null,
        reviewCount: place.userRatingCount || 0,
        placeId: place.id,
        photoUrl: photo ? photo.photoUrl : null,
        photoAttribution: photo ? photo.photoAttribution : null,
        signals: signals || defaultSignals()
      };
    });
    // ---- 6. Sort by distance, closest first ----
    results.sort(function (a, b) { return a.distance - b.distance; });
    return res.status(200).json({ results: results });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch places' });
  }
};
// ---- Helper: extract signals for ALL parks in one Gemini call ----
// Builds a single prompt containing reviews for every park,
// sends one request to Gemini, and parses the batch response.
function extractAllSignals(places, geminiKey) {
  if (!geminiKey) {
    return Promise.resolve(places.map(function () { return null; }));
  }

  // Build a section for each park with its reviews
  var parkSections = [];
  var parkIndices = []; // tracks which parks have reviews

  places.forEach(function (place, index) {
    if (!place.reviews || place.reviews.length === 0) return;

    var reviewTexts = place.reviews.map(function (review) {
      return review.text ? review.text.text : '';
    }).filter(function (text) {
      return text.length > 0;
    }).join('\n');

    if (reviewTexts.length === 0) return;

    parkSections.push('PARK ' + (parkSections.length + 1) + ': ' + place.displayName.text + '\n' + reviewTexts);
    parkIndices.push(index);
  });

  // If no parks have reviews, return all nulls
  if (parkSections.length === 0) {
    return Promise.resolve(places.map(function () { return null; }));
  }

  var prompt = 'You are analyzing reviews of multiple parks and playgrounds. '
    + 'For each park below, extract information about five dimensions from its reviews.\n\n'
    + 'Dimensions:\n'
    + '1. fenced - Is the area fenced? Values: "yes", "no", or "not_mentioned"\n'
    + '2. shade - Is there shade available? Values: "yes", "no", or "not_mentioned"\n'
    + '3. bathrooms - Are there bathrooms or restrooms? Values: "yes", "no", or "not_mentioned"\n'
    + '4. ageSuitability - What ages is it suitable for? Values: "toddler", "older", "both", or "not_mentioned"\n'
    + '5. parking - What parking is available? Values: "lot", "street", "both", or "not_mentioned"\n\n'
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
    + '    "parking": { "value": "...", "summary": "..." }\n'
    + '  },\n'
    + '  ...\n'
    + ']';

  var geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiKey;

  return fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  })
    .then(function (geminiRes) {
      if (!geminiRes.ok) {
        return null;
      }
      return geminiRes.json();
    })
    .then(function (geminiData) {
      if (!geminiData) {
        return places.map(function () { return null; });
      }
      var text = geminiData.candidates
        && geminiData.candidates[0]
        && geminiData.candidates[0].content
        && geminiData.candidates[0].content.parts
        && geminiData.candidates[0].content.parts[0]
        && geminiData.candidates[0].content.parts[0].text;
      if (!text) {
        return places.map(function () { return null; });
      }
      var cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
      var parsed = JSON.parse(cleaned);

      // parsed should be an array with one entry per park that had reviews.
      // Map it back to the full places array (parks without reviews stay null).
      var allSignals = places.map(function () { return null; });
      if (Array.isArray(parsed)) {
        parkIndices.forEach(function (placeIndex, i) {
          if (parsed[i]) {
            allSignals[placeIndex] = validateSignals(parsed[i]);
          }
        });
      }
      return allSignals;
    })
    .catch(function () {
      return places.map(function () { return null; });
    });
}
// ---- Helper: validate and normalize Gemini's response ----
function validateSignals(parsed) {
  var booleanDimensions = ['fenced', 'shade', 'bathrooms'];
  var booleanAllowed = ['yes', 'no', 'not_mentioned'];
  var ageAllowed = ['toddler', 'older', 'both', 'not_mentioned'];
  var parkingAllowed = ['lot', 'street', 'both', 'not_mentioned'];

  var result = {};

  booleanDimensions.forEach(function (dim) {
    if (parsed[dim] && booleanAllowed.indexOf(parsed[dim].value) !== -1) {
      result[dim] = {
        value: parsed[dim].value,
        summary: parsed[dim].value === 'not_mentioned' ? null : (parsed[dim].summary || null)
      };
    } else {
      result[dim] = { value: 'not_mentioned', summary: null };
    }
  });

  if (parsed.ageSuitability && ageAllowed.indexOf(parsed.ageSuitability.value) !== -1) {
    result.ageSuitability = {
      value: parsed.ageSuitability.value,
      summary: parsed.ageSuitability.value === 'not_mentioned' ? null : (parsed.ageSuitability.summary || null)
    };
  } else {
    result.ageSuitability = { value: 'not_mentioned', summary: null };
  }

  if (parsed.parking && parkingAllowed.indexOf(parsed.parking.value) !== -1) {
    result.parking = {
      value: parsed.parking.value,
      summary: parsed.parking.value === 'not_mentioned' ? null : (parsed.parking.summary || null)
    };
  } else {
    result.parking = { value: 'not_mentioned', summary: null };
  }

  return result;
}
// ---- Helper: default signals when no extraction is possible ----
function defaultSignals() {
  return {
    fenced: { value: 'not_mentioned', summary: null },
    shade: { value: 'not_mentioned', summary: null },
    bathrooms: { value: 'not_mentioned', summary: null },
    ageSuitability: { value: 'not_mentioned', summary: null },
    parking: { value: 'not_mentioned', summary: null }
  };
}
// ---- Helper: extract attribution from a photo object ----
function getAttribution(photo) {
  if (!photo.authorAttributions || photo.authorAttributions.length === 0) {
    return null;
  }
  var author = photo.authorAttributions[0];
  return {
    name: author.displayName || null,
    url: author.uri || null
  };
}
// ---- Haversine formula ----
function haversine(lat1, lng1, lat2, lng2) {
  var R = 3958.8;
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}
function toRad(deg) {
  return deg * (Math.PI / 180);
}
