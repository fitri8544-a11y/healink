/* =========================================================
   HEALINK 2.0
   PWA SERVICE WORKER
========================================================= */

const CACHE_NAME =
  "healink-v2-cache-v3";


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

/* =========================================================
   HEALINK 2.0
   FIREBASE CLOUD MESSAGING
   BACKGROUND NOTIFICATIONS
========================================================= */

// Firebase SDK untuk Service Worker
importScripts(
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js"
);

// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyA9R5jKqeJNvBHD-SIOuseAqyb_x909R3Q",
  authDomain: "bimbingankaunselingskkk.firebaseapp.com",
  databaseURL: "https://bimbingankaunselingskkk-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "bimbingankaunselingskkk",
  storageBucket: "bimbingankaunselingskkk.firebasestorage.app",
  messagingSenderId: "847162891153",
  appId: "1:847162891153:web:0ff6aa5a6c7276133f1830"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Firebase Messaging
const messaging = firebase.messaging();

// =====================================================
// HEALINK 2.0 - BACKGROUND NOTIFICATION
// Untuk mesej FCM jenis DATA-ONLY
// =====================================================

messaging.onBackgroundMessage((payload) => {

  console.log(
    "🔔 HEALINK Background Message Received"
  );

  // Elakkan paparan kedua jika mesej mempunyai
  // notification payload yang dipaparkan oleh Firebase.
  if (payload.notification) {
    return;
  }

  const data = payload.data || {};

  const notificationTitle =
    data.title || "🔔 HEALINK 2.0";

  const notificationOptions = {

    body:
      data.body ||
      "Terdapat makluman baharu untuk pentadbir.",

    icon:
      "/assets/healink-icon-192.png",

    badge:
      "/assets/healink-icon-192.png",

    tag:
      data.eventId || "healink-admin-notification",

    data: {
      url: "/dashboard.html"
    }

  };

  return self.registration.showNotification(
    notificationTitle,
    notificationOptions
  );

});

// Apabila notifikasi diklik
self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();

    event.waitUntil(
      clients.openWindow(
        "/dashboard.html"
      )
    );

  }
);