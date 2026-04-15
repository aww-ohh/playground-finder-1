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

// ---- Helper: called once we have coordinates from either source ----
// For now this just displays a confirmation. Step 5 will replace
// this with the actual API call.
function handleCoordinates(lat, lng) {
  showMessage('Got your location: ' + lat.toFixed(5) + ', ' + lng.toFixed(5), 'success');
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
