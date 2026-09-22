/* =========================================================
   HEALINK 2.0
   PWA SERVICE WORKER
========================================================= */

const CACHE_NAME =
  "healink-v2-cache-v2";


/* =========================================================
   CORE FILES
   Fail asas sahaja untuk proses pemasangan PWA
========================================================= */

const CORE_FILES = [

  "/",

  "/manifest.json",

  "/assets/healink-icon-192.png",

  "/assets/healink-icon-512.png",

  "/assets/apple-touch-icon.png"

];


/* =========================================================
   INSTALL
========================================================= */

self.addEventListener(
  "install",
  event => {

    console.log(
      "📦 HEALINK Service Worker installing..."
    );


    event.waitUntil(

      caches
        .open(CACHE_NAME)
        .then(async cache => {

          /*
            Cache satu demi satu.

            Jika satu fail gagal,
            Service Worker masih boleh dipasang.
          */

          for(
            const file of CORE_FILES
          ) {

            try {

              await cache.add(file);

              console.log(
                "✅ Cached:",
                file
              );

            }
            catch(error) {

              console.warn(
                "⚠️ Cache skipped:",
                file,
                error
              );

            }

          }

        })

    );


    self.skipWaiting();

  }
);


/* =========================================================
   ACTIVATE
========================================================= */

self.addEventListener(
  "activate",
  event => {

    console.log(
      "🚀 HEALINK Service Worker activated"
    );


    event.waitUntil(

      caches
        .keys()
        .then(cacheNames => {

          return Promise.all(

            cacheNames.map(
              cacheName => {

                if(
                  cacheName !==
                  CACHE_NAME
                ) {

                  return caches.delete(
                    cacheName
                  );

                }

              }
            )

          );

        })

        .then(() => {

          return self.clients.claim();

        })

    );

  }
);


/* =========================================================
   FETCH
   NETWORK FIRST
========================================================= */

self.addEventListener(
  "fetch",
  event => {

    if(
      event.request.method !== "GET"
    ) {

      return;

    }


    const requestURL =
      new URL(
        event.request.url
      );


    /*
      Jangan campur tangan dengan Firebase,
      Google Fonts, CDN atau domain luar.
    */

    if(
      requestURL.origin !==
      self.location.origin
    ) {

      return;

    }


    event.respondWith(

      fetch(
        event.request
      )

        .then(response => {

          if(
            response &&
            response.ok
          ) {

            const copy =
              response.clone();


            caches
              .open(CACHE_NAME)
              .then(cache => {

                cache.put(
                  event.request,
                  copy
                );

              });

          }


          return response;

        })

        .catch(async () => {

          const cached =
            await caches.match(
              event.request
            );


          if(cached) {

            return cached;

          }


          /*
            Jika navigasi gagal ketika offline,
            cuba paparkan halaman utama.
          */

          if(
            event.request.mode ===
            "navigate"
          ) {

            return caches.match(
              "/"
            );

          }


          return new Response(
            "",
            {
              status: 503,
              statusText: "Offline"
            }
          );

        })

    );

  }
);