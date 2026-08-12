(function () {
  'use strict';

  var STORAGE_KEY = 'neotavern.backendUrl';
  var form = document.getElementById('connect-form');
  var input = document.getElementById('server-url');
  var error = document.getElementById('error');

  function normalizeUrl(value) {
    var candidate = value.trim();
    if (!candidate) return null;
    if (!/^https?:\/\//i.test(candidate)) candidate = 'http://' + candidate;
    try {
      var url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.href;
    } catch (e) {
      return null;
    }
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  // Prefill with the saved address so reconnecting is one tap.
  var saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    saved = null;
  }
  if (saved) input.value = saved;

  // Auto-connect only on a fresh page load. When the user presses the system
  // back button from the server UI (or from a failed connection error page),
  // the WebView restores this page as a back-forward navigation; redirecting
  // again there would trap the user in a loop with no way back to this form.
  var navigationType = null;
  try {
    var entries = performance.getEntriesByType('navigation');
    if (entries.length) navigationType = entries[0].type;
  } catch (e) {
    navigationType = null;
  }
  if (saved && navigationType !== 'back_forward') {
    var url = normalizeUrl(saved);
    if (url) {
      // Keep this page addressable in history: a failed navigation to the
      // target replaces the current entry, so without this copy the system
      // back button would exit the app instead of returning to the form.
      try {
        history.pushState({}, '');
      } catch (e) {
        // History API unavailable: fall back to a plain redirect.
      }
      location.href = url;
      return;
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var url = normalizeUrl(input.value);
    if (!url) {
      showError('Enter a valid server address, for example http://192.168.1.5:8000');
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, url);
    } catch (e) {
      // Storage unavailable: still connect, just don't remember the address.
    }
    location.href = url;
  });
})();
