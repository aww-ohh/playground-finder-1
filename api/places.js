// api/places.js — Vercel serverless function
// Accepts lat/lng from the front end, calls Google Places API (New),
// fetches photo URLs, and returns a cleaned list of nearby parks and playgrounds
// (including raw reviews so the frontend can request signals from /api/signals).
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
    radiusMiles = 0.5; // default
  }
  var radiusMeters = radiusMiles * 1609.344;
  // ---- 1c. Which weekday is it for the USER? ----
  // U3: this serverless function runs in UTC. After ~4-5pm Pacific the
  // server's "today" is already tomorrow, so "Today's hours" showed the
  // wrong day. The client sends its own weekday (0=Sunday..6=Saturday);
  // we trust it when it's a valid 0-6 integer, else fall back to server time.
  var clientDay = parseInt(req.query.day, 10);
  if (isNaN(clientDay) || clientDay < 0 || clientDay > 6) {
    clientDay = new Date().getDay();
  }
  // ---- 2. Check for API key ----
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
    'places.reviews',
    'places.regularOpeningHours',
    'places.currentOpeningHours',
    // V6 F3: street address shown on each card
    'places.formattedAddress',
    // V6 F2: Google's own yes/no answers for "has a restroom?" and
    // "good for children?". These are Enterprise-tier fields — the same
    // SKU we already pay for via places.reviews, so adding them costs
    // nothing extra.
    'places.restroom',
    'places.goodForChildren'
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
      // 300px is plenty for the 16:9 card hero at typical device pixel ratios;
      // smaller than 400px saves ~30-40% in photo payload size.
      var photoMediaUrl = 'https://places.googleapis.com/v1/'
        + firstPhoto.name
        + '/media?maxHeightPx=300&skipHttpRedirect=true&key=' + apiKey;
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
    // ---- 5. Clean and transform each result ----
    // Reviews are included so the frontend can pass them to /api/signals.
    // Strip down each review to just the text (saves payload size).
    var results = data.places.map(function (place, index) {
      var placeLat = place.location.latitude;
      var placeLng = place.location.longitude;
      var photo = photoResults[index];
      var reviewTexts = [];
      if (Array.isArray(place.reviews)) {
        reviewTexts = place.reviews
          .map(function (rv) {
            return {
              text: rv && rv.text ? rv.text.text : '',
              // V6 F5: when the review was written, so the frontend can warn
              // when ALL of a park's reviews are years old.
              publishTime: (rv && rv.publishTime) || null
            };
          })
          .filter(function (rv) { return rv.text && rv.text.length > 0; });
      }
      // Hours info: openNow + a short string for today's hours
      var openNow = null;
      if (place.currentOpeningHours && typeof place.currentOpeningHours.openNow === 'boolean') {
        openNow = place.currentOpeningHours.openNow;
      }
      var todayHours = null;
      if (place.regularOpeningHours && Array.isArray(place.regularOpeningHours.weekdayDescriptions)) {
        // weekdayDescriptions is Mon-Sun. JS getDay() is Sun=0..Sat=6 → convert.
        // U3: use the CLIENT's weekday (computed above), not the server's —
        // this function runs in UTC, where "today" flips a day early for US users.
        var jsDay = clientDay;
        var dayIndex = jsDay === 0 ? 6 : jsDay - 1;
        var todayDesc = place.regularOpeningHours.weekdayDescriptions[dayIndex];
        if (todayDesc) {
          // "Monday: 6:00 AM – 10:00 PM" → "6:00 AM – 10:00 PM"
          todayHours = todayDesc.replace(/^[A-Za-z]+:\s*/, '');
        }
      }
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
        // V7 F8: photo NAMES are free metadata — only resolving a name into a
        // real image URL is billed. So we ship up to 2 extra names here, and
        // the frontend resolves them lazily via /api/photo only when the user
        // taps the "more photos" badge. Zero added cost per search.
        extraPhotoNames: Array.isArray(place.photos)
          ? place.photos.slice(1, 3).map(function (p) { return p.name; }).filter(Boolean)
          : [],
        reviews: reviewTexts,
        openNow: openNow,
        todayHours: todayHours,
        // V6 F3: human-readable street address for the card + map popup
        address: place.formattedAddress || null,
        // V6 F2: Google's structured facts. Only pass real booleans through —
        // anything else becomes null so the frontend knows "Google didn't say".
        restroom: typeof place.restroom === 'boolean' ? place.restroom : null,
        goodForChildren: typeof place.goodForChildren === 'boolean' ? place.goodForChildren : null
      };
    });
    // ---- 6. Sort by distance, closest first ----
    results.sort(function (a, b) { return a.distance - b.distance; });
    return res.status(200).json({ results: results });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch places' });
  }
};
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
