/*
 * TeamLink service worker - phone notifications only.
 *
 * It has no fetch handler and caches nothing: the portal loads exactly as
 * it does without it. Its one job is to show a push as a notification
 * and to open the right page when the notification is tapped.
 *
 * EVERY push shows a notification. iOS removes the subscription of a site
 * whose push displays nothing, so even a payload that cannot be read
 * produces a plain "TeamLink" notice rather than silence.
 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    try { data = { body: event.data ? event.data.text() : '' }; } catch (e2) { data = {}; }
  }
  var title = data.title || 'TeamLink';
  var options = {
    body: data.body || 'You have an update on TeamLink.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  var work = [self.registration.showNotification(title, options)];
  /* The number on the Home Screen icon, where the platform supports it. */
  if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
    work.push(self.navigator.setAppBadge(data.badge).catch(function () {}));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  var url = new URL(target, self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    /* Focus the app's own window (the Home Screen app on iPhone) and take
       it to the page; open one only when there is none. */
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        return c.focus().then(function (w) { return (w || c).navigate ? (w || c).navigate(url.href) : null; });
      }
    }
    return self.clients.openWindow ? self.clients.openWindow(url.href) : null;
  }));
});
