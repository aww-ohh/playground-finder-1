// api/places.js — Vercel serverless function
// Accepts lat/lng from the front end, calls Google Places API (New),
// and returns a cleaned list of nearby parks and playgrounds.

module.exports = async function handler(req, res) {
  // ---- 1. Validate query parameters ----
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Missing or invalid lat/lng parameters' });
  }

  // ---- 2. Check for the API key ----
  var apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ---- 3. Call Google Places API (New) — Nearby Search ----
  var googleUrl = 'https://places.googleapis.com/v1/places:searchNearby';

  var requestBody = {
    includedTypes: ['park', 'playground'],
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 8046.72  // 5 miles in meters
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
    'places.userRatingCount'
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

    // ---- 5. Clean and transform each result ----
    var results = data.places.map(function (place) {
      var placeLat = place.location.latitude;
      var placeLng = place.location.longitude;

      return {
        name: place.displayName.text,
        type: place.types.includes('playground') ? 'playground' : 'park',
        lat: placeLat,
        lng: placeLng,
        distance: haversine(lat, lng, placeLat, placeLng),
        rating: place.rating || null,
        reviewCount: place.userRatingCount || 0,
        placeId: place.id
      };
    });

    // ---- 6. Sort by distance, closest first ----
    results.sort(function (a, b) { return a.distance - b.distance; });

    return res.status(200).json({ results: results });

  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch places' });
  }
};

// ---- Haversine formula ----
// Calculates the straight-line distance between two lat/lng points
// on Earth's surface. Returns distance in miles.
function haversine(lat1, lng1, lat2, lng2) {
  var R = 3958.8; // Earth's radius in miles
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100; // rounded to 2 decimal places
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}
