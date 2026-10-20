/* ==========================================
   HEALINK 2.0
   FIREBASE CLOUD MESSAGING SERVICE WORKER
========================================== */

"use strict";

// Terima mesej FCM ketika aplikasi di latar belakang.
self.addEventListener("push", (event) => {

  if (!event.data) return;

  let payload;

  try {
    payload = event.data.json();
  } catch (error) {
    console.error("Payload notifikasi tidak sah:", error);
    return;
  }

  const data = payload.data || {};

  const title =
    data.title || "🔔 HEALINK 2.0";

  const body =
    data.body || "Terdapat makluman baharu.";

  const url =
    new URL(
      data.url || "/dashboard.html",
      self.location.origin
    ).href;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      tag: "healink-notification-" + Date.now(),
      data: { url }
    })
  );

});

// Apabila admin menekan notifikasi
self.addEventListener("notificationclick", (event) => {

  event.notification.close();

  const url =
    event.notification.data?.url ||
    new URL("/dashboard.html", self.location.origin).href;

  event.waitUntil(
    clients.openWindow(url)
  );

});