// app.js — Front-end logic for Playground Finder

// ---- Grab references to HTML elements ----
const geolocateBtn = document.getElementById('geolocate-btn');
const addressForm = document.getElementById('address-form');
const addressInput = document.getElementById('address-input');
const searchSection = document.querySelector('.search-section');

// ---- Helper: show a status message on the page ----
// Creates (or reuses) a small message area below the search controls.
function showMessage(text, type) {
  let msg = document.getElementById('status-message');
  if (!msg) {
    msg = document.createElement('p');
    msg.id = 'status-message';
    searchSection.appendChild(msg);
  }
  msg.textContent = text;
  msg.className = 'status-message ' + type;  // type is "info", "success", or "error"
}

// ---- Map state ----
// These persist across searches so we can reuse the map and clear old markers.
var map = null;
var markerGroup = L.layerGroup();

// ---- Helper: show the map and place markers ----
function showMap(lat, lng, results) {
  // Unhide the map section
  document.getElementById('map-section').classList.remove('hidden');

  // Create the map on first use, or re-center on subsequent searches
  if (!map) {
    map = L.map('map').setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    markerGroup.addTo(map);
  } else {
    map.flyTo([lat, lng], 13);
  }

  // Clear markers from any previous search
  markerGroup.clearLayers();

  // Visitor marker: a bright pulsing dot, forced on top of other markers
  var visitorIcon = L.divIcon({
    className: 'visitor-marker',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -18]
  });
  L.marker([lat, lng], { icon: visitorIcon, zIndexOffset: 1000 })
    .bindPopup('You are here')
    .addTo(markerGroup);

  // Park/playground markers
  var bounds = L.latLngBounds([[lat, lng]]);
  results.forEach(function (r) {
    var ratingText = r.rating ? r.rating + ' stars (' + r.reviewCount + ' reviews)' : '0 ratings';
    var popupContent = '<strong>' + r.name + '</strong><br>'
      + r.type + ' — ' + ratingText;
    L.marker([r.lat, r.lng])
      .bindPopup(popupContent)
      .addTo(markerGroup);
    bounds.extend([r.lat, r.lng]);
  });

  // Zoom to fit all markers if there are results
  if (results.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  // Leaflet needs a nudge to render correctly after the container becomes visible
  setTimeout(function () { map.invalidateSize(); }, 200);
}

// ---- Helper: render a raw list of results on the page (temporary) ----
// This is a plain unordered list for verifying data flow.
// Steps 6 and 7 will replace this with the styled map + list.
function renderRawResults(results) {
  var container = document.getElementById('raw-results');
  if (!container) {
    container = document.createElement('div');
    container.id = 'raw-results';
    document.querySelector('main').appendChild(container);
  }
  if (results.length === 0) {
    container.innerHTML = '';
    return;
  }
  var html = '<ul>';
  results.forEach(function (r) {
    var rating = r.rating ? r.rating + ' stars' : 'no rating';
    html += '<li><strong>' + r.name + '</strong> — '
      + r.type + ', ' + r.distance + ' mi, '
      + rating + ', ' + r.reviewCount + ' reviews</li>';
  });
  html += '</ul>';
  container.innerHTML = html;
}

// ---- Helper: called once we have coordinates from either source ----
// Calls the serverless function and displays results.
function handleCoordinates(lat, lng) {
  showMessage('Searching for playgrounds and parks…', 'info');

  fetch('/api/places?lat=' + lat + '&lng=' + lng)
    .then(function (response) {
      if (response.ok) {
        return response.json().then(function (data) {
          if (data.results.length === 0) {
            showMessage('No playgrounds or parks found within 5 miles of this location.', 'info');
            showMap(lat, lng, []);
            renderRawResults([]);
            return;
          }
          showMessage('Found ' + data.results.length + ' playgrounds and parks nearby.', 'success');
          console.log('Results:', data.results);
          showMap(lat, lng, data.results);
          renderRawResults(data.results);
        });
      }
      if (response.status === 400) {
        showMessage('Something is wrong with the request. Please try again.', 'info');
      } else if (response.status === 500) {
        showMessage('The server is not set up correctly. Please try again later.', 'info');
      } else if (response.status === 502) {
        showMessage('We couldn\u2019t get results right now. Please try again in a moment.', 'info');
      } else {
        showMessage('Something went wrong. Please try again.', 'info');
      }
      renderRawResults([]);
    })
    .catch(function () {
      showMessage('Could not reach the server. Please check your connection and try again.', 'info');
      renderRawResults([]);
    });
}

// ---- "Use My Location" button ----
geolocateBtn.addEventListener('click', function () {
  // Check if the browser supports geolocation at all
  if (!navigator.geolocation) {
    showMessage(
      'Your browser does not support location services. Please enter an address instead.',
      'info'
    );
    return;
  }

  // Show a loading message while we wait for the browser prompt
  showMessage('Checking your location…', 'info');

  navigator.geolocation.getCurrentPosition(
    // Success: the user allowed location access
    function (position) {
      var lat = position.coords.latitude;
      var lng = position.coords.longitude;
      handleCoordinates(lat, lng);
    },
    // Failure: the user denied permission, or something else went wrong
    function () {
      showMessage(
        'We couldn\u2019t get your location. Please enter an address below instead.',
        'info'
      );
    }
  );
});

// ---- Address form submission ----
addressForm.addEventListener('submit', function (e) {
  // Prevent the form from reloading the page (default browser behavior)
  e.preventDefault();

  var address = addressInput.value.trim();
  if (!address) {
    showMessage('Please type an address or city name.', 'info');
    return;
  }

  showMessage('Looking up "' + address + '"…', 'info');

  // Call Nominatim (OpenStreetMap's free geocoding service) to convert
  // the typed address into latitude/longitude coordinates.
  var url = 'https://nominatim.openstreetmap.org/search'
    + '?q=' + encodeURIComponent(address)
    + '&format=json'
    + '&countrycodes=us,ca'
    + '&limit=1';

  fetch(url, {
    headers: { 'Accept': 'application/json' }
  })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (data.length === 0) {
        showMessage(
          'We couldn\u2019t find that address. Please try a different one.',
          'info'
        );
        return;
      }
      var lat = parseFloat(data[0].lat);
      var lng = parseFloat(data[0].lon);
      handleCoordinates(lat, lng);
    })
    .catch(function () {
      showMessage(
        'Something went wrong looking up that address. Please try again.',
        'info'
      );
    });
});
