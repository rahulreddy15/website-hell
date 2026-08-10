/* sw.js — offline shell.

   Two rules:
   - App shell: cache first, revalidate in the background. The app must
     open instantly with no signal.
   - /api/*: network only, never cached. Stale health data pretending to be
     current is worse than no data. Writes are queued in IndexedDB by the
     page, not here, so nothing is lost when a request fails.
*/

var VERSION = "record-v3";
var SHELL = VERSION + "-shell";

var SCOPE = new URL("./", self.registration ? self.registration.scope : self.location.href);

var ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-180.png",
  "js/util.js",
  "js/store.js",
  "js/api.js",
  "js/sync.js",
  "js/bristol.js",
  "js/sheet.js",
  "js/entry.js",
  "js/view-today.js",
  "js/view-explore.js",
  "js/view-timeline.js",
  "js/view-evidence.js",
  "js/view-review.js",
  "js/view-settings.js",
  "js/app.js",
].map(function (path) { return new URL(path, SCOPE).toString(); });

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      return Promise.all(
        ASSETS.map(function (url) {
          return cache.add(new Request(url, { cache: "reload" })).catch(function () {
            /* one missing optional asset must not fail the whole install */
          });
        })
      );
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== SHELL; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function isApi(url) {
  return url.pathname.indexOf(new URL("api/", SCOPE).pathname) === 0;
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isApi(url)) return;                       // never cache data

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(new URL("index.html", SCOPE).toString());
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(SHELL).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});

/* Background sync: nudge any open page to flush its queue. The queue lives
   in IndexedDB in the page, which keeps the replay logic in one place. */
self.addEventListener("sync", function (event) {
  if (event.tag !== "st-flush") return;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true }).then(function (clients) {
      clients.forEach(function (client) { client.postMessage({ type: "flush" }); });
    })
  );
});
